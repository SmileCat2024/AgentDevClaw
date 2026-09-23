# 群聊指挥台：实施规划

> **状态**：实施中
> **日期**：2026-06-19（初版），2026-06-19（修订：简化 Phase 1 方向）
> **前置文档**：[group-chat-command-center-design.md](./group-chat-command-center-design.md)
> **当前进展**：Phase 0 完成（Identity Registry + finishReason），UI Demo 已落地（mock 数据），Phase 1 启动中

---

## 0. 关键架构决策（2026-06-19 讨论结论）

以下决策在实施前经过充分讨论，作为 Phase 1 的指导原则。

### 0.1 软耦合原则

**Mention 语法是稳定的，派发行为是软耦合的。**

`@编程小助手` 这个 mention 语法本身不会变。但"mention 之后具体发生什么"——发到哪个 session、附带什么上下文、触发什么操作——取决于系统给群管理员暴露了什么能力。这些行为可以单独迭代，不需要改 mention 语法。

### 0.2 两层 Mention 语法

| 层级 | 语法 | 语义 | 实施阶段 |
|------|------|------|----------|
| **Level 1** | `@编程小助手` | 抽象 mention，只指定身份不指定会话 | **Phase 1** |
| **Level 2** | `@编程小助手<qualifier>` | 精确 mention，附带 session/qualifier 限定符 | 后续阶段 |

Level 2 预设了更细节的产品语义（qualifier 怎么选、session 怎么映射），暂不实施。Level 1 的灵活度足够高，派发行为通过软耦合方式迭代。

### 0.3 状态回传：最简可靠版

Agent 完成任务后，群聊必须显示状态（完成/失败）。但**不做 summary + attachment 的复杂回写**。

实施最简版：消息上的 `routing.status` 从 `delivered` 更新为 `completed` / `failed`。这个数据模型和状态机无论后续怎么迭代都不会返工。后续可在状态回传的基础上叠加 response 内容回写。

### 0.4 Phase 1 明确不做的事项

| 不做 | 原因 |
|------|------|
| Agent → 群聊的 response 内容回写 | 复杂度最高、侵入性最强，先跑通正向派发 |
| Level 2 mention（qualifier 语法） | 预设过多产品语义，等 Level 1 跑通后再定 |
| 一个 agent 服务多个群聊 | 短期不需要，按简单模型做 |
| GroupChatBridgeFeature（完整版） | 依赖回写方案，暂不实施 |
| 管理员智能路由 | 依赖管理员 agent 设计，暂不实施 |

---

## 1. 现状盘点

### 已有

| 组件 | 状态 | 说明 |
|------|------|------|
| Identity 声明 | **已完成** | programming-helper(main+explorer)、flow-workspace(architect+runtime)、qqbot(operator) |
| Identity Registry API | **已完成** | `GET /protoclaw/identities`、`GET /protoclaw/identities/:wid/:iid/sessions` |
| CallFinishReason | **已完成** | 框架侧 `CallFinishContext.finishReason` 字段已落地 |
| 群聊 UI | Demo | `public/src/modules/work-group-ui.js`，微信桌面风格，全 mock 数据 |
| work-group workspace | 壳层 | `prebuilt-agents/official/work-group/metadata.json`，`kind: workspace`, `launchMode: ui-only` |
| Provider 体系 | 仅 programming-helper | `claw-core.mjs` + `providers/programming-helper.mjs`，有 overview/explorations/spawn/create_session 等 |
| 运行时管理 | 成熟 | `managedAgents` Map、`buildStatus()`、CallArbiter、RuntimeCallEnvelope |

### 缺失（按依赖顺序，已标注 Phase）

1. ~~**Identity 声明机制**~~ — ✅ Phase 0 完成
2. ~~**Identity Registry**~~ — ✅ Phase 0 完成
3. **群聊数据层** — 群聊 CRUD、消息存储 — **Phase 1**
4. **Level 1 mention 派发** — @mention → agent session 的执行链路 — **Phase 1**
5. **最简状态回传** — routing 状态机（pending → delivered → completed/failed） — **Phase 1**
6. **前端真实数据接入** — UI 替换 mock — **Phase 1**
7. **Provider 标准操作** — `status`, `sessions`, `send`, `interrupt` — **Phase 1+（按需）**
8. **Agent response 回写** — summary + attachment — **后续阶段**
9. **Level 2 mention** — qualifier 语法 — **后续阶段**

---

## 2. 核心语义模型

### 2.1 三层关系

```
Workspace（工作空间）
  │  声明一个 identities 数组
  │
  ├── Identity（身份）  ← 群聊中 @mention 的目标
  │     │  声明自己支持哪些 provider operations
  │     │  声明自己的 session 模型
  │     │
  │     └── Qualifier（限定符） ← @身份<限定符> 的二级选择
  │           │  绑定到具体 session
  │           │
  │           └── Session（会话） ← 实际的 agent runtime
  │
  └── Provider Operations（操作集）
        │  工作空间实现的具体操作
        │  群聊路由最终调用的是这些操作
        │
        ├── status     — 当前运行时状态
        ├── sessions   — 活跃会话列表
        ├── send       — 向指定会话发送消息
        ├── interrupt  — 中断当前运行
        ├── create     — 创建新会话
        └── (扩展操作) — workspace 自定义
```

### 2.2 关键语义决策

**身份是一等寻址单元。** 群聊里 @mention 的是身份，不是 workspace、不是 session。身份背后绑到哪个 session，是身份自己的事。

**身份 ≠ 会话。** 一个身份可以管理多个会话（如主代理管理多个项目目录），也可以不绑定任何会话（如管理员）。会话选择通过 qualifier 二级交互完成。

**Provider 操作是唯一执行路径。** 群聊消息路由最终都变成一次 provider operation 调用。不存在"绕过 provider 直接操纵 runtime"的捷径。这保证了 CLI / MCP / 群聊三种消费形态走同一条路。

**身份是静态声明的。** 身份在 workspace 启动时就声明好了，不随会话变化。群聊系统在任何 session 创建之前就能列出"系统里有哪些身份可用"。

---

## 3. 数据结构（初版，不锁死字段）

### 3.1 Identity Manifest

声明在 `metadata.json` 中，工作空间启动时被 server 读取并注册。

```jsonc
// metadata.json 新增字段
{
  "id": "programming-helper",
  "name": "编程助手",
  // ... 现有字段不变 ...

  "identities": [
    {
      "id": "main",
      "displayName": "主代理",
      "description": "擅长编码、调试、重构，支持完整工具链",
      "sessionModel": "persistent",
      "qualifierLabel": "项目",
      "operations": ["status", "sessions", "send", "interrupt", "create", "overview", "explorations"]
    },
    {
      "id": "explorer",
      "displayName": "探索代理",
      "description": "只读分析、知识收集，不可修改文件",
      "sessionModel": "one-shot",
      "operations": ["status", "spawn", "compact"]
    }
  ]
}
```

字段说明（最小集，后续可扩展）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 身份唯一标识，workspace 内不重复 |
| `displayName` | 是 | 群聊中显示的名字 |
| `description` | 是 | 给管理员看的"说明书"，一句话 |
| `sessionModel` | 是 | `persistent`（持久会话）/ `one-shot`（一次性任务） |
| `qualifierLabel` | 否 | qualifier 选择器的标签（如"项目"），仅 persistent 模式有意义 |
| `operations` | 是 | 该身份支持的 provider operation 名称列表 |

**没有声明 identities 的 workspace**：向后兼容，视为暴露单个默认身份（id = workspace id, displayName = workspace name, sessionModel = workspace 已有行为）。

### 3.2 GroupChat

```jsonc
// ~/.agentdev/AgentDevClaw/group-chats/<chatId>.json
{
  "id": "chat-sys-refactor",
  "name": "系统重构",
  "goal": "重构支付系统，拆分三个模块",
  "createdAt": "2026-06-19T12:00:00Z",
  "members": [
    {
      "identityRef": "user",           // 固定值，表示人类用户
      "role": "human"
    },
    {
      "identityRef": "programming-helper:main",
      "qualifier": "auth-service",     // 绑定到哪个 session/project
      "role": "agent"
    },
    {
      "identityRef": "programming-helper:main",
      "qualifier": "payment-service",
      "role": "agent"
    }
    // admin 不存为 member，是群聊的功能层
  ],
  "settings": {
    "adminEnabled": true               // 是否激活管理员功能层
  }
}
```

关键点：
- `identityRef` 格式：`<workspaceId>:<identityId>`，人类用户固定为 `"user"`
- 同一个 identity 可以以不同 qualifier 出现多次（主代理绑定 auth，主代理绑定 payment）
- 管理员不是 member，是群聊的一个功能开关

### 3.3 GroupChatMessage

```jsonc
// 独立文件或嵌入 group-chat 文件的消息数组
{
  "id": "msg-001",
  "chatId": "chat-sys-refactor",
  "from": "user",                      // "user" | identityRef | "system" | "admin"
  "fromQualifier": null,               // 发送者的 qualifier（agent 消息才有）
  "text": "重构 auth 模块的登录逻辑",
  "mentions": [                         // 解析后的 @mention（仅用户消息）
    {
      "identityRef": "programming-helper:main",
      "qualifier": "auth-service"
    }
  ],
  "kind": "text",                       // "text" | "report" | "system" | "daily-summary"
  "timestamp": 1718793000000,
  // 可选：路由执行状态（仅含 mention 的用户消息）
  "routing": {
    "status": "delivered",              // "pending" | "delivered" | "executing" | "completed" | "failed"
    "targetSessionId": "sess-xxx",
    "providerOperation": "send",
    "error": null
  }
}
```

消息存储为 **append-only**，永不修改、永不删除。`routing` 字段是唯一会被更新的部分（跟踪执行状态）。

---

## 4. API 接口设计

### 4.1 Identity Registry

```
GET /protoclaw/identities
```

```jsonc
// Response
{
  "identities": [
    {
      "workspaceId": "programming-helper",
      "workspaceName": "编程助手",
      "identityId": "main",
      "identityRef": "programming-helper:main",
      "displayName": "主代理",
      "description": "擅长编码、调试、重构",
      "sessionModel": "persistent",
      "qualifierLabel": "项目",
      "operations": ["status", "sessions", "send", "interrupt", "create"]
    },
    {
      "workspaceId": "programming-helper",
      "identityId": "explorer",
      "identityRef": "programming-helper:explorer",
      "displayName": "探索代理",
      "description": "只读分析、知识收集",
      "sessionModel": "one-shot",
      "operations": ["status", "spawn", "compact"]
    }
  ]
}
```

**实现方式**：server.js 扫描所有已加载的 prebuilt agent metadata.json，聚合 identities 数组。无 identities 声明的 workspace 自动生成默认身份。

### 4.2 Identity Sessions（qualifier 选择器数据源）

```
GET /protoclaw/identities/:workspaceId/:identityId/sessions
```

```jsonc
// Response — 当前身份可选的 session 列表（用于 @mention 后的 qualifier 选择器）
{
  "sessions": [
    {
      "qualifier": "auth-service",
      "label": "auth-service",
      "status": "running",
      "lastActiveTime": "2026-06-19T14:52:00Z",
      "summary": "auth 重构进行中"
    },
    {
      "qualifier": "payment-service",
      "label": "payment-service",
      "status": "idle",
      "lastActiveTime": "2026-06-19T10:00:00Z",
      "summary": null
    }
  ],
  "allowCreate": true   // 该身份是否允许创建新 session
}
```

各 workspace 自己决定 session 列表怎么来。programming-helper 的 session qualifier 就是 project directory。

### 4.3 Group Chat CRUD

```
GET    /protoclaw/group_chats                          → 群聊列表
POST   /protoclaw/group_chats                          → 创建群聊
GET    /protoclaw/group_chats/:chatId                  → 群聊详情（含最近消息）
PUT    /protoclaw/group_chats/:chatId                  → 更新群聊信息
DELETE /protoclaw/group_chats/:chatId                  → 删除群聊
POST   /protoclaw/group_chats/:chatId/members          → 添加成员
DELETE /protoclaw/group_chats/:chatId/members/:identityRef  → 移除成员
```

### 4.4 Messages

```
GET    /protoclaw/group_chats/:chatId/messages         → 消息列表（分页）
POST   /protoclaw/group_chats/:chatId/messages         → 发送消息（触发路由）
```

发送消息的 request body：

```jsonc
{
  "text": "重构 auth 模块的登录逻辑",
  "mentions": [
    { "identityRef": "programming-helper:main", "qualifier": "auth-service" }
  ]
}
```

### 4.5 Identity Status（态势层数据源）

```
GET /protoclaw/group_chats/:chatId/status
```

```jsonc
// Response — 群聊所有成员的实时状态
{
  "members": [
    {
      "identityRef": "programming-helper:main",
      "qualifier": "auth-service",
      "status": "running",        // "running" | "idle" | "error" | "stopped"
      "lastActivity": "正在分析 auth 模块结构..."
    }
  ]
}
```

实现方式：遍历群成员，对每个 agent 成员调用其 provider 的 `status` 操作（或直接查 `buildStatus()`）。

---

## 5. Provider 标准操作（需要实现的最小集）

在 `claw-core.mjs` 的 `createContext()` 中增加以下运行时控制函数，所有 provider 共用：

```javascript
// claw-core.mjs createContext() 新增

ctx.getRuntimeStatus = async (identityId, qualifier) => {
  // 调用 GET /protoclaw/get_agents_status 或直接查 managedAgents
  // 返回 { status, lastMessage }
};

ctx.sendToRuntime = async (identityId, qualifier, message) => {
  // 1. 根据 qualifier 找到或创建 session
  // 2. 通过 API 发送消息（经 CallArbiter 入队）
  // 返回 { ok, sessionId, queuePosition }
};

ctx.interruptRuntime = async (identityId, qualifier) => {
  // 中断当前运行
  // 返回 { ok }
};
```

programming-helper provider 对应操作：

```javascript
// programming-helper.mjs 新增操作

{
  name: 'status',
  description: '当前身份的运行时状态',
  params: [{ name: 'qualifier', required: false }],
  execute: async (ctx, { qualifier } = {}) => {
    return ctx.getRuntimeStatus('main', qualifier);
  },
},
{
  name: 'sessions',
  description: '活跃会话列表',
  params: [],
  execute: async (ctx) => {
    // 复用 readSessionIndex，返回 qualifier 可选列表
  },
},
{
  name: 'send',
  description: '向指定会话发送消息',
  params: [
    { name: 'qualifier', required: true },
    { name: 'message', required: true },
  ],
  execute: async (ctx, { qualifier, message }) => {
    return ctx.sendToRuntime('main', qualifier, message);
  },
},
{
  name: 'interrupt',
  description: '中断当前运行',
  params: [{ name: 'qualifier', required: false }],
  execute: async (ctx, { qualifier } = {}) => {
    return ctx.interruptRuntime('main', qualifier);
  },
},
```

---

## 6. 消息路由流程

> **Phase 1 实施范围**：仅 Level 1 mention（`@身份`，不带 qualifier）+ 最简状态回传（routing 状态机，不做 response 内容回写）。
> 以下 GroupChatBridgeFeature、CallFinish piggyback、formatForGroupChat 等内容描述的是**完整愿景**，对应 Phase 3。
> Phase 1 的派发路径更简单：服务端直接组装 prompt 并发送到 agent session，不需要 Feature、不需要轮询。

Phase 1 只做**确定性路由**（Level 1 @mention 直达目标身份），不做管理员介入的智能路由。

```
用户在群聊输入并发送
  │
  ├── 解析 mentions[]（前端已结构化，不需要 NLP）
  │
  ├── 无 mention → 存为讨论型消息，不触发执行
  │
  ├── 有 mention → 存为指令型消息，逐 mention 路由：
  │     │
  │     ├── 解析 identityRef → 找到 workspace + identity
  │     │
  │     ├── 检查 identity 是否声明了 `send` 操作
  │     │     └── 没有 → 路由失败，群聊显示错误
  │     │
  │     ├── 根据 qualifier 找到或创建 session
  │     │     └── qualifier 不存在 → 尝试创建新 session
  │     │
  │     ├── 调用 provider.dispatch(workspaceId, 'send', { qualifier, message })
  │     │     └── 这内部走 CallArbiter，保证 per-runtime 串行
  │     │
  │     └── 更新消息的 routing.status
  │
  └── Agent 产出回写群聊（通过 provider 的 callback 或 webhook）
        └── 以新消息形式写入群聊消息流
```

**Agent 产出回写方案：GroupChatBridgeFeature（Feature + CallFinish piggyback）**

这是整个群聊系统中最关键的架构决策。当前 agent runtime 的产出只走 ViewerWorker chunk 流，没有"向群聊发消息"的能力。

**已有参照：`ClawDispatchFeature` 已经完全解决了这个问题。** dispatch feature 的双模式注入 + CallFinish piggyback 机制可以 1:1 映射到群聊场景。

### 机制说明

```
                    ┌─────────────────────────────────┐
                    │   GroupChatBridgeFeature         │
                    │   (挂在 agent runtime 进程上)     │
                    │                                  │
                    │  ┌── 轮询 inbox ──────────────┐ │
                    │  │ GET /protoclaw/gc/inbox    │ │
                    │  │ → { chatId, text, msgMeta } │ │
                    │  └─────────────┬───────────────┘ │
                    │                │                  │
                    │    ┌───────────┴───────────┐     │
                    │    │                       │     │
                    │  Agent 空闲?           Agent 忙?  │
                    │    │                       │     │
                    │    ▼                       ▼     │
                    │  Arbiter 起新 call     Buffer 消息 │
                    │  enqueue({               pending  │
                    │    source:'group-chat',  Buffer[]  │
                    │    text: msg.text                  │
                    │  })                       │       │
                    │  waitForCompletion()      │ @StepStart│
                    │    → result               │ 注入为    │
                    │    │                      │ system-   │
                    │    │                      │ reminder  │
                    │    │                      │     │     │
                    │    │              @CallFinish      │
                    │    │              ctx.response     │
                    │    │                      │     │
                    │    ▼                      ▼     ▼
                    │  ┌── 后处理 + 回写 ──────────────┐│
                    │  │ formatForGroupChat(response)  ││
                    │  │ → { summary, attachment }     ││
                    │  │ POST /protoclaw/gc/writeback  ││
                    │  └───────────────────────────────┘│
                    └──────────────────────────────────┘
```

### 两个方向，两条路径

| 方向 | 机制 | 说明 |
|------|------|------|
| 群聊 → Agent | 轮询 inbox（同 dispatch poll） | Agent 侧 Feature 长轮询服务端，收到群聊消息后注入 |
| Agent → 群聊 | CallFinish piggyback（同 dispatch respond） | 在 `@CallFinish` 取 `ctx.response`，后处理后 POST 回群聊 |

### 双模式注入（完全照搬 dispatch）

**模式 A — Agent 空闲时（Call 级注入）**：
```
inbox 收到消息 → Agent 无活跃 call
  → arbiter.enqueue({ source: 'group-chat', text: msg.text })
  → waitForCompletion(entry.id)
  → 取 result → 后处理 → POST 回群聊
```

上下文在闭包里，不需要跨生命周期传播。`enqueue` 的 `source` 字段标记来源。

**模式 B — Agent 忙时（Step 级注入）**：
```
inbox 收到消息 → Agent 有活跃 call
  → buffer 消息（带 chatId 等 metadata）
  → @StepStart 时注入为 system-reminder
  → @CallFinish 时 ctx.response 携带 piggyback 回写
```

CallArbiter 保证 per-runtime 串行。即使两个群聊同时往同一个 session 注消息：
- 两条消息排队，串行执行
- 每条各走一遍 enqueue → completion → writeback
- 不会串台

### 为什么不轮询 agent 产出

轮询 agent 产出（检测新 assistant 消息）有三个硬伤：
1. 有延迟——轮询间隔期间群聊看不到回复
2. 无法区分"报告"和"中间思考"——agent 的 tool call、thinking 不应进群聊
3. 无法关联来源——不知道这次产出对应哪条群聊消息

Feature + CallFinish 解决了全部三个问题：零延迟（hook 同步触发）、取的是 `ctx.response`（最终回复，不是中间过程）、来源在闭包/enqueue source 里。

### 后处理：summary + attachment（规则化，不用 LLM）

```typescript
function formatForGroupChat(response: string): { summary: string; fullAttachment: string | null } {
  const MAX = 600;
  if (response.length <= MAX) {
    return { summary: response, fullAttachment: null };
  }
  // 尝试取最后一段（agent 通常在结尾做小结）
  const paragraphs = response.split('\n\n');
  const lastPara = paragraphs[paragraphs.length - 1];
  if (lastPara.length >= 50 && lastPara.length <= MAX) {
    return { summary: lastPara, fullAttachment: response };
  }
  // fallback：截断
  return { summary: response.slice(0, MAX) + '…', fullAttachment: response };
}
```

零 LLM 调用。依赖 agent 已有的行为模式（结尾小结），不增加任何 agent 侧心智负担。

### 为什么不用工具

工具方案（给 agent 一个 `report_to_group` 工具）的问题：
- agent 需要主动调用，可能忘记
- agent 需要思考"发什么到群里"——心智负担
- 不调用 = 没有回写 = 群聊消息黑洞

Feature hook 是自动的，agent 完全不知道群聊的存在。零认知负担，零遗漏风险。

### 实现复用

| 组件 | dispatch 已有 | group chat 对应 |
|------|-------------|----------------|
| 轮询端点 | `/protoclaw/dispatch/poll` | `/protoclaw/gc/inbox` |
| 回写端点 | `/protoclaw/dispatch/respond` | `/protoclaw/gc/writeback` |
| 状态上报 | `/protoclaw/dispatch/agent_status` | 复用同一端点 |
| Feature 类 | `ClawDispatchFeature` | `GroupChatBridgeFeature` |
| 注入模式 | Step 级 + Call 级 | 完全相同 |
| CallFinish hook | `ctx.response` piggyback | 完全相同 |
| CallArbiter | `enqueue` + `waitForCompletion` | 完全相同 |

**结论：这不是新架构，是把 dispatch 的双模式注入模式再实现一遍，换成群聊语义。**

### CallFinish 的失败分类（基于框架现有能力）

`CallFinishContext` 只暴露 `completed: boolean`，但框架内部有更细的区分，Feature 可以推断出具体原因：

| 实际场景 | `completed` | `response` 内容 | Feature 如何判断 |
|---------|-------------|----------------|-----------------|
| 正常完成 | `true` | agent 实际输出 | `completed === true` |
| 用户中断 | `false` | 部分输出 | `agentRef._abortController.signal.aborted === true` |
| API 错误 | `false` | `[API Error: {type}] {message}` | response 以 `[API Error:` 开头 |
| 运行时错误 | `false` | `[Error] {message}` | response 以 `[Error]` 开头 |
| 最大步数 | `false` | 部分输出 | 以上都不是 |

关键发现：react-loop.ts 在 step 级 catch 了 API 错误和运行时错误（不会抛出到 agent.ts 的 catch），而是返回 `{ completed: false, finalResponse: '[API Error: ...]' }`。所以这些错误也走 CallFinish 正常路径（不是异常路径）。

```typescript
function classifyFinish(ctx, agentRef): FinishReason {
  if (ctx.completed) return 'completed';
  if (agentRef?._abortController?.signal.aborted) return 'interrupted';
  if (ctx.response?.startsWith('[API Error:')) return 'api_error';
  if (ctx.response?.startsWith('[Error]')) return 'error';
  return 'max_steps';
}
```

群聊 writeback 根据 FinishReason 做不同处理：

| FinishReason | 群聊显示 | routing.status | 处理 |
|-------------|---------|---------------|------|
| completed | summary + attachment | completed | 正常回写 |
| interrupted | "已中断" + 部分输出 | completed | 标注中断，写部分结果 |
| api_error | "API 错误：{type}" | failed | 提取 errorType 展示 |
| error | "执行出错：{msg}" | failed | 去掉 `[Error]` 前缀展示 |
| max_steps | "达到最大步数" + 部分输出 | completed | 标注未完成 |

**长期改进方向**（不在 Phase 1 内）：给 `CallFinishContext` 增加 `finishReason` 字段，框架侧在 react-loop 的各返回路径上设置。但当前框架的 prefix 约定已经足够 Feature 工作。

### Timeout 默认 15 分钟，可配置

```jsonc
// identity 声明（metadata.json）
{
  "id": "main",
  "displayName": "主代理",
  "callTimeoutMs": 900000,   // 默认 15 分钟，可选
  "operations": ["status", "sessions", "send", "interrupt"]
}
```

- 不声明则默认 900000ms（15 分钟）
- Feature 的 arbiter timeout 用 `callTimeoutMs`
- 服务端定时扫描用 `callTimeoutMs + 120000`（2 分钟 grace，确保 Feature 先有机会 writeback）
- 群聊成员级别也可覆盖：`member.callTimeoutMs`
- 这个接口目前被服务端扫描器和 Feature 消费，未来也可暴露给管理员/用户界面

---

## 7. 分阶段实施路线

### Phase 0：Identity 声明 + Registry（地基）✅ 已完成

**目标**：让系统知道"有哪些身份可用"。

**完成项**：
- [x] `metadata.json` 增加 `identities` 字段规范
- [x] 为 `programming-helper` 声明 `main` 和 `explorer` 两个身份
- [x] 为 `flow-workspace` 声明 `architect` 和 `runtime` 两个身份（占位）
- [x] 为 `qqbot` 声明 `operator` 身份（占位）
- [x] server.js 实现 `GET /protoclaw/identities`
- [x] server.js 实现 `GET /protoclaw/identities/:workspaceId/:identityId/sessions`
- [x] 框架侧 `CallFinishContext.finishReason` 字段落地

### Phase 1：群聊数据层 + Level 1 Mention 派发

**目标**：用户能在群聊中 `@编程小助手` 派发任务，agent 真实执行，群聊显示完成状态。

**设计原则**（见 Section 0）：
- Level 1 mention：`@身份` 不带 qualifier，派发到 agent 活跃 session
- 派发行为软耦合：mention 语法稳定，具体派发逻辑可迭代
- 最简状态回传：routing 状态机 `pending → delivered → completed | failed`，不做 response 内容回写

**工作项**：

群聊数据层：
- [ ] 群聊文件存储（`~/.agentdev/AgentDevClaw/group-chats/<chatId>.json`）
- [ ] server.js 群聊 CRUD API（`GET/POST /protoclaw/group_chats`、`GET/PUT/DELETE /protoclaw/group_chats/:chatId`）
- [ ] 消息存储（append-only，含 `mentions[]` 和 `routing` 字段）
- [ ] `GET/POST /protoclaw/group_chats/:chatId/messages`（消息列表 + 发送消息）

Level 1 mention 派发：
- [ ] 消息发送时解析 `mentions[]`（前端结构化传入，不需文本 NLP）
- [ ] 有 mention → 服务端组装 prompt（任务文本 + 附带资源）→ 发送到 agent session
- [ ] 无 mention → 存为讨论型消息，不触发执行
- [ ] routing 状态：消息写入时 `pending` → 派发后 `delivered`

最简状态回传：
- [ ] 服务端检测 agent 完成后更新 routing 状态为 `completed` / `failed`
- [ ] `GET /protoclaw/group_chats/:chatId/messages` 返回消息含 routing 状态
- [ ] 群聊 UI 显示状态标记（⌛ pending → 🔄 delivered → ✓ completed / ✗ failed）

群聊 UI 接入：
- [ ] 群聊列表从真实 API 加载
- [ ] 消息流从真实 API 加载
- [ ] 输入框：@mention 选择器（从 `GET /protoclaw/identities` 拉取身份列表）
- [ ] 发送消息 → 调用 `POST /protoclaw/group_chats/:chatId/messages`
- [ ] 轮询消息更新（新消息 + routing 状态变化）

**交付物**：用户在群聊 UI 中 `@编程小助手` + 写任务 → agent 真实执行 → 群聊显示完成状态。agent 的具体回复在 agent 自己的 session 里查看。

**明确不做**：
- ~~GroupChatBridgeFeature~~（后续阶段，依赖回写方案）
- ~~`/gc/inbox` + `/gc/writeback` 端点~~（后续阶段）
- ~~`formatForGroupChat` 后处理~~（后续阶段）
- ~~Level 2 mention（qualifier 语法）~~（后续阶段）
- ~~Provider `send` / `interrupt` 操作~~（Phase 1 用服务端直接派发，不需要 provider 操作）

### Phase 2：态势层 + 会话管理

**目标**：群头部实时状态，Level 2 mention qualifier 选择器。

**工作项**：
- [ ] `GET /protoclaw/group_chats/:chatId/status` 聚合成员状态
- [ ] 群头部态势层 UI 接入（替换 mock status）
- [ ] Level 2 mention：`@身份<qualifier>` 语法 + qualifier 选择器 UI
- [ ] 新建群聊 UI（选身份 → 选 qualifier → 建群）
- [ ] Provider `status` / `sessions` 操作（按需实现）

### Phase 3：Agent 回写 + Response 内容

**目标**：Agent 完成后，群聊能看到回复摘要。

**工作项**：
- [ ] GroupChatBridgeFeature（照搬 dispatch 双模式注入 + CallFinish piggyback）
- [ ] `/gc/inbox` + `/gc/writeback` 端点
- [ ] `formatForGroupChat` 后处理（summary + attachment，规则化）
- [ ] routing 状态增强：`completed` 时附带 response summary
- [ ] 错误处理三层兜底（Feature try/catch → writeback retry → 服务端定时扫描）

### Phase 4：管理员功能层

**目标**：管理员按需激活，提供路由解析和分析。

**工作项**：
- [ ] 管理员的上下文组装逻辑（热窗口 + 每日总结 + 用户指定）
- [ ] 管理员的路由解析（裸 @mention → 确定身份 → 路由）
- [ ] 管理员的全局分析能力（进度、风险）
- [ ] 每日总结的生成与存储（作为群聊特殊消息）

### Phase 5：私聊体系 + 结构化输入

**目标**：群聊和私聊完整体验，结构化输入框。

**工作项**：
- [ ] 私聊入口和独立上下文
- [ ] 结构化输入框（@mention 分块 → 指令组合 → 关联发送）
- [ ] 指令依赖管理（条件指令执行）

### Phase 6：编排沉淀

**目标**：群聊成功协作模式可固化为 Flow 图。

**工作项**：
- [ ] 从群聊条件指令提取 Flow 编排图
- [ ] 群聊归档和回溯检索

---

## 8. 待讨论的开放问题

以下问题影响实施但不需要现在锁定，列出来供后续讨论：

1. **identityRef 的 qualifier 映射**：programming-helper 的 qualifier = 项目目录，但 flow-workspace 的 qualifier = 项目名，qqbot 的 qualifier = 线路 ID。各 workspace 自己实现 `sessions` 操作来暴露 qualifier 列表即可，不需要统一格式。→ Phase 2 解决。

2. ~~**多 workspace 在同一群聊中的 session 隔离**~~：Phase 1 不考虑一个 agent 服务多个群聊的场景，按简单模型做。后续需要时再讨论 CallArbiter 隔离粒度。

3. ~~**Agent 产出回写的延迟**~~：Phase 1 不做 response 内容回写。Phase 3 实施 GroupChatBridgeFeature 时再关注。

4. ~~**群聊消息与 agent session 消息的关系**~~：Phase 1 不做 response 回写，此问题移至 Phase 3。

5. **管理员的激活方式**：是每次 @管理员 都启动一个临时 LLM 调用（无持久 session），还是有某种缓存机制？→ Phase 4 解决。

6. **identity 声明是否需要动态**：当前设计是静态声明（metadata.json）。但未来可能需要运行时动态注册身份（如 flow-workspace 每个编排图节点是一个身份）。先做静态，后续再考虑动态。

7. **Phase 1 派发路径的 session 关联**：Level 1 mention 不带 qualifier，派发到 agent 的哪个 session？当前方案：发到活跃 session（`activeSessionId`），无活跃 session 则创建新 session。这个行为是软耦合的，后续可以改为"让用户选"或"自动匹配"。

---

## 9. 文件变更预览

### Phase 0（已完成）

```
已修改：
  prebuilt-agents/official/programming-helper/metadata.json  ← 增加 identities
  prebuilt-agents/official/flow-workspace/metadata.json      ← 增加 identities（占位）
  prebuilt-agents/official/qqbot/metadata.json               ← 增加 identities（占位）
  server.js                                                  ← 增加 identities + identity sessions API

框架侧（AgentDev 仓库，已完成）：
  src/core/lifecycle.ts          ← CallFinishReason 类型 + finishReason 字段
  src/core/agent/types.ts        ← ReActResult.finishReason
  src/core/agent/react-loop.ts   ← 9 条返回路径设置 finishReason
  src/core/agent.ts              ← CallFinish hook 透传 finishReason
```

### Phase 1（进行中）

```
将修改：
  server.js                                  ← 群聊 CRUD API + 消息路由 + 状态回传
  public/src/modules/work-group-ui.js        ← 接入真实 API，替换 mock 数据

暂不修改（后续阶段）：
  server/claw-core.mjs                       ← Provider 运行时控制函数（Phase 2+）
  server/providers/programming-helper.mjs     ← Provider 标准操作（Phase 2+）

暂不新建（后续阶段）：
  local-features/group-chat-bridge/          ← GroupChatBridgeFeature（Phase 3）
```

---

## 10. 错误处理与鲁棒性

> **Phase 1 适用范围**：10.0 设计原则（三条底线）、10.1 消息路由生命周期（routing 状态机）完全适用。
> 10.2~10.7 中涉及 GroupChatBridgeFeature、writeback retry、Feature try/catch 的内容对应 Phase 3，Phase 1 暂不需要。
> Phase 1 的错误处理更简单：服务端直接派发，失败直接标记 routing.status = "failed"。

### 10.0 设计原则

dispatch 的设计是"fire and forget"——丢了就丢了，schedule 下次再触发。群聊不行——用户发的消息丢了、agent 回复丢了、error 不可见，用户就会失去信任。

三条底线：
1. **用户的消息永不丢**（群聊消息流 append-only，在任何路由之前就已落盘）
2. **每一个错误都可见**（群聊里直接显示错误指示，不是藏在日志里）
3. **所有状态可查询**（routing 状态有 API，可 debug）

### 10.1 消息路由生命周期

routing 状态直接作为消息的一个字段存在群聊消息文件里，不需要额外队列：

```
用户发消息（含 @mention）
  │
  ├── 1. 消息写入群聊消息流（append-only，永不丢）
  │
  ├── 2. 消息的 routing.status = "pending"
  │     存入群聊文件，持久化
  │
  ├── 3. Agent Feature 轮询 inbox → 拿到消息
  │     routing.status → "delivered"
  │     routing.deliveredAt = now
  │
  ├── 4a. 成功 → Feature POST /gc/writeback { summary, attachment }
  │       routing.status → "completed"
  │       群聊追加 agent 回复消息
  │
  ├── 4b. 失败 → Feature POST /gc/writeback { error }
  │       routing.status → "failed"
  │       群聊追加 "⚠️ 执行失败：{error}"
  │
  └── 4c. 超时 → 服务端定时扫描，delivered 超过 callTimeoutMs + 2min 未 writeback
          routing.status → "timeout"
          群聊追加 "⚠️ 未收到回复（超时）"
```

关键：routing 状态和群聊消息在同一个文件里。服务重启后扫描文件就能恢复全部状态。不需要内存队列。

### 10.2 故障场景逐一分析

#### 场景 A：Claw 服务关闭（全部 Agent 被杀）

```
t0: 用户发消息 → routing.status = "pending" → 落盘
t1: Agent 被 poll 拿到 → routing.status = "delivered"
t2: Agent 正在处理中...
t3: Claw 关闭 → Agent 进程被 kill → server.js 停止
```

恢复后：
- pending 状态的消息：仍在文件里，Agent 重启后 poll 拿到，正常处理
- delivered 状态的消息：Agent 已死，永远不会 writeback
  - **服务端启动时扫描所有群聊**，找到 `status=delivered` 且 `deliveredAt` 超过阈值的消息
  - 标记为 `status=failed`，error = "agent process terminated"
  - 群聊追加 "⚠️ 消息未完成（服务重启）"
- 群聊消息本身（用户原文）：完好无损

#### 场景 B：Agent 卡住（LLM 超时、死循环）

```
t0: 消息 → delivered → Agent 开始处理
t1: Agent 卡住（无限 tool loop 或 API 超时）
t2: callTimeoutMs（默认 15 分钟）后，服务端定时扫描发现 delivered 超时
t3: routing.status → "timeout"
t4: 群聊追加 "⚠️ 未收到回复（超时）"
```

Agent 侧保护：
- `arbiter.waitForCompletion()` 加 timeout 包装（`Promise.race` + callTimeoutMs deadline）
- 超时后 Feature 发送 writeback `{ error: 'agent call timeout' }`
- 如果 Agent 连 writeback 都发不出（完全卡死），服务端定时扫描兜底

用户可手动 interrupt/restart Agent。重启后按场景 A 处理。

#### 场景 C：Agent 被用户手动重启

```
t0: 消息 → delivered → Agent 正在处理
t1: 用户点"重启"→ stopManagedAgent → child.kill('SIGTERM')
t2: child.on('exit') 触发
```

服务端 `child.on('exit')` 回调中增加群聊清理：
- 找到该 runtime 的所有 `status=delivered` 消息
- 标记为 `status=failed`，error = "agent restarted"
- 群聊追加错误提示

新 Agent 启动后：
- Feature 恢复 polling
- pending 消息正常投递

#### 场景 D：Agent Feature 内部异常

Feature 自身的 bug（格式化崩溃、HTTP 构造错误等）：
- `dispatchViaArbiter` 和 `handleMessage` 全程 try/catch
- catch 块里发 writeback `{ error: err.message }`
- 即使 writeback 也失败：console.error 记录完整 context（msgId, chatId, error）
- 不会崩溃 polling loop（loop 有独立的 try/catch）

#### 场景 E：并发注入（多个来源同时往同一 Agent 发消息）

两个群聊同时往同一个 session 注入：
- 服务端 inbox 是 long-poll，每次只返回一条消息
- 两条消息天然串行投递
- 第一条走 arbiter call → completion → writeback
- 第二条在 inbox 等待下次 poll
- **不会串台**

如果第一条正在处理时第二条到达（Agent busy）：
- 模式 B：buffer，@StepStart 注入，@CallFinish piggyback
- `injectedThisCall[]` 带各自的 chatId，writeback 到各自的群聊
- buffer 有上限（MAX_BUFFER = 10），超出直接 writeback `{ error: 'agent overloaded' }`

#### 场景 F：writeback 失败（网络问题）

Agent 处理完了，但 POST writeback 到服务端失败：
- Feature 侧 retry（3 次，指数退避：1s → 2s → 4s）
- 全部失败：缓存到本地内存，下次 polling 时附带 retry
- 如果 Agent 在 retry 期间被 kill：response 丢失，但 agent 的 session 里有完整记录
- 服务端定时扫描兜底（5 分钟 timeout）

### 10.3 Agent 进程死亡的服务端清理

在 `child.on('exit')` 回调中增加群聊 routing 清理：

```javascript
child.on('exit', (code) => {
  const current = managedAgents.get(runtime.key);
  if (current && current === runtime) {
    current.exitCode = code;
    current.stopped = true;
  }
  // ── 群聊 routing 清理 ──
  failDeliveredMessagesForRuntime(runtime.key, 'agent process terminated');
  log(agent.id, `process exited with code ${code ?? 'null'}`);
});
```

`failDeliveredMessagesForRuntime` 遍历所有群聊，找到该 runtime 的 `status=delivered` 消息，标记为 failed。

### 10.4 服务端定时扫描（timeout 兜底）

```javascript
// 每 60 秒扫描一次
setInterval(() => {
  const chats = listAllGroupChats();
  const now = Date.now();
  for (const chat of chats) {
    for (const msg of chat.messages) {
      if (msg.routing?.status === 'delivered') {
        const timeoutMs = msg.routing.callTimeoutMs || 900000; // 默认 15 分钟
        const graceMs = timeoutMs + 120000; // Feature 先有机会 writeback
        const elapsed = now - (msg.routing.deliveredAt || 0);
        if (elapsed > graceMs) {
          msg.routing.status = 'timeout';
          msg.routing.error = 'no writeback within 5 minutes';
          appendGroupChatMessage(chat.id, {
            kind: 'system',
            text: `⚠️ ${msg.routing.targetIdentityRef} 未回复（超时）`,
            timestamp: now,
          });
          saveGroupChat(chat);
        }
      }
    }
  }
}, 60_000);
```

### 10.5 启动恢复

服务端启动时扫描全部群聊：

```javascript
function recoverGroupChatRouting() {
  const chats = listAllGroupChats();
  for (const chat of chats) {
    let dirty = false;
    for (const msg of chat.messages) {
      if (!msg.routing) continue;
      if (msg.routing.status === 'delivered') {
        // Agent 在服务关闭时死了，消息永远不会收到 writeback
        msg.routing.status = 'failed';
        msg.routing.error = 'agent process terminated (server restart)';
        dirty = true;
      }
      // pending 状态的消息：保持 pending，等 Agent 重启后 poll
    }
    if (dirty) saveGroupChat(chat);
  }
}
```

### 10.6 调试可见性

| 需要查什么 | 怎么查 |
|-----------|--------|
| 某条消息的路由状态 | `GET /protoclaw/gc/routing_status?chatId=xxx` |
| 某个群聊的所有未完成路由 | `GET /protoclaw/gc/routing_status?chatId=xxx&status=pending,delivered` |
| Feature 的注入日志 | Agent 进程 stdout `[GroupChatBridge]` 前缀 |
| 服务端路由日志 | server.js `[GroupChat]` 前缀 |
| 用户可见的错误 | 群聊消息流里的 system 类型消息 |

### 10.7 与 dispatch 的鲁棒性对比

| 问题 | dispatch 现状 | group chat 方案 |
|------|-------------|----------------|
| 消息持久化 | 内存 Map，重启全丢 | 文件持久化，routing 状态在消息上 |
| Agent 死亡 | 无人处理 | child.on('exit') 清理 delivered |
| 超时检测 | 无（watchdog 仅用于 schedule） | 60s 定时扫描，callTimeoutMs+2min 超时 |
| writeback 失败 | fire-and-forget `.catch()` | 3 次 retry + 指数退避 |
| 卡住检测 | `waitForCompletion` 无限等 | `Promise.race` + callTimeoutMs deadline |
| 错误可见性 | 日志 | 群聊 system 消息 + routing 状态 API |
| 并发安全 | CallArbiter 串行 | CallArbiter 串行 + buffer 上限 |

---

*本文档随实施进展持续更新。*
