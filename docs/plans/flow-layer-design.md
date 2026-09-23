# Flow 编排层设计备忘录

> 本文档记录 AgentDevClaw 当前 Flow 编排层的产品模型、运行时模型和 UI 约定。
> 截至当前版本，阶段二与阶段三已经落地：可视化编排编辑器、Agent 项目绑定、Feature 能力感知、节点级工具权限、运行时 FlowFeature 集成均已打通。

---

## 一、核心定位

Flow Layer 不是传统工作流引擎，也不是独立于 Agent 存在的 Flow 管理器。它是当前 Agent 项目的一张行为蓝图，用来把用户与 Agent 反复协作形成的长链路套路沉淀为可编辑、可运行、可调试的阶段图。

当前临时产品模型明确采用：

```text
Agent Project = Persona + Enabled Features + One Orchestration Graph + Runtime Sessions
```

也就是说，开发一个 Agent 时，一对一配套唯一一张编排图。不是先创建多张 Flow，再挂到 Agent 上。

这张图允许存在多个连通分量。每个连通分量在运行时被视为一个 Workflow。Agent 进入某个 Workflow，本质上是进入当前 Agent 编排图里的某个连通分量。

---

## 二、对象模型

### 2.1 Agent Project

Agent Project 是用户正在开发和测试的对象。它包含：

- 目标 Agent 名称、目标用户、目标、约束、系统提示词覆盖内容
- 已启用 Features
- 用户运行环境目录
- 唯一配套编排图
- 测试运行会话

当前 `flow-workspace` 的“项目 / 组装 / 编排”三个页面围绕同一个 Agent Project 展开，避免“组装是组装、编排是编排、运行时又是另一套对象”的割裂。

阶段二/三完成后的约束是：UI 上可以切换“项目 / 组装 / 编排”不同视角，但它们都必须读写同一份 Agent Project 状态。任何会影响运行时的字段，例如 `selected_features`、`custom_system_prompt`、`assembly_name`、`env_dir` 和编排图绑定路径，都不能只停留在前端草稿里。

### 2.2 Orchestration Graph

Orchestration Graph 是 Agent Project 的唯一配套编排图，固定保存为：

```text
~/.agentdev/AgentDevClaw/flows/<agentProjectId>/agent-flow-graph.json
```

其中 `<agentProjectId>` 当前取自组装页的 `assembly_name`。

图内字段包括：

- `nodes`：节点
- `edges`：连线
- `workflows`：按连通分量维护的 Workflow 元数据
- `variables`：图级变量
- `viewport`：画布视口状态

### 2.3 Workflow

Workflow 不是外部对象，而是图中的一个连通分量。每个 Workflow 至少包含：

- `id`
- `name`
- `description`
- `mode`: `auto` 或 `agent-initiated`
- `entry`
- `reminderFrequency`
- `variables`

一张图中最多允许一个 Workflow 为 `auto`。其他 Workflow 作为可选能力列表注入给 Agent，由 Agent 按需通过 `enter_flow(flowName)` 进入。

### 2.4 Node

Node 是 Workflow 的阶段上下文。它描述 Agent 在当前阶段应该看到什么、可以用什么、什么时候切换。

当前 Node 支持：

- `prompt`：动态阶段提示词
- `tools.rules`：节点级工具权限规则
- `onEnter`：进入节点时自动执行的动作
- `exitWhen`：基于变量的自动退出条件
- `reminderFrequency`：节点级提醒频率覆盖
- `position`：画布位置
- `workflowId`：所属连通分量元数据归属

---

## 三、Feature 与 Flow 的关系

Feature 回归能力包定位。它可以提供 tools、skills、hooks、MCP、变量、节点模板和渲染模板，但不默认接管主循环。

Flow 编排期必须感知当前 Agent 已启用 Feature 暴露的能力，不能靠用户手动输入名字碰运气匹配。

当前能力解析由服务端接口提供：

```text
GET /protoclaw/flow_capabilities?agentId=flow-workspace
```

接口会根据组装页 `selected_features` 实例化 Feature，并收集：

- Feature 列表
- `getTools()` 暴露的 tools
- `getFlowVariables()` 暴露的变量
- `getFlowNodeTemplates()` 暴露的节点模板

能力清单只来自当前 Agent Project 已启用的 Feature。编辑器不提供“手动输入工具名后碰运气”的主路径；如果后续需要支持高级手写引用，也必须作为诊断明确的高级入口，而不是默认体验。

编辑器保存时保留运行时兼容字段，同时写入结构化引用：

- `toolRef`
- `variableRef`
- `tools.rules[].ref`

这样后续 Feature 缺失、改名或版本不匹配时，编辑器可以明确展示失效引用，而不是静默失败。

---

## 四、节点级工具权限

### 4.1 产品语义

工具权限不是“挂载工具”。Feature 挂载发生在 Agent 组装阶段，工具权限是在某个 Node 中对已挂载 Feature 提供的 tools 进行启用/关闭控制。

当前 UI 语义是：

1. 先点击“添加工具”
2. 在右侧 Inspector 左边展开的 Feature 工具库子面板中选择工具
3. 可以单独添加工具，也可以添加某个 Feature 提供的全部 tools
4. 添加到当前 Node 后，再对每个工具设置“启用”或“关闭”

未添加到当前 Node 的工具不由该 Node 管理，保持进入 Workflow 前的基线状态。

这意味着“添加工具”不是把工具安装到 Agent，也不是给 Agent 新增能力，而是把一个已存在工具纳入当前 Node 的权限管理清单。添加之后再决定启用或关闭，二者是两个动作。

### 4.2 数据结构

```typescript
interface FlowToolRule {
  name: string
  enabled: boolean
  ref?: FlowCapabilityRef
}

interface FlowNode {
  tools?: {
    rules?: FlowToolRule[]
    enable?: string[]        // 旧兼容字段
    refs?: FlowCapabilityRef[]
  }
}
```

旧的 `tools.enable` 仍被运行时兼容读取，但新的编辑器会写入 `tools.rules`。

### 4.3 运行时语义

FlowFeature 在进入 Workflow 时保存 ToolRegistry 的基线状态。每次进入或执行当前 Node 前：

1. 先恢复基线工具状态
2. 再应用当前 Node 的 `tools.rules`
3. `enter_flow`、`complete_node`、`exit_flow` 始终保持可用
4. 退出 Workflow 时恢复基线状态并清空缓存

修复后的关键点：AgentDev 的 ToolRegistry 实际挂在 Agent 的 `tools` 字段上。FlowFeature 现在会从 `ctx.agent.tools` 获取 ToolRegistry，而不是只找不存在的 `getToolRegistry()` 或 `toolRegistry` 字段。

运行时烟测已经验证：节点规则可以让 `web_fetch` 关闭，同时保持 `safe_trash_delete` 和 Flow 自身工具可用。因此当前结论是 AgentDev 框架支持工具启停，之前不生效是 FlowFeature 获取 ToolRegistry 的集成问题。

---

## 五、onEnter 与 exitWhen

### 5.1 onEnter

onEnter 表示进入 Node 时由 FlowFeature 自动执行的动作，不是 Agent 自主调用 tool。

当前实现仍以 `tool-call` 作为兼容通道，但 UI 文案按产品语义展示为“函数调用”。后续应演进为 Feature 显式暴露的 workflow functions，而不是复用 Agent tools。

支持动作：

- 函数调用：进入节点后由代码自动调用
- 变量赋值：写入 Workflow 自定义变量

### 5.2 exitWhen

exitWhen 绑定 Feature 暴露变量或 Workflow 自定义变量。FlowFeature 在每步 `@StepStart` 检查条件，满足则自动切换到下一个节点。

Agent 不需要知道自动切换发生了什么。它只是正常工作；工具或函数改变变量后，FlowFeature 检测条件满足并推进阶段。

---

## 六、运行时机制

Flow 层由本地 Feature `FlowFeature` 承载，不修改 AgentDev 主循环。

核心机制：

- `@CallStart`
  - 缓存 Agent 引用和 ToolRegistry
  - 收集 Feature 暴露变量
  - 自动激活 auto Workflow
  - 注入当前 Flow 状态
- `@StepStart`
  - 处理 pending transition
  - 检查 exitWhen
  - 执行 onEnter
  - 按提醒频率注入 Node prompt
  - 应用节点工具权限
- `getTools()`
  - `enter_flow`
  - `complete_node`
  - `exit_flow`
- `captureState()` / `restoreState()`
  - 保存当前活跃 Workflow、当前 Node、节点历史、工具基线等状态

FlowFeature 不是执行引擎。每个阶段内仍由 Agent 自主推理和调用可见工具。

---

## 七、图形编辑器产品形态

图形编辑器必须独立于 `index.html` 实现。目前已拆分为：

```text
public/flow-editor.js
public/flow-editor.css
```

`index.html` 只保留 `flow-editor` block 的薄适配层。

当前编辑器要求：

- 画布铺满“编排”页面中央核心内容区
- 页面本身不产生上下滚动
- 支持画布平移、滚轮缩放、适配视图
- 支持创建、删除、拖拽节点
- 支持从节点右侧 `+` 连接柄拖动创建连线
- 左侧悬浮面板展示 Workflow 连通分量列表和能力概览
- 右侧悬浮 Inspector 默认显示 Node，可切换 Workflow
- 工具库以 Inspector 左侧子面板展开，参考 Dify 的侧向面板体验，避免所有内容挤在右侧
- 工具权限面板只展示当前 Node 已添加的工具；完整工具库通过侧向子面板打开、搜索和批量选择

---

## 八、当前已完成状态

### 阶段一：已完成

- FlowFeature 运行时核心
- Flow 类型定义
- `enter_flow` / `complete_node` / `exit_flow`
- 节点 prompt 注入
- Feature 变量读取
- exitWhen 自动切换
- Flow 状态持久化

### 阶段二：已完成

- 独立 `flow-workspace`
- Agent Project / 组装 / 编排 UI 基础模型
- 独立文件实现可视化流程图编辑器
- 单图多连通分量 Workflow
- 画布平移、缩放、拖拽节点、拖线连接
- 可关闭悬浮面板
- Node / Workflow 分离 Inspector

### 阶段三：已完成

- 组装页 Feature 选择写入运行时
- 装配运行环境安装所选 Feature
- Runtime 挂载所选 Feature
- 装配系统提示词生效
- Flow graph 保存与运行时读取
- 连通分量转换为 FlowFeature flows
- Feature capabilities API
- 工具权限从 Feature tools 中选择
- 节点级工具启用/关闭规则真实生效
- 装配运行环境会按当前 Feature 选择刷新依赖，避免 UI 显示启用但运行时包未安装

---

## 九、后续方向

下一阶段应聚焦阶段四：编辑器体验增强和调试可视性。

优先事项：

- 节点模板库
- 变量选择器和 prompt 中 `/` 插入
- 失效引用提示
- Workflow 列表注入的可视化预览
- 当前运行节点高亮
- 工具权限变更日志
- onEnter 从 tool-call 兼容通道迁移到 workflow function 声明
- 保存前能力引用校验：工具、变量、函数、Feature 包缺失都应在编辑器中显式报出

---

## 十、已知边界

- 当前只有一个活跃 Workflow。
- 并行节点暂不支持真实并发。
- onEnter 的函数调用语义尚未完全独立于 Agent tools。
- ToolRegistry disable 主要影响下一次 LLM 调用可见工具列表；如果模型已经在同一步返回了某个 tool_call，ToolExecutor 仍可能执行该调用。
- Feature 内部状态是否可回滚，取决于 Feature 自身是否实现 `captureState()` / `restoreState()`。
