# ADR 0018: Feature-Panel 通信基座（feature-comms 通道）

日期：2026-09-23
状态：已接受

## 背景与问题

前端面板与运行时 Feature 之间缺少一条**定向、实时、按会话隔离**的通信链路：

- 生成式 UI（generative-ui）是请求-响应模型：面板是 Feature 主动推的产物快照，没有持续更新。
- 监控类面板只能轮询全局接口（inspector snapshot、logs），粒度是整个 runtime，无法订阅单个 Feature 的进程内状态。
- Feature 内的实时状态（首个动因：shell-feature `BgRegistry` 的后台任务登记表）只能靠 agent 主动调 `bg_status` 才进入对话上下文，浏览器侧不可见。
- 全局事件流 `/protoclaw/events` 是广播：任何面板订阅它都要为不相关会话的事件付费，且无法做按通道的授权。

需求侧共识（来源会话的系列裁决）：面板需要的是"订阅某会话某 feature 的状态投影 + 偶发定向请求"，而不是通用消息总线。

## 决策

### 1. 四元组逻辑通道，无全局主题

通道由 `(agentId, sessionId, featureId, channelId)` 四元组寻址。没有全局主题、没有跨通道订阅、没有通配符——面板要什么就精确订阅什么。通道不持久化：server 重启后通道为空，由 Feature 重新 declare 重建。

### 2. 快照 + 有界增量，不承诺可靠投递

每通道维护一个快照（带 revision）与一条有界事件缓冲（默认 256 条）。订阅经 SSE `Last-Event-ID` 续接；游标越界（缓冲已丢弃）时下发 `resync` + 全量快照。**状态真相始终在 Feature**：通道是尽力而为的投影面，消费端以请求面（见决策 5）兜底对齐。这排除了把通道当持久队列用的可能——需要可靠投递的场景走轮询或请求面。

### 3. 上行/下行信任边界分离

- **上行**（`declare` / `publish`，Feature → server）：仅 internal auth（runtime 进程身份），且校验目标 runtime 存活（404 `runtime_not_found`）。用户浏览器永远无法直接发布。
- **下行**（`stream` / `snapshot` / `events` / `request`，浏览器 → server）：仅用户会话 auth。EventSource 同源携带 cookie，无需额外令牌传递。

### 4. 授权 = 声明制（declare as authorization record）

通道必须先由**活 runtime 上的 Feature** 经 internal auth 声明，才可发布、可订阅、可请求。声明即宿主侧授权记录：它证明"该会话该 feature 正在运行并愿意暴露该通道"。未声明通道：读端点 404 `channel_not_declared`，发布拒绝。

声明的生命周期绑定 runtime：

- 进程退出（`run-prebuilt-agent.js` exit 处理）与共享进程的单会话摘除（`agent-lifecycle.js` `removeSharedSession`）都会 `closeSession`：清声明、清通道数据、向订阅者推 `closed` 终态并断开。订阅端因此天然感知会话终结，不会挂着死通道。
- 挂起中的面板请求在 closeSession 时被拒绝（`channel_closed`），不留悬空 Promise。

### 5. 面板→Feature 定向请求：onHostRequest

`POST /request` → server 经 runtime IPC（`feature-comms-request`，带 `__targetSessionId` 精确投递）→ Feature 实例的 `onHostRequest(requestType, payload, meta)` 方法 → 结果经 IPC 回流。要点：

- `onHostRequest` 是 **Claw 宿主层钩子约定**（duck-typing：`typeof feature.onHostRequest === 'function'`），不在框架 `AgentFeature` 接口中；生态包实现它没有框架类型可依——这是已知的跨仓契约缺口，待沉淀进框架。
- 无跨会话 fallback：runtime 不在（退出/摘除）直接 `runtime_not_connected`，不猜目标。
- 请求是低频控制面（list / status / kill 这类），不是数据面；高频状态消费走事件流。

### 6. 独立端点，不混入全局事件流

通道订阅走专用 `/protoclaw/feature-comms/stream`，不进 `/protoclaw/events`。全局流保持"宿主级事件"语义，通道流是"会话内 feature 投影"语义，两者的授权模型与生命周期都不同。

### 7. 首个接入：后台任务实时面板（打样）

端到端链路，作为通道能力的活体验证：

- **框架侧**（`AgentDev/packages/shell-feature`）：`BgRegistry` 新增 `observer` 配置（六类事件：registered / output / report / ready / finalized / tuned；output 按 1s 节流，终态不节流）+ `ShellFeature.getBgRegistry()` 访问器。
- **镜像 Feature**（`local-features/feature-wrappers/src/panel-shell-feature.ts` 的 `PanelShellFeature`，继承 `ShellFeature` 的增强子类，装配处整体替换原版——同 `ControlledTodoFeature` 模式）：构造即声明 `shell-bg` 通道（featureId=`shell`，即 feature name——IPC 分发按它在 runtime 内查实例）；观察事件投影为 `publishEvent(kind, BgTaskSnapshot)`；`onHostRequest` 提供 `list` / `status`（含输出尾部）/ `kill`（graceful 透传，且恒为用户发起——`manual: true` 让引擎终止后补发"用户手动打断"通知：发起方不是模型，模型需要知情；工具路径 `bg_control` 的 kill 不通知，发起方已从工具结果收到回执）/ `report`（手动触发 `BgRegistry.reportNow`——与节拍/静默同款汇报与双节奏重置）。发布失败静默——`bg_status` 仍是任务状态真值。
- **消费面板**（`public/src/modules/bg-panel.js`）：右侧 rail "后台任务"面板，SSE 订阅渲染任务列表，输出查看与终止走请求面；会话切换守卫自动重订，面板取消激活自动拆订阅。
- **装配**（`programming-helper/agent.js`）：单一挂载 `new PanelShellFeature({ workspaceDir, ...runtimeIdentity })`，`bgObserver` 由子类自持并经 `super()` 注入，不再旁挂第二个 feature。

## 备选方案（rejected）

- **广播进 `/protoclaw/events` 全局流**：跨会话信息进入所有订阅者，授权模型无处安放；面板为不相关事件付费。
- **WebSocket 双向通道**：现有需求是"订阅 + 低频请求"，SSE 下行 + HTTP POST 上行已覆盖，避免引入新长连接生命周期与重连状态机。
- **跨 feature 进程内总线**：进程内协作已有 CapabilityRegistry（ADR-0007）；本通道解决的是跨进程边界（runtime 进程 → 浏览器）的投影，不重复造进程内总线。
- **bind / reactive / watch-state 式状态订阅**：ADR-0007 负面清单同款理由——共享权威状态上移宿主或留在 Feature，通道只传事件与快照，不做状态绑定。

## 不变量

- 通道数据是尽力而为镜像；任务/业务状态真值永远在 Feature 自身。
- 上行端点永不接受用户会话认证；下行端点永不接受 internal-only 混用。
- 无跨会话 fallback：寻址不命中（runtime 不在、通道未声明）一律显式失败。
- 通道随 runtime 生命周期开合：进程退出、会话摘除 → `closeSession` → `closed` 终态送达订阅者。
- 有界缓冲：事件缓冲超限丢最旧并触发消费端 resync，不做无限积压。

## 后果

正面：面板获得按会话隔离的实时投影面与定向请求面；授权模型闭环（声明制 + 信任边界分离）；首个真实接入让通道不再是空转基座。

代价与已知缺口：

- 通道数据是 server 进程内存态，无 TTL / 总量上限——慢泄漏面记账在案（生产观察项）。
- `onHostRequest` 尚未进框架 `AgentFeature` 接口，生态 feature 包实现它缺类型与文档（见决策 5）。
- 消费端目前仅 `bg-panel`；generative-ui 等既有面板仍走原链路，迁移按需逐个进行（本 ADR 不强制）。

## 实现索引

| 层 | 位置 |
|---|---|
| store（通道状态机） | `server/feature-communication-store.js` |
| 路由（declare/publish/stream/snapshot/events/request/channels） | `server/routes/feature-communication.js` |
| Feature 侧 client | `local-features/shared/src/feature-communication.ts`（`FeatureCommunicationClient`） |
| runtime IPC（onHostRequest 分发 + 进程退出清理） | `scripts/run-prebuilt-agent.js` |
| 共享会话摘除清理 | `server/agent-lifecycle.js`（`removeSharedSession`） |
| 首个接入 feature | `local-features/feature-wrappers/src/panel-shell-feature.ts`（`PanelShellFeature`） |
| 首个消费面板 | `public/src/modules/bg-panel.js`（注册于 `app-ui.js`，接线于 `modules/debug-panel-host.js`） |
| 框架观察面 | `AgentDev/packages/shell-feature/src/bg-core.ts`（observer）+ `src/index.ts`（`bgObserver` / `getBgRegistry`） |
