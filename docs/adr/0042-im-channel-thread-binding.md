# ADR 0042: IM 渠道线程化与平台连接归门户

日期：2026-11-05
状态：Proposed（未实施；实施计划另行立项）

## 背景与问题

qqbot 诞生在线程概念之前。IM 线路的绑定、投递、回复建立在 sessionId 之上，与线程化的会话模型错位。问题有四处（2026-11-05 代码实测）。

1. 绑定键是会话。`im-workspace.config.json` 的 `lines[].boundSession` 记 `{agentId, sessionId}`。`im_line_transfer` 绑定前校验目标 runtime 存活，否则 409（server/routes/im.js）。目标会话精简、接续或归档后 runtime 换代，渠道连接随进程消失，绑定悬空。
2. 可绑目标过窄。`im_routable_targets` 只列有 project adapter 的 APP 加 work-group 特判，而 adapter 只注册了 programming-helper 和 qqbot（server/routes/dispatch.js）。coder 线程今天不可绑。
3. 平台连接活在目标会话 runtime 里。线路模式下 server 经 IPC `mount-im-carrier` 把渠道 feature 挂进目标 runtime，平台连接、收消息、回消息都发生在目标进程内（scripts/runtime-im-bridge.js）。线程换头窗口内连接断开，消息没有暂存。
4. 服务端观察不到轮次结果。turn 终态事件只在 runtime 进程内的 turn-event-bus 流动（scripts/run-prebuilt-agent.js），服务端线程事件只覆盖生命周期事实（thread.created / head-advanced 等，server/routes/sse-events.js）。线程侧执行完，门户接不到回复。

线程侧的投递入口已预留：input-gateway 头注写明"当 IM 线路绑定指向线程宿主时，应在 IM 的目标会话解析处改调本入口"，`deliverThreadInput` 已服务 ACP。

## 决策

### 1. 绑定键：Thread 寻址

- `lines[].boundSession` 替换为 `boundTarget: { agentId, threadId }`，全部线路统一线程寻址：外部线路绑定目标工作空间的线程，门户渠道线路绑定接线员线程（决策 5）。不需要 portal 特殊分支——qqbot 线程化后接线员也是线程，两种线路只剩绑定目标不同。
- 可绑目标 = 非终态、非归档、非删除中的线程，判定与 input-gateway 的接受性判定同源。绑定不再要求目标 runtime 存活：消息到达时线程 Inbox 兜底，runtime 未起时由既有投递触发点补投。
- `im_routable_targets` 改为线程投影（threads 全局库派生）。project adapter 路径对该接口退役。

### 2. 平台连接归门户

- 所有线路的渠道 gateway 由 qqbot 门户 runtime 持有，不再向目标 runtime 挂载体。门户从"单活跃渠道"改为"多线路并发连接"，出站状态按线路记录（线路到最近对端），替换现有单值 `_activeIMChannel` / `_lastIMTarget`。
- `selectedChannel` 并入线路模型：门户渠道即一条绑定接线员线程的线路。三方互斥的门户分支（resolvePortalChannelConflict）随合并消失。
- `mount-im-carrier` / `unmount-im-carrier` IPC、mountCarrierFeature、mountIMLineCarrierIfBound 退役。

### 3. 入站：线程寻址投递

- 门户收到消息后按线路解析 boundTarget。目标为接线员线程（门户 runtime 自持）时走门户自身 CallArbiter，行为与现状一致；目标为外部线程时调 input-gateway 的 `deliverThreadInput`（入 Thread Inbox，接续窗口暂存，head 就绪补投）。
- 串行化的位置从目标 runtime 的 CallArbiter 移到线程域：同一线程的并发消息由 Inbox 顺序投递，与调度、前端输入共用同一套行政检查。

### 4. 出站：轮次结果事件回流

- runtime 宿主把 turn-event-bus 的终态事件经内部认证 HTTP 上报 server（与 internalAuthHeaders 模式同型）。
- server 按线程归并，发布线程轮次事件（扩展现有线程事件面，只报告事实，不触发行为）。
- 门户经既有 server 到 runtime 的 IPC 接收绑定线程的轮次事件，把结果经平台连接出站。截断与错误文案沿用 IM_REPLY_POLICY，搬到门户实现。非 IM 来源的轮次结果镜像（现 dispatchIMCallFinish 语义）随载体退役一并迁到这条出站路径。

### 5. qqbot 自身线程化（接线员唯一线程）

- qqbot 声明 `threadHost: true`（ADR-0024 声明化机制：宿主启动按发现注册进派生集合，公共代码不硬编码 APP ID）。
- 接线员采用业务单对话模型，与 memo 同构（ADR-0024）：唯一接线员线程承接连续对话，新建换代归档；门户首个消息或用户首次打开会话时 ensure 创建，引用经 threads 全局库持久化。
- 线程宿主通用裁剪随之生效（slash /trim /summary 与精简页归档勾选按线程事实隐藏/钳制），侧栏与接续呈现同 coder、编程小助手。
- 每条线路独立接线员线程仍是另立决策的范畴，本 ADR 不做。

### 6. 存量处置：清空，不迁移

- 线路绑定是运行态事实，不是需要保护的持久状态：现有 bundle 加载已会清理失效绑定。切换时清空全部 `boundSession` 与 `selectedChannel`，用户按新模型重新接线。零兼容分支，零换算脚本。
- 既有接线员会话随换代归档，只读保留，不换算线程身份。

### 7. 分两步实施，形态一次锁死

1. 两个线程化与通路切换是一个里程碑，联合交付、联合验收：qqbot 线程化（threadHost、接线员唯一线程、宿主裁剪）、绑定线程化（boundTarget、门户渠道并入线路、routable targets 线程投影、存量清空）、轮次结果上报与门户出站、载体挂载退役。验收判据即核心业务闭环：一条 IM 消息进入绑定线程处理，结果回到 IM；接线员对话以线程身份呈现、可接续。轮次上报是通用线程事件能力，落地时须落实非 IM 订阅者（auto-title、OS 通知）。
2. qqbot 界面重建。im-ui.js / im-actions.js 随新模型重写（前端插件化规划已定不收编，随工程消亡）。

里程碑内部可按上述括号切片提交，但不得引入目标形态之外的过渡机制（如"载体随线程头重挂"、"换头即断线"产品妥协）——切换窗口内绑定功能宁可整体停用并显式提示，不冻结半套模型。

## 不做清单（显式边界）

- 不做"载体随线程头重挂"的过渡机制。它在通路切换完成后整体作废，属一次性兼容态，违反 [ADR-0025](0025-coder-workspace-promotion.md) 的"抽象必须做减法"纪律。
- 不改 CallArbiter 的串行语义，只改串行化的位置。
- 不做工作群 @mention 路由改造。群聊侧已有 identityRef / lineage 投影，属工作群工程。
- 不做 IM 线路绑定的 UI 直建入口，维持接线员工具与配置面。
- 不迁移、不识别存量绑定。

## 后果

**正面**：绑定与 runtime 存活解耦。接续窗口消息经 Inbox 暂存不丢。coder 线程可绑。平台连接跨换头稳定。selectedChannel 与 lines 两套概念合一，绑定目标全库统一为线程一种寻址。qqbot 会话模型与其他线程宿主同构，侧栏、接续、裁剪不再特判。

**代价**：改动横跨门户 runtime、server 路由、宿主上报三处，且首个里程碑同时含形态与通路，交付窗口长。存在破坏性切换窗口（连接重建、接线员会话换代）。im-ui / im-actions 约 1345 行重写。

**风险与失效条件**：门户 runtime 成为线路单点，启动恢复（现 mountIMLineCarrierIfBound 的"启动时按配置重连"语义）改由门户自持。切换窗口内绑定功能停用，须显式提示而不是半套模型错乱。turn 上报通道若只服务 IM，建成即闲置，落地时须落实至少一个非 IM 订阅者，或显式记录二期待用面。出站事件丢失时消息有去无回，门户按线路对端做最小重试或显式失败提示。

## 关联

- [ADR-0024](0024-app-workspace-eternal-thread-model.md) / [ADR-0025](0025-coder-workspace-promotion.md) / [ADR-0032](0032-programming-helper-thread-driven.md)：线程宿主声明与 OS 到 APP 对象模型。
- [ADR-0018](0018-feature-panel-communication-transport.md)：feature-comms 通道。本 ADR 的轮次事件是线程级服务端事实，不经 feature-comms。
- server/thread-control/input-gateway.js 头注：决策 3 的预留接线点。
- [前端插件化规划](../plans/2026-11-04-frontend-plugin-architecture.md)：qqbot 前端随本工程重做。
