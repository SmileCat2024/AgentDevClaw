# 任务交接文档：工具状态三元化改造

## 一、背景与目标

### 当前状态（二元模型）

当前 AgentDev 框架的工具状态是二元的：

| 状态 | 行为 |
|------|------|
| **enabled** | LLM 可见，可执行 |
| **disabled** | LLM **不可见**（从 tools 列表移除），不可执行 |

核心代码在 `ToolRegistry`（`D:\code\AgentDev\src\core\tool.ts`），通过 `enabled: Set<string>` 和 `pendingDisabled: Set<string>` 两个集合管理。

### 目标状态（三元模型）

改造为三元状态：

| 状态 | 行为 | 说明 |
|------|------|------|
| **enabled（启用）** | LLM 可见，可执行 | 不变 |
| **disabled（禁用）** | LLM **可见**，但执行时拦截并返回英文错误提示 | **语义迁移**：原 disable 从"移除"变为"屏蔽" |
| **removed（移除）** | LLM **不可见**，从列表物理移除 | **新增**：承接旧 disable 的行为 |

### 核心变更

1. **`ToolRegistry.disable()` 语义迁移**：从"移除出 LLM 列表"变为"留在列表但拦截执行"
2. **新增 `ToolRegistry.remove()`**：承接旧 disable 的"物理移除"行为
3. **`ToolExecutor.execute()` 新增拦截**：对 disabled 状态的工具拦截执行，返回固定英文提示
4. **现有 `disable()` 调用自动迁移**：ExplorerAgent、BasicAgent 等处的 `disable()` 调用无需改动，行为自动从"移除"变为"屏蔽"

### 拦截提示设计

被禁用的工具执行时统一返回：
```
This tool is currently disabled and cannot be used.
```

---

## 二、AgentDev 框架层改动（D:\code\AgentDev）

### 2.1 ToolRegistry — 核心状态模型

**文件**：`D:\code\AgentDev\src\core\tool.ts`

**当前内部结构（行65-69）**：
```typescript
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private enabled = new Set<string>();      // 启用的工具名
  private pendingDisabled = new Set<string>(); // 工具注册前的预禁用状态
  private sources = new Map<string, string>();
}
```

**需要改为**：
```typescript
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private enabled = new Set<string>();        // 启用的工具名
  private disabled = new Set<string>();       // 禁用（屏蔽）的工具名 — 新增
  private pendingDisabled = new Set<string>(); // 注册前的预禁用状态
  private pendingRemoved = new Set<string>();  // 注册前的预移除状态 — 新增
  private sources = new Map<string, string>();
}
```

**需要改动的方法**：

| 方法 | 行号 | 改动 |
|------|------|------|
| `register()` | 74-85 | 注册时检查 pendingDisabled 和 pendingRemoved 两个集合 |
| `disable()` | 90-96 | **语义迁移**：从 `enabled.delete()` 改为同时 `enabled.delete()` + `disabled.add()`；工具仍会被 `getAll()` 返回 |
| `enable()` | 101-108 | 同时清除 disabled 状态 |
| 新增 `remove()` | — | 承接旧 disable 行为：`enabled.delete()` + `disabled.delete()` + `pendingRemoved.add()` |
| 新增 `unremove()` | — | 恢复被移除的工具 |
| `isEnabled()` | 113-115 | 不变 |
| 新增 `isDisabled()` | — | `return this.disabled.has(name)` |
| 新增 `isRemoved()` | — | `return !this.enabled.has(name) && !this.disabled.has(name)` |
| `getEntries()` | 127-133 | 返回结构需从 `{ tool, enabled: boolean }` 改为三态表达，如 `{ tool, state: 'enabled' \| 'disabled' \| 'removed' }` |
| `getAll()` | 145-149 | **关键改动**：返回 enabled + disabled 的工具（disabled 的工具 LLM 仍可见），不再只返回 enabled |

### 2.2 ToolExecutor — 执行拦截

**文件**：`D:\code\AgentDev\src\core\agent\tool-executor.ts`

**当前拦截逻辑（行62-155）**：

当前 `execute()` 方法在行 62 获取工具后，只在以下情况拦截：
- 正向钩子返回 `block`（行92-96）
- 反向钩子返回 `Deny`（行105-110）
- 工具不存在（行127）

**需要新增的拦截（行62之后）**：

在获取 tool 对象之后、执行钩子之前，新增 disabled 状态检查：

```typescript
const tool = this.tools.get(call.name);

// 新增：禁用工具拦截
if (tool && this.tools.isDisabled(call.name)) {
  const errorResult: ToolExecResult = {
    success: false,
    result: { error: 'This tool is currently disabled and cannot be used.' },
  };
  context.addToolMessage(call, errorResult, callIndex);
  // 仍需触发 ToolFinished 钩子
  // ...
  return;
}
```

拦截点应在行 62 `const tool = this.tools.get(call.name)` 之后，行 82 钩子执行之前。

### 2.3 React Loop — LLM 工具列表

**文件**：`D:\code\AgentDev\src\core\agent\react-loop.ts`

**当前代码（行114-116）**：
```typescript
await this.agent.llm.chat(
  context.getAll(),
  this.agent.tools.getAll()  // 只返回 enabled
);
```

**无需改动**：因为 `getAll()` 语义已变更，会返回 enabled + disabled 的工具。

### 2.4 Agent — enable/disable/remove API

**文件**：`D:\code\AgentDev\src\core\agent.ts`

**需要改动的方法**：

| 方法 | 行号 | 改动 |
|------|------|------|
| `enable(featureName)` | 752-774 | 增加清除 disabled 状态的逻辑 |
| `disable(featureName)` | 782-804 | 语义迁移：调用新的 `tools.disable()`（屏蔽），无需改调用代码 |
| 新增 `remove(featureName)` | — | 调用 `tools.remove()`，承接旧 disable 的物理移除行为 |
| `isEnabled(featureName)` | 812-820 | 逻辑不变 |

### 2.5 Hook Inspector Snapshot — 三态表达

**文件**：`D:\code\AgentDev\src\core\agent.ts`

**当前代码（行1146-1233）**：`buildHookInspectorSnapshot()` 方法

**需要改动**：
- 行1149-1155：工具条目类型从 `enabled: boolean` 改为三态（如 `state: 'enabled' | 'disabled' | 'removed'`）
- 行1173-1197：遍历 `tools.getEntries()` 时提取新的三态字段
- 行1201-1208：Feature status 计算逻辑需适配三态

**类型文件**：`D:\code\AgentDev\src\core\types.ts`

**当前代码（行332-348）**：`FeatureInspectorSnapshot` 接口

```typescript
tools: Array<{
  name: string;
  description: string;
  enabled: boolean;    // ← 需改为三态
  renderCall?: string;
  renderResult?: string;
}>;
```

需要改为：
```typescript
tools: Array<{
  name: string;
  description: string;
  state: 'enabled' | 'disabled' | 'removed';  // 三态
  renderCall?: string;
  renderResult?: string;
}>;
```

同时 `status` 字段（行335）也需要适配：
```typescript
status: 'enabled' | 'disabled' | 'partial';
// 可能需要扩展为包含 'removed' 的状态
```

### 2.6 现有 disable() 调用点 — 自动迁移

这些调用**不需要改代码**，因为 `disable()` 语义自动从"移除"变为"屏蔽"：

| 文件 | 行号 | 调用 |
|------|------|------|
| `D:\code\AgentDev\src\agents\system\ExplorerAgent.ts` | 124-128 | `this.getTools().disable('write')` 等 5 个工具 |
| `D:\code\AgentDev\src\agents\system\BasicAgent.ts` | 152-153 | `this.getTools().disable('list_agents')` 等 2 个工具 |

如果这些场景确实需要"物理移除"行为，需要将调用从 `disable()` 改为 `remove()`。**这是需要确认的决策点。**

---

## 三、AgentDevClaw 产品层改动（D:\code\AgentDevClaw）

### 3.1 Flow Editor — 数据结构

**文件**：`D:\code\AgentDevClaw\public\flow-editor.js`

**当前数据结构（行1209-1222）**：`getNodeToolRules(node)`

```javascript
// node.tools.rules 中的每条 rule
{ name: string, enabled: boolean, ref: object }
```

**需要改为**：
```javascript
{ name: string, mode: 'enabled' | 'disabled' | 'removed', ref: object }
```

向后兼容：读取时如果遇到旧格式 `enabled: false`，映射为 `mode: 'disabled'`；如果遇到 `enabled: true` 或无 enabled 字段，映射为 `mode: 'enabled'`。

**相关函数**：

| 函数 | 行号 | 改动 |
|------|------|------|
| `getNodeToolRules()` | 1209-1222 | 读取时做三态映射 |
| `writeNodeToolRules()` | 1229-1247 | 写入新格式，保持向后兼容 |
| `renderToolRuleRow()` | 892-906 | 渲染三态选择器替代二元 toggle |

### 3.2 Flow Editor — UI 渲染

**文件**：`D:\code\AgentDevClaw\public\flow-editor.js`

**当前渲染（行892-906）**：`renderToolRuleRow()` 函数

当前是一个二元 toggle 按钮（启用/关闭）+ 移除按钮。

**需要改为**：三态切换，可以用下拉菜单、按钮组或循环切换：
- 启用（绿色）→ 点击切换到禁用
- 禁用（橙色）→ 点击切换到移除
- 移除（红色）→ 点击执行移除

**CSS 文件**：`D:\code\AgentDevClaw\public\flow-editor.css`

**当前样式（行468-489）**：`.flow-editor-state-toggle.enabled` 和 `.flow-editor-state-toggle.disabled`

需要新增 `.shielded` 或 `.disabled` 的中间态样式（视觉区分三种状态）。

### 3.3 Flow Runtime — 工具规则应用

**文件**：`D:\code\AgentDevClaw\local-features\flow\src\index.ts`

**当前代码（行576-634）**：`applyToolScopeForCurrentNode()`

```typescript
for (const rule of rules) {
  const toolName = rule.name.trim();
  if (rule.enabled || flowToolNames.has(toolName)) {
    this.toolRegistry.enable(toolName);
  } else {
    this.toolRegistry.disable(toolName);
  }
}
```

**需要改为**：
```typescript
for (const rule of rules) {
  const toolName = rule.name.trim();
  const mode = rule.mode || (rule.enabled !== false ? 'enabled' : 'disabled');
  if (mode === 'enabled' || flowToolNames.has(toolName)) {
    this.toolRegistry.enable(toolName);
  } else if (mode === 'disabled') {
    this.toolRegistry.disable(toolName);   // 新语义：屏蔽
  } else {
    this.toolRegistry.remove(toolName);    // 物理移除
  }
}
```

同时 `restoreBaselineToolStates()`（行636-646）和 `saveToolStates()`（行564-573）也需要适配三态存储和恢复。

### 3.4 前端 Hooks 面板 — 工具状态渲染

**文件**：`D:\code\AgentDevClaw\public\index.html`

**当前代码（行11870）**：

```javascript
'<div class="' + getStatusBadgeClass(tool.enabled ? 'enabled' : 'disabled') + '">' +
  escapeHtml(tool.enabled ? t('feature_tool_enabled') : t('feature_tool_disabled')) +
'</div>'
```

**需要改为**三态渲染：
- `tool.state === 'enabled'` → 绿色 badge "enabled"
- `tool.state === 'disabled'` → 橙色 badge "disabled"
- `tool.state === 'removed'` → 红色 badge "removed"

**翻译字符串（行6498-6505 和 6719-6726）**：

需要新增：
```javascript
feature_tool_enabled: '启用',   // 或 'enabled'
feature_tool_disabled: '禁用',  // 或 'disabled'
feature_tool_removed: '移除',   // 新增
```

### 3.5 Assembly 工作空间 — Feature 挂载

**文件**：`D:\code\AgentDevClaw\public\index.html`

Assembly 工作空间的 Feature 挂载（行8794 附近）目前只有"启用/停用"二元选择。如果后续需要在 Assembly 层面也支持三态，需要额外设计。**当前阶段可以先不改动此区域**，只在 Flow Editor 中实现三态。

---

## 四、改动清单汇总

### AgentDev 框架（D:\code\AgentDev）

| 文件 | 改动类型 | 优先级 |
|------|----------|--------|
| `src/core/tool.ts` | 核心：ToolRegistry 三态模型重构 | P0 |
| `src/core/agent/tool-executor.ts` | 核心：disabled 拦截逻辑 | P0 |
| `src/core/types.ts` | 类型：FeatureInspectorSnapshot 三态字段 | P0 |
| `src/core/agent.ts` | API：新增 remove()、snapshot 三态 | P0 |
| `src/core/agent/react-loop.ts` | 无代码改动，但需验证 getAll() 行为 | P1 |
| `src/agents/system/ExplorerAgent.ts` | 决策：disable 是否改为 remove | P1 |
| `src/agents/system/BasicAgent.ts` | 决策：disable 是否改为 remove | P1 |
| `src/test/tool-registry-pre-disable.test.ts` | 测试：更新以覆盖三态 | P0 |

### AgentDevClaw 产品（D:\code\AgentDevClaw）

| 文件 | 改动类型 | 优先级 |
|------|----------|--------|
| `public/flow-editor.js` | 核心：三态数据结构 + UI 渲染 | P0 |
| `public/flow-editor.css` | 样式：三态切换按钮样式 | P0 |
| `local-features/flow/src/index.ts` | 核心：applyToolScope 三态逻辑 | P0 |
| `public/index.html` | Hooks 面板三态渲染 + 翻译字符串 | P1 |

---

## 五、需要注意的设计决策

1. **ExplorerAgent / BasicAgent 的 disable 调用**：这些是只读/受限 Agent，禁用工具的目的是防止 LLM 调用。在新模型下，`disable()` 变成"屏蔽"（LLM 仍能看到工具定义），这可能导致 LLM 尝试调用后被拒绝，消耗额外 token。是否应改为 `remove()`？

2. **Flow Editor 三态 UI 交互**：推荐用循环切换（点击在 启用→禁用→移除 之间循环），还是用下拉选择器？建议参考当前 toggle 按钮的设计风格。

3. **向后兼容**：Flow 配置中已有的 `enabled: true/false` 格式需要能被正确读取并映射到新的三态格式。

4. **拦截提示文案**：统一为 `"This tool is currently disabled and cannot be used."`，不需要本地化。
