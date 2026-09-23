# AgentDev + Claw 产品总览

> 本文面向希望理解 AgentDev 框架与 Claw 产品形态的读者。
> 修改代码请从 [AGENT.md](../../AGENT.md)（agent 认知地图）进入；本文讲产品是什么、为什么、往哪去。

## 一、核心判断

AI Agent 的下一阶段，不只是更聪明的聊天框，也不是传统工作流工具的简单 AI 化。

真实用户在长期使用 Agent 完成复杂工作时，会形成稳定但不完全死板的协作套路：哪些阶段要先做、哪些信息要反复提醒、哪些能力来自不同组件。AgentDev + Claw 的产品判断是：

> 把用户与 Agent 反复协作出来的工作套路，沉淀成可组装、可配置、可调试、可演化的 Agent 体系，同时保留 Agent 在每个任务内的自主推理能力。

AgentDev（框架）提供 Agent 运行时、Feature 组件系统、Skill、Hook 生命周期、MCP 集成、会话持久化与调试器。Claw（产品）把这套能力组织成实际可用的多 Agent 工作台。

## 二、产品形态：以 Agent 为中心的可扩展工作台

Claw 不是单聊天窗口，而是托管多个预制 Agent 的工作台。每个 Agent 是一个工作空间，有自己的会话、工具链与交互面。

当前活跃维护的工作空间：

| 工作空间 | 定位 |
|---|---|
| **编程小助手**（programming-helper） | 对标 Claude Code 的 AI 编程 Agent：Shell / LSP / Web / MCP 工具链，会话分支、精简、checkpoint，浏览器可视化交互层；另含 coder 身份（无人值守自主编码，经线程调度） |
| **Agent Studio**（agent-studio） | 上游制造端：对话中开发 Feature、装配 Agent，经隔离 Test Runtime 验证后打成不可变包进入 Feature 仓库 |
| **IM 渠道**（qqbot） | 多渠道消息门户代理与路由（QQ / 微信 / 企业微信 / 飞书等），线路到工作空间会话的动态转接 |
| **工作群**（work-group，Beta） | 群聊形式指挥与协调多 Agent |

支撑形态（非工作空间）：

- **`claw` CLI / plain agent** — 不建工作空间的轻量调用：可组合装配、无头审计（jsonl 事件流）
- **ACP 适配层** — 独立 stdio 进程，把外部编辑器（如 Zed）的 ACP 协议转接到 coder 线程

## 三、核心概念

### Agent 与 Feature

- **Agent**：自主推理与行动的执行体。运行时 = 系统提示词 + 所装配的 Feature + 会话上下文。
- **Feature**：能力包，可提供 tools、MCP、skills、hooks、运行时状态、渲染模板、配置 schema。框架与生态以 npm 包形式分发（`@agentdevjs/*`），Claw 侧另有本地 feature 与用户自建 feature 仓库。
- **预制 agent**（prebuilt agent）：Claw 开箱即用的 Agent 装配（入口 `prebuilt-agents/official/<agent-id>/agent.js`），清单以各 `metadata.json` 为准。

### 制造 → 消费链路

上游 Agent Studio 制造 Feature 与 Agent，下游 `claw` CLI、plain agent、Studio 调试模式共同消费。"Studio 验证过的装配 = 消费端运行的装配"由共享的解析链保证（schema 校验 → catalog → resolver → provisioner → loader），Feature 快照打成不可变 tgz 进入官方或用户仓库。

### 会话连续性

会话不是线性聊天记录，而是可变换的对象：分支（从指定节点开新会话）、Trim（裁剪早期历史）、Compact（压缩为摘要）、checkpoint / rollback。线程（WorkThread）承载跨会话的任务连续性。详见 [ADR-0002](../adr/0002-session-continuity-as-transformation.md)。

### 能力控制面

Feature 经 `getCapabilities()` 声明能力，统一注册到 Capability Registry；用户经 slash 命令以结构化激活的方式使用能力，激活随消息流动、可跨会话交接。详见 [ADR-0007](../adr/0007-capability-registry-as-control-plane.md)。

## 四、演进历史

Claw 经历过一次大的形态收敛：

- **早期**：Feature 表单 + Agent 装配工作空间（feature-creator、agent-creator）。
- **Flow 编排阶段**：以 Agent Project / Orchestration Graph 为中心的可视化编排（"Unity Editor for Agents"）。设计全貌见 [Flow 编排层设计备忘录](../plans/flow-layer-design.md) 系列。
- **dsh 冲击后的战略改造**（2026-08）：对撞车竞品的差异化研判驱动了大刀阔斧的重构，收敛到当前"以 Agent 为中心的可扩展工作台"形态。战略全文见 [ADV 对 DSH 的差异化战略](../plans/adv-vs-dsh-strategy-2026.md)。

Flow 编排、feature-creator、agent-creator 等工作空间的代码保留但已悬置，不再积极迭代；当时的完整设计文档在 `plans/` 留档。

## 五、长期图景

长期看，AgentDev + Claw 可以成为一个 Agent 应用开发与运行平台：

- 开发者用 AgentDev 构建 Feature
- 高级用户在 Agent Studio 中开发能力组件、装配 Agent
- 普通用户在工作空间中与预制 Agent 协作，经 IM 渠道接入日常沟通流
- 企业可以沉淀自己的 Feature 仓库：内部服务、工程规范、审查策略、发布流程、数据权限、知识库

最终，Claw 承载的不是孤立 Agent，而是一套可组合、可配置、可调试、可演化的 Agent 行为系统。
