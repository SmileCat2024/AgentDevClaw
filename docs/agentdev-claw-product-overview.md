# AgentDev + Claw 产品全貌介绍

> 本文面向希望理解 AgentDev 框架与 Claw 产品形态的读者。
> 当前产品已经进入 Flow 编排阶段：阶段二与阶段三已落地，Claw 不再只是 Agent/Feature 表单，而是开始具备 Agent 项目、组装、编排、运行测试的一体化工作空间。

---

## 一、核心判断

AI Agent 的下一阶段，不只是更聪明的聊天框，也不是传统工作流工具的简单 AI 化。

真实用户在长期使用 Agent 完成复杂工作时，会形成一些稳定但不完全死板的协作套路：

- 哪些阶段要先做
- 哪些工具只能在某个阶段使用
- 哪些信息要反复提醒
- 哪些变量或状态决定是否进入下一步
- 哪些能力来自不同 Feature

AgentDev + Claw 的产品判断是：

> 把用户与 Agent 反复协作出来的长链路工作套路，沉淀成可编辑、可配置、可运行、可调试的 Agent 行为图，同时保留 Agent 在每个阶段内的自主推理能力。

这不是 Dify / n8n 式固定工作流，也不是纯 prompt/skill 文本，而更接近：

```text
Unity Editor for Agents
```

在这个类比里：

- Agent Project 是正在开发的场景对象
- Feature 是可挂载组件
- Orchestration Graph 是该 Agent 一对一配套的行为蓝图
- Workflow 是图中的一个连通分量
- Node 是阶段上下文
- Tool / Skill / Hook / MCP 是 Feature 暴露的能力
- Variable 是组件属性与运行时数据
- Inspector 是属性编辑器
- Debugger 是运行时解释器

---

## 二、AgentDev 的作用

AgentDev 是底层 Agent 开发框架，提供：

- Agent 运行时
- ReAct 循环
- ToolRegistry
- Feature 组件系统
- Skill 系统
- Hook 生命周期
- MCP 集成
- 会话持久化
- rollback
- ViewerWorker 调试器
- Feature 打包与分发机制

Feature 可以把某类能力封装成可安装、可分发、可复用的组件。

但 Feature 的自由度很高，复杂 Feature 往往同时处理 tools、skills、hooks、状态、模板、MCP 和调试器契约。Claw 的目标就是把复杂行为编排从 Feature 代码中抽出来，变成可视化、可检查、可运行的数据。

---

## 三、Claw 当前要解决的问题

Claw 当前聚焦三个层次。

### 3.1 能力组件化

用户通过 Feature 获得能力，例如：

- shell 操作
- web search
- 语音反馈
- 审查
- 记忆
- QQBot
- 企业 API
- 内部知识库

### 3.2 Agent 项目化

用户不是在编辑一堆松散表单，而是在开发一个 Agent Project。

当前 `flow-workspace` 已把“项目 / 组装 / 编排”统一到同一个对象上：

- 项目页：管理已创建和已运行的 Agent 项目
- 组装页：设置目标、系统提示词、Feature、运行环境
- 编排页：编辑该 Agent 唯一配套的编排图

阶段二/三完成后，Claw 的关键变化是：这些页面不再只是视觉上的三个入口，而是同一个 Agent Project 的不同编辑面。组装页启用的 Feature、配置的提示词和运行环境，会直接影响编排页能力清单与装配运行时。

### 3.3 行为图形化

每个 Agent Project 拥有一张 Orchestration Graph。图中允许多个连通分量，每个连通分量是一个 Workflow。

这些 Workflow 像 Skills 一样作为可进入的工作模式注入给 Agent；进入后，FlowFeature 动态管理当前阶段 prompt、工具权限、变量条件和节点转换。

---

## 四、核心对象

### Agent Project

Agent Project 是当前工作空间中的主对象，包含：

- 名称
- 目标用户
- 目标与限制
- 自定义系统提示词覆盖
- 已启用 Features
- 运行环境目录
- 唯一配套编排图
- 测试运行会话

当前运行时已经能真实读取组装页配置：所选 Feature、系统提示词、目标、约束和编排图都会进入装配 Agent。

如果运行环境已经存在但缺少当前选择的 Feature 包，启动装配实例前会按 `selected_features` 刷新依赖，避免出现“UI 已启用、运行时没挂上”的状态。

### Feature

Feature 是能力包，可以提供：

- tools
- MCP
- skills
- hooks
- runtime variables
- flow node templates
- render templates
- settings schema

Feature 不应默认接管 Agent 主循环。它贡献能力，Flow 组织行为。

### Orchestration Graph

Orchestration Graph 是 Agent Project 的唯一行为蓝图。

存储位置：

```text
~/.agentdev/AgentDevClaw/flows/<agentProjectId>/agent-flow-graph.json
```

它不是独立 Flow 集合，也不是后挂到 Agent 上的资源。

### Workflow

Workflow 是图中的连通分量。一个图可以有多个 Workflow：

- 一个可设为 `auto`
- 多个可设为 `agent-initiated`

Agent 进入 Workflow，实际是进入图中的某个连通分量。

### Node

Node 是阶段上下文，可以包含：

- prompt
- reminder frequency
- tool permission rules
- onEnter 函数调用
- exitWhen 条件
- Feature / Workflow 变量引用

Node 可以来自 Feature 模板，也可以由用户手动创建。模板只是初始值，导入后就是用户数据。

### Inspector

当前已实现 Node / Workflow 分离的 Inspector：

- 默认显示 Node
- 可切换到当前 Node 所在 Workflow
- 不把两者塞在同一个长表单里

工具权限不再直接在右侧塞满所有工具，而是：

- 右侧显示当前 Node 已添加工具
- 点击“添加工具”后，在 Inspector 左侧展开 Feature 工具库子面板
- 可按 Feature 分组选择工具，或添加某 Feature 的全部工具
- 添加后再设置每个工具启用或关闭

这个交互区分了两个概念：Feature 是否挂载由组装页决定；Node 工具权限只决定当前阶段是否显式启用或关闭某个已存在工具。

---

## 五、当前 Flow 编排运行方式

当前 Agent 运行结构：

```text
Agent = Persona + Enabled Features + FlowFeature + Orchestration Graph
```

启动装配 Agent 时：

1. 读取 `flow-workspace` 的 `assembly-form`
2. 根据 `selected_features` 创建或刷新运行环境依赖
3. 实例化并挂载所选 Feature
4. 生成或应用系统提示词
5. 读取当前 Agent 的 `agent-flow-graph.json`
6. 将图中的连通分量转换为 FlowFeature flows
7. 挂载 FlowFeature
8. 进入对话调试

FlowFeature 在运行时：

- `@CallStart`：收集变量、激活 auto Workflow、注入状态
- `@StepStart`：处理节点转换、注入节点 prompt、应用工具权限
- tools：提供 `enter_flow`、`complete_node`、`exit_flow`
- state：通过 Feature snapshot 保存和恢复 Flow 状态

工具权限已经验证为真实影响 AgentDev `ToolRegistry`。当前实现会从 Agent 的 `tools` 字段获取注册表，进入节点时先恢复 Workflow 进入前的基线状态，再应用 Node 规则。

---

## 六、工具权限的产品语义

工具权限不是 Feature 挂载。Feature 挂载在组装阶段完成。

工具权限是在某个 Node 中对已挂载 Feature 提供的 tools 做阶段性启用/关闭。

当前语义：

- 未添加到 Node 的工具保持进入 Workflow 前的基线状态
- 已添加到 Node 的工具可以设置启用或关闭
- 每次应用 Node 权限前，先恢复基线状态，再应用当前 Node 规则
- Flow 自身工具始终保持可用

这保证不同节点的权限不会相互污染。

---

## 七、为什么不是传统低代码工作流

传统工作流里，图是执行真相，节点决定系统下一步做什么。

Claw 的 Flow Graph 是 Agent 行为场景：

- 它告诉 Agent 当前阶段目标
- 它限制当前阶段可见工具
- 它提供动态上下文
- 它定义阶段退出条件
- 但阶段内部仍由 Agent 自主推理和行动

这使 Claw 更适合“有套路但不完全确定”的工作，例如编程、审查、研究、发布检查、企业内部流程和个人知识工作流。

---

## 八、当前完成度

### 阶段一：已完成

- FlowFeature 运行时
- Flow 类型
- 节点 prompt 注入
- 手动节点推进
- exitWhen 自动推进
- Flow 状态持久化

### 阶段二：已完成

- 独立 `flow-workspace`
- Agent Project 概念在 UI 中落地
- 组装、项目管理、编排页面协同
- 独立文件实现可视化流程图编辑器
- 单图多连通分量 Workflow
- 画布平移、缩放、拖拽、连线
- 悬浮面板与 Node / Workflow Inspector

### 阶段三：已完成

- 组装页配置真实进入运行时
- 所选 Feature 真实挂载
- 运行环境依赖按所选 Feature 刷新
- 系统提示词生效
- 编排图运行时读取并拆分为 Workflow
- Feature capabilities API
- 工具权限从 Feature tools 中选择
- 节点级工具启用/关闭规则真实影响 ToolRegistry
- 工具选择 UI 已从右侧长列表改为 Inspector 左侧展开的 Feature 工具库子面板

---

## 九、下一阶段

下一阶段是阶段四：编辑器体验增强与调试可视化。

重点包括：

- Feature 节点模板库
- 变量选择器
- prompt 中 `/` 插入变量
- 失效引用提示
- onEnter workflow function 正式化
- 当前运行节点高亮
- 工具权限变更日志
- exitWhen 判断可视化
- onEnter 执行结果展示
- Feature / Tool / Variable / Function 引用失效诊断

---

## 十、长期图景

长期看，AgentDev + Claw 可以成为一个 Agent 应用开发与运行平台。

开发者用 AgentDev 构建 Feature。

高级用户用 FeatureCreator 创建能力组件。

普通用户在 AgentCreator / Flow Workspace 中描述自己的工作方式、组装 Agent、编辑行为图、测试运行。

企业可以沉淀自己的 Feature 仓库：

- 内部服务
- 工程规范
- 审查策略
- 发布流程
- 数据权限
- 知识库
- 本地工具

最终，Claw 承载的不是孤立 Agent，而是一套可组合、可配置、可调试、可演化的 Agent 行为系统。
