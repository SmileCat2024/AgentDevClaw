# IM 渠道线程化 — 里程碑 1 实施计划

日期：2026-11-05
状态：A–E 已落地；F 端到端已在隔离实例跑通，待真实 IM 平台侧手测
决策依据：[ADR-0042](../adr/0042-im-channel-thread-binding.md) 里程碑 1（两个线程化 + 通路切换，联合交付锁死形态）

## 实施进度（2026-11-05）

- **A 接线员线程化**：完成。`metadata.json` 声明 `threadHost: true`；`server/routes/im-operator-thread.js`（start/new 事务、boot 钩子、head 解析、旧会话归档迁移）+ 11 条单测；`agent-startup.js` / `server.js` / `im-config.js` 接线（`operatorThreadId`）。
- **B 线路模型**：完成。`boundTarget` 替换 `boundSession`；`selectedChannel` 归一并入门户线路（固定 id `portal`）；`resolveLineTransferConflict` 单一互斥；prune 改按线程事实。消费方（agent-discovery / agent-lifecycle / dispatch-engine / im-workspace-bundle / im.js）全部切换。
- **C 线程投影与校验**：完成。`im_routable_targets` 改 `core.listThreads()` 线程投影（剔终态/归档/删除中）；`im_line_transfer` 线程寻址 + 接受性同源校验（`_threadAcceptanceVerdict`），mount/unmount IPC 副作用删除；`im_line_binding` 死端点删除；qqbot `agent.js` 配置读取切新模型（多线路并发留 E）；`im-data-pipelines.test.js` 按新契约更新。
- **D 轮次结果事件**：完成。`turn-event-mapping` 加法式 `resultText`（envelope.result）；`thread-routes` 落板后发布 `thread.turn-*` SSE 帧 + `onTurnTerminalFact` 订阅钩子（DI）；OS 通知出口接入（`observeThreadTurnFact`：completed/failed 投递带线程身份与 200 字交付摘要，cancelled 跳过，轮次级 dedupe；快照路径对线程宿主 finish 让位防双通知）；3 个测试文件 66 用例 + 4 组变异验证。
- **E 门户投递切换与载体退役**：完成。新建 `prebuilt-agents/official/qqbot/portal-lines.js`（门户线路运行时：多线路并发连接、按 boundTarget 入站分发、SSE 轮次事件出站、线路级对端记账）；qqbot `agent.js` 以 `startPortalLines` / `reloadPortalLines` 取代单渠道 `startSelectedIMGateway` 与五个 `start<Carrier>BotGateway`；`runtime-im-bridge.js` 缩为 `createRuntimeIPC`（只留 todo-control），`mountCarrierFeature` / `mountIMLineCarrierIfBound` / `dispatchIMCallFinish` 与 mount/unmount-im-carrier IPC 全部退役；`run-prebuilt-agent.js` 接 `startPortalLines` 与 `reload-im-lines` 热对账；`im.js` 的 PUT 从「重启 runtime」改为「通知门户对账」；接线员工具 `im_overview` / `im_browse` / `im_connect_line` 全部切线程词汇；`metadata.json` 临时声明 `contextRotationStrategy: adaptive`。19 条新单测 + 4 组变异验证。
- **F 联合验收**：端到端已跑通（见下节实测记录）；剩余为真实 IM 平台侧实测（需在 QQ/飞书客户端发消息）。

实施中发现并修复：server.js 重复 import `readProjectIMWorkspaceConfig`（B/C 期间引入，node --check 暴露）。

## 目标

一条 IM 消息进入绑定线程处理、结果回到 IM；接线员对话以线程身份呈现、可接续。里程碑内不引入目标形态之外的过渡机制（不保留 mount-im-carrier 载体挂载、不做"换头即断线"妥协）。

## 现状事实基线（2026-11-05 代码实测）

实施直接依赖的机制与位置：

- **线路配置**：`.agentdev/im-workspace.config.json`，形状经 `normalizeIMWorkspaceConfig`（server/routes/im-config.js）归一。`lines[].boundSession: {agentId, sessionId}`、`selectedChannel`（门户单渠道）、`receptionistSessionId`（接线员会话引用）。`pruneStaleIMLineBindings` 按 runtime 存活清绑定。
- **绑定与挂载**：`im_line_transfer`（server/routes/im.js）校验目标 runtime 存活 → 写 boundSession → IPC `mount-im-carrier` 动态挂载体 feature 到目标 runtime（scripts/runtime-im-bridge.js `mountCarrierFeature`）；启动时 `mountIMLineCarrierIfBound` 按 `/protoclaw/im_line_binding` 重挂。
- **接线员工具**：prebuilt-agents/official/qqbot/agent.js `IMOperatorFeature`（im_overview / im_browse / im_connect_line / im_disconnect_line），全走 server HTTP。
- **门户 gateway**：`startSelectedIMGateway` 只启 selectedChannel 单渠道；`_activeIMChannel` / `_lastIMTarget` 单值记录出站状态；`sendIMMessage` 按单值分发。
- **轮次事件**：runtime 宿主已在 `callStarted` / `callFinished` 时经 `POST /protoclaw/thread_events` 上报 turn.* 事件（run-prebuilt-agent.js `reportThreadEvent`），server 落看板（`board.recordRuntimeEvent`）。事件形状由 turn-event-mapping.js 产出，**不含结果文本**；assistant 文本经 `item.completed`（agent_message）事件单独上报。应用内另有 `turnEvents` 总线（进程内，ADR-0041）。
- **非 IM 结果镜像**：runtime 侧 `dispatchIMCallFinish`（CallArbiter callFinished → 非 IM 来源且有活跃渠道时 `agent.sendIMMessage`）。
- **线程投递**：`POST /protoclaw/threads/:threadId/input`（thread-routes.js）已存在，接受性判定 + Thread Inbox + head runtime 唤醒补投一体。宿主裁剪前端按 `window.isThreadHostAgentId`（thread-store.js，服务端发现驱动），metadata 声明 `threadHost: true` 后自动生效。
- **线程库 API**：`core.listThreads({agentId})`（摘要视图）、`core.getThread`、`core.findThreadByHeadSession`。
- **memo 先例**：server/routes/memo-app.js——`app-state.json` 持有 activeThreadId，start/new 事务串行，新建会话 → 宿主钩子建线程 → 写引用。
- **幂等键**：框架 `appendCommand` 的 idempotencyKey 命中 pending **或 delivered** 指令均判 duplicate——IM 投递的 sourceRef 必须消息级唯一，否则同对端连发第二条被吞。

## 切片

### A. qqbot 线程化（任务 #11）

改动：
- prebuilt-agents/official/qqbot/metadata.json 加 `"threadHost": true`（server.js 发现注册自动生效，宿主裁剪与侧栏呈现随之生效，前端零改动）。
- 新建 server/routes/im-operator-thread.js（memo-app 同构）：`im-workspace.config.json` 的 `receptionistSessionId` 替换为 `operatorThreadId`（接线员唯一线程引用）。事务：
  - ensure：引用存在且线程非终态非归档 → 唤起 head runtime 复用；引用悬空或缺失 → 新建会话 → 拉起门户 runtime → 宿主钩子建线程 → 写引用（in-flight 互斥串行）。
  - 换代（新建对话）：先建新线程写引用，再 best-effort 归档旧线程（memo 顺序：丢引用不可，多一条未归档可收敛）。
  - 既有接线员会话：不迁移，随首代切换自然只读保留。
- 触发点：门户 runtime 启动链（server 侧 start qqbot 时 ensure）+ IM 门户线路消息到达时 ensure。

验收：qqbot 新会话自动建线程；`isThreadHostSession('qqbot')` 为真；接线员线程跨 runtime 重启引用稳定；slash /trim 在 qqbot 会话隐藏。

### B. 线路模型 boundTarget（任务 #12）

改动（server/routes/im-config.js 为主）：
- `normalizeIMLine`：`boundSession` → `boundTarget: {agentId, threadId}`；归一时直接丢弃存量 boundSession（清空不迁移，零换算）。
- `selectedChannel` 并入线路模型：归一时把 selectedChannel 转为门户线路（固定 id `portal`，carrier 取原值，boundTarget 自动指向 operatorThreadId）；写回后 selectedChannel 字段不再消费。`resolvePortalChannelConflict` 退役，载体互斥只保留 `resolveLineTransferConflict` 一份（去掉 selectedChannel 特判）。
- `pruneStaleIMLineBindings` 改按线程事实清绑定（线程终态/归档/删除中即清，不再看 runtime 存活）。

验收：归一后配置无 boundSession / selectedChannel 残留；两条线路同载体时互斥仍成立。

### C. routable targets 线程投影与 transfer 校验（任务 #13）

改动（server/routes/im.js）：
- `im_routable_targets`：workspace→project→session 树退役，改为 `core.listThreads()` 派生的线程清单（agentId、threadId、标题、head 会话、执行状态），剔除终态/归档/删除中；lines 快照改投 boundTarget。project adapter 路径与 work-group 特判对该接口退役。
- `im_line_transfer`：body 改 `{lineId, carrier, agentId, threadId}`；校验改为线程可接受输入（与 input-gateway `_threadAcceptanceVerdict` 同源判定），删除 runtime 存活校验与 mount/unmount IPC 副作用。
- `im_line_disconnect` / `im_line_binding` 同步换形状（后者改按 threadId 查询，只服务前端显示）。
- qqbot agent.js `IMOperatorFeature` 四个工具同步改线程寻址（im_browse 列线程、im_connect_line 传 threadId）；接线员 system prompt 同步更新（两处注入点纪律）。

验收：transfer 绑定未运行 runtime 的线程成功；绑定终态线程被拒；接线员工具在新形状下端到端可用。

### D. 轮次结果事件（任务 #14）

改动：
- scripts/turn-event-mapping.js：turn.completed 增加可选 `resultText`（取 envelope.result，加法式字段，无 result 不加）——"本回合交付文本"是通用事实，不是 IM 私有。run-prebuilt-agent.js 上报处透传。
- server：`POST /protoclaw/thread_events` 在落板后，对 turn 终态事件按线程归并发布 `publishThreadEvent(threadId, {kind: 'thread.turn-completed'|'thread.turn-failed'|'thread.turn-cancelled', turn, source, sourceRef, resultText?})`。session→thread 解析与 board 落板共用（实施时按 board.recordRuntimeEvent 内部解析挂点）。
- 非 IM 订阅者：OS 通知出口（ADR-0030）订阅 thread.turn-completed，线程空闲通知携带交付事实。此为通用能力首用，IM relay 是第二个订阅者。

验收：线程轮次完成后 SSE 订阅方收到 thread.turn-completed 且带 resultText；OS 通知路径收到同一事实；既有 thread_events 消费方（无头 JSONL / ACP / 看板）不受加字段影响（全量测试回归）。

### E. 门户投递切换、出站与载体退役（任务 #15）

实现（与初稿设计的差异已注明）：
- qqbot `portal-lines.js`（新建）：门户线路运行时。
  - 连接管理：`syncLines(lines)` 按配置对账——连新增/变更线路、断已移除线路；同线路重复对账不重连平台连接，改绑目标只更新 `boundTarget`。
  - 入站分发：按 carrier 定位线路 → `boundTarget` 是接线员线程（agentId === 门户自身）或未绑定时交门户 CallArbiter，结果作为回调返回值同步回平台（与历史单渠道行为一致）；外部线程则 `POST /protoclaw/threads/:threadId/input`，回「已收到，处理中…」，结果稍后经出站送达。
  - 幂等键：`sourceRef` 取消息级唯一 ID（QQ/飞书 `messageId`、微信 `msg_id`），缺失时合成「发送者+时间戳+文本摘要」。**不能用 senderId**——框架 `appendCommand` 命中 pending 或 delivered 同键都判重复，同对端连发第二条会被静默吞掉。
  - 出站：门户自建 SSE 订阅（`GET /protoclaw/events?threads=*`，带 `Last-Event-ID` 断线续传），命中本门户绑定的**外部**线程时经该线路发回。**与原设计的差异**：没有新建 server 侧 relay + IPC 推送，直接用切片 D 已发布的线程轮次事件面——少一个模块、少一条 IPC 路径，且 SSE 的环形缓冲 + Last-Event-ID 天然覆盖「出站时门户短暂离线」的重连补帧。截断与错误文案 `PORTAL_REPLY_POLICY` 从 runtime-im-bridge 迁入门户。
  - 接线员线程不出站：结果已在入站同步返回，再发一次是重复（`handleTurnFact` 的 portalAgentId 守卫，已被变异验证覆盖）。
- qqbot `agent.js`：`startPortalLines` / `reloadPortalLines` 取代 `startSelectedIMGateway` 与五个 `start<Carrier>BotGateway`；`_activeIMChannel` / `_lastIMTarget` 单值退役为 `_portalLines`；上传工具按已连接线路判定渠道。
- `runtime-im-bridge.js` → `createRuntimeIPC`：只留 `todo-control`；`mountCarrierFeature` / `mountIMLineCarrierIfBound` / `dispatchIMCallFinish` 与 mount/unmount-im-carrier IPC 全部删除。
- `run-prebuilt-agent.js`：接 `startPortalLines`，新增 `reload-im-lines` IPC 分支做配置热对账。
- `im.js`：PUT bundle 的「重启 runtime」改为「通知门户对账」（`notifyPortalReload`），重启 4 个依赖随之从解构中移除；`im_routable_targets` 补齐 `workspaces` 线程投影（修复此前替换时漏定义的 `activeWorkspaces`）。

验收（单测已覆盖；端到端见下节实测记录）：外部线程绑定线路上发消息入 Thread Inbox 并触发处理（runtime 未起时唤醒）；轮次完成后结果文本回到 IM 对端；接线员线路行为与现状一致；仓库内无 mount-im-carrier 残留引用（已确认）。

### F. 联合验收（任务 #16）

端到端判据（ADR-0042 里程碑 1）：
1. 一条 IM 消息 → 绑定的外部线程（coder）→ 处理 → 结果文本回到 IM 对端。
2. 接线员对话以线程身份呈现（侧栏、裁剪、接续与 coder 同口径），门户 runtime 重启后接线员线程引用稳定。
3. 目标线程接续窗口（trim/换代中）内到达的 IM 消息经 Inbox 暂存，换头后补投不丢。
4. 相关单测全绿：im-config / im 路由 / turn-event / input-gateway 既有测试按新形状更新，新增接线员线程事务与 relay 测试。

## 端到端实测记录（2026-11-05，隔离实例）

方法：`AGENTDEV_DATA_DIR=D:/tmp/claw-exp PORT=1521 AGENTDEV_VIEWER_PORT=2031` 起独立实例，与在用实例的数据和端口完全隔离；复制 `default.json` / `presets.json` / `model-connections.json` 以获得真实模型（不复制任何会话与线程数据）。全部经真实 HTTP 端点驱动，未 stub。

已验证的事实：

1. **建会话自动建线程**：`POST /protoclaw/prebuilt_sessions {agentId:qqbot}` 响应直接返回 `threadId: wt-…`，`/protoclaw/threads` 同步出现 `agentId=qqbot` 的 open 线程。`threadHost` 声明生效。
2. **可绑定目标是线程**：`/protoclaw/im_routable_targets` 返回 `workspaces[].threads[]` 投影（含 title/status/headSessionId/execStatus），qqbot 线程在列——不再受 ProjectAdapter 白名单限制。
3. **线路绑定线程寻址**：`POST /protoclaw/im_line_transfer {lineId, carrier, agentId, threadId}` 落盘为 `boundTarget:{agentId,threadId}`。注意契约要求 `carrier` 与 `agentId/threadId` 同时给，只给后者会走清除分支。
4. **线程投递与幂等**：`POST /protoclaw/threads/:id/input` 返回 `delivery: thread_queued`；同 `sourceRef` 重发判 `duplicate: true`，不同 `sourceRef` 正常入箱。证实门户必须以消息级 ID 作 `sourceRef`。
5. **换代窗口不丢消息**：服务重启后投递返回 `delivered: 0, reason: runtime_not_accepting`，命令留在 Inbox；head runtime 拉起后自动补投，终态 `delivered`。
6. **轮次交付文本回流**：`turn.completed` 事件与 `thread.turn-completed` SSE 帧均携带 `resultText`，值等于模型真实回复（`SECOND_OK` / `THIRD_OK` / `FOURTH_OK`），`sourceRef` 对应投递指令。门户出站消费的正是这一帧。

实测暴露并修复的两个缺陷（单测均已补，变异验证通过）：

- **`envelope.result` 恒为空串**：`CallArbiter` 在引入 `onCallDetailed` 后仍用 `typeof result === 'string'` 取交付文本，而该路径返回 `CallOutcome` 对象（文本在 `outcome.response`），导致真实 agent 的 `resultText` 永远缺席——切片 D 的功能对 IM 完全无效。修复：两条路径统一落到 `envelope.result`。既有桩 agent 只实现 `onCall` 返回字符串，故旧测试全绿却漏掉了真实路径。
- **空 `receptionistSessionId` 被兜底成 `'default'`**：`sanitizeSessionFragment` 对空串返回 `'default'`，升级迁移会拿它当真实旧会话去归档。修复：先判空再 slug 化，空保持空。

未覆盖：真实 IM 平台侧（QQ/飞书客户端发消息 → 门户入站 → 出站回到客户端）需在配置了平台凭证的实例上手测；隔离实例无 feishu/qq 凭证，`line2 [feishu] 连接失败: 缺少 appId 或 appSecret` 即此项。

## 实施时确认点（不阻塞开工）

- `board.recordRuntimeEvent` 内部 session→thread 解析的具体挂点（D 片 relay 挂同一处）。
- 各载体消息回调能否拿到消息级唯一 id（QQ msgSeq / weixin msg_id / feishu message_id）；拿不到的载体退化为不传 sourceRef（无幂等键，不误吞）。
- 空 idempotencyKey（''）在 appendCommand 的行为确认（预期跳过幂等匹配）。
- qqbot runtime 启动链里 ensure 接线员线程的准确挂点（与 startManagedAgent 的时序）。

## 明确不做（里程碑 2 界限）

- im-ui.js / im-actions.js 前端重建（切换窗口内线路管理 UI 显示降级，接口形状以本计划为准）。
- 每条线路独立接线员线程、工作群 @mention 路由、IM 线路 UI 直建入口。
