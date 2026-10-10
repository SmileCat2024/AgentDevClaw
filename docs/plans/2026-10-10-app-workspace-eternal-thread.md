# 实施计划：APP 型工作空间——业务单对话、可选线程连续性与单流投影（ADR-0024）

日期：2026-10-10
状态：未实施
关联：[ADR-0024](../adr/0024-app-workspace-eternal-thread-model.md)（状态：提议中）
范围：线程输入与唤醒契约（含框架 command 身份槽位）、thread 事件源、线程流契约与前端流视图——全部为通用线程消费能力，不含 APP 产品语义。第一个 APP（日程工作空间）的业务实现——对话业务状态、启动恢复、接续变换、metadata/ui 声明与端到端验收——不在本计划，随其工作空间首张工单实施。

改动主体在 Claw 仓库；PR-1 含一个 AgentDev 框架仓库改动（WorkThread command 契约），独立 PR、先行合入。

## 0. 总原则

1. **单对话是 APP 业务状态，不新增框架宿主模式**：不在 WorkThread / metadata identities 中引入 `singleton` 模式或 ThreadHostRegistry；APP 以自己的持久化引用选定活动对话（qqbot receptionistSessionId 同构），随 APP 工单实施。未接入的通用路径行为不变。
2. **每个 PR 独立可验收、可 revert**：输入契约、事件、前端视图三类改动不混一个 PR。
3. **不新增平行机制**：APP 关联线程时复用既有接力事务与输入网关；换头重绑不走导航事务；接续变换在框架接续协议（ADR-0002）内选择或新写，宿主不预设具体变换。
4. **产品语义住 APP feature**：接续变换形态、对话业务状态、业务词汇全部住 APP；本计划交付的机制不出现任何"日程 / 提醒"词汇。

## 1. 现状基准（2026-10-10 读码核证）

### 1.1 宿主判定与消费点

- `server/thread-control/host-agents.js`：`THREAD_HOST_AGENT_IDS = {'programming-helper'}`、`THREAD_HOST_SESSION_TYPES = {'coder'}` 两个常量 + `isThreadHostSession()`。消费点仅两处（`thread-integration.onSessionCreated`、`input-gateway._resolveThreadRoute`）+ 测试。agent 子进程无引用（注释中的"子进程同源"是历史设计考量，当前无此消费方）。
- `metadata.json` 的 `identities[]` 已声明 sessionType / sidebarEntry / operations / ui；`server/routes/agent-discovery.js` 扫描 `prebuilt-agents/**/metadata.json`（discoverAgents），`collectSidebarIdentityEntries` 展开侧栏身份条目。**声明面已存在，供 APP 工单的 identity/ui 声明使用；本计划不为其增加 thread 维度。**
- `server/feature-runtime/install-service.js` / `server/routes/feature-store.js`：main/coder 双 scope 常量硬编码（`agentId + sessionType` 组合）。

### 1.2 接力与输入链路（APP 关联线程后直接复用，零改动预期）

- 接力事务：`thread-rotation.js`（context guard 事件入口）→ `beginSessionSuccession`（挡板）→ `compactAndResumeCurrentSession`（policy 固定 `strategy: 'trim-transcript'` + `appendSummary: true`）→ `thread-succession.commitSuccession`（READY 门禁 + advanceHead + 补投递）。
- 摘要/变换装配：`server/context-continuity/trim-appended-summary.js` 裸 `new` 框架变换，调用链 `compactAndResumeCurrentSession → exportHandoff(appendSummary) → runTrimTranscriptWithSummary` 全链无参数。APP 新写接续变换与装配点参数化属 APP 工单，本计划不改。
- 输入网关：`input-gateway.deliverUserInput` 按 viewerAgentId 反查 runtime → `isThreadHostSession` 闸门 → head 直投 / Inbox 暂存 / 终态拒绝。`kind: 'reminder'` 在线程域显式拒绝（`turn_kind_unsupported`）：`appendCommand` 的 `kind` 是指令分类，turn 身份（user / reminder）未入契约，bridge 投递只能以用户消息落地。
- 线程 API：`/protoclaw/threads`（列表 + contentHash 条件刷新）、`/:id/commands`、`/:id/head`、`/:id/deliver`、归档 / 删除 / 关闭。

### 1.3 前端投影与数据通道

- coder 投影：`coder-threads-ui.js`（行 = 线程，openHead → `jumpToThreadHead` → `open_session` 完整导航事务）；`thread-store.js`（20s 轮询 + contentHash、会话徽标、`resolveThreadInputRoute` 输入守卫、接力分隔条）。
- 消息通道：per-runtime probe/tail（ADR-0013），probe 随 overview 响应；换绑数据源 = 对新 runtime 全量重建基线（rewrite 分支既有）。
- 打开会话：`workspace-actions.js` open_session 链（pending navigation、sidebar operation、缓存交接、乐观绑定、requestSwitch）——流视图换头**不进**这条链。
- SSE：`server/routes/sse-events.js` 全部 `${kind}:${agentId}`（viewerAgentId）寻址；发布为模块私有 `publish`。
- Block 分发：`app-ui.js` 类型 if 链；未知类型返回空串。

## 2. 改造切片

### PR-1 线程输入入口 + command 身份槽位（含框架 PR）

框架仓库（AgentDev，先行合入 + build）：

- `packages/core` WorkThread command 契约：command 携带 turn 身份（建议复用 / 扩展 `kind` 枚举：`'user_message' | 'reminder'`），`appendCommand` 校验透传；投递 bridge（Claw 侧 `delivery` 桥接实现处）将 turn 身份随 `submitTurn` 原样转发（submitTurn 已支持 `kind: 'reminder'` 落地为带 source 的 system 消息）。守卫：身份缺失默认 `user_message`（存量记录兼容）。

Claw 仓库：

- `input-gateway.js`：删除 `turn_kind_unsupported` 拒绝分支，`kind` 透传进 `appendCommand`。词汇映射在网关处显式归一：gateway 输入 `kind`（`'user' | 'reminder'`）映射为 command `kind`（`'user_message' | 'reminder'`），缺失/未知值归一为 `user_message`；`appendCommand` 调用点（`input-gateway.js` 现硬编码 `'user_message'` 处）即为适配点。
- 新入口 `POST /protoclaw/threads/:threadId/input`（`thread-routes.js` 或 input-gateway 路由挂载处）：threadId → head runtime（`resolveSessionViewerId`）→ `deliverUserInput`。返回形状沿用 gateway（`delivery: 'delivered' | 'queued' | 'input' | 'thread_queued'` + head 事实）。head runtime 未运行时先经 `ensureHeadRuntime` 唤起（与 commands 端点同语义）。
- 测试：gateway 线程域 reminder 入箱 → bridge 投递落地 system 消息（stub）；交接窗口内输入暂存、advance 后补投（既有用例扩展）。

验收：`kind: 'reminder'` 经线程入口在直投 / 暂存两条路径下身份不丢失；`turn_kind_unsupported` 错误码删除（grep 零残留）。

### PR-2 thread 事件源（SSE）

改动：

- `server/routes/sse-events.js`：导出模块级 `publishThreadEvent(threadId, payload)` 内部入口（不进 worker 事件总线——线程事件的事实源在 server 侧事务，不在 ViewerWorker 会话事件）；SSE 订阅端增加 `thread` 事件名，按 threadId 路由到已订阅连接。订阅过滤为本 PR 新增的服务端 `?threads=<id1,id2>` 参数——现状服务端只有 lastEventId，agent 过滤在前端本地分发，不存在可复用的服务端过滤。事件名最小集：`thread.created` / `thread.head-advanced` / `thread.archived` / `thread.deleted`；发布时机为对应事务落定后（head-advanced 在 advanceHead 与补投递完成后）。
- 发布点全部挂通用线程事务：线程创建落定；`thread-integration.applySessionSuccession` head 推进后；`thread-lifecycle` 归档 / `thread-delete` 删除事务落定。APP bootstrap 若创建线程，自然经过通用创建事务，不设 APP 专属发布点。事件携带 threadId 与对应的权威状态事实，不带派生视图数据。重启恢复不能重复发布为新建事件。
- 前端 `public/src/modules/sse-client.js`：thread 事件订阅 API（供 PR-3 流视图消费）。

验收：接力完成 → SSE 订阅端在 100ms 内收到 `thread.head-advanced`；无订阅者时发布零开销（no-op 安全）。

### PR-3 服务端线程流契约与前端流视图（依赖 PR-1 / PR-2）

改动：

- **开工首步 spike**：以现有官方变换（trim+summary）的真实 handoff 产物为样本，验证协议持久事实（handoff 包、seed 落盘结构）足以切分源消息与 seed 边界。若现有产物缺少落盘事实（如 seed 边界 marker 缺失），将边界事实落盘升级为接续协议层的落盘要求（对 APP 新写变换同样约束），不回退为消息内容启发式切分。
- 服务端新增线程流读取接口：按 threadId 读取一次一致的 `sessionChain` 快照，为每棒返回稳定棒次、session 标识、原始消息基线与 handoff/seed 关联事实；读取期间 head 变化时返回一致快照版本或显式冲突，不能混合新旧链。契约锚定接续协议持久事实，不绑定任何具体变换的产物形态；不依赖摘要文本相似度去重。契约定稿必须包含两点：其一，successor 创建时在 successor metadata / handoff 包落盘显式 seed 边界 marker（seed 消息数与注入位置），流读取按持久 marker 切分，不按数组位置推导；其二，head 棒快照基线与既有 probe 全量数组（含 seed 重放）的对齐规则——probe 增量以快照消息游标续接，seed 段不重复计入基线。
- 新模块 `public/src/modules/thread-stream.js`：流视图状态与渲染。
  - 视图状态（滚动、草稿、焦点）挂 APP 对话键下（模块局部作用域，遵守 app-core 全局状态纪律）；
  - 数据源绑定：以线程流接口的有序快照建立基线；当前 head 的新增内容仍经既有 probe/tail 增量通道接入，head 变化则获取新一致快照后 rewrite。
  - 换头发现：SSE `thread.head-advanced`（即时）+ contentHash 轮询签名变化（兜底）双触发，去抖合并；
  - 发送：`POST /protoclaw/threads/:threadId/input`，永不计算目标 session / viewer id；`resolveThreadInputRoute` 在流视图模式不消费；
  - rotation_failed 呈现：一条可恢复错误状态条（复用 thread-store failed 事实），不呈现接力过程；
  - `thread_queued`（交接窗口暂存）呈现"已发送、等待送达"占位，不静默吞输入；
  - 输入增强（capabilityActivations / pills / 语音）复用既有 composer，仅替换提交目标。
- `app-ui.js`：block 分发新增 `thread-stream`；APP 入口由该 workspace 的 ui 声明提供。
- `thread-store.js`：提供线程链数据到流视图的映射；APP 业务对话引用到 threadId 的映射属 APP 工单接入。
- 侧栏：APP 投影提供稳定业务对话 ID 与当前 session/runtime；换 successor 时侧栏条目不换位。若关联 WorkThread，可将 threadId 用作 APP 内映射值，但不规定为通用 singleton 宿主契约。ADR-0010 高亮谓词与空值守卫纪律不变。
- 功能裁剪：由 APP 声明可用 UI 操作，不以通用 thread mode 决定 trim / compact / branch / checkpoint / rollback / 归档 / 删除入口。

验收：以现有官方变换的真实 successor 产物验证线程流投影：源消息顺序保持，工具活动与摘要按契约呈现，无 seed 重复，接力前后增量无丢失/重放；若不能证明完整性，接口必须返回不完整而非伪装连续。另验证接力窗口发送抵达新 head、SSE 断连后轮询恢复、滚动与草稿保持、侧栏条目不换位。

## 3. 依赖与顺序

```text
PR-1 输入入口 + 框架契约 ──┬──→ PR-3 线程流契约 + 流视图（首步真实产物 spike）
PR-2 thread 事件源 ────────┘
```

PR-1（框架契约部分）与 PR-2 相互独立，可并行；PR-3 的首步 spike（真实产物切分验证）亦可并行先行，实现依赖 PR-1 / PR-2。PR-1 框架改动需 AgentDev build + Claw 服务重启生效。

## 4. 测试策略

- 服务端：`test/thread-*.test.js` 扩展（gateway reminder 透传、SSE thread 事件、线程流读取契约）；inline 复刻的 server 逻辑（如有）随实现同步。
- 服务端线程流：用真实 source session snapshot、handoff package 与 successor seed fixture 验证链排序、seed 来源边界、消息稳定标识、读取竞态与不完整状态；测试数据不得仅用手写理想化消息数组。
- 前端：thread-stream 的纯函数（rebind 去抖、状态键控、菜单派生）入 `test/frontend-*.test.js` 风格用例；以服务端真实投影输出驱动侧栏和流视图往返测试。
- 时长预算遵守既有约束（单文件 < 1.5s）；涉及真实子进程生命周期的用例归入 feature-runtime 类慢文件预算。

## 5. 明确不做

- 第一个 APP（日程工作空间）的全部产品实现——对话业务状态与启动恢复、接续变换、存储 schema、定时语义、通知渠道与业务 UI——随其工作空间首张工单实施。
- 通用会话创建 sessionType 白名单扩展（`server/routes/session.js` 现硬编码 `['main','coder']`）等独立通用化改动。
- 消息 SSE 数据通道（ADR-0024 不做清单；SSE 仅发现 thread/head 状态变化）。
- 工作空间删除 / 数据清除 UI。
- ADR-0014 导航事务收编（流视图换头是数据源重绑，非导航）。
