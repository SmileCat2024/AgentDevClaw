# IM 渠道线程化 — 里程碑 1 实施计划

日期：2026-11-05
状态：进行中（A–D 已落地待评审，E/F 未开工）
决策依据：[ADR-0042](../adr/0042-im-channel-thread-binding.md) 里程碑 1（两个线程化 + 通路切换，联合交付锁死形态）

## 实施进度（2026-11-05）

- **A 接线员线程化**：完成。`metadata.json` 声明 `threadHost: true`；`server/routes/im-operator-thread.js`（start/new 事务、boot 钩子、head 解析、旧会话归档迁移）+ 11 条单测；`agent-startup.js` / `server.js` / `im-config.js` 接线（`operatorThreadId`）。
- **B 线路模型**：完成。`boundTarget` 替换 `boundSession`；`selectedChannel` 归一并入门户线路（固定 id `portal`）；`resolveLineTransferConflict` 单一互斥；prune 改按线程事实。消费方（agent-discovery / agent-lifecycle / dispatch-engine / im-workspace-bundle / im.js）全部切换。
- **C 线程投影与校验**：完成。`im_routable_targets` 改 `core.listThreads()` 线程投影（剔终态/归档/删除中）；`im_line_transfer` 线程寻址 + 接受性同源校验（`_threadAcceptanceVerdict`），mount/unmount IPC 副作用删除；`im_line_binding` 死端点删除；qqbot `agent.js` 配置读取切新模型（多线路并发留 E）；`im-data-pipelines.test.js` 按新契约更新。
- **D 轮次结果事件**：完成。`turn-event-mapping` 加法式 `resultText`（envelope.result）；`thread-routes` 落板后发布 `thread.turn-*` SSE 帧 + `onTurnTerminalFact` 订阅钩子（DI）；OS 通知出口接入（`observeThreadTurnFact`：completed/failed 投递带线程身份与 200 字交付摘要，cancelled 跳过，轮次级 dedupe；快照路径对线程宿主 finish 让位防双通知）；3 个测试文件 66 用例 + 4 组变异验证。
- **E 门户投递切换与载体退役 / F 联合验收**：未开工（等 A–D 评审）。

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

改动：
- qqbot agent.js：
  - `startSelectedIMGateway` → `startLineGateways`：读 lines（含 portal 线路），逐线路启动载体 gateway（同载体互斥由配置归一保证）。出站状态 `_activeIMChannel`/`_lastIMTarget` 单值 → 按线路 Map（lineId → {carrier, peer}）。
  - 入站分发：gateway 消息回调按载体定位线路 → 解析 boundTarget。目标为 operatorThreadId（接线员线程）→ 门户 CallArbiter（现状路径）；外部线程 → `POST /protoclaw/threads/:threadId/input`（internalAuthHeaders，source=载体 id，sourceRef=**消息级唯一标识**，见幂等键基线）。
  - 出站：`handleIPCMessage` 增 `im-thread-turn` 分支——按 {lineId, resultText, status} 经该线路载体 gateway 发送；截断与错误文案 IM_REPLY_POLICY 从 runtime-im-bridge.js 搬到门户侧。`sendIMMessage` 单值语义并入按线路发送。
- server：新建 im-thread-relay（挂 thread_events 归并发布处）——turn 终态事件 → 匹配 boundTarget.threadId 的线路 → `sendIPCtoSession` 到门户 runtime `{type:'im-thread-turn', lineId, threadId, status, resultText}`。
- 退役：runtime-im-bridge.js 删 `mountCarrierFeature` / `mountIMLineCarrierIfBound` / `dispatchIMCallFinish` 与 mount/unmount-im-carrier IPC 分支（todo-control 保留）；im.js 删对应 IPC 调用与重试；`/protoclaw/im_line_binding` 仅保留前端显示用途。

验收：外部线程绑定线路上发消息，消息入 Thread Inbox 并触发处理（runtime 未起时唤醒）；轮次完成后结果文本回到 IM 对端；接线员线路行为与现状一致；仓库内无 mount-im-carrier 残留引用。

### F. 联合验收（任务 #16）

端到端判据（ADR-0042 里程碑 1）：
1. 一条 IM 消息 → 绑定的外部线程（coder）→ 处理 → 结果文本回到 IM 对端。
2. 接线员对话以线程身份呈现（侧栏、裁剪、接续与 coder 同口径），门户 runtime 重启后接线员线程引用稳定。
3. 目标线程接续窗口（trim/换代中）内到达的 IM 消息经 Inbox 暂存，换头后补投不丢。
4. 相关单测全绿：im-config / im 路由 / turn-event / input-gateway 既有测试按新形状更新，新增接线员线程事务与 relay 测试。

## 实施时确认点（不阻塞开工）

- `board.recordRuntimeEvent` 内部 session→thread 解析的具体挂点（D 片 relay 挂同一处）。
- 各载体消息回调能否拿到消息级唯一 id（QQ msgSeq / weixin msg_id / feishu message_id）；拿不到的载体退化为不传 sourceRef（无幂等键，不误吞）。
- 空 idempotencyKey（''）在 appendCommand 的行为确认（预期跳过幂等匹配）。
- qqbot runtime 启动链里 ensure 接线员线程的准确挂点（与 startManagedAgent 的时序）。

## 明确不做（里程碑 2 界限）

- im-ui.js / im-actions.js 前端重建（切换窗口内线路管理 UI 显示降级，接口形状以本计划为准）。
- 每条线路独立接线员线程、工作群 @mention 路由、IM 线路 UI 直建入口。
