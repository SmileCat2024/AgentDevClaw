---
name: generative-ui
description: AgentDevClaw 内置可视化交互面板的完整参考。当你需要向用户呈现结构化选项（按钮选择）、收集表单输入、展示数据表格或状态面板时，先读本技能获取 Spec 格式、组件目录和使用示例。
---

# Generative UI — 交互式面板参考手册

## 为什么用面板而不是纯文本

当你在聊天中输出一串文字让用户选择或填写时，用户需要手动回复。而面板可以：

- **按钮选择** — 用户点击即提交，比"请回复序号"自然得多
- **表单收集** — 多字段一次填完，不用来回追问
- **持久状态** — 面板在你继续工作的同时保持可见，用户随时查看
- **确认门禁** — 破坏性操作可以弹出确认框，防止误触

面板是 AgentDevClaw 浏览器客户端中紧邻对话区的独立区域。它不是聊天消息——它在上下文精简、消息裁剪和会话切换后仍然存在。用户在面板上的本地交互（填写、选择）不会触发 Agent 调用；**只有当用户点击 submit 按钮时，他们的输入才作为一条用户消息进入聊天**。

---

## Spec 结构

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "面板标题",
  "description": "可选描述",
  "root": "root",
  "elements": {
    "root": { "type": "Stack", "props": {}, "children": ["child1", "child2"] },
    "child1": { "type": "Text", "props": { "content": "Hello" }, "children": [] },
    "child2": { "type": "Button", "props": { "label": "确定", "actionId": "submit" }, "children": [] }
  },
  "initialValues": { "fieldName": "初始值" },
  "actions": {
    "submit": { "intent": "submit", "label": "提交" }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | `1` | 是 | 固定为 `1` |
| `catalogVersion` | `"v1"` | 是 | 固定为 `"v1"` |
| `title` | `string` | 是 | 面板标题（max 200 字符） |
| `description` | `string` | 否 | 面板描述 |
| `root` | `string` | 是 | `elements` 中作为根节点的 key |
| `elements` | `Record<string, Element>` | 是 | id 到元素的映射 |
| `initialValues` | `Record<string, PrimitiveValue>` | 否 | 字段初始值，key 是字段的 `name` |
| `actions` | `Record<string, Action>` | 否 | actionId 到 action 定义的映射 |

### Element 结构

```json
{ "type": "组件名", "props": { ... }, "children": ["childId1", "childId2"] }
```

- `type`：必须是下方组件目录中列出的组件名。
- `props`：组件属性。**必须严格匹配该组件在下文列出的 props——多余的 prop 会导致校验失败（fail closed）。**
- `children`：子元素 ID 列表（字符串数组）。
  - **容器组件**（Stack / Row / Grid / Card）的 `children` 是**必填的**，必须为数组（可以为空 `[]`）。
  - **叶子组件**（所有非容器组件）的 `children` 可以省略或为空数组 `[]`；**不能包含任何元素 ID**。

### Action 结构

```json
{
  "intent": "submit",
  "label": "提交",
  "includeFields": ["field1", "field2"],
  "confirm": { "title": "确认操作", "description": "确定要执行吗？", "confirmLabel": "确认" }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `intent` | `"submit" \| "reset"` | `submit` = 交给 Agent 处理；`reset` = 本地重置表单 |
| `label` | `string` | Action 标签（非空） |
| `includeFields` | `string[]` | 提交时包含的字段名白名单。**引用的每个字段名必须真实存在于某个输入组件的 `name`。** 省略时提交全部已声明字段 |
| `confirm` | `object` | 提交前弹出本地确认对话框。`title`（必填，max 200）、`description`（可选，max 1000）、`confirmLabel`（可选，max 100） |

**submit 行为**：当用户点击绑定了 submit action 的按钮时，当前页面上各字段的值（含未被用户修改的 initialValues）会作为一条用户消息出现在聊天中。

---

## 严格校验规则

Spec 提交后会经过严格的运行时校验。以下规则**违反任何一条都会导致整个 Spec 被拒**，返回 `invalid_spec` 错误。这是 agent 最容易踩坑的地方，务必逐条阅读。

### 元素 ID 格式

所有 `elements` 的 key 和 `actions` 的 key 都必须匹配正则 **`/^[a-zA-Z][a-zA-Z0-9_-]*$/`**：

- **必须以字母开头**（`a-z` / `A-Z`），不能以数字开头
- 只允许字母、数字、下划线 `_` 和连字符 `-`
- 不允许点号 `.`、空格、斜杠 `/` 等特殊字符
- 最大长度 64 字符

```
合法：root, child1, my-element, btn_submit
非法：1btn, my.text, btn-1 (数字开头), my element (空格)
```

### 图结构约束（elements 形成的树）

| 规则 | 说明 |
|------|------|
| **root 必须存在** | `root` 字段引用的 ID 必须在 `elements` 中 |
| **children 引用完整** | 每个 children 中的 ID 必须存在于 `elements` |
| **单父节点** | 一个元素**不能被多个父节点的 children 同时引用**。如果多个容器需要显示相同内容，必须创建多个独立元素 |
| **无环** | 元素引用不能形成循环 |
| **无孤立节点** | **所有元素都必须从 root 可达。** 在 `elements` 中添加了元素但忘记挂到树的某处，会报 `unreachable` |

### Props 严格模式（fail closed）

**不允许使用组件 Catalog 中未声明的 prop。** 这是最高频的错误来源：

- 每个组件只接受下方组件目录中明确列出的 props
- 添加任何未列出的 prop（即使看起来"合理"）都会导致 `unknown prop` 错误
- **特别注意 `placeholder`**：在所有输入类组件中，**只有 `TextInput` 支持 `placeholder`**。`Textarea`、`NumberInput`、`Select`、`Slider`、`Switch`、`Checkbox`、`RadioGroup`、`DateInput`、`SegmentedControl` 均**不支持** `placeholder`

### initialValues 约束

- 每个 key **必须对应某个输入组件的 `name`**。引用不存在的字段名会报错
- 值类型应为 `string | number | boolean | null`

### Action 引用约束

- Button 的 `actionId` **必须在 `spec.actions` 中有对应定义**。引用未定义的 action 会报错
- action 的 `includeFields` 中每个字段名**必须对应某个输入组件的 `name`**
- 不同的输入组件**不能使用相同的 `name`**（重复字段名会报错）

### 组件特定约束

| 组件 | 约束 |
|------|------|
| **Slider** | `min` 必须严格小于 `max`；`step`（如果提供）必须是正数 |
| **Grid** | `columns` 必须是 1-4 的整数 |
| **DateInput** | `min` / `max`（如果提供）必须是 `YYYY-MM-DD` 格式；`min` 不能晚于 `max` |

---

## 组件速查表（catalogVersion: v1）

共 31 个组件。下表标注了类型、是否可包含子元素、必填 props。**完整属性表和用法约定见同目录 `COMPONENT-REFERENCE.md`。**

### 布局类

| 组件 | 子元素 | 必填 props | 说明 |
|------|:------:|-----------|------|
| **Stack** | 是 | — | 垂直布局。gap, align |
| **Row** | 是 | — | 水平布局。gap, align, wrap |
| **Grid** | 是 | `columns`(1-4) | 固定列数网格。gap |
| **Card** | 是 | — | 带边框容器。title, variant |
| **Divider** | 否 | — | 水平分隔线。无 props |
| **Tabs** | 是 | `items` | 选项卡。每个子元素 = 一个标签页内容（按索引对应）。defaultIndex |
| **Accordion** | 是 | `items` | 折叠面板。每个子元素 = 一个折叠区内容（按索引对应）。defaultOpen, multiple |
| **Carousel** | 是 | — | 水平轮播。每个子元素 = 一页。loop |

### 展示类（均为叶子，无 children，无提交值）

| 组件 | 必填 props | 说明 |
|------|-----------|------|
| **Text** | `content` | 静态文本。variant, tone |
| **Badge** | `text` | 小标签。variant |
| **Table** | `columns`, `rows` | 只读数据表 |
| **Alert** | `title` | 状态提示。variant, description |
| **Progress** | `value`(0-100) | 进度条。label, showValue, tone |
| **CodeBlock** | `code` | 代码块。language, title |
| **Steps** | `items`, `current` | 步骤进度。items: `[{title, description?}]` |
| **Spinner** | — | 加载旋转。size, label |
| **Image** | `src`, `alt` | 图片。width, height |
| **Avatar** | `name` | 头像（src 或首字母）。size |
| **Link** | `text`, `href` | 超链接（新标签打开） |
| **Stat** | `label`, `value` | KPI 指标卡片。unit, tone |
| **Skeleton** | — | 骨架屏。variant, width, height, rounded |
| **Tooltip** | `text`, `content` | 行内文本 + 悬浮提示 |

### 输入类（均为叶子，通过 name 提交值）

> **placeholder 只在 TextInput 上可用。** 其他所有输入组件均不支持 placeholder。

| 组件 | 必填 props | 提交类型 | 说明 |
|------|-----------|---------|------|
| **TextInput** | `name` | string | label, placeholder, required, minLength, maxLength |
| **NumberInput** | `name` | number | label, min, max, step, required |
| **Textarea** | `name` | string | label, rows, maxLength, required |
| **Select** | `name`, `options` | string | label, required。options: `[{value, label}]` |
| **Checkbox** | `name`, `label` | boolean | — |
| **RadioGroup** | `name`, `options` | string | label, required |
| **DateInput** | `name` | string\|null | label, min, max, required（ISO `YYYY-MM-DD`） |
| **Slider** | `name`, `min`, `max` | number | label, step, showValue |
| **Switch** | `name`, `label` | boolean | description |
| **SegmentedControl** | `name`, `options` | string | label, required |

### 操作类

| 组件 | 必填 props | 说明 |
|------|-----------|------|
| **Button** | `label`, `actionId` | variant(primary\|secondary\|ghost\|danger), disabled |

---

## 关键示例

一个涵盖表单、展示和操作的完整面板：

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "部署配置",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack", "props": { "gap": "md" }, "children": ["title", "env", "replicas", "confirm"]
    },
    "title": {
      "type": "Text", "props": { "content": "部署到生产环境", "variant": "heading" }, "children": []
    },
    "env": {
      "type": "Select", "props": {
        "name": "env", "label": "环境",
        "options": [
          { "value": "staging", "label": "Staging" },
          { "value": "prod", "label": "Production" }
        ],
        "required": true
      }, "children": []
    },
    "replicas": {
      "type": "Slider", "props": {
        "name": "replicas", "label": "副本数", "min": 1, "max": 10, "showValue": true
      }, "children": []
    },
    "confirm": {
      "type": "Button", "props": {
        "label": "部署", "actionId": "deploy", "variant": "primary"
      }, "children": []
    }
  },
  "initialValues": { "env": "staging", "replicas": 3 },
  "actions": {
    "deploy": {
      "intent": "submit", "label": "部署",
      "confirm": { "title": "确认部署", "description": "确定要部署到所选环境吗？" }
    }
  }
}
```

> 更多示例（Tabs、Accordion、Steps、Stat 信息面板、多按钮选择等）见 `COMPONENT-REFERENCE.md`。

---

## 限制

| 限制项 | 值 |
|--------|-----|
| 每个 Agent 最多 Surface 数 | 8 |
| 每个 Surface 最多元素数 | 200 |
| 元素树最大深度 | 20 |
| Spec 最大字节 | 256 KiB |
| 文本属性最大字符数 | 10,000 |
| 表格最大列数 | 20 |
| 表格最大行数 | 100 |
| Select/RadioGroup/SegmentedControl 最大选项数 | 100 |
| 元素 / Action ID 最大长度 | 64 |
| 元素 / Action ID 格式 | `/^[a-zA-Z][a-zA-Z0-9_-]*$/`（字母开头，只含字母数字下划线连字符） |

---

## 高频错误与规避

以下是 agent 生成 Spec 时**最常见的校验失败**，以及对应的规避方法：

### 1. 给不支持 placeholder 的组件加了 placeholder

**错误**：`Element "x" (Textarea) has unknown prop "placeholder".`

**原因**：看到 TextInput 有 placeholder，就假设其他输入组件也有。

**规避**：在所有输入类组件中，**只有 TextInput 支持 placeholder**。Textarea、NumberInput、Select、Slider、Switch、Checkbox、RadioGroup、DateInput、SegmentedControl 均不支持。如需提示信息，使用 `label` 或在上方放置 Text 组件。

### 2. 元素 ID 以数字开头或含特殊字符

**错误**：`Element ID "1btn" is invalid (must match /^[a-zA-Z][a-zA-Z0-9_-]*$/).`

**规避**：ID 必须以字母开头，只允许 `[a-zA-Z0-9_-]`。用 `btn1` 而非 `1btn`，用 `myText` 而非 `my.text`。

### 3. 同一元素被多个父节点引用

**错误**：`Element "shared" has multiple parents: a, b.`

**规避**：每个元素只能有一个父节点。如果两个容器需要显示相同内容，为每个容器创建独立的元素副本（不同 ID，相同 props）。

### 4. 在 elements 中添加了元素但未挂到树中

**错误**：`Element "orphan" is unreachable from root "root".`

**规避**：每个元素都必须从 root 通过 children 链可达。添加元素后，确认它的 ID 出现在某个容器组件的 children 数组中。

### 5. initialValues 或 includeFields 引用了不存在的字段名

**错误**：`initialValues key "ghost" does not match any input field name.` 或 `Action "x" includeFields references unknown field "y".`

**规避**：initialValues 的 key 和 includeFields 的值，都必须精确对应某个输入组件的 `name` prop。检查拼写一致性。

### 6. Button 引用了未定义的 action

**错误**：`Button references action "x" but it is not defined in spec.actions.`

**规避**：每个 Button 的 `actionId` 都必须在 `spec.actions` 中有对应的 key。

### 7. 容器组件缺少 children 字段

**错误**：`Element "root" (Stack) children must be an array.`

**规避**：Stack、Row、Grid、Card 的 children 字段是**必填的**，即使没有子元素也要写 `"children": []`。

### 8. Slider 的 min >= max 或 step <= 0

**错误**：`Element "x" (Slider) requires min to be less than max.`

**规避**：min 必须严格小于 max；step 如果提供，必须是正数。

---

## 最佳实践

1. **先规划元素树**：在写 Spec 之前，先想好布局结构（root → 容器 → 内容），确保 children 引用正确、无孤立节点。
2. **严格对照组件目录**：写每个元素的 props 时，回到上方组件目录逐项核对，不要添加目录中未列出的 prop。
3. **用 initialValues 预填**：合理设置初始值能让用户更快完成交互。
4. **破坏性操作加 confirm**：删除、部署、发送等有副作用的 submit action，应设置 `confirm` 弹出确认框。
5. **用 includeFields 精简提交**：如果一个面板有多个 action 但各自只需要部分字段，用 `includeFields` 指定白名单。
6. **更新而非重建**：当面板内容需要变化时，用相同 `surfaceId` 调用 `ui_surface_upsert` 更新，而不是 close + 新建。
7. **会话恢复**：上下文精简或会话切换后，用 `ui_surface_list` 和 `ui_surface_get` 恢复对当前 Surface 状态的感知。
