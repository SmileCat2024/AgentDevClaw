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
| `title` | `string` | 是 | 面板标题 |
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
- `props`：组件属性，必须符合该组件的 props 定义。
- `children`：子元素 ID 列表。只有布局类组件（Stack / Row / Grid / Card）可以有 children。

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
| `label` | `string` | Action 标签 |
| `includeFields` | `string[]` | 提交时包含的字段名白名单。省略时提交全部已声明字段 |
| `confirm` | `object` | 提交前弹出本地确认对话框。用于破坏性或有副作用的操作 |

**submit 行为**：当用户点击绑定了 submit action 的按钮时，当前页面上各字段的值（含未被用户修改的 initialValues）会作为一条用户消息出现在聊天中。

---

## 组件目录（catalogVersion: v1）

### 布局类

#### Stack `[has children]`
垂直布局容器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |
| align | `start\|center\|end\|stretch` | 否 | 交叉轴对齐 |

#### Row `[has children]`
水平布局容器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |
| align | `start\|center\|end\|stretch` | 否 | 交叉轴对齐 |
| wrap | `boolean` | 否 | 空间不足时是否换行。窄面板下默认 true |

#### Grid `[has children]`
固定列数网格布局。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| columns | `number` | 是 | 列数（1-4） |
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |

#### Card `[has children]`
带边框的容器，可选标题。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | `string` | 否 | 卡片标题 |
| variant | `default\|subtle\|emphasis` | 否 | 视觉样式 |

#### Divider
水平分隔线。无 props，无 children。

### 展示类

#### Text
静态文本。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | `string` | 是 | 文本内容 |
| variant | `body\|caption\|heading\|code` | 否 | 文本样式 |
| tone | `default\|muted\|success\|warning\|danger\|info` | 否 | 语义色调 |

#### Badge
小标签。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | `string` | 是 | 标签文本 |
| variant | `default\|success\|warning\|danger\|info` | 否 | 语义样式 |

#### Table
只读数据表。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| columns | `array` | 是 | 列定义，每项 `{ key, label }`，最多 20 列 |
| rows | `array` | 是 | 行数据，最多 100 行 |

**columns item 结构**：`{ key: string (required, max 64), label: string (required, max 100) }`

**rows item 结构**：`{ [columnKey]: string | number | boolean | null }`

#### Alert
状态提示框。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | `info\|success\|warning\|danger\|neutral` | 否 | 提示类型 |
| title | `string` | 是 | 标题 |
| description | `string` | 否 | 补充说明 |

#### Progress
进度条。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| value | `number` | 是 | 进度百分比（0-100） |
| label | `string` | 否 | 标签 |
| showValue | `boolean` | 否 | 显示百分比数值 |
| tone | `default\|success\|warning\|danger` | 否 | 语义色调 |

#### CodeBlock
代码块（纯文本渲染，不执行不高亮）。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| code | `string` | 是 | 代码或预格式化文本 |
| language | `string` | 否 | 语言标签（仅展示用） |
| title | `string` | 否 | 标题 |

### 输入类

所有输入组件的 `name` prop 用于：
- 在 `initialValues` 中设置初始值
- 在 submit action 的 `includeFields` 中被引用
- 在用户提交时作为字段 key 返回

#### TextInput
单行文本输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| placeholder | `string` | 否 | 占位提示 |
| required | `boolean` | 否 | 是否必填 |
| minLength | `number` | 否 | 最小长度（0-10000） |
| maxLength | `number` | 否 | 最大长度 |

#### NumberInput
数字输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `number` | 否 | 最小值 |
| max | `number` | 否 | 最大值 |
| step | `number` | 否 | 步进值（min: 0） |
| required | `boolean` | 否 | 是否必填 |

#### Textarea
多行文本输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| rows | `number` | 否 | 行数（2-12） |
| maxLength | `number` | 否 | 最大长度 |
| required | `boolean` | 否 | 是否必填 |

#### Select
下拉选择。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

**options item 结构**：`{ value: string (required), label: string (required) }`

#### Checkbox
复选框。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 是 | 标签文本 |

#### RadioGroup
单选按钮组。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

#### DateInput
日期选择。提交 ISO 日期字符串（`YYYY-MM-DD`）或 null。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `string` | 否 | 最早日期（`YYYY-MM-DD`） |
| max | `string` | 否 | 最晚日期（`YYYY-MM-DD`） |
| required | `boolean` | 否 | 是否必填 |

#### Slider
数值滑块。提交有限数值。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `number` | 是 | 最小值 |
| max | `number` | 是 | 最大值 |
| step | `number` | 否 | 步进值，默认 1 |
| showValue | `boolean` | 否 | 显示当前值 |

#### Switch
开关。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 是 | 标签文本 |
| description | `string` | 否 | 补充说明 |

#### SegmentedControl
分段选择器。提交选中项的 value。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

### 操作类

#### Button
按钮。点击时触发引用的 action。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| label | `string` | 是 | 按钮文本 |
| actionId | `string` | 是 | 引用 `spec.actions` 中定义的 action |
| variant | `primary\|secondary\|ghost\|danger` | 否 | 按钮样式 |
| disabled | `boolean` | 否 | 禁用状态 |

---

## 完整示例

### 表单提交

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

用户点击"部署"后，聊天中会收到一条消息，包含 `env` 和 `replicas` 的当前值。

### 信息展示面板

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "任务进度",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack", "props": { "gap": "md" }, "children": ["alert", "table", "progress"]
    },
    "alert": {
      "type": "Alert", "props": {
        "variant": "info", "title": "3 个任务进行中", "description": "预计 10 分钟内完成"
      }, "children": []
    },
    "table": {
      "type": "Table", "props": {
        "columns": [
          { "key": "name", "label": "任务" },
          { "key": "status", "label": "状态" },
          { "key": "progress", "label": "进度" }
        ],
        "rows": [
          { "name": "构建", "status": "进行中", "progress": "80%" },
          { "name": "测试", "status": "等待中", "progress": "0%" },
          { "name": "部署", "status": "等待中", "progress": "0%" }
        ]
      }, "children": []
    },
    "progress": {
      "type": "Progress", "props": { "value": 27, "label": "总体进度", "showValue": true }
      , "children": []
    }
  }
}
```

### 多按钮选择面板

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "选择操作",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack", "props": { "gap": "sm" }, "children": ["label", "btns"]
    },
    "label": {
      "type": "Text", "props": { "content": "请选择操作方式：" }, "children": []
    },
    "btns": {
      "type": "Row", "props": { "gap": "sm" }, "children": ["btnA", "btnB", "btnC"]
    },
    "btnA": {
      "type": "Button", "props": { "label": "方案 A", "actionId": "chooseA", "variant": "primary" }, "children": []
    },
    "btnB": {
      "type": "Button", "props": { "label": "方案 B", "actionId": "chooseB", "variant": "secondary" }, "children": []
    },
    "btnC": {
      "type": "Button", "props": { "label": "取消", "actionId": "cancel", "variant": "ghost" }, "children": []
    }
  },
  "actions": {
    "chooseA": { "intent": "submit", "label": "方案 A" },
    "chooseB": { "intent": "submit", "label": "方案 B" },
    "cancel": { "intent": "submit", "label": "取消" }
  }
}
```

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
| ID 最大长度 | 64 |

---

## 最佳实践

1. **先规划元素树**：在写 Spec 之前，先想好布局结构（root → 容器 → 内容），确保 children 引用正确。
2. **用 initialValues 预填**：合理设置初始值能让用户更快完成交互。
3. **破坏性操作加 confirm**：删除、部署、发送等有副作用的 submit action，应设置 `confirm` 弹出确认框。
4. **用 includeFields 精简提交**：如果一个面板有多个 action 但各自只需要部分字段，用 `includeFields` 指定白名单。
5. **更新而非重建**：当面板内容需要变化时，用相同 `surfaceId` 调用 `ui_surface_upsert` 更新，而不是 close + 新建。
6. **会话恢复**：上下文精简或会话切换后，用 `ui_surface_list` 和 `ui_surface_get` 恢复对当前 Surface 状态的感知。
