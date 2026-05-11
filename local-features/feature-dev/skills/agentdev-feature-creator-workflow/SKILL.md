---
name: agentdev-feature-creator-workflow
description: Feature Creator 的上层工作流编排技能。用于先判断用户当前要的是理解、分析、设计、实现、打包还是接入，再决定是否需要调用 agentdev-feature-guide、agentdev-usage、agentdev-feature-packaging。只要任务与 AgentDev Feature 的创建、修改、接入、打包、定位、工作空间推进有关，就优先使用此 skill。
---

# AgentDev Feature Creator Workflow

这个 skill 不替代已有的 `agentdev-feature-guide`、`agentdev-usage`、`agentdev-feature-packaging`，而是负责先判断任务类型，再调度它们。

## 先做什么

收到与 Feature 相关的请求后，先判断当前任务属于哪一类：

1. `理解 / 澄清`
2. `分析 / 方案`
3. `实现 / 修改`
4. `打包 / 模板 / 产物`
5. `接入 / Agent 挂载 / Runtime / Session`

先给出这个判断，再决定是否调用下层 skill。

## 默认响应协议

### 如果用户明确说“先不要实操 / 先分析 / 先讨论 / 先计划”

- 不要先跑命令
- 不要先读目录
- 不要先改代码
- 先用文字说明：
  - 你对需求的理解
  - 你认为它在 AgentDev 里属于什么
  - 你计划怎么做
  - 风险和取舍

只有用户明确允许，或者意图明显已经进入实现阶段，才开始工具操作。

另外，工作台里注入的 Feature 名称、目标、限制等内容，本质上是用户填写的需求草稿，不一定严谨。先整理和校准，再把它们当作实现输入。

### 如果用户只是问候或做轻量确认

- 简短回应
- 不要立刻展开冗长说明
- 不要为了显得积极而提前执行 skill 或命令
- 默认用更通俗、更亲和的语言回复
- 只有当用户自己明显使用专业术语并要求更细时，再同步提高专业度

### 如果用户的问题本质上是在问“这到底是不是一个 Feature / Feature 是干什么的”

先直接回答：

- Feature 是 Agent 的能力扩展，不是独立 Agent，也不是独立 daemon
- 它通常通过工具、上下文注入、生命周期钩子、渲染模板、状态快照等方式增强 Agent

然后再决定是否调用 `agentdev-feature-guide` 补实现细节。

## skill 调度规则

### `agentdev-feature-guide`

在这些情况下优先调用：

- 判断某个需求是否应该做成 Feature
- 决定用 `getTools`、`getAsyncTools`、`CallStart`、`onInitiate`、`captureState`
- 设计 Feature 的最小结构
- 调试 Feature 行为与模板契约

### `agentdev-usage`

在这些情况下调用：

- Feature 要如何挂到 Agent 上
- Agent / Session / Runtime / Debugger / ViewerWorker 怎么接
- 与预制 agent、工作空间、会话恢复有关

### `agentdev-feature-packaging`

在这些情况下调用：

- 涉及独立 npm Feature 包
- 涉及 tsup、模板产物、tgz、模板 404、dist 结构

## 分析时的输出顺序

分析模式下，默认按这个顺序回答：

1. 先说明你认为这件事在 AgentDev 里属于什么
2. 再说明正确的扩展点
3. 再给最小可落地方案
4. 最后再列风险、边界和下一步

不要一上来就展开目录结构、依赖清单、包名设计，除非用户已经在问实现。

如果已经进入规划阶段，优先读取相关 skills 的正文内容，再开始细化方案。

## 实现时的输出顺序

进入实现模式后，默认按这个顺序：

1. 先确认最小实现范围
2. 再读必要代码
3. 再动手改
4. 最后验证

不要为了“显得全面”一次性读取大量无关文件。

## Feature Creator 特殊约束

你运行在 `Feature 创建者` 工作空间里时，还要额外记住：

- 首轮上下文中已经有用户之前填写的 Feature 名称、目标、限制、目录
- `process.cwd()` 就是当前 Feature 开发目录
- 默认围绕当前目录工作，而不是围绕 Claw 项目根目录随意发散

## 何时不用这个 skill

如果用户只是在问一个非常窄的、显然属于某个下层 skill 的问题，也可以直接调用那个 skill，例如：

- “这个模板 404 为什么” -> 可直接走 `agentdev-feature-packaging`
- “这个 capability 该不该做成 Feature” -> 可直接走 `agentdev-feature-guide`

但只要任务明显是“推进 Feature 创建工作”，优先先走本 workflow skill。
