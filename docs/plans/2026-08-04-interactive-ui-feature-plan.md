# Generative UI（Interactive UI）Feature 可执行方案

> 日期：2026-08-04  
> 状态：产品边界已重构，待按阶段实施  
> 取代：原“聊天内 `render_ui` + action 自动注入下一轮用户输入”方案

## 0. 结论先行

这项能力的本质不是“在工具结果里画一张可点击卡片”，也不是“建立一套新的 Agent 输入循环”，而是：

> **让 Agent 使用受限的声明式协议，创建和维护由宿主安全渲染的交互页面。页面默认作为右侧工作区中的持久 UI 独立运行；同一套 UI Spec 与 Renderer 还可以被现有 UserInput 机制复用，用于一次性的阻塞交互。**

产品由一个共享 UI 内核和两个语义独立的适配层组成：

```text
                         Generative UI Kernel
              Catalog + Schema + Validator + Renderer
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
       Persistent Surface Adapter          UserInput Adapter
       右侧面板、长期存在、工具不阻塞        临时请求、工具阻塞、一次提交
                 │                                 │
       普通交互默认不触发 Agent              复用现有 requestId/response
```

### 0.1 已确定的核心决策

| 问题 | 决策 |
|---|---|
| 产品主形态是什么 | 右侧 Feature Panel 中的持久 Generative UI Surface |
| 是否只做阻塞工具 | 否。阻塞式 UI Input 是第二适配层，不是整个产品 |
| 是否修改 ReAct / 核心 call 循环 | 持久 Surface 不修改；阻塞模式仅复用现有 UserInput 等待点 |
| 普通 UI 事件是否自动成为用户消息 | 否，禁止默认注入 |
| 用户何时触发新 Agent call | 仅点击明确标记为“提交给 Agent”的动作时；该动作形成可见的正常用户回合 |
| 阻塞 UI 提交是否创建新 call | 否。它解析当前 `requestId` 对应的 Promise，继续同一个 call |
| UI 放在哪里 | 持久模式放右侧固定 Tab；阻塞模式放现有 UserInput 区域 |
| 是否渲染在聊天历史中 | 不渲染真实交互页面；工具消息只显示简短操作摘要 |
| 是否引入 React | 第一版不引入，使用原生 DOM 和独立状态 Store |
| 更新方式 | 第一版按 Surface 全量 Spec 更新、按 `revision` 替换；不做 element patch |

## 1. 产品定义

### 1.1 用户问题

纯文本对话并不适合所有任务：

- 需要同时浏览多组结构化信息；
- 需要持续调整多个字段，而不是来回问答；
- 需要一个长期存在的仪表盘、配置页、结果页或操作台；
- 需要用户在当前推理步骤中填写比固定选项更丰富的输入。

现有 `UserInputFeature` 已经很好地解决了“Agent 当前必须等用户回答”的问题，但它的 UI 是预设的，表达能力有限。Generative UI 扩展的是**页面表达能力**，不另造输入循环。

### 1.2 一句话能力边界

`GenerativeUISurfaceFeature` 为 Agent 提供创建、读取、更新和关闭右侧持久交互页面的能力；`GenerativeUIInputFeature` 复用同一渲染内核，为现有 UserInput 增加可生成的复杂表单与布局。

### 1.3 用户可完成的目标

- Agent 创建一个长期存在的状态面板、配置表单、数据表格或操作台；
- 用户切换聊天、打开或关闭右侧面板后，Surface 仍然存在；
- Agent 使用相同 `surfaceId` 更新页面；用户未受影响的草稿字段得到保留；
- 用户在页面内完成筛选、切换、展开和填写等本地交互，不打扰 Agent；
- 用户通过明确的提交按钮，把选定字段作为一个可见用户回合交给 Agent；
- Agent 在确实必须等待用户时调用 `request_ui_input`，用户提交后同一工具调用返回结构化结果。

### 1.4 明确非目标

- 不允许运行 Agent 生成的 HTML、JavaScript、CSS 或任意前端代码；
- 不允许组件自行访问网络、文件系统、剪贴板或本地进程；
- 不让 UI Feature 接管 `Agent.onCall()`、`@CallStart`、`@StepFinish` 或消息消费逻辑；
- 不把每次 `click`、`change`、`input` 事件转成 Agent 消息；
- 不在第一版实现任意第三方组件、插件脚本、iframe 或远程页面；
- 不在第一版实现协同编辑、跨设备草稿同步和离线运行；
- 不声称 checkpoint rollback 会撤销已经发布到 UI 宿主的 Surface 更新。

## 2. 两种交互模式

### 2.1 模式对比

| 维度 | Persistent Surface | UI Input Request |
|---|---|---|
| 典型用途 | 仪表盘、配置页、结果浏览、长期操作台 | 当前步骤必须获取的表单、确认或选择 |
| 宿主位置 | 右侧 `Feature Panel` 固定 Tab | 现有 `#user-input-container` |
| Agent 工具 | `ui_surface_*` | `request_ui_input` |
| 工具是否阻塞 | 否 | 是 |
| 身份 | `agentId + surfaceId + revision` | `agentId + requestId` |
| 生命周期 | 跨多个 call，直到关闭或会话删除 | 一次提交、取消、超时或中断后结束 |
| 普通交互 | 前端本地处理 | 前端本地处理，直到最终提交 |
| 最终提交 | 显式创建一个新的、可见的用户回合 | 解析当前等待请求，不创建新 call |
| 与聊天历史关系 | 工具历史只记录创建/更新摘要 | 工具历史记录“等待/已完成”，请求本体不长期可操作 |

### 2.2 持久 Surface 回路

```text
Agent 调用 ui_surface_upsert(spec)
  → Feature 校验并 PUT 到 AgentDevClaw SurfaceStore
  → 工具立即返回 { ok, surfaceId, revision }
  → 前端轮询发现 registryRevision 变化
  → 右侧 Generative UI Tab 挂载/更新 Surface
  → 用户进行本地交互，不触发 Agent
  → [可选] 用户点击明确的“提交给 Agent”按钮
  → Surface Action Adapter 校验 action + revision + values
  → 复用现有 queue-input 通道，形成可见用户回合
```

### 2.3 阻塞 UI Input 回路

```text
Agent 独占调用 request_ui_input(prompt, spec)
  → 通过 UserInputFeature.requestUserInputEvent() 创建 requestId
  → DebugHub / ViewerWorker 保存 pending request
  → 前端用同一个 Generative UI Renderer 渲染请求
  → 用户填写并提交
  → POST /api/agents/:agentId/input { requestId, response }
  → 对应 Promise resolve
  → request_ui_input 返回 { actionId, values }
  → 同一个 Agent call 进入下一 ReAct step
```

### 2.4 必须保持的不变量

1. `Generative UI Kernel` 不依赖 Agent、Context、UserInput 或输入框模块。
2. `GenerativeUISurfaceFeature` 没有 call/step hooks，不读取或改写用户输入。
3. 持久页面的 `input`、`change`、Tab 切换和展开收起永远不会自动触发 Agent。
4. 只有 `intent: "submit"` 的显式按钮能进入宿主提交适配器。
5. Surface 宿主把 `submit` 转为新的正常用户回合；Input 宿主把 `submit` 转为当前请求响应。
6. 当前存在阻塞 UserInput 请求时，持久 Surface 的 Agent 提交按钮禁用；本地交互仍可继续。
7. Surface 更新不抢走正在输入的焦点，不关闭 UserInput，不自动中断正在运行的 call。
8. 所有交互内容必须来自 Catalog 白名单和通过校验的纯数据。

## 3. 总体架构

```text
┌──────────────────────── Agent 进程 ─────────────────────────┐
│                                                             │
│  GenerativeUISurfaceFeature       GenerativeUIInputFeature  │
│  - ui_surface_upsert              - request_ui_input        │
│  - ui_surface_get                 - 依赖 user-input API      │
│  - ui_surface_list                                         │
│  - ui_surface_close                                        │
│             │                              │                │
│    HttpSurfaceTransport            UserInputFeature API     │
└─────────────┼──────────────────────────────┼────────────────┘
              │                              │
              ▼                              ▼
┌────────────────────── AgentDevClaw Server ───────────────────┐
│ SurfaceStore + routes                   Viewer proxy          │
│ - 按 agentId/surfaceId 保存最新 Spec     /input-requests      │
│ - revision / ETag / 幂等                 /input               │
│ - 持久 Surface action 校验               /queue-input         │
└──────────────────────┬──────────────────────────┬────────────┘
                       │                          │
                       ▼                          ▼
┌──────────────────────── Web UI ──────────────────────────────┐
│  Generative UI Panel                    UserInput Host        │
│  - 固定右侧 Tab                          - 临时请求区域        │
│  - Surface selector                     - requestId 生命周期 │
│  - SurfaceViewState                              │            │
│                 └──────── Shared DOM Renderer ───┘            │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 责任划分

| 模块 | 只负责 | 不负责 |
|---|---|---|
| Catalog / Schema | 组件、属性、布局 token、限制、Spec 校验 | Agent 调用、网络、DOM |
| Renderer | 把已校验 Spec 和 ViewState 转成 DOM；发出语义 action | 决定是否调用 Agent |
| Surface Feature | Agent 工具契约、Spec 校验、调用 SurfaceTransport | 前端状态、UserInput、call hooks |
| SurfaceStore | Surface 最新版本、revision、查询和关闭 | Agent 推理、表单草稿 |
| Surface Panel Host | 面板生命周期、Surface 切换、草稿和焦点 | 解析 UserInput Promise |
| Surface Action Adapter | 校验显式提交并复用正常用户消息通道 | 处理普通 UI 事件 |
| UI Input Adapter | 将 Spec 放入现有 UserInput 请求并等待响应 | 创建第二条消息队列 |

### 3.2 为什么持久 Surface 不通过 tool result 携带页面

工具结果仍会记录简短摘要，但不再作为真实 Surface 的存储与渲染来源。原因：

- 聊天消息是历史记录，不适合表达“同一个页面的最新状态”；
- 上下文压缩和消息裁剪会让页面意外消失；
- 相同 `surfaceId` 的多条历史 tool result 会产生多个可操作副本；
- 聊天渲染刷新会破坏表单草稿、焦点和局部交互状态；
- 将页面放入独立 Store 后，UI 生命周期与 Agent 消息生命周期自然解耦。

因此工具结果只返回：

```json
{
  "ok": true,
  "surface": {
    "surfaceId": "release-center",
    "revision": 3,
    "status": "active",
    "placement": "right-panel"
  }
}
```

## 4. 共享 UI Spec

### 4.1 顶层结构

```ts
interface GenerativeUISpecV1 {
  schemaVersion: 1;
  catalogVersion: 'v1';
  title: string;
  description?: string;
  root: string;
  elements: Record<string, GenerativeUIElement>;
  initialValues?: Record<string, PrimitiveValue>;
  actions?: Record<string, GenerativeUIAction>;
}

type PrimitiveValue = string | number | boolean | null;

interface GenerativeUIElement {
  type: CatalogComponentType;
  props: Record<string, unknown>;
  children: string[];
}

interface GenerativeUIAction {
  intent: 'submit' | 'reset';
  label: string;
  includeFields?: string[];
  confirm?: {
    title: string;
    description?: string;
    confirmLabel?: string;
  };
}
```

`intent` 只描述用户意图，不直接描述 Agent 运行机制：

- `reset`：Renderer 本地重置指定字段，不离开浏览器；
- `submit`：交给当前宿主处理。Surface Host 创建正常用户回合，Input Host 解析当前 `requestId`。

第一版不支持任意 `setState(path, value)` 表达式，避免引入第二套前端编程语言。Tabs、表单输入、展开收起等常见状态由组件自身处理。

### 4.2 示例

```json
{
  "schemaVersion": 1,
  "catalogVersion": "v1",
  "title": "发布中心",
  "description": "检查参数并提交发布请求",
  "root": "page",
  "elements": {
    "page": {
      "type": "Stack",
      "props": { "gap": "md" },
      "children": ["summary", "environment", "dryRun", "actions"]
    },
    "summary": {
      "type": "Card",
      "props": { "title": "待发布版本" },
      "children": ["version"]
    },
    "version": {
      "type": "Text",
      "props": { "content": "v1.8.0", "variant": "heading" },
      "children": []
    },
    "environment": {
      "type": "Select",
      "props": {
        "name": "environment",
        "label": "环境",
        "options": [
          { "value": "staging", "label": "Staging" },
          { "value": "production", "label": "Production" }
        ],
        "required": true
      },
      "children": []
    },
    "dryRun": {
      "type": "Checkbox",
      "props": { "name": "dryRun", "label": "先执行预检" },
      "children": []
    },
    "actions": {
      "type": "Button",
      "props": { "label": "提交给 Agent", "actionId": "submit-release", "variant": "primary" },
      "children": []
    }
  },
  "initialValues": {
    "environment": "staging",
    "dryRun": true
  },
  "actions": {
    "submit-release": {
      "intent": "submit",
      "label": "提交发布配置",
      "includeFields": ["environment", "dryRun"],
      "confirm": {
        "title": "提交给 Agent？",
        "description": "这会创建一条新的用户消息，但不会自动中断正在执行的任务。"
      }
    }
  }
}
```

### 4.3 V1 Catalog

| 类别 | 组件 | 关键属性 |
|---|---|---|
| 布局 | `Stack` | `gap: xs/sm/md/lg`, `align: start/center/end/stretch` |
| 布局 | `Row` | `gap`, `align`, `wrap: boolean` |
| 布局 | `Grid` | `columns: 1..4`, `gap` |
| 布局 | `Card` | `title?: string`, `variant: default/subtle/emphasis` |
| 布局 | `Divider` | 无动态属性 |
| 展示 | `Text` | `content`, `variant: body/caption/heading/code`, `tone` |
| 展示 | `Badge` | `text`, `variant: default/success/warning/danger/info` |
| 展示 | `Table` | `columns`, `rows`，只读且有行列上限 |
| 输入 | `TextInput` | `name`, `label`, `placeholder`, `required`, `minLength`, `maxLength` |
| 输入 | `NumberInput` | `name`, `label`, `min`, `max`, `step`, `required` |
| 输入 | `Textarea` | `name`, `label`, `rows: 2..12`, `maxLength`, `required` |
| 输入 | `Select` | `name`, `label`, `options`, `required` |
| 输入 | `Checkbox` | `name`, `label` |
| 输入 | `RadioGroup` | `name`, `label`, `options`, `required` |
| 操作 | `Button` | `label`, `actionId`, `variant`, `disabled?: boolean` |

V1 暂不包含 `Image`、`Markdown`、`HTML`、`Link`、`FileInput`、`PasswordInput`、`Chart` 和 `iframe`。这些组件涉及远程资源、内容清洗、秘密数据或额外渲染依赖，单独评审后再加入。

### 4.4 Catalog 单一来源

Catalog 不能分别手写在工具描述、服务端校验器和前端渲染器中。实现时以 `local-features/generative-ui/src/catalog.ts` 为唯一语义来源，并生成或导出：

- 工具参数使用的 JSON Schema；
- 服务端使用的 Spec Validator；
- Agent 可阅读的精简 Catalog 文本；
- 前端 Renderer 的组件名/版本契约测试数据。

前端每个组件仍有独立渲染函数，但测试必须断言 Renderer 支持 Catalog 中全部组件，且没有额外未声明组件。

### 4.5 强制限制

| 项目 | V1 上限 |
|---|---:|
| 每个 Agent 活跃 Surface | 8 |
| 每个 Surface 元素数 | 200 |
| 最大树深度 | 20 |
| 单个 Spec 序列化大小 | 256 KiB |
| 单个文本属性 | 10,000 字符 |
| 表格 | 20 列 × 100 行 |
| Select / Radio 选项 | 100 |
| 单次提交值大小 | 64 KiB |
| ID 长度 | 1–64，`^[a-zA-Z][a-zA-Z0-9_-]*$` |

Validator 必须检查：根节点存在、所有 child 引用存在、无环、无孤立节点、每个节点最多一个父节点、组件 props 符合对应分支、字段名不重复、Button 引用的 action 存在、action 引用的字段存在、限制未超出。

## 5. Feature 与工具契约

### 5.1 Feature 拆分

共享内核不是独立 Feature；它是纯类型、Catalog、校验器和 Renderer 契约。

#### `GenerativeUISurfaceFeature`

- `name = 'generative-ui-surface'`；
- 无 dependencies；
- 无 call/step hooks；
- `onInitiate()` 只解析配置、保存 logger 和创建 HTTP transport；
- 不实现 `captureState()`：SurfaceStore 是宿主侧外部状态，checkpoint rollback 不伪装成撤销它；
- 写工具串行，读工具可以 `parallelizable: true`；
- 宿主不可用时返回结构化降级结果，Agent 应回退到文本。

#### `GenerativeUIInputFeature`

- `name = 'generative-ui-input'`；
- `dependencies = ['user-input']`；
- `onInitiate()` 通过 `ctx.getFeature('user-input')` 获取最小公开 API；
- 只提供 `request_ui_input`；
- 工具标记 `executionMode: 'exclusive'`；
- 不创建自己的 pending Promise、请求队列或输入路由。

需要在 AgentDev 中正式导出最小接口：

```ts
export interface UserInputFeatureApi {
  requestUserInputEvent(
    request: UserInputRequest,
    timeout?: number,
  ): Promise<UserInputResponse>;
}
```

### 5.2 `ui_surface_upsert`

用途：创建 Surface，或用完整新 Spec 替换同一 `surfaceId` 的当前版本。

```ts
interface UISurfaceUpsertArgs {
  surfaceId: string;
  spec: GenerativeUISpecV1;
  expectedRevision?: number;
  presentation?: {
    open?: 'never' | 'if-empty' | 'request';
  };
}
```

语义：

- `expectedRevision` 缺省时允许无条件 upsert；存在时做乐观并发检查；
- 相同 `surfaceId + 内容哈希` 的重试返回原 revision，不重复递增；
- `presentation.open = request` 只是请求宿主打开，宿主可因焦点保护或阻塞输入而拒绝；
- 工具返回摘要，不返回完整 Spec，避免污染 Context；
- 不标记 `parallelizable`。

成功：

```json
{
  "ok": true,
  "surface": {
    "surfaceId": "release-center",
    "revision": 3,
    "status": "active",
    "placement": "right-panel",
    "changed": true
  }
}
```

业务失败：`invalid_spec`、`revision_conflict`、`surface_limit`、`payload_too_large`、`surface_host_unavailable`。

### 5.3 `ui_surface_get`

- 参数：`surfaceId`；
- 返回当前 revision、metadata 和完整 Spec；
- `parallelizable: true`；
- 用于 Agent 在上下文压缩或接管已有会话后恢复对页面的认识；
- `not_found` 使用结构化业务失败。

### 5.4 `ui_surface_list`

- 无必填参数；可选 `includeClosed: false`；
- 只返回 `surfaceId/title/revision/updatedAt/status`，不返回完整 Spec；
- `parallelizable: true`；
- 最大 8 条，不需要分页。

### 5.5 `ui_surface_close`

- 参数：`surfaceId`、可选 `expectedRevision`；
- 幂等：已经关闭时返回 `ok: true, alreadyClosed: true`；
- 不标记 `parallelizable`；
- 关闭仅移除活动 Surface，不删除聊天中的工具审计记录。

### 5.6 `request_ui_input`

```ts
interface RequestUIInputArgs {
  prompt: string;
  spec: GenerativeUISpecV1;
  timeoutMs?: number;
}
```

执行：

```ts
const response = await userInput.requestUserInputEvent({
  prompt,
  mode: 'ui',
  ui: { spec },
}, timeoutMs);

return {
  ok: true,
  actionId: response.actionId,
  values: response.payload?.values ?? {},
};
```

约束：

- `executionMode: 'exclusive'`；
- Spec 至少有一个 `intent: 'submit'` 的 action；
- 响应只包含 action 声明的 `includeFields`；
- 用户取消返回 `{ ok: false, code: 'cancelled' }`，超时与 Agent interrupt 分开表达；
- 工具描述明确：普通单选优先用现有 `ask_user_choice`，只有布局或输入确实更复杂时才调用。

### 5.7 Feature 配置

```ts
interface GenerativeUISurfaceFeatureConfig {
  enabled?: boolean;                  // default true
  maxSurfaces?: number;               // default 8, hard max 16
  allowAgentSubmit?: boolean;          // default true
  autoOpenPolicy?: 'never' | 'first';  // default first
  serverOrigin?: string;               // 构造参数/env 优先，不在 UI 中展示 secret
}
```

优先级：显式构造参数 > `ctx.featureConfig` > `PROTOCLAW_SERVER_ORIGIN` > `http://127.0.0.1:1420`。`getFeatureManifest()` 声明的默认值必须在 `onInitiate()` 中真实应用。

`serverOrigin` 属于部署连接参数，不由 Agent 工具参数控制，也不应作为普通可编辑字段暴露给 Agent。Transport 只接受明确允许的 `http/https` origin，拒绝 URL userinfo 和非预期 redirect；本地默认配置仅连接 loopback 上的 AgentDevClaw Server。

## 6. Persistent Surface 详细设计

### 6.1 SurfaceStore

V1 的权威状态由 AgentDevClaw Server 持有：

```ts
interface UISurfaceRecord {
  agentId: string;
  surfaceId: string;
  revision: number;
  status: 'active' | 'closed';
  spec: GenerativeUISpecV1;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  presentation: { open: 'never' | 'if-empty' | 'request' };
}

interface UIRegistrySnapshot {
  agentId: string;
  registryRevision: number;
  surfaces: UISurfaceRecord[];
}
```

状态范围：

- 按 runtime `agentId` 隔离；
- 跨多个 Agent call、前端重渲染和面板开关保留；
- Agent 会话删除时清理；
- V1 为服务进程内存状态，服务重启后不恢复；
- “跨服务重启持久化”是后续能力，不与“跨 call 持久存在”混为一谈。

### 6.2 HTTP 路由

Agent Feature 和 Web UI 共用同一 Store，但能力分开：

| 方法 | 路径 | 调用方 | 用途 |
|---|---|---|---|
| `PUT` | `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | Feature | 校验并 upsert |
| `GET` | `/protoclaw/agents/:agentId/ui-surfaces` | Feature / Web | 获取 registry；支持 ETag |
| `GET` | `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | Feature | 获取单个 Surface |
| `DELETE` | `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | Feature | 幂等关闭 |
| `POST` | `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId/actions/:actionId` | Web | 显式提交动作 |

实现要求：

- 所有写请求再次执行服务端校验，不能只依赖工具 schema；
- `PUT` 返回 revision 和 ETag；`GET` 支持 `If-None-Match`；
- action 请求必须携带 `surfaceRevision` 和 `eventId`；
- 服务端只接受当前 Spec 中存在的 action 和允许字段；
- 通过短期 LRU 记录 `eventId`，避免双击或网络重试创建重复用户消息；
- Agent 会话不存在、已删除或 action revision 过期时 fail closed。

### 6.3 Feature 到 Server 的 Transport

`HttpSurfaceTransport` 是可替换适配器：

```ts
interface SurfaceTransport {
  upsert(agentId: string, input: UISurfaceUpsertInput, signal?: AbortSignal): Promise<UISurfaceRecord>;
  get(agentId: string, surfaceId: string, signal?: AbortSignal): Promise<UISurfaceRecord | null>;
  list(agentId: string, signal?: AbortSignal): Promise<UISurfaceSummary[]>;
  close(agentId: string, surfaceId: string, expectedRevision?: number, signal?: AbortSignal): Promise<CloseResult>;
}
```

- `agentId` 使用 `DebugHub.getInstance().getCurrentAgentId()` 获取；不存在时返回 `surface_host_unavailable`；
- HTTP 请求设置 5 秒超时，并与工具 `context.signal` 组合；
- 不自动重试未知写结果；upsert 的内容哈希和 close 的幂等语义允许 Agent 安全重试；
- Feature 不暴露 transport、内部 Store 或 mutable Map。

### 6.4 右侧面板接入

仓库已经存在：

- `public/index.html` 中的 `.right-workspace`、`#feature-panel`、`#feature-panel-body` 和 `.right-rail`；
- `public/src/app-ui.js` 中的 `featurePanels` 注册表；
- `public/src/modules/debug-panel-host.js` 中的 `renderFeaturePanel()` / `toggleFeaturePanel()`。

新增一个固定 Rail Button：`data-panel="generative-ui"`。一个 Tab 内通过 Surface selector 切换多个 Surface，V1 不动态创建多个 Rail Button。

现有 Panel Host 每次使用 `innerHTML = panel.render()` 替换整个 body，会破坏交互状态。实施时把 Panel 注册契约轻量扩展为：

```ts
interface FeaturePanelDefinition {
  title: string | (() => string);
  render(): string;
  afterRender?(body: HTMLElement): void;
  onOpen?(): void | Promise<void>;
  onClose?(): void;
}
```

Generative UI Panel 的 `render()` 只返回稳定挂载点，`afterRender()` 调用 Renderer。Surface 数据变化时只 patch 该挂载点，不调用全局聊天 render。

### 6.5 前端状态分层

```text
Server Surface State
  spec / revision / active surfaces

Frontend Registry Cache
  agentId -> registryRevision -> surface snapshots

Frontend View State（不上传）
  agentId + surfaceId -> field values / dirty fields / selected tab / scroll
```

草稿规则：

- 输入值默认只保存在浏览器内存，不自动上传；
- Surface revision 更新后，相同 `name` 且输入类型兼容的 dirty value 保留；
- 新字段使用 `initialValues`；删除字段清理其草稿；
- Agent 不能通过一次普通 upsert 静默覆盖用户正在编辑的 dirty 字段；
- 提交成功后是否清空由 action 的后续策略决定，V1 默认保留，直到 Agent 更新或用户 reset。

### 6.6 打开与焦点策略

- 没有 Surface 时 Rail Button 隐藏或 disabled；
- 第一个 Surface 创建后显示 Rail Button 和 badge；
- `autoOpenPolicy = first` 时，仅当前 Agent 的第一个 Surface 可以请求打开；
- 正在输入聊天消息、正在编辑另一个 Surface、存在阻塞 UserInput、用户刚主动关闭面板时，不自动打开；
- 后续更新只更新 badge，不抢焦点；
- 切换 Agent 时按对应 `agentId` 加载 Surface，不串台。

### 6.7 显式提交给 Agent

持久 Surface 的 `intent: 'submit'` 是唯一允许触发 Agent 的页面动作。

提交步骤：

1. Renderer 做字段级校验；
2. 如 action 声明 `confirm`，展示明确确认层；
3. Web 发送 `{ eventId, surfaceRevision, values }` 到 Surface action 路由；
4. Server 按保存的 Spec 再校验 action、revision 和字段白名单；
5. Server 构造用户可读、Agent 可解析的规范消息；
6. 复用现有 `/api/agents/:agentId/queue-input`；
7. 消息必须作为可见用户回合出现在聊天中；
8. Agent 正在运行时正常排队，不自动 interrupt。

规范消息示例：

```text
通过右侧页面「发布中心」执行「提交发布配置」。

surfaceId: release-center
surfaceRevision: 3
actionId: submit-release
values:
{"environment":"production","dryRun":true}
```

这不是“UI Feature 偷偷注入输入”，而是用户点击了语义明确的提交按钮后，走现有正常消息入口。UI Kernel 和 Surface Feature 本身都不依赖该入口；只有 Action Adapter 依赖。

### 6.8 与阻塞 UserInput 的冲突策略

| 状态 | Surface 本地交互 | Surface 提交给 Agent | 阻塞请求提交 |
|---|---:|---:|---:|
| Agent 空闲，无 pending request | 允许 | 立即创建 call | 不适用 |
| Agent 正在运行，无 pending request | 允许 | 进入现有队列 | 不适用 |
| 存在 pending UserInput request | 允许 | 禁用并提示先完成当前请求 | 解析当前 request |
| Agent interrupt / request 已取消 | 允许 | 按正常空闲/运行状态处理 | 拒绝 stale requestId |

## 7. UI Input Adapter 详细设计

### 7.1 复用而不是重建

当前 `UserInputFeature` 已具备正确生命周期：

- `DebugHub.pendingInputRequests` 按 `requestId` 保存 resolver；
- `request-input` 发送到 ViewerWorker；
- ViewerWorker 在 AgentSession 中保存 pending request；
- Web 通过 `/input-requests` 获取请求；
- `/input` 返回 `input-response`；
- 原 Promise resolve，工具继续。

Generative UI Input 只扩展 request payload 和前端 renderer，不新增另一套等待 Map、HTTP 路由或 call 机制。

### 7.2 AgentDev 最小上游改动

在 AgentDev 实际源码仓库中修改，不直接编辑本项目的 `node_modules`：

```ts
export type UserInputRequestMode = 'text' | 'choices' | 'ui';

export interface UserInputRequest {
  // existing fields...
  ui?: {
    spec: GenerativeUISpecV1;
  };
}
```

需要同步透传 `ui` 字段的位置：

- `src/core/types.ts`：request 类型、`RequestInputMsg`、`ActiveInputRequest`；
- `src/core/debug-hub.ts`：active request 保存、`request-input` 发送、重连恢复；
- `src/core/viewer-worker.ts`：pending request 保存与 GET 返回；
- `src/core/claw-debug-client.ts`：Claw transport 请求序列化；
- UserInput 单元测试与 ViewerWorker 路由测试。

响应可以复用现有 `UserInputResponse.kind = 'action'`：

```json
{
  "kind": "action",
  "actionId": "submit-release",
  "payload": {
    "values": {
      "environment": "production",
      "dryRun": true
    }
  }
}
```

无需新增 `ui-input-response` 消息类型。

### 7.3 前端渲染

`renderInputRequests()` 识别 `request.mode === 'ui'` 后：

- 在现有 UserInput Card 内创建独立 mount point；
- 调用共享 Renderer，host mode 设为 `input`；
- `reset` 仍为本地动作；
- `submit` 调用 `/api/agents/:agentId/input` 并携带 `requestId`；
- 请求完成后立即清除 ViewState 和 DOM；
- 历史工具消息只显示“用户已完成交互”，不保留可再次提交的表单。

## 8. 与 Agent 循环的边界

### 8.1 不使用 hooks 的原因

Surface 创建和更新是 Agent 主动选择的领域动作，应由工具表达；它不是每个 call 或 step 都必须发生的框架策略。因此：

- 不使用 `@CallStart` 改写输入；
- 不使用 `@StepStart` 注入 Surface 事件；
- 不使用 `@StepFinish` 强制续跑；
- 不注册 continuation；
- 不让后台 UI 事件并发修改 Context。

### 8.2 三种“用户动作”必须区分

| 动作 | 是否产生 Agent 输入 | 运行机制 |
|---|---:|---|
| Surface 内筛选、编辑、切换、reset | 否 | 浏览器 ViewState |
| Surface 显式 submit | 是，新用户回合 | 现有 queue-input / call arbitration |
| pending UI Input submit | 否，不创建新回合 | 现有 requestId resolver |

任何实现如果不能清楚判断自己属于哪一行，就不应合入。

## 9. 状态、恢复、并发与中断

### 9.1 状态所有权

| 状态 | 所有者 | 是否进入 Feature snapshot |
|---|---|---:|
| Surface Spec / revision | AgentDevClaw SurfaceStore | 否 |
| 表单草稿 / selected tab / scroll | Web ViewState | 否 |
| pending UI Input resolver | UserInputFeature / DebugHub | 否，按现有重连机制恢复描述 |
| 工具配置、readiness | Feature 实例 | 无需快照 |
| HTTP client / AbortController | Transport 调用 | 否 |

### 9.2 Session 与 rollback

- 同一 runtime `agentId` 下跨 call 保留 Surface；
- Viewer/Agent 暂时断开不立即删除 Surface；
- 明确删除 Agent session 时同步清理 SurfaceStore；
- step rollback 不回滚已发布的 Surface，这是外部 UI 副作用；
- rollback 后 Agent 如需恢复页面，显式再次调用 `ui_surface_upsert`；
- V1 不宣称服务重启恢复，后续若需要持久化，再定义磁盘 schema 和迁移策略。

### 9.3 并发

- `upsert` / `close` 不标记 parallelizable；
- `get` / `list` 可以 parallelizable；
- `expectedRevision` 防止旧页面覆盖新页面；
- 前端 action 携带 `surfaceRevision`，过期提交返回 `409 stale_surface`；
- `eventId` 去重防止重复创建用户回合；
- `request_ui_input` 为 exclusive，禁止与其他工具同批调用。

### 9.4 中断与超时

- 所有 HTTP transport 接收工具 `context.signal`；
- abort 前未提交的请求停止；服务端已经接受的 upsert 不声称被撤销；
- `request_ui_input` 的用户取消、超时和 Agent interrupt 分别返回 `cancelled`、`timeout`、`aborted`；
- pending request 结束后，旧 `requestId` 的重复提交必须拒绝。

## 10. 安全、隐私与可访问性

### 10.1 渲染安全

- 只使用 `document.createElement`、`textContent`、`setAttribute` 的允许子集；
- 不使用 Agent 内容拼接 `innerHTML`；
- 不允许任意 tag、class、style、事件名、URL 或 data attribute；
- 不执行表达式、模板字符串、脚本、Markdown HTML 或 CSS；
- 未知组件、未知 props、Catalog 版本不匹配时整张 Surface fail closed，并显示安全错误卡片。

### 10.2 请求安全

- Agent 生成的工具参数、前端 action payload、session 中恢复的数据全部视为不可信；
- schema 校验之外，服务端再次校验大小、ID、revision、字段白名单和 Agent 归属；
- action 只接受当前 Spec 声明的字段，拒绝额外字段；
- 限制请求 body；超限返回 `413`；
- 同源请求并检查 JSON content type；
- 日志不记录完整 Spec、表单正文或潜在秘密，只记录 ID、revision、字节数和计数。

V1 的威胁模型是“同一台设备、同一位登录用户、同源 AgentDevClaw UI”。按 `agentId` 隔离用于防止数据串台和错误路由，不等同于多租户鉴权。如果 Server 将来允许远程访问，必须在开放前增加会话身份、Surface capability 或等价授权校验，不能仅凭 URL 中的 `agentId` 授权。

### 10.3 隐私

- 表单草稿默认不上传；
- 没有显式 submit 就不会进入 Context；
- V1 不提供 PasswordInput/FileInput；
- 确认层展示即将提交给 Agent 的字段摘要；
- Agent 提交动作生成的用户消息在聊天中可见、可审计。

### 10.4 可访问性

- 输入组件必须有 `<label for>`；
- Button、Select、RadioGroup 支持键盘；
- 校验错误通过 `aria-describedby` 关联；
- Surface 更新使用非打断式 `aria-live="polite"`；
- 切换 Surface 后焦点进入标题，revision 更新不强制移动焦点；
- 颜色不是成功/危险状态的唯一表达方式。

## 11. 可观测性与降级

### 11.1 Feature 日志

使用 `ctx.logger`，统一字段：

```text
operation: surface_upsert | surface_get | surface_list | surface_close | ui_input_request
surfaceId / requestId
revision
nodeCount
payloadBytes
durationMs
result: success | unchanged | conflict | rejected | unavailable | aborted
errorCode
```

不记录 Spec 正文和 values。

### 11.2 前端诊断

右侧面板需区分：

- 当前 Agent 无 Surface；
- Surface host unavailable；
- Spec invalid / catalog mismatch；
- Surface revision 已过期，正在刷新；
- 当前有阻塞 UserInput，提交按钮暂不可用；
- Agent 离线，但页面仍可本地浏览。

### 11.3 降级策略

- Surface host 不可用：工具返回 `surface_host_unavailable`，Agent 回退为文本或 Markdown；
- 当前渠道没有 Web UI：不要反复调用 Surface 工具；
- 某个 Surface 非法：只隔离该 Surface，不破坏其他 Panel；
- UI Input 渲染失败：请求不自动转成普通文本答案，向用户显示错误和取消入口，避免提交错误数据。

## 12. 文件级实施清单

### 12.1 AgentDevClaw 新增文件

| 文件 | 职责 |
|---|---|
| `local-features/generative-ui/src/types.ts` | Spec、Surface、Transport、结果类型 |
| `local-features/generative-ui/src/catalog.ts` | Catalog 单一语义来源、JSON Schema 生成 |
| `local-features/generative-ui/src/validator.ts` | 结构、图、上限和 action 校验 |
| `local-features/generative-ui/src/transport.ts` | `HttpSurfaceTransport` |
| `local-features/generative-ui/src/surface-service.ts` | 领域服务、错误归一化 |
| `local-features/generative-ui/src/surface-feature.ts` | `GenerativeUISurfaceFeature` 装配 |
| `local-features/generative-ui/src/input-feature.ts` | `GenerativeUIInputFeature` 装配 |
| `local-features/generative-ui/src/index.ts` | 包根导出 |
| `local-features/generative-ui/test/*.test.ts` | Catalog、Validator、工具、Transport 测试 |
| `local-features/generative-ui/skills/use-generative-ui/SKILL.md` | 教 Agent 区分持久 Surface、阻塞 UI Input 与普通文本回复 |
| `server/ui-surface-store.js` | 按 agent 隔离、revision、hash、event 去重 |
| `server/routes/ui-surfaces.js` | Surface CRUD 和显式 action 路由 |
| `public/src/modules/generative-ui-renderer.js` | 纯 DOM Renderer 和组件实现 |
| `public/src/modules/generative-ui-state.js` | Registry cache、ViewState、dirty merge |
| `public/src/modules/generative-ui-panel.js` | Feature Panel 注册、selector、mount 生命周期 |
| `public/src/modules/generative-ui-actions.js` | 本地 reset、Surface submit、Input submit host adapter |
| `public/styles/generative-ui.css` | token 化布局、组件、响应式和无障碍样式 |
| `test/ui-surface-store.test.js` | Store、revision、幂等和隔离测试 |
| `test/ui-surface-routes.test.js` | 路由校验、stale action、去重测试 |
| `test/generative-ui-frontend.test.js` | DOM、草稿保留、宿主语义测试 |

### 12.2 AgentDevClaw 修改文件

| 文件 | 改动 |
|---|---|
| `local-features/tsconfig.json` | include generative-ui 源码与测试 |
| `local-features/index.ts` | 导出两个 Feature 和公共类型 |
| `server.js` | 注册 Surface routes；删除 Agent session 时清理 Store |
| `public/index.html` | 增加固定 Rail Button、脚本和样式 |
| `public/src/app-ui.js` | 注册 `generative-ui` Panel |
| `public/src/modules/debug-panel-host.js` | 泛化 `onOpen/onClose/afterRender` 生命周期 |
| `public/src/app-main.js` | 按 agent 轮询 registry revision；该 Panel 不请求 hooks 数据 |
| `public/src/modules/input-render.js` | `mode: ui` 路由到共享 Renderer |
| `prebuilt-agents/official/programming-helper/agent.js` | 挂载 `GenerativeUISurfaceFeature`；输入适配层在上游支持后再挂载 |
| `package.json` | 将新增测试加入现有 build/test 流程；需要 DOM 测试时增加明确 dev dependency |

明确不修改：

- `public/src/modules/chat-renderer.js`：不在聊天流中渲染真实 Surface；
- `template-engine.js`：Generative UI 不是 Tool HTML Template；
- Agent 的 call/step 主循环：不增加 UI 专用分支；
- `queue-input` 消费逻辑：显式 action 只调用现有入口，不改变其语义。

### 12.3 AgentDev 上游修改

| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | `mode: 'ui'`、`ui.spec`、ActiveInputRequest 透传类型 |
| `src/core/debug-hub.ts` | 保存、发送和重连恢复 `ui` 字段 |
| `src/core/viewer-worker.ts` | pending request 存取 `ui` 字段 |
| `src/core/claw-debug-client.ts` | Claw transport 透传 `ui` 字段 |
| `src/features/user-input/index.ts` | 导出正式 `UserInputFeatureApi`，保持旧工具兼容 |
| 对应测试 | text/choices 行为不回归，ui payload 往返完整 |

开发时使用本仓库的 AgentDev local-link 脚本连接实际源码；禁止直接修改 `node_modules/agentdev` 作为最终交付。

## 13. 分阶段执行计划

### Phase 0：冻结契约与测试夹具

目标：先让“什么是 Surface、什么是 Input、什么会触发 Agent”成为可测试契约。

任务：

1. 定义 V1 Spec、Catalog、限制、错误码和示例；
2. 实现纯 `validateGenerativeUISpec()`；
3. 定义 `SurfaceTransport` 和假 Transport；
4. 为工具名、schema、结果形状、executionMode 写契约测试；
5. 写一份 Feature skill，说明何时使用持久 Surface、何时使用 UserInput、何时直接文本回复。

退出标准：

- 非法引用、循环、未知组件、超限和 action 字段越权均被测试拒绝；
- 单看工具描述，Agent 能区分 `ui_surface_upsert` 与 `request_ui_input`；
- 文档和类型中不存在“普通 action 自动注入下一轮输入”的表述。

### Phase 1：持久 Surface 后端闭环

目标：Agent 可以创建、读取、列出、更新和关闭独立于聊天消息的 Surface。

任务：

1. 实现 SurfaceStore；
2. 实现 CRUD routes、revision、hash 幂等、大小限制；
3. 实现 `HttpSurfaceTransport` 和四个 `ui_surface_*` 工具；
4. 接入 logger、AbortSignal、配置和结构化错误；
5. 在 programming-helper 挂载 Surface Feature；
6. 完成 Store、route、Feature 单元测试。

退出标准：

- upsert 工具在 5 秒内返回，不等待用户；
- 同内容重试不产生新 revision；
- Agent 间 Store 严格隔离；
- 宿主不可用时 Agent 获得可降级错误；
- 不改聊天 renderer 和输入循环。

### Phase 2：右侧 Panel 与共享 Renderer

目标：右侧固定 Tab 可以稳定承载多个持久 Surface。

任务：

1. 扩展 Feature Panel 生命周期；
2. 增加 Rail Button、badge 和 Surface selector；
3. 实现 V1 组件 Renderer；
4. 实现 Registry Cache 和 ViewState；
5. 将 Surface registry 接入主轮询，使用 revision/ETag 避免无变化重绘；
6. 实现草稿保留、焦点保护、Agent 切换隔离和错误态；
7. 完成 DOM contract tests。

退出标准：

- Agent 创建 Surface 后右侧入口出现；
- 相同 `surfaceId` 更新原页面，不在聊天中产生第二份页面；
- 无变化 poll 不替换 DOM；
- 更新后 dirty 字段、焦点和 Surface 选择符合规则；
- 页面内输入和切换不会产生网络 action 或 Agent call。

### Phase 3：显式 Surface Action Adapter

目标：用户可以明确地把 Surface 数据提交给 Agent，同时不引入隐式输入。

任务：

1. 实现 `intent: reset/submit`；
2. 实现字段校验、确认层和提交摘要；
3. 实现 action route 的 revision 校验、字段白名单和 eventId 去重；
4. 复用现有 queue-input；
5. 实现 call active 时排队、pending UserInput 时禁用；
6. 确保提交形成可见用户消息；
7. 测试双击、重试、stale revision、跨 Agent 伪造和超限 payload。

退出标准：

- 普通 UI 事件永不触发 Agent；
- 明确 submit 恰好产生一个可见用户回合；
- Agent 运行中不被自动 interrupt；
- 存在阻塞请求时不会出现两个竞争输入入口。

### Phase 4：阻塞 UI Input Adapter

目标：复用共享 Renderer 扩展现有 UserInput，而不是建立第二套等待机制。

任务：

1. 在 AgentDev 上游扩展 `mode: ui` payload 透传；
2. 导出 `UserInputFeatureApi`；
3. 实现 `GenerativeUIInputFeature` 和 exclusive 工具；
4. 在 Input Host 中挂载共享 Renderer；
5. 提交使用现有 `/input` requestId 响应；
6. 测试成功、取消、超时、interrupt、重连和 stale request；
7. 验证既有 text/choices UserInput 无回归。

退出标准：

- 工具调用在用户完成前保持 pending；
- 完成后同一个 call 继续下一 step；
- 不创建 queue-input、不增加 user message、不启动新 call；
- request 结束后 UI 不能再次提交。

### Phase 5：硬化与后续能力

在 V1 验收后按独立需求加入：

1. 服务重启后的 Surface 持久化、schemaVersion 和迁移；
2. `ui_surface_patch` 增量更新；
3. Tabs / Accordion / Progress / Chart 等 Catalog 扩展；
4. 多 Surface 排序、固定、用户关闭与恢复；
5. 远程 Claw 的持久 Surface transport；
6. Surface 操作历史与审计面板；
7. 大数据表格的分页/虚拟化。

每项都必须单独扩展 Catalog、限制、安全审查和测试，不能用“任意 props”绕过协议。

## 14. 测试计划

### 14.1 纯函数测试

- Catalog 到 JSON Schema 的稳定生成；
- 所有组件合法最小输入；
- 未知组件/props、缺 root、悬空 child、环、多父节点、孤立节点；
- ID、字节、元素、深度、表格和选项上限；
- action 与字段引用；
- content hash 稳定性；
- dirty value merge 规则。

### 14.2 Feature 单元测试

- Feature name、工具集合和工具描述；
- schema required/additionalProperties/limits；
- upsert/close 串行，get/list parallelizable；
- request tool exclusive；
- HTTP 成功、业务失败、5xx、timeout 和 abort；
- `ctx.featureConfig` 默认值与优先级；
- UserInput dependency 缺失/未就绪时错误清晰；
- 所有结果可以 `JSON.stringify()`。

### 14.3 Server 测试

- Agent 隔离和 session 删除清理；
- revision conflict 和 identical-content idempotency；
- ETag / 304；
- action 当前版本校验；
- action 字段白名单；
- eventId 重放只产生一次 queue input；
- body 超限、非法 JSON、错误 content type；
- 日志不包含 Spec 和 values 正文。

### 14.4 前端 DOM 测试

- Catalog 中每个组件均有 renderer；
- 动态文本只进入 `textContent`；
- field label、键盘和 aria；
- Surface 切换、revision 更新、草稿/焦点/滚动保留；
- 本地事件没有 fetch；
- Surface submit 和 Input submit 调用不同 host adapter；
- pending UserInput 时 Surface submit disabled；
- stale action 刷新页面，不重复提交。

### 14.5 端到端验收场景

1. Agent 创建“发布中心”，工具立即结束，右侧页面出现；
2. 用户填写表单并继续聊天，草稿保留，Agent 未收到事件；
3. Agent 更新摘要，表单 dirty value 保留；
4. 用户显式提交，聊天出现一条可见用户消息，Agent 正常处理；
5. Agent 正在运行时提交进入现有队列且不 interrupt；
6. Agent 调用 `request_ui_input`，工具阻塞；用户提交后同一 call 继续；
7. 阻塞请求存在时，持久页面的 Agent submit 不可用；
8. 切换 Agent 后不显示另一个 Agent 的 Surface；
9. 无 Web Surface host 时，Agent 能降级为文本完成任务。

## 15. 验收标准

### 15.1 产品验收

- 用户能直观区分“长期页面”和“Agent 正在等待我回答”；
- 页面内普通操作安静、本地、不会打断对话；
- 所有会触发 Agent 的动作都具有明确文案并可在聊天中审计；
- 右侧页面跨 call 存在，同一 ID 更新同一页面；
- 复杂阻塞表单仍保持 UserInput 的单请求心智模型。

### 15.2 架构验收

- Kernel、Surface Host、Input Host、Action Adapter 无反向依赖；
- Surface Feature 没有 call/step hooks；
- `chat-renderer.js` 不承担 Surface 生命周期；
- 不存在第二套 pending input Map 或自定义 ReAct 循环；
- Surface submit 只调用现有正常输入边界，Input submit 只调用现有 requestId 边界；
- 状态所有权、revision、幂等和 rollback 边界与文档一致。

### 15.3 工程验收

- TypeScript build、现有 core tests、Feature tests 和新增前端/Server tests 全部通过；
- 无 XSS、跨 Agent 访问、重复提交和未限制 payload；
- abort 到达底层 HTTP；
- Inspector 能看到两个 Feature、工具来源和 executionMode；
- 工具描述和 Feature skill 能让 Agent 正确选择模式；
- 服务、前端和 Agent 日志可通过 ID/revision 定位一次更新，但不泄露正文。

## 16. 风险与默认取舍

| 风险 | V1 取舍 |
|---|---|
| Surface 与聊天状态长期不一致 | Agent 显式 upsert；不假装 rollback 自动同步 |
| 前端全量替换丢草稿 | 独立 ViewState + revision merge；无变化不重绘 |
| Surface submit 与 UserInput 竞争 | pending request 优先，禁用 Surface submit |
| action 重试产生重复 call | `eventId` 去重 + 可见用户消息 |
| Catalog 太复杂增加模型错误 | V1 只保留 15 个组件、enum token、严格 schema |
| Spec 过大污染 Context | upsert 结果只返回摘要，get 才返回完整 Spec |
| 本地 Feature 与 Claw transport 不一致 | V1 先支持 AgentDevClaw HTTP host；远程能力单独验收 |
| 服务重启后页面消失 | V1 明确仅跨 call 持久；磁盘恢复放 Phase 5 |
| Panel Host 的 innerHTML 破坏状态 | 增加 mount lifecycle，Surface 更新不走全局 panel 重绘 |

## 17. 相对旧方案的迁移

| 旧方案 | 新方案 |
|---|---|
| `render_ui` 同时意味着展示和输入 | 拆成 `ui_surface_*` 与 `request_ui_input` |
| 工具结果直接携带并渲染页面 | 工具结果只做审计摘要，真实页面进入 SurfaceStore |
| 页面嵌入聊天消息 | 持久页面进入右侧固定 Tab；阻塞请求进入 UserInput 区域 |
| 每次更新生成一条新的可操作历史面板 | 同一 `surfaceId` 更新同一活动页面 |
| action 默认 POST 后注入下一轮输入 | 普通 action 本地；只有显式 submit 进入独立适配器 |
| 自定义 action 路由直接构造隐藏用户消息 | Surface submit 形成可见正常用户回合；Input submit resolve requestId |
| 前端识别 tool result 特殊标记 | 前端读取独立 Surface registry 或 pending request |
| 修改 `chat-renderer.js` | 不修改聊天 Surface 渲染路径 |
| Feature 注入 system prompt | 工具 schema + 精简描述 + Feature skill |
| “历史面板仍可点击是 feature” | 历史工具消息不可提交；只有当前 Surface 可交互 |

## 18. 推荐实施顺序

严格按下面顺序推进，避免再次把两种模式混在一起：

```text
Spec/Validator
  → SurfaceStore/CRUD
  → ui_surface_* tools
  → Right Panel/Renderer/ViewState
  → explicit Surface submit adapter
  → UserInput mode: ui upstream support
  → request_ui_input adapter
  → persistence / patch / richer catalog
```

第一条产品 smoke test 应当是：

> “Agent 创建一个右侧发布配置页；工具立即返回。用户可以编辑页面而 Agent 不会收到任何事件。只有用户点击‘提交给 Agent’后，聊天中才出现一条可见用户消息。”

第二条产品 smoke test 才是：

> “Agent 调用 `request_ui_input` 并等待；用户提交同一套页面后，该工具返回结构化 values，同一个 call 继续。”

只有这两条同时成立且互不干扰，Generative UI 的产品边界才算真正落地。
