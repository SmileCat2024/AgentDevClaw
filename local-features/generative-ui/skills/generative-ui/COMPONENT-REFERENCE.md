# Generative UI — 组件完整属性参考

所有 31 个组件的完整 prop 表。按分类组织。

本文档是 SKILL.md 的配套参考。多数场景下只需阅读 SKILL.md 中的速查表即可；当需要精确的 prop 类型、约束或复杂组件的用法约定时，再查阅本文档。

---

## 布局类

容器组件（`acceptsChildren: true`）可以包含子元素。叶子组件不能。

### Stack `[has children]`
垂直布局容器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |
| align | `start\|center\|end\|stretch` | 否 | 交叉轴对齐 |

### Row `[has children]`
水平布局容器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |
| align | `start\|center\|end\|stretch` | 否 | 交叉轴对齐 |
| wrap | `boolean` | 否 | 空间不足时是否换行。窄面板下默认 true |

### Grid `[has children]`
固定列数网格布局。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| columns | `number` | 是 | 列数（1-4，超范围会被拒） |
| gap | `xs\|sm\|md\|lg` | 否 | 子元素间距 |

### Card `[has children]`
带边框的容器，可选标题。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | `string` | 否 | 卡片标题（max 200） |
| variant | `default\|subtle\|emphasis` | 否 | 视觉样式 |

### Divider
水平分隔线。无 props，无 children。

### Tabs `[has children]`
选项卡导航。每个子元素是一个标签页面板，按 `items` 数组顺序对应。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| items | `array` | 是 | 标签页定义，每项 `{ label, value }`。子元素按索引对应每个标签页的内容 |
| defaultIndex | `number` | 否 | 初始激活的标签页索引（0-based），默认 0 |

**children 约定**：第 N 个子元素渲染为第 N 个标签页的内容面板。`children` 数量**必须**与 `items` 数量一致，否则多出的标签页点击后内容为空。

### Accordion `[has children]`
可折叠面板。每个子元素是一个折叠区内容，按 `items` 数组顺序对应。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| items | `array` | 是 | 折叠区标题，每项 `{ title }`。子元素按索引对应每个折叠区的内容 |
| defaultOpen | `array` | 否 | 默认展开的折叠区索引数组（0-based），空或省略 = 全部折叠 |
| multiple | `boolean` | 否 | 是否允许同时展开多个。默认 true |

**children 约定**：第 N 个子元素渲染为第 N 个折叠区的内容。`children` 数量**必须**与 `items` 数量一致。

### Carousel `[has children]`
水平滚动轮播。每个子元素是一个轮播页。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| loop | `boolean` | 否 | 到末尾后循环回第一页，默认 false |

---

## 展示类

展示类组件都是叶子组件（不能有 children），且不产生提交值。

### Text
静态文本。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | `string` | 是 | 文本内容（max 10000） |
| variant | `body\|caption\|heading\|code` | 否 | 文本样式 |
| tone | `default\|muted\|success\|warning\|danger\|info` | 否 | 语义色调 |

### Badge
小标签。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | `string` | 是 | 标签文本（max 100） |
| variant | `default\|success\|warning\|danger\|info` | 否 | 语义样式 |

### Table
只读数据表。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| columns | `array` | 是 | 列定义，每项 `{ key, label }`，最多 20 列 |
| rows | `array` | 是 | 行数据，最多 100 行 |

**columns item 结构**：`{ key: string (required, max 64), label: string (required, max 100) }`

**rows item 结构**：`{ [columnKey]: string | number | boolean | null }`

### Alert
状态提示框。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | `info\|success\|warning\|danger\|neutral` | 否 | 提示类型 |
| title | `string` | 是 | 标题（max 200） |
| description | `string` | 否 | 补充说明（max 10000） |

### Progress
进度条。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| value | `number` | 是 | 进度百分比（0-100） |
| label | `string` | 否 | 标签（max 200） |
| showValue | `boolean` | 否 | 显示百分比数值 |
| tone | `default\|success\|warning\|danger` | 否 | 语义色调（**不支持 info**） |

### CodeBlock
代码块（纯文本渲染，不执行不高亮）。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| code | `string` | 是 | 代码或预格式化文本（max 10000） |
| language | `string` | 否 | 语言标签（仅展示用，max 40） |
| title | `string` | 否 | 标题（max 200） |

### Steps
水平步骤进度指示器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| items | `array` | 是 | 步骤定义，每项 `{ title, description? }` |
| current | `number` | 是 | 当前步骤索引（0-based） |

### Spinner
加载旋转指示器。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| size | `sm\|md\|lg` | 否 | 尺寸，默认 md |
| label | `string` | 否 | 加载提示文字 |

### Image
图片展示。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| src | `string` | 是 | 图片 URL |
| alt | `string` | 是 | 替代文字（无障碍） |
| width | `number` | 否 | CSS 像素宽度（1-2000） |
| height | `number` | 否 | CSS 像素高度（1-2000） |

> **Data URI 警告**：使用 SVG data URI 时，所有 `#` 必须编码为 `%23`，否则浏览器会将其解析为 URL fragment，导致 SVG 截断、图片不显示。包括 SVG 属性值（`fill="%23f00"`）和文本内容。

### Avatar
用户头像。有 `src` 时显示图片，否则显示从 `name` 提取的首字母。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 人物名称（用于首字母 fallback） |
| src | `string` | 否 | 头像图片 URL |
| size | `sm\|md\|lg` | 否 | 尺寸，默认 md |

### Link
超链接（在新标签页打开）。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | `string` | 是 | 链接显示文字 |
| href | `string` | 是 | 目标 URL |

### Stat
键值指标卡片，适合仪表盘中的 KPI 展示。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| label | `string` | 是 | 指标标签 |
| value | `string` | 是 | 指标值 |
| unit | `string` | 否 | 单位后缀 |
| tone | `default\|success\|warning\|danger\|info` | 否 | 语义色调 |

### Skeleton
加载占位骨架屏。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| variant | `text\|rect\|circle` | 否 | 形状变体，默认 rect |
| width | `number` | 否 | CSS 像素宽度（1-2000） |
| height | `number` | 否 | CSS 像素高度（1-2000） |
| rounded | `boolean` | 否 | 使用圆角，circle 始终全圆 |

### Tooltip
行内文本 + 悬浮提示。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| text | `string` | 是 | 可见的行内文本 |
| content | `string` | 是 | 悬浮时显示的提示内容 |

### Chart
只读折线/柱状图，渲染为内联 SVG。**数据可视化一律用 Chart，不要用 SVG data URI 拼 Image。** 柱与数据点自带原生 hover 提示（label · 系列：值）。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| chartType | `line\|bar` | 是 | 图表类型 |
| series | `Array<{label, values, tone?}>` | 是 | 数据系列，1-5 组。每个 `values` 长度必须与 `labels` 一致，全为有限数字 |
| labels | `string[]` | 是 | X 轴类目标签，1-60 项，与数据点一一对应 |
| unit | `string` | 否 | 单位，显示在 y 轴左上角与 hover 提示中 |
| showLegend | `boolean` | 否 | 图例开关。默认：多系列时显示 |
| showGrid | `boolean` | 否 | 水平网格线，默认 true |
| showValues | `boolean` | 否 | 仅柱状图：单系列且 ≤12 组时在柱顶打印数值，默认 false |
| height | `number` | 否 | 图表高度 CSS 像素（120-600），默认 220 |
| yMin / yMax | `number` | 否 | 固定 y 轴范围。默认自动包含 0（避免截断坐标轴夸大波动） |

- 系列 `tone` 取值 `default|success|warning|danger|info`，省略时按目录色板顺序自动分配，多系列天然可区分
- y 轴刻度自动取 1/2/5×10^n 的"好看"步长；x 轴标签超过 8 个自动抽稀

```json
{ "type": "Chart", "props": {
  "chartType": "bar",
  "labels": ["W31", "W32", "W33", "W34"],
  "series": [
    { "label": "AgentDevClaw", "values": [48, 20, 137, 165] },
    { "label": "AgentDev", "values": [11, 9, 68, 43], "tone": "success" }
  ],
  "unit": "commits", "height": 200
}, "children": [] }
```

### Sparkline
迷你趋势线，适合嵌在文本旁或 Stat 卡片中展示走势。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| values | `number[]` | 是 | 数据点，2-100 个有限数字 |
| tone | `default\|success\|warning\|danger\|info` | 否 | 线条色调，默认 default |
| width | `number` | 否 | 宽度 CSS 像素（40-2000），默认 120 |
| height | `number` | 否 | 高度 CSS 像素（16-96），默认 32 |
| showArea | `boolean` | 否 | 线下渐变填充，默认 true |

```json
{ "type": "Sparkline", "props": { "values": [34654, 98185, 157151, 214533], "tone": "info" }, "children": [] }
```

---

## 输入类

所有输入组件的 `name` prop 用于：
- 在 `initialValues` 中设置初始值
- 在 submit action 的 `includeFields` 中被引用
- 在用户提交时作为字段 key 返回

> **placeholder 只在 TextInput 上可用**。Textarea、NumberInput、Select 等其他输入组件均不支持 placeholder prop。

### TextInput
单行文本输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| placeholder | `string` | 否 | 占位提示 |
| required | `boolean` | 否 | 是否必填 |
| minLength | `number` | 否 | 最小长度（0-10000） |
| maxLength | `number` | 否 | 最大长度 |

### NumberInput
数字输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `number` | 否 | 最小值 |
| max | `number` | 否 | 最大值 |
| step | `number` | 否 | 步进值（min: 0） |
| required | `boolean` | 否 | 是否必填 |

### Textarea
多行文本输入。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| rows | `number` | 否 | 行数（2-12） |
| maxLength | `number` | 否 | 最大长度 |
| required | `boolean` | 否 | 是否必填 |

### Select
下拉选择。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

**options item 结构**：`{ value: string (required), label: string (required) }`

### Checkbox
复选框。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 是 | 标签文本 |

### RadioGroup
单选按钮组。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

### DateInput
日期选择。提交 ISO 日期字符串（`YYYY-MM-DD`）或 null。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `string` | 否 | 最早日期（`YYYY-MM-DD`） |
| max | `string` | 否 | 最晚日期（`YYYY-MM-DD`） |
| required | `boolean` | 否 | 是否必填 |

### Slider
数值滑块。提交有限数值。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| min | `number` | 是 | 最小值（必须严格小于 max） |
| max | `number` | 是 | 最大值 |
| step | `number` | 否 | 步进值，默认 1（必须为正数） |
| showValue | `boolean` | 否 | 显示当前值 |

### Switch
开关。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 是 | 标签文本 |
| description | `string` | 否 | 补充说明（max 500） |

### SegmentedControl
分段选择器。提交选中项的 value。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | `string` | 是 | 字段名 |
| label | `string` | 否 | 标签 |
| options | `array` | 是 | 选项列表，每项 `{ value, label }`，最多 100 项 |
| required | `boolean` | 否 | 是否必填 |

---

## 操作类

### Button
按钮。点击时触发引用的 action。

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| label | `string` | 是 | 按钮文本（max 100） |
| actionId | `string` | 是 | 引用 `spec.actions` 中定义的 action（**必须已定义**） |
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

### 信息展示面板（含新组件）

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "任务进度",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack", "props": { "gap": "md" }, "children": ["stats", "steps", "table", "progress"]
    },
    "stats": {
      "type": "Row", "props": { "gap": "sm" }, "children": ["stat1", "stat2"]
    },
    "stat1": {
      "type": "Stat", "props": { "label": "活跃用户", "value": "12,345", "tone": "info" }, "children": []
    },
    "stat2": {
      "type": "Stat", "props": { "label": "成功率", "value": "98.7", "unit": "%", "tone": "success" }, "children": []
    },
    "steps": {
      "type": "Steps", "props": {
        "items": [
          { "title": "构建" }, { "title": "测试" }, { "title": "部署" }
        ],
        "current": 1
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
          { "name": "构建", "status": "完成", "progress": "100%" },
          { "name": "测试", "status": "进行中", "progress": "80%" },
          { "name": "部署", "status": "等待中", "progress": "0%" }
        ]
      }, "children": []
    },
    "progress": {
      "type": "Progress", "props": { "value": 60, "label": "总体进度", "showValue": true },
      "children": []
    }
  }
}
```

### Tabs 多视图面板

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "项目概览",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack", "props": { "gap": "md" }, "children": ["tabs"]
    },
    "tabs": {
      "type": "Tabs", "props": {
        "items": [
          { "label": "概览", "value": "overview" },
          { "label": "团队", "value": "team" }
        ],
        "defaultIndex": 0
      },
      "children": ["tabOverview", "tabTeam"]
    },
    "tabOverview": {
      "type": "Stack", "props": { "gap": "sm" }, "children": ["overviewText"]
    },
    "overviewText": {
      "type": "Text", "props": { "content": "这是概览标签页。", "variant": "body" }, "children": []
    },
    "tabTeam": {
      "type": "Stack", "props": { "gap": "sm" }, "children": ["avatar1", "avatar2"]
    },
    "avatar1": {
      "type": "Avatar", "props": { "name": "张三", "size": "md" }, "children": []
    },
    "avatar2": {
      "type": "Avatar", "props": { "name": "Li Si", "size": "md" }, "children": []
    }
  }
}
```

### Accordion 折叠面板

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "设置",
  "root": "root",
  "elements": {
    "root": {
      "type": "Accordion", "props": {
        "items": [
          { "title": "基本设置" },
          { "title": "高级配置" },
          { "title": "安全设置" }
        ],
        "defaultOpen": [0]
      },
      "children": ["sectionBasic", "sectionAdvanced", "sectionSecurity"]
    },
    "sectionBasic": {
      "type": "Text", "props": { "content": "基本设置内容。" }, "children": []
    },
    "sectionAdvanced": {
      "type": "Text", "props": { "content": "高级配置内容。" }, "children": []
    },
    "sectionSecurity": {
      "type": "Text", "props": { "content": "安全设置内容。" }, "children": []
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
