# Flow 编排层实施计划

> 本文档是 `flow-layer-design.md` 的实施进度与后续计划。
> 当前版本已经完成阶段二和阶段三，下一步进入阶段四。

---

## 总体策略

Flow 编排层采用“Agent Project 一对一配套唯一编排图”的产品模型。

当前核心路径已经打通：

```text
组装页选择 Feature
  -> 创建/刷新运行环境依赖
  -> 编排页读取 Feature 能力清单
  -> 编辑单图多连通分量 Workflow
  -> 保存 agent-flow-graph.json
  -> 启动装配 Agent
  -> 运行时挂载所选 Feature + FlowFeature
  -> FlowFeature 根据图执行阶段提示、节点切换和工具权限
```

不再把 Flow 当成独立资源挂到 Agent 上。Workflow 是编排图内的连通分量。

阶段二和阶段三的完成口径不是“页面能展示”或“表单能填写”，而是从组装配置、运行环境依赖、能力发现、图编辑、保存、启动实例到运行时执行的闭环全部真实生效。

---

## 阶段一：FlowFeature 运行时核心

**状态：已完成。**

### 已交付

- `local-features/flow/src/types.ts`
  - `FlowGraph`
  - `FlowNode`
  - `FlowEdge`
  - `ExitCondition`
  - `AutoAction`
  - `FlowCapabilityRef`
  - `FlowToolRule`
- `local-features/flow/src/index.ts`
  - `FlowFeature`
  - `@CallStart`
  - `@StepStart`
  - `enter_flow`
  - `complete_node`
  - `exit_flow`
  - prompt 注入
  - exitWhen 自动切换
  - 工具权限控制
  - 状态持久化
- `getFlowVariables()` 与 `getFlowNodeTemplates()` 的编排能力接口已进入使用链路。

### 当前运行时语义

FlowFeature 不替代 AgentDev 的 ReAct 主循环。它只在 Call / Step 生命周期中调整上下文、节点状态和工具可见性。

工具权限已经从旧的白名单语义演进为节点级规则：

```typescript
tools: {
  rules: [
    { name: 'web_fetch', enabled: false, ref: { source: 'feature', packageName: '@agentdev/websearch-feature', name: 'web_fetch' } },
    { name: 'safe_trash_list', enabled: true, ref: { source: 'feature', packageName: '@agentdev/shell-feature', name: 'safe_trash_list' } }
  ]
}
```

运行时进入节点时先恢复进入 Workflow 前的工具基线，再应用当前节点规则。

---

## 阶段二：带可视化编排能力的 Workspace

**状态：已完成。**

### 已交付

- 新增独立 workspace：

```text
prebuilt-agents/official/flow-workspace/
```

- `flow-workspace` 包含：
  - 项目页
  - 组装页
  - 编排页
  - 装配运行时 Agent

- 编排编辑器拆分到独立文件：

```text
public/flow-editor.js
public/flow-editor.css
```

`public/index.html` 只保留 block 分发适配，不再承载主要编辑器实现。

### UI 已实现

- “编排”页不再显示额外“编排工作流”标题栏。
- 画布铺满中央核心内容区。
- 页面不产生上下滚动。
- 支持画布拖拽平移、滚轮缩放、适配视图。
- 支持创建节点、删除节点、拖拽节点。
- 支持从节点右侧 `+` 连接柄拖线到其他节点。
- 左侧悬浮面板展示图中 Workflow 连通分量。
- 右侧 Inspector 可关闭，默认 Node，可切换 Workflow。
- Node 与 Workflow 属性不再混在同一长表单中。
- 工具库不直接挤在右侧 Inspector；点击“添加工具”后以左侧子面板展开。

### 数据已实现

编排图固定保存为：

```text
~/.agentdev/AgentDevClaw/flows/<agentProjectId>/agent-flow-graph.json
```

其中 `<agentProjectId>` 当前来自 `assembly_name`。

服务端 API：

```text
GET    /protoclaw/flow_graphs?agentId=...
GET    /protoclaw/flow_graph/:flowId?agentId=...
POST   /protoclaw/flow_graph
PUT    /protoclaw/flow_graph/:flowId
DELETE /protoclaw/flow_graph/:flowId
```

---

## 阶段三：Feature 能力感知与运行时闭环

**状态：已完成。**

### 3.1 组装配置真实生效

已修复装配页表单“看似填写但运行时无效”的问题。

现在装配运行时会读取：

- `assembly_name`
- `target_user`
- `goal`
- `constraints`
- `custom_system_prompt`
- `selected_features`
- 当前 Agent 配套编排图

运行时会：

- 挂载用户选择的 Feature
- 注入装配系统提示词
- 挂载 FlowFeature
- 将编排图连通分量转换为 FlowFeature flows

### 3.2 运行环境依赖刷新

已修复“环境 ready 但没有安装所选 Feature”的问题。

当前逻辑：

- 创建环境时按 `selected_features` 安装 Feature 包
- 启动装配实例前再次按当前 `selected_features` 刷新依赖
- 前端记录 `env_configured_features`
- 如果已配置 Feature 与当前选择不一致，环境标记为 stale

### 3.3 Feature 能力清单 API

已新增：

```text
GET /protoclaw/flow_capabilities?agentId=flow-workspace
```

返回：

- `features`
- `tools`
- `variables`
- `nodeTemplates`

编辑器不再要求用户手动输入工具名或变量名。

当前能力清单服务既用于编辑器 UI，也用于运行时一致性诊断。后续如果 Feature 包缺失、工具改名或变量消失，应在这个层面优先给出明确提示。

### 3.4 工具权限 UI

已按最新设计调整。

当前流程：

1. 在 Node Inspector 中点击“添加工具”
2. Inspector 左侧展开 Feature 工具库子面板
3. 工具库按 Feature 分组
4. 支持搜索
5. 支持单个添加工具
6. 支持添加某个 Feature 的全部 tools
7. 添加后回到 Node 中设置每个工具“启用 / 关闭”

这参考了 Dify 编排面板的侧向子面板体验，避免所有内容挤在右侧属性面板。

当前保存数据写入 `tools.rules`。旧的 `tools.enable` 仍作为兼容读取路径存在，但不再是新 UI 的主写入格式。

### 3.5 工具权限运行时修复

已确认问题不在 AgentDev 框架核心，而在 FlowFeature 取 ToolRegistry 的方式。

修复前：

```typescript
agent.getToolRegistry?.()
agent.toolRegistry
```

修复后兼容：

```typescript
agent.getToolRegistry?.()
agent.toolRegistry
agent.tools
```

AgentDev 的 `ToolRegistry.enable()` / `disable()` / `getAll()` 本身可正常工作。修复后节点级工具权限已通过烟测：

```json
{
  "web_fetch": false,
  "safe_trash_delete": true,
  "enter_flow": true,
  "complete_node": true,
  "exit_flow": true
}
```

因此阶段三的结论是：工具权限问题不是 AgentDev 框架能力缺失，而是 FlowFeature 与 ToolRegistry 的集成字段错误。当前修复已覆盖 `agent.tools`。

---

## 当前验证清单

已执行并通过：

```text
node --check public\flow-editor.js
node --check server.js
node --check prebuilt-agents\official\flow-workspace\agent.js
npm run build:local-features
```

手动验证：

- 选中 Feature 后运行环境能安装包
- 装配 Agent 能挂载所选 Feature
- 装配系统提示词生效
- 动态阶段 prompt 生效
- 工具权限规则能影响 ToolRegistry
- 旧环境缺少 Feature 包时，启动前刷新依赖可以自愈
- 工具库 UI 支持单工具添加、按 Feature 添加全部、添加后再启用/关闭

---

## 阶段四：编辑器体验增强

**状态：下一阶段。**

目标是在阶段二/三的可运行闭环上增强编辑效率、可解释性和调试体验。

### 4.1 节点模板库

- 展示 Feature 提供的 `getFlowNodeTemplates()`
- 支持拖入节点模板
- 模板导入后成为静态快照
- 显示模板来源 Feature

### 4.2 变量选择器

- Prompt 中支持 `/` 或 `{{` 触发变量选择
- 变量按来源分组：
  - Feature variables
  - Workflow variables
  - Graph variables
- 失效变量引用显示警告

### 4.3 onEnter 函数调用正式化

当前 onEnter UI 已使用“函数调用”语义，但底层仍兼容 `tool-call`。

阶段四应增加 Feature 显式 workflow function 声明，例如：

```typescript
getFlowFunctions?(): FlowFunction[]
```

onEnter 应从 functions 中选择，而不是复用 Agent tools。

### 4.4 调试叠加

- 当前活跃 Workflow 高亮
- 当前 Node 高亮
- 节点切换历史
- 工具权限变更日志
- exitWhen 判断结果
- onEnter 执行结果

### 4.5 引用失效诊断

- Feature 未安装
- Tool 不存在
- Variable 不存在
- Function 不存在
- Feature 版本不匹配

编辑器应在保存前或加载时明确提示，而不是让运行时静默失败。

阶段四不再优先补“能跑通”的基础链路，而是补“能解释、能发现问题、能高效编辑”的体验层。阶段二/三已经解决运行闭环，阶段四要避免用户再靠猜测判断当前 Agent 到底挂了什么、运行到哪、为什么某个工具不可用。

---

## 阶段五：运行时调试视图

**状态：后续阶段。**

阶段五聚焦 ViewerWorker / Debugger 的深度集成。

可能交付：

- Flow 状态 IPC
- 图上实时高亮
- 节点日志聚合
- 边走过次数
- 变量快照
- 工具可见性快照
- 回滚后 Flow 状态对比

---

## 不在当前阶段范围内

- 多活跃 Workflow
- 并行节点真实并发
- Subflow / Workflow 嵌套
- AgentCreator 自动生成复杂 Flow
- Feature 默认编排片段的完整打包规范
- 跨 session 的独立 Flow 进度

---

## 风险与注意事项

| 风险 | 当前处理 |
| --- | --- |
| Feature 包未安装但 UI 显示已启用 | 启动前刷新依赖，记录 `env_configured_features` |
| 用户手动输入工具名导致失效 | 编辑器改为从 capabilities API 选择 |
| 工具权限污染后续节点 | 每个节点应用前恢复基线 |
| `index.html` 继续膨胀 | Flow 编辑器保持独立 JS/CSS |
| onEnter 与 Agent tools 语义混淆 | UI 已改“函数调用”，后续阶段拆成 workflow functions |
| 旧装配环境 ready 但未安装 Feature | 启动实例前强制刷新依赖 |
