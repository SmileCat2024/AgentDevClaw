# Session Continuity as Transformation：会话接续的框架化原则

AgentDev 框架以 **Session 为第一等单位**；会话接续被定义为对 Session 施加一次
**变换（Transformation）**，产出下一个 Session 的种子（SuccessorSeed）。
**变换是绝对自由的扩展点**：trim、summary、trim&summary 混合只是框架提供的
**官方参考实现**，宿主可整体替换为任意自定义变换。这是框架与其他家
（compaction 内建固定策略）的根本区别：接续本身是协议，策略只是插件。

第三个核心概念 **WorkThread** 是框架层对「Session + 接续变换」的封装：把一串
先后接力的 Session 认定为同一项工作的连续性锚点（sessionChain / head /
交接挡板 / 指令暂存 Inbox），由宿主显式 opt-in 创建，不强制于纯会话场景。

## Considered Options

- **内建固定 compaction 策略（他家路线，rejected）**：框架锁定策略，宿主无法
  替换；与"接续是协议"的定位直接冲突。
- **变换作为 Feature（rejected）**：变换发生在 runtime 之外（读源会话快照、
  可能驱动 successor 创建），Feature 生命周期绑定 runtime，runtime 停止即消失
  ——与 work-thread-design.md 已论证的「Thread 不能是 Feature」同理。
- **宽边界全程事务作为核心契约（rejected for core）**：`transform(session) →
  new session` 全程编排强依赖宿主形态（Claw 托管 runtime vs 未来其他宿主），
  锁定为唯一路径违背"绝对自由"；编排以**可替换的框架默认实现**提供
  （grill Q1=C 两层结构）。
- **WorkThread 合一承载执行调度语义（rejected）**：连续性锚点语义已实战稳定，
  执行调度看板（idle/running/waiting_input/failed 状态机、executionEvents、
  resume）昨天刚经历 ticket→thread-only 推翻重构、仍在演化；变化速率不同的
  两层焊死在一个框架契约里，每次产品层演化都是框架 breaking change
  （grill Q4=C 拆分决策）。

## Consequences

- 框架**首次定义宿主进程级、比 Runtime 生命周期长的服务端对象**
  （WorkThread 及其持久化 store）。这是架构边界的实质扩张：此前框架内
  长寿对象只有 ViewerWorker/DebugHub。下游宿主（Claw）通过 import 使用，
  不再各自实现 successor 切换与指令迁移。
- 命名两义并存且被显式接受：codex exec 事件流的 `thread.started`
  （thread = 会话本身，对外 jsonl 审计契约）保持原样；框架接续链概念定名
  **WorkThread**，一词不混用。
- 官方变换实现从 Claw 下沉框架后，Claw 的 mirror 摘要子进程管线降级为
  宿主实现细节；摘要变换的 LLM 基座在框架层为进程内注入
  （`transformContext.llm`），不再要求"起一个完整 agent"的重基座。
- Session 一等公民化按分阶段推进：本批只做变换所需的**契约级**消费面
  （快照契约），列表/分支/归档等会话管理仍留宿主；对象级上收为远期方向，
  变换接口设计不依赖 Claw 私有概念，不堵死该路径（grill Q2=C）。

（来源：2026-08-21 grill 会话第二轮，决策记录见
[docs/tickets/README.md](../tickets/README.md) 批次 2；上游调研为上下文接续协议
与 thread 设计的耦合点评估，见同批次引言）
