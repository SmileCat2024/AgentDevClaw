# Flow × Feature 双层控制面设计与执行计划

> 本文档用于定义 AgentDev 框架与 AgentDevClaw 产品在下一阶段的联合调整方案。
> 核心目标是：降低 Feature 开发理解成本，同时保留 Flow 编排端足够的控制力。

---

## 一、问题定义

当前 AgentDev + Claw 已经具备：

- Feature 提供 `tools`、`hooks`、`variables`、`nodeTemplates`
- Claw `flow-workspace` 可编辑编排图
- FlowFeature 在运行时负责：
  - 节点 prompt 注入
  - 节点级工具权限控制
  - onEnter 自动动作
  - exitWhen 条件切换

这条链路已经跑通，但仍存在一个根本性问题：

```text
Feature 开发者仍然需要理解 ReAct 循环、反向 hooks、ToolRegistry、节点切换和工具可见性，
才能把一个“业务能力”正确映射到框架运行时。
```

这导致两个后果：

1. Feature 开发心智成本过高
2. 用户在 Flow 侧看到的仍然偏底层，例如 tools、hook side effects、进入动作，而不是更直觉的业务状态

典型痛点不是“有没有能力”，而是：

- 一个 Feature 内部存在多个业务状态
- 不同状态下 hook 行为不同
- 不同状态下工具权限不同
- 某些状态切换时要自动执行动作

如果这些都要求 Feature 开发者自己内部消化，那么 Flow 只是把一部分复杂性挪给用户，但没有真正降低 Feature 开发成本。

---

## 二、目标

本次调整目标不是取消 Flow 的控制能力，而是重组控制权层级。

### 2.1 主要目标

- 让 Feature 开发者以“业务状态”而不是“hook 拓扑”暴露能力
- 为框架提供统一的 Feature 配置契约（Manifest）
- 让 Flow 用户先使用直觉化的 Feature mode 编排
- 保留高级用户对底层工具权限的细粒度 override 能力
- 让 Feature 抽象与用户 override 之间的关系明确、可诊断、可解释

### 2.2 一句话总结

```text
Flow 中提供两套心智：
默认层是 Feature mode 编排；
高级层是显式展开后才出现的细粒度 override / 设置。
```

---

## 三、最终产品判断

最终方案不采用二选一：

- 不是“只暴露 Feature mode，彻底取消底层控制”
- 也不是“继续默认让用户直接操作工具权限和内部控制项”

而是采用双层控制面：

### 第一层：Feature Mode

这是默认主路径。

用户在节点中看到的是：

- 某个 Feature 的模式
- 某个 Feature 的变量引用
- 某个 Feature 预先整理好的提示词片段

例如：

- `自动审查`
- `静默记录`
- `严格门禁`
- `人工确认后继续`

用户编排的是“业务语义状态”，不是 hooks。

### 第二层：高级设置

这是展开后才出现的高级控制面。

当前已实现并可直接复用的，就是：

- 节点级工具权限 `tools.rules`

当前阶段高级层不继续扩展新的 override 类型，只承接这一项。

这意味着：

- 普通用户默认不需要碰底层
- 高级用户依然保留控制权
- Feature 作者的语义封装不会被默认路径打穿

---

## 四、设计原则

### 4.1 Feature 对外暴露业务语义，不暴露实现拓扑

Feature 不应主要向 Flow 暴露：

- “该开哪个 hook”
- “该关哪个 hook”
- “该执行哪个内部工具”

Feature 应主要向 Flow 暴露：

- 当前有哪些可理解的业务模式
- 这些模式分别代表什么
- 哪些变量可被 Flow 用于条件判断和显示
- 哪些提示词片段可直接插入到 Flow 的 prompt 中

### 4.2 高级控制存在，但不应是默认主路径

`tools.rules` 不删除，也不降级为不支持。

但它在产品上应从“编排主路径”变成：

```text
Advanced Overrides
```

即：

- 默认先选 Feature mode
- 需要时再展开高级设置
- 高级设置是 override，而不是默认心智入口

### 4.3 冲突必须允许，但必须可诊断

只要同时存在：

- Feature mode 默认行为
- 节点级高级 override

就一定会出现冲突，例如：

- 某 mode 默认启用某工具
- 用户在高级设置中又把它禁用了

这个冲突不应该靠“禁止用户修改”解决，而应该靠：

- 明确优先级
- 明确可视化提示
- 明确调试快照

### 4.4 Prompt 必须由 Flow 显式拼装

当前阶段不把 Feature 暴露的 prompt 当作自动注入的运行时系统提示。

Feature 可以暴露：

- 变量
- 节点模板
- 预先整理好的 prompt 片段 / prompt 预设

但最终 prompt 仍由 Flow 节点中的用户显式拼装。

这意味着：

- 哪个节点需要 prompt，由 Flow 决定
- prompt 拼成什么样，由 Flow 决定
- Feature 只负责提供可复用材料，而不是偷偷改写上下文

### 4.5 节点记录的是 mode 修改，不是完整 mode 状态

当前阶段采用：

```text
节点显式修改，状态持续继承
```

即：

- 一个 Feature 在一个节点里只能处于一个 mode
- 节点可以不设置某个 Feature 的 mode
- 如果节点不设置，则继承前一个节点已经生效的 mode
- 若要“关闭”某种行为，应由 Feature 自己暴露显式的 `off` / `idle` / `manual` 等 mode

这比“每个节点都必须重填一次 mode”更符合真实编排心智。

### 4.6 先保证产品结构正确，再逐步增强可视化

本阶段优先级是：

1. 抽象边界
2. 运行时契约
3. 数据结构
4. UI 主路径
5. 调试可视化增强

而不是一开始把所有调试面板一次性做满。

---

## 五、统一抽象：Feature Flow Contract

为跨 AgentDev 与 Claw 的这一轮调整，引入统一概念：

```text
Feature Flow Contract
```

它是 Feature 面向 Flow 暴露的正式编排契约。

包含五类核心对象：

### 5.1 Feature Manifest

Feature Manifest 是 Feature 的配置契约。

它回答的问题不是：

```text
WHEN：当前节点让这个 Feature 以什么状态工作
```

而是：

```text
HOW：这个 Feature 平时以什么参数工作
```

典型例子：

- AudioFeedback 的音量、音频路径
- AuditFeature 使用哪个模型、缓存开关、严格程度

Feature Manifest 是 AgentDev 框架层的能力，不等同于当前仓库中用于包元数据展示的 `agentdev-feature.json`。

两者区别如下：

| 概念 | 用途 |
|------|------|
| `agentdev-feature.json` | 仓库/分发元数据，描述包是什么 |
| `Feature Manifest` | 运行时配置契约，描述这个 Feature 能怎么配 |

当前文档中的 Feature Manifest，更接近运行时配置契约。

### Manifest 的载体与项目值

当前阶段建议把 Manifest 视为框架契约本身，默认可由 Feature 包内的 `manifest.json` 承载。

但要明确区分两件事：

1. `manifest.json`
   负责声明 schema / 默认值 / 配置项说明
2. Agent Project 中用户填写的配置值
   不写回 `manifest.json`，而是存入 Claw 的 workspace state

这样：

- AgentDev 框架拥有统一的配置契约能力
- Claw 继续用现有 workspace state 保存项目级实际取值
- 同一个 Feature 可以在不同 Agent Project 中拥有不同配置值

### 5.2 Feature Modes

Feature 对外声明的业务模式。

每个 mode 是一个可命名、可解释、可编排的状态面。

例如：

- `auto-review-on`
- `auto-review-off`
- `strict-audit`
- `collect-only`

### 5.3 Feature Variables

Flow 可读取的变量。

用于：

- `exitWhen`
- prompt 引用
- 调试显示
- 条件化编排

### 5.4 Prompt Presets / Prompt Fragments

Feature 可以暴露预先整理好的提示词片段。

它们可以：

- 直接引用 Feature 变量
- 作为用户在 Flow 节点中手动拼 prompt 的素材
- 与 mode 关联，也可以独立存在

但它们不是运行时自动注入的系统提示。

### 5.5 Feature Node Templates

Feature 推荐给用户的节点模板。

模板应优先围绕 mode / prompt 片段 / variables 组织，而不是围绕 tool name 组织。

---

## 六、AgentDev 框架侧调整方案

## 6.1 新增 Feature Manifest 与 Flow Contract 接口

在 Feature 层面新增两套相互正交的契约：

1. Feature Manifest：配置契约，回答 HOW
2. Flow Contract：编排契约，回答 WHEN

### Feature Manifest（配置契约）

Feature Manifest 用于统一声明：

- 这个 Feature 有哪些可配置项
- 每个配置项的数据类型、默认值、说明

建议方向如下：

```ts
interface FeatureManifestDefinition {
  schemaVersion: 1;
  settings?: {
    properties: Record<string, {
      type: 'string' | 'number' | 'boolean' | 'select' | 'file';
      title: string;
      description?: string;
      default?: any;
      options?: Array<{ label: string; value: any }>;
    }>;
  };
}
```

Manifest 是框架能力的一部分，更像配置契约，而不是单纯的 UI 约定。

存储和作用域约定如下：

- Manifest 本身由 Feature 提供，代表 schema / 默认值
- 用户填写的配置值属于 Agent Project 级数据
- 配置值写入 Claw 的 workspace state
- 运行时通过 AgentDev 已有 `featureConfig` 通道传入 Feature

这意味着：

- Config 是全局底座
- Mode 是流程阶段状态
- 两者正交，不应混用

### Flow Contract（编排契约）

在 Feature 层面新增正式接口。

建议接口方向如下：

```ts
interface FlowModeDefinition {
  id: string;
  title: string;
  description?: string;
  featureId?: string;
  category?: string;
  tags?: string[];

  /**
   * 声明式效果——mode 选中后 FlowFeature 可读取并自动应用。
   * 这部分是透明层，用于编辑器预览与诊断。
   *
   * 注意：当前阶段 prompt 不自动注入到上下文。
   */
  effects?: {
    tools?: FlowToolRule[];   // 此模式下工具的默认状态
  };

  /**
   * 预先整理好的 prompt 片段。
   * 它们只作为 Flow 编辑器中的手动拼装素材，不自动注入。
   */
  suggestedPromptFragments?: Array<{
    id: string;
    title: string;
    template: string;
    description?: string;
  }>;
}

interface FlowAwareFeatureContract {
  getFlowModes?(): FlowModeDefinition[];
  getFlowVariables?(): FlowVariable[];
  getFlowNodeTemplates?(): FlowNodeTemplate[];

  applyFlowMode?(modeId: string, ctx: FlowModeContext): Promise<void> | void;
  resetFlowModes?(ctx: FlowModeContext): Promise<void> | void;
}
```

说明：

- `getFlowModes()`：声明式暴露可编排模式。返回值中的 `effects` 与 `suggestedPromptFragments` 都是纯数据，能力收集阶段（`instantiateFeatureForCapability()`）可直接读取，不需要调用运行时方法。
- `applyFlowMode()`：当 Feature 有 `effects` 无法覆盖的行为时（例如内部 hook 行为变化、内部状态切换），由 FlowFeature 在节点进入时调用。
- `resetFlowModes()`：恢复 Feature 自身到进入 Workflow 前的基线状态。与 FlowFeature 的 `restoreBaselineToolStates()` 互补：前者管 Feature 内部状态，后者管 ToolRegistry 状态。

## 6.2 Mode 的职责边界与两层封装

Feature mode 的职责不是”给用户看一个名字”。

### 透明层：effects + prompt fragments（声明式，Flow 可见）

mode 的 `effects` 是声明式行为，由 FlowFeature 直接读取并自动应用：

- 工具默认状态（`effects.tools`）
- 可手动插入的 prompt 片段（`suggestedPromptFragments`）

这部分对 Flow 完全透明：

- capabilities API 能返回
- 编辑器能预览
- Diagnostics 能展示
- FlowFeature 能自动应用 `effects.tools`
- 编辑器能把 prompt 片段作为插入素材提供给用户

Feature 开发者不需要为这部分写任何运行时代码，只在 `getFlowModes()` 的返回值中声明即可。

### 封装层：内部行为（Feature 私有）

如果 Feature 有 `effects` 无法覆盖的行为变化（例如 hook 内部分支逻辑切换、内部状态机转换），由 `applyFlowMode()` 处理。

这部分对 Flow 不透明：

```text
Feature 内部的 hook 行为变化属于 Feature 自己；
FlowRuntime 不知道 mode 触发了哪些 hook 逻辑调整。
```

这能避免把 hook 拓扑继续泄露到编排层。

### 设计约束

mode 的效果应尽量通过 `effects` 与 `suggestedPromptFragments` 声明，`applyFlowMode()` 只用于这些声明式信息无法覆盖的场景。

## 6.3 与 ToolRegistry 的关系

Feature mode 允许影响工具默认状态，但分两层：

1. Feature 内部默认状态
2. Flow 节点高级 override

框架侧必须支持：

- 先应用 mode 的 `effects.tools`（声明式部分）
- 再应用 Flow 节点 override

这意味着 ToolRegistry 在 Flow 节点中的最终结果是：

```text
Feature baseline（进入 Workflow 前的状态）
-> active mode effects.tools（声明式效果）
-> node advanced overrides（高级覆盖）
-> final visible/executable tool state
```

`effects.tools` 与高级 override 使用相同的 `FlowToolRule` 结构，FlowFeature 应用时直接遍历 rules 列表调用 ToolRegistry 的 enable/disable/remove。

### 工具状态来源的三级溯源

在 Diagnostics 和调试视图中，每个工具的最终状态必须可溯源：

| 来源 | 含义 |
|------|------|
| `baseline` | 进入 Workflow 前的状态 |
| `mode:{featureId}:{modeId}` | 由某个 Feature 的某个 mode 带来 |
| `override` | 由节点高级设置手动覆盖 |

如果高级 override 与 mode effects 冲突（例如 mode 启用了某工具，override 又把它关了），Diagnostics 中应同时展示两个来源。

## 6.4 Prompt 的职责边界

当前阶段明确规定：

- Feature 不自动把 mode prompt 注入上下文
- FlowFeature 不根据 mode 自动拼 prompt
- 所有最终 prompt 都在 Flow 节点里显式存在

Feature 只提供三类与 prompt 相关的能力：

1. 变量
2. prompt 片段 / prompt 预设
3. 节点模板

这能保证：

- prompt 来源清晰
- 用户对节点上下文拥有最终控制权
- 在提示词系统尚未完全稳定前，不引入隐式注入副作用

## 6.5 调试快照扩展

AgentDev 调试器侧需要新增可见信息：

- Feature 当前激活的 flow modes
- 每个 mode 来源于哪个节点
- 最终工具状态由 mode effects 还是 override 导致（参考 6.3 三级溯源）
- 当前节点执行了哪些 onEnter 动作

这部分是后续调试解释能力的基础。

## 6.6 架构性变更说明：FlowFeature 作为编排 Feature

当前 AgentDev 的设计中，所有 Feature 平等，Feature 之间没有调用关系。

本次调整后，FlowFeature 将成为"编排 Feature"（Orchestrator Feature），拥有对其他 Feature 实例的运行时控制权：

- 通过 `agent.features` Map 获取其他 Feature 实例
- 在节点进入时调用其他 Feature 的 `applyFlowMode()` / `resetFlowModes()`
- 读取其他 Feature 的 `getFlowModes()` 返回值来应用 `effects`

这是一个架构性变更，不是简单的接口新增。需要在 AgentDev 侧明确：

1. `agent.features` Map 的公开访问是稳定的 API（当前已是）
2. Feature 之间通过 `getFlowModes()` / `applyFlowMode()` 建立协作契约
3. mode 应用顺序：如果多个 Feature 的 mode 存在工具冲突，按 Feature 挂载顺序决定优先级（后挂载的 mode effects 覆盖先挂载的）

---

## 七、Claw 产品侧调整方案

## 7.1 Capabilities API 扩展

当前 `/protoclaw/flow_capabilities` 已返回：

- features
- tools
- variables
- nodeTemplates

需要扩展为：

- featureManifests
- features
- tools
- variables
- nodeTemplates
- modes

其中：

- `featureManifests` 按 Feature 返回配置 schema / 默认值
- `modes` 按 Feature 分组，每个 mode 包含完整的 `effects` 声明
- capabilities API 不新增 `functions`（参见 6.4 暂不建立独立 Function 体系的决定）

返回结构中要包含结构化引用信息，便于后续诊断失效引用。

### modes 的序列化

`modes` 与现有 `tools`、`variables`、`nodeTemplates` 的收集方式一致：

```text
instantiateFeatureForCapability() 创建临时 Feature 实例
  → 调用 getFlowModes()
  → 返回值包含 effects（纯数据，不需要运行时状态）
  → 按所属 Feature 添加 featureId / packageName 元信息
  → 序列化到 API 响应
```

`effects.tools` 中的 `FlowToolRule` 与 capabilities 返回的 `tools` 列表通过 `name` 字段关联。编辑器可以在 mode 预览中展示"选择此模式后，以下工具会变为启用/禁用/移除"。

### Feature Manifest 在 Claw 中的定位

Manifest 的 schema 用于组装页渲染 Feature 配置表单。

配置值存储在 workspace state 中，例如：

```json
{
  "forms": {
    "assembly-form": { "selected_features": "..." },
    "feature-configs": {
      "@agentdev/audio-feedback-feature": {
        "audioPath": "C:/Users/me/alert.wav",
        "volume": 0.8
      }
    }
  }
}
```

运行时构造 Agent 时，将这部分值填入 `config.features[name]`，通过 AgentDev 已有的 `featureConfig` 通道传入各 Feature。

## 7.2 编排图数据结构扩展

当前节点结构主要围绕：

- `prompt`
- `tools.rules`
- `onEnter`
- `exitWhen`

建议新增：

```ts
interface FlowNodeFeatureModeChange {
  featureId?: string;
  packageName?: string;
  modeId: string;
}
```

节点结构扩展为：

```ts
interface FlowNode {
  ...
  featureModeChanges?: FlowNodeFeatureModeChange[];
  advanced?: {
    tools?: {
      rules?: FlowToolRule[];
    };
  };
}
```

说明：

- `featureModeChanges`：默认主路径——节点只记录 mode 修改，而不是完整状态
- `advanced.tools.rules`：高级覆盖层，替代顶层的 `tools.rules`

### mode 继承规则

运行时不把 `featureModeChanges` 解释为“当前节点完整 mode 列表”，而解释为“相对上一个节点的修改”。

规则如下：

1. 一个 Feature 在一个时刻只能有一个激活 mode
2. 节点可以不写该 Feature 的 mode
3. 如果不写，则继承前一个节点已经生效的 mode
4. 进入 Workflow 时，所有 Feature 的初始 mode 均为“未设定”
5. 若要显式关闭某种行为，应切到该 Feature 自己暴露的 `off` / `idle` / `manual` 等 mode

### tools.rules 迁移与兼容策略

运行时读取优先级（在 FlowFeature 的 `applyToolScopeForCurrentNode()` 中）：

```ts
function getEffectiveToolRules(node: FlowNode): FlowToolRule[] {
  // 优先读新结构
  const advancedRules = node.advanced?.tools?.rules;
  if (Array.isArray(advancedRules) && advancedRules.length > 0) {
    return advancedRules;
  }
  // 兼容旧结构（已保存的旧图）
  const legacyRules = node.tools?.rules;
  if (Array.isArray(legacyRules) && legacyRules.length > 0) {
    return legacyRules;
  }
  return [];
}
```

写入策略：

- 新 UI 只写 `advanced.tools.rules`，不再往顶层 `tools.rules` 写
- 旧数据在用户编辑并保存后自然迁移到新结构
- 不做双写，不做一次性迁移脚本

兼容读取覆盖的字段：

- `advanced.tools.rules`（新主路径）
- `tools.rules`（旧主路径，降级为兼容回退）
- `tools.enable`（更旧的兼容路径，保持不变）

## 7.3 节点编辑器 UI 重构

节点 Inspector 结构改为两层：

### 区块 A：Feature Behaviors

默认展开。

包含：

- 为某个 Feature 选择新的 mode
- 查看 mode 说明
- 预览 mode 的工具效果
- 插入 mode 提供的 prompt 片段
- 变量引用辅助

这是用户的默认工作路径。

### 区块 B：Advanced Overrides

默认折叠。

包含：

- 现有工具权限规则 `tools.rules`

区块标题建议直接体现这是高级层，例如：

- `高级设置`
- `Advanced Overrides`

### 区块 C：Diagnostics

用于解释当前节点最终生效的控制结果，例如：

- 已启用哪些 Feature modes
- 哪些 mode 是继承来的，哪些是当前节点刚修改的
- 哪些工具是 mode 默认带来的
- 哪些工具被高级设置覆盖
- 当前节点有无冲突

## 7.4 冲突可视化

如果某个 mode 默认启用某工具，而节点高级层把它关掉：

- UI 不阻止保存
- UI 标注该工具已被 override
- Diagnostics 中显示：
  - 默认来源：`mode:auto-review-on`
  - 最终状态：`disabled by node override`

这比简单禁止更符合高级用户需要。

---

## 八、运行时执行模型调整

当前 FlowFeature 节点执行顺序主要是：

1. 处理 pending transition
2. 检查 `exitWhen`
3. 注入 prompt
4. 应用工具权限

调整后建议顺序为：

1. 处理 pending transition
2. 根据上一节点的有效 mode 状态 + 当前节点的 `featureModeChanges` 计算新的有效 mode 状态
3. 对所有已知支持 mode 的 Feature 调用 `resetFlowModes()` — Feature 内部状态回归
4. 恢复工具基线 (`restoreBaselineToolStates()`) — ToolRegistry 状态回归
5. 对新的有效 mode 状态中的每个 Feature 调用 `applyFlowMode(modeId, ctx)` — Feature 内部状态切换到目标 mode
6. 应用新的有效 mode 状态里所有 mode 的 `effects.tools` — FlowFeature 根据声明式效果调整工具状态
7. 应用高级 overrides（`advanced.tools.rules`）— 覆盖 mode 的默认工具状态
8. 由节点自身显式注入 `prompt` —— 如需使用 Feature 提供的 prompt 片段，由编辑器提前拼入节点 prompt
9. 检查/刷新变量
10. 在后续步骤中按 `exitWhen` 决定切换

## 8.1 模式应用顺序

### 有效 mode 状态

FlowFeature 在运行时维护一份：

```text
effectiveModesByFeature
```

它表示“当前这个 Workflow 在这一节点上，每个 Feature 实际处于哪个 mode”。

其计算规则为：

- 进入 Workflow 时为空
- 节点切换时，在上一节点 `effectiveModesByFeature` 的基础上应用当前节点 `featureModeChanges`
- 若当前节点未修改某个 Feature 的 mode，则沿用上一节点的结果

这正是“节点设置的是 mode 的修改，如果模式维持，这个节点可以不手动设置”的运行时表达。

### 节点进入时的重放策略

节点进入时不是“只执行当前节点改了的 mode”，而是：

1. 先把所有支持 mode 的 Feature reset 回基线
2. 再把当前节点对应的完整有效 mode 状态全部重放一遍

这样可以保证：

- mode 能跨节点持续
- 节点之间不会残留脏状态
- rollback / restore 时也更容易恢复一致状态

### applyFlowMode 的调用契约

```ts
interface FlowModeContext {
  nodeId: string;           // 当前进入的节点 ID
  workflowId: string;       // 当前工作流 ID
  agent: any;               // Agent 引用（Feature 可能需要访问）
}
```

**调用时机**：FlowFeature `@StepStart` 中，baseline 恢复之后、`effects.tools` 应用之前。

**幂等性**：对同一 modeId 连续调用应安全。Feature 内部应检测是否已在目标状态，避免重复初始化。

**失败策略**：`applyFlowMode()` 抛异常时，FlowFeature 记录警告但不中止节点进入，继续处理其他 Feature 的 mode。异常信息注入到上下文中供调试。

**不需要 applyFlowMode 的场景**：如果 Feature 的 mode 只影响声明式工具状态，不影响内部 hook / 状态逻辑，则可以不实现 `applyFlowMode()`。FlowFeature 仍会直接应用 `effects.tools`。

### resetFlowModes 与 restoreBaselineToolStates 的关系

两者互补，不替代：

| 机制 | 管理范围 | 调用者 |
|------|---------|--------|
| `resetFlowModes()` | Feature 内部状态（hook 行为、内部变量等） | FlowFeature 调 Feature |
| `restoreBaselineToolStates()` | ToolRegistry 中的工具 enable/disable/remove 状态 | FlowFeature 自身 |

两者共同保证节点切换时不残留上一个节点的状态。

## 8.2 优先级规则

最终优先级统一规定为：

```text
Feature baseline
< Effective mode state defaults
< Node advanced overrides
```

即：

- 当前节点的有效 mode 状态可以改变默认行为
- 高级 override 始终有权覆盖 mode

但 override 必须在 UI 与调试里显式显示为“覆盖行为”。

## 8.3 与现有工具权限实现的关系

当前已实现的工具权限机制不废弃。

它的角色从：

```text
节点编排主路径
```

调整为：

```text
节点高级控制层
```

运行时实现仍可复用现有 `ToolRegistry` + baseline restore 机制。

---

## 九、向后兼容策略

## 9.1 Flow 图兼容

旧图结构必须继续可运行：

- 旧 `tools.rules`
- 旧 `tools.enable`
- 旧 `onEnter.tool-call`

短期策略：

- 读取全部兼容字段
- 新 UI 尽量写新结构
- 保存时尽量保留兼容所需信息

## 9.2 Feature 兼容

旧 Feature 没有实现：

- `getFlowModes()`
- `applyFlowMode()`
- `resetFlowModes()`

仍然应可被当前系统挂载使用。

对旧 Feature：

- 仅展示 tools / variables / templates
- 不展示 modes
- 允许用户继续只用高级层或旧编排方式

## 9.3 渐进迁移

新抽象不是一次性重写全部 Feature。

建议：

- 先允许新旧 Feature 共存
- 先让 Flow 能同时编排 modes 与旧工具权限
- 逐步把典型 Feature 升级为 mode-aware

---

## 十、推荐实施阶段

## 阶段一：框架契约落地

目标：

- 在 AgentDev 中新增 Feature Manifest 与 Flow Contract 接口
- 在本地 flow feature/types 中补充 modes 结构
- 保证旧 Feature 不受影响

交付：

- Feature Manifest 配置契约（settings schema）
- `getFlowModes()` 返回含 `effects.tools` 与 `suggestedPromptFragments` 的 mode 定义
- `applyFlowMode()` 接口定义及调用契约（见 8.1）
- `resetFlowModes()` 接口定义及与 baseline 的关系（见 8.1）

## 阶段二：Capabilities API 与数据结构扩展

目标：

- `/protoclaw/flow_capabilities` 返回 featureManifests 与 modes
- 编排图节点结构新增 `featureModeChanges` / `advanced`
- 实现 tools.rules 的运行时兼容读取（见 7.2）

交付：

- server 侧能力聚合扩展（`instantiateFeatureForCapability()` 调 Manifest / `getFlowModes()` 并序列化）
- flow types 扩展
- 图保存/读取兼容（优先 `advanced.tools.rules`，回退 `tools.rules`）

## 阶段三：Flow Runtime 接入

目标：

- FlowFeature 在节点切换时正式应用 Feature modes
- mode effects（工具状态）由 FlowFeature 直接应用
- applyFlowMode / resetFlowModes 按契约调用
- 高级工具权限以 override 层方式应用

交付：

- baseline 恢复机制扩展到 mode 层（resetFlowModes + restoreBaselineToolStates 互补）
- 有效 mode 状态计算与重放机制
- mode 应用顺序固定化（见第八章 10 步执行流程）
- effects.tools 应用逻辑

## 阶段四：UI 双层控制面落地

目标：

- 节点 Inspector 默认显示 Feature Behaviors
- 高级工具权限折叠进 Advanced Overrides
- 用户编排主路径切换到 mode + prompt 片段 + variables

交付：

- `flow-editor.js` Inspector 重构
- mode 选择器
- prompt 片段插入能力
- 高级区块折叠面板

## 阶段五：Feature Config / Manifest 面板接入

目标：

- 组装页基于 Feature Manifest 渲染配置表单
- 配置值写入 workspace state 并进入运行时 `featureConfig`

交付：

- Feature 列表中的配置入口
- `forms.feature-configs` 数据持久化
- Agent 构造时把配置值注入 `config.features[name]`

## 阶段六：诊断与调试增强

目标：

- 明确显示 mode/default/override 冲突
- 图上或 Inspector 中可见当前节点的最终生效结果

交付：

- override 标记
- 冲突提示
- hooks / features 面板扩展 mode 快照

## 阶段七：试点 Feature 升级

建议先选 1-2 个状态语义明显的 Feature 试点，例如：

- audit 类 Feature
- todo 类 Feature
- qqbot / 自动交互类 Feature

目标：

- 验证 mode 抽象是否真能降低实现复杂度
- 验证用户是否更容易理解编排面

---

## 十一、Feature 改造案例：Before / After

以项目中典型的"审查能力"Feature 为例，展示 mode 方案如何实际减负。

### Before：当前写法

当前仓库中的 [AuditFeature](D:\code\AgentDev\src\features\audit\index.ts) 是一个典型的”hook 驱动型 Feature”：

- `getTools()` 返回空数组（不暴露工具，纯 hook 驱动）
- 核心行为在 `@ToolUse auditBashCommand()`，只拦截 `bash` 工具调用
- 通过 `AuditFeatureConfig` 管理：`enabled`、`model`、`baseUrl`、`enableCache`、`cacheTtlDays` 等构造时配置
- hook 内部先检查 `config.enabled`，命中恶意命令时返回 `Decision.Deny` 并注入系统消息；安全时返回 `Decision.Approve`

当前 `config.enabled` 是构造时参数，运行时不可按节点变化。如果未来要支持”某些节点自动审查、某些节点关闭审查”，Feature 开发者很容易在现有 `config.enabled` 之外再引入一层流程状态：

```typescript
class AuditFeature implements AgentFeature {
  readonly name = 'audit';

  // Config 层：仍然通过构造函数 / featureConfig 管理
  private config: { enabled: boolean; model: string; enableCache: boolean; cacheTtlDays: number; /* ... */ };

  // 问题 1：Feature 自己引入流程阶段状态，与 Config 层职责混杂
  private runtimeMode: 'auto-review' | 'collect-only' | 'off' = 'off';

  setRuntimeMode(mode: 'auto-review' | 'collect-only' | 'off') {
    this.runtimeMode = mode;
  }

  // 问题 2：hook 内部需要同时检查 Config enabled 和 runtimeMode
  @ToolUse
  async auditBashCommand(ctx: ToolContext): Promise<DecisionResult> {
    if (!this.config.enabled || this.runtimeMode === 'off') return Decision.Continue;
    if (ctx.call.name !== 'bash') return Decision.Continue;

    const command = ctx.call.arguments?.command as string;
    if (!command) return Decision.Continue;

    const result = await this.auditCommand(command);
    if (result.is_malicious) {
      // collect-only 模式下记录但不阻断——又是一层分支逻辑
      if (this.runtimeMode === 'collect-only') return Decision.Continue;
      return { action: Decision.Deny, reason: result.analysis };
    }
    return Decision.Approve;
  }

  // 问题 3：如果后续要支持更多模式（如”严格门禁””人工确认后继续”），
  // 这些运行时状态切换逻辑都需要 Feature 自己继续扩展，
  // 而 Flow 侧不知道这些状态的存在
}
```

开发者需要同时思考：

- 哪些状态属于 Agent Project 级配置（`config.model`、`config.enableCache`）
- 哪些状态属于节点间流程切换（`runtimeMode`）
- hook 在不同运行阶段如何读这些状态
- Flow 到底要用什么方式通知这个 Feature 改状态

### After：mode 方案

```typescript
class AuditFeature implements AgentFeature {
  readonly name = 'audit';

  // Config 层不变——仍然通过 AuditFeatureConfig / featureConfig 管理
  // 包括：baseUrl, model, enabled, enableCache, cacheTtlDays, dbPath, workspaceDir
  private config: Required<Omit<AuditFeatureConfig, 'workspaceDir'>> & { workspaceDir?: string };

  // Mode 层：由 FlowFeature 通过 applyFlowMode / resetFlowModes 管理
  private active: boolean = false;
  private collectOnly: boolean = false;

  // 核心变化 1：声明式暴露 modes
  getFlowModes(): FlowModeDefinition[] {
    return [
      {
        id: 'auto-review',
        title: '自动审查',
        description: '自动审查所有 shell 命令的安全性，命中恶意时阻断执行',
        suggestedPromptFragments: [
          {
            id: 'audit-context',
            title: '审查上下文提示',
            template: '当前处于自动审查阶段，shell 命令会经过安全审计。',
          },
        ],
      },
      {
        id: 'collect-only',
        title: '仅记录',
        description: '审查但不阻断，将审计结论记录到数据库但不拒绝执行',
      },
      {
        id: 'off',
        title: '关闭审查',
        description: '不进行任何审查',
      },
    ];
  }

  // 核心变化 2：FlowFeature 统一调用 mode 切换入口
  applyFlowMode(modeId: string, _ctx: FlowModeContext): void {
    this.active = (modeId === 'auto-review' || modeId === 'collect-only');
    this.collectOnly = (modeId === 'collect-only');
  }

  resetFlowModes(): void {
    this.active = false;
    this.collectOnly = false;
  }

  // @ToolUse 仍然保留，但只关心”当前 mode 是否激活”以及”是否阻断”
  // 不再需要自己管理 runtimeMode 状态
  @ToolUse
  async auditBashCommand(ctx: ToolContext): Promise<DecisionResult> {
    if (!this.active) return Decision.Continue;
    if (ctx.call.name !== 'bash') return Decision.Continue;

    const command = ctx.call.arguments?.command as string;
    if (!command) return Decision.Continue;

    // 审计逻辑（缓存查询 + LLM 调用）与当前实现相同
    const result = await this.auditCommand(command);
    if (result.is_malicious) {
      if (this.collectOnly) return Decision.Continue;
      return { action: Decision.Deny, reason: result.analysis };
    }
    return Decision.Approve;
  }

  // auditCommand()、缓存、数据库等实现不变
}
```

### 关键变化总结

| 维度 | Before | After |
|------|--------|-------|
| 配置与流程状态 | `config.enabled`（构造时）和 `runtimeMode`（运行时）混杂 | Config（构造时 `model`/`enableCache`）与 Mode（Flow 控制）分层明确 |
| 模式管理 | Feature 自己引入 `setRuntimeMode()`，Flow 侧不知道 | `getFlowModes()` + `applyFlowMode()` 统一契约 |
| prompt 使用 | Feature 若想提供提示，容易走隐式注入 | Feature 只提供 prompt 片段，Flow 显式拼装 |
| hook 复杂度 | hook 同时承担业务逻辑和流程状态判断 | hook 只做业务逻辑，mode 切换由 FlowFeature 统一调度 |
| 节点持续状态 | 需要 Feature 自己额外理解”上个节点发生了什么” | FlowFeature 维护有效 mode 状态并重放 |
| 开发者需要理解 | ReAct 循环、hook 时序、流程状态管理 | 主要回答”我有哪些模式，切到这些模式时怎么工作” |

---

## 十二、需要避免的错误方向

### 12.1 不要把 mode 做成 hook 开关表的别名

如果 mode 最终只是：

- `StepStart=true`
- `ToolUse=false`
- `tool_x=true`

那只是把底层实现换了个名字，并没有真正降低心智成本。

mode 必须是业务状态语义。

### 12.2 不要取消高级 override

如果彻底取消工具权限控制：

- 高级用户会失去灵活性
- 调试与实验能力会明显下降
- Flow 的“编排工作台”属性会受损

### 12.3 不要让 override 无痕生效

只要 override 能覆盖 mode，就必须让用户看见：

- 覆盖了什么
- 覆盖来源是什么
- 最终结果是什么

否则用户会失去对系统的信任。

### 12.4 不要一次性强制全部 Feature 升级

框架与产品抽象升级应允许：

- 新旧能力并存
- Feature 渐进迁移
- Flow 图渐进升级

---

## 十三、最终结论

本轮跨 AgentDev 与 Claw 的调整，不是简单增加几个新接口，而是对控制面进行重新分层。

最终方案明确采用双层结构：

### 配置底座

在双层控制面之下，增加统一的 Feature Manifest / Config 契约：

- Manifest 描述这个 Feature 能怎么配
- Config 值属于 Agent Project 级数据
- Mode 和 Override 都建立在 Config 底座之上

### 默认层

Flow 主要编排：

- Feature modes（用户可预览 mode 的工具效果）
- Feature variables
- Feature templates
- Feature 提供的 prompt 片段（由用户手动拼到节点 prompt 里）

这是面向直觉、面向业务语义的主路径。

### 高级层

Flow 在 `高级设置 / Advanced Overrides` 中继续保留细粒度控制：

- 当前第一项就是已实现的节点级工具权限

这是面向高级用户的 override 层。

### 统一优先级

```text
Feature baseline（进入 Workflow 前的状态）
< Effective mode state defaults（声明式工具状态）
< Advanced overrides（高级覆盖）
```

### 统一收益

- Feature 开发者不必主要围绕 hook 拓扑思考，而是把“配置契约”和“流程状态”分开表达
- 用户默认看到的是更符合业务心智的编排面，mode 工具效果可预览、可溯源
- prompt 仍然完全显式留在 Flow 里，不引入隐式注入歧义
- 高级用户仍然保有控制力，且 override 与 mode 的冲突可诊断
- 框架与产品都能在后续继续增强调试解释能力

这应作为下一阶段 Flow × Feature 结合方式的主设计方向。
