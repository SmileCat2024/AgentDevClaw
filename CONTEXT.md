# AgentDevClaw

以 Agent 为中心的可扩展工作台（产品壳层）与 AgentDev 框架的共享运行时协议术语。
本文件只收本上下文特有的概念，不收通用编程概念。

## Language

### 工具执行协议

**工具终止（tool termination）**:
工具执行的三个正常终局之一（正常完成 / 超时终止 / 用户打断），是结果的一部分而非异常。
细分 reason：`timeout`（到达超时上限）与 `user`（用户主动打断）。
_Avoid_: 中断（在超时语境下与"打断"混义；"中断"仅指用户打断动作）

**部分输出（partial output）**:
工具被终止时已积累、并随结果正常返回的输出。与"丢弃"相对——终止永不吞掉已发生的事。

**settle 窗口（settle window）**:
终止信号发出后，执行器为当前工具调用建立的唯一收尾预算（当前为 1s）；工具通过绝对截止时间
把 kill、排空管道和部分输出整理纳入同一预算，超窗才降级。

**进度信号（progress signal）**:
工具执行中面向人的节流 UI 状态（已运行时长、超时上限、尾部输出），走通知系统，
永不进入对话上下文。与审计事件（不节流、记录终态）相对。

**超时契约（timeout contract）**:
工具在定义处声明的 `{ defaultMs, maxMs, fromArg? }`；执行器统一计时，
到限经 AbortSignal 通知工具，工具自决优雅终止。未声明的工具不受框架超时管辖。

### 本地资源与请求协议

**逻辑 Agent（logical agent）**:
可被产品发现、配置和展示的稳定 Agent / 工作空间身份。它不是某次进程运行实例，也不是页面焦点。

**工作会话（session）**:
逻辑 Agent 下可持久化、可恢复的对话与工作状态身份。Session 的归属由显式 `agentId` 与 `sessionId` 表达，不由页面焦点推导。

**运行时实例（runtime instance）**:
ViewerWorker 中一次实际运行的 Agent 实例，由动态 `runtimeId` 标识。runtimeId 可因重启变化，不能作为逻辑 Agent 的稳定产品身份。

**页面焦点（UI focus）**:
某个页面当前正在展示的 Agent 身份。页面焦点只控制展示和本地 UI 恢复，不是服务端全局状态、请求默认目标或执行归属。

**Runtime-scoped 操作**:
直接读取或控制某个 Agent/Session/Runtime 的操作，例如消息、工具、Todo、输入请求、输入提交和中止。必须使用显式资源身份。

**Host-scoped 操作**:
作用于宿主配置、目录、进程、调度或全局资源的操作，例如模型配置、workspace state、Feature 配置和项目管理。没有明确宿主目标时，只表示当前本地宿主，不能从页面焦点猜测。

**显式资源寻址（explicit resource targeting）**:
请求通过 `agentId`、`sessionId`、`runtimeId` 等真实资源字段确定目标；缺少必要字段时显式失败，不通过焦点、列表位置、名称或 parentId 静默 fallback。

**操作关联元数据（operation metadata）**:
用于跨 UI、宿主服务和运行时关联一次请求的 `operationId`、`requestId`、`sourceRef` 和 `idempotencyKey`。这些字段分别表达界面操作、协议请求、外部来源和可安全重放的写操作键，不互相替代。

**结果未知（operation result unknown）**:
请求可能已经在执行端生效，但响应在返回前丢失的状态。结果未知不能显示为成功，也不能在没有幂等键的情况下自动重放。
