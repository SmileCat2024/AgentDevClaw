# 群聊会话血缘与生命周期感知设计

> **状态**：Phase 1-3 已实施（2026-07-08），前端 UI 设计见 [附录 C](#附录-c前端态势感知与工作面板设计)
> **日期**：2026-07-08（正文），2026-07-09（附录 C）
> **参与**：产品方向讨论
> **关联文档**：
> - [group-chat-command-center-design.md](./group-chat-command-center-design.md) — 群聊指挥台总体设计
> - [group-chat-admin-context-injection-design.md](./group-chat-admin-context-injection-design.md) — 管理员上下文注入规范
> - [group-chat-session-pool-data-link.md](./group-chat-session-pool-data-link.md) — 会话池数据链路
> - 上下文管理.md（用户提供，桌面）— 实践经验总结

---

## 目录

1. [产品背景与核心矛盾](#1-产品背景与核心矛盾)
2. [定位修正与核心洞察](#2-定位修正与核心洞察)
3. [核心概念定义](#3-核心概念定义)
4. [设计原则：推送事件 + 按需拉取](#4-设计原则推送事件--按需拉取)
5. [管理员上下文积累过程](#5-管理员上下文积累过程)
6. [用户视角：无感知的协调](#6-用户视角无感知的协调)
7. [新事件如何融入已有注入规范](#7-新事件如何融入已有注入规范)
8. [数据链路全景](#8-数据链路全景)
9. [开发规划](#9-开发规划)
10. [Mode 演进的影响](#10-mode-演进的影响)
11. [渐进验证路径](#11-渐进验证路径)
12. [开放问题](#12-开放问题)
13. [被否定的方案](#13-被否定的方案)
14. [附录 B：Phase 1 实施记录](#附录-bphase-1-实施记录)
15. [附录 C：前端态势感知与工作面板设计](#附录-c前端态势感知与工作面板设计)

---

## 1. 产品背景与核心矛盾

### 1.1 群聊为什么感觉"花瓶"

群聊模块的抽象层（身份系统、滑动窗口、管理员上下文注入）在设计层面是正确的。但实际使用中暴露的根本矛盾是：

**群聊被设计来解决"多 agent 协调"问题，但日常最高频的痛点是"单个 agent 会话的生命周期管理"。**

具体表现为：
- trim 是最高频的上下文管理操作，但 trim 产生的后续会话对管理员完全不可见
- 会话数量随 trim 爆炸，管理员面对扁平的"会话池"无法判断"该派哪个会话、要不要建新的"
- 群聊和编程小助手本体割裂：用户在原生界面 trim 后，管理员失去对工作线程的追踪
- 最终用户倾向于"让管理员开个头，后面自己干"——管理员的价值在第一次 trim 后归零

### 1.2 断裂点的精确描述

```
管理员派发任务 A → session-001
A 完成探索阶段 → 上下文爆了
用户在编程小助手原生界面 trim → 产生 session-002
  ← 断裂发生在这里
管理员看不到 session-002
用户必须手动重新导入 + 重新解释"这是后续会话"
管理员才能继续协调
```

管理员在第一个阶段还有协调价值，一旦需要上下文管理操作，它就变成了瞎子。

### 1.3 用户的实践经验

来自 `上下文管理.md` 的关键经验：
- trim 是最常用的操作（远多于 summary 和 branch）
- trim 后的会话拿来当 branch 用效果也不错——流程连贯，agent 不会困惑
- 120K token 是一个经验性的"拐点"
- trim 的时机判断高度依赖人类对会话语义的理解——探索阶段结束、编码阶段开始
- 完成某些 task 后中断会话也是服务于"避免 token 爆炸"的目的

**这些经验目前只存在于用户脑中，没有任何一条能传递给管理员。**

---

## 2. 定位修正与核心洞察

### 2.1 核心洞察

> **"协调多个 agent"就是"管理这批会话的上下文生命周期"。**

| 以前的认知 | 修正后的认知 |
|---|---|
| 协调 = A 做完了，检查指标，决定派 B | 协调 = 追踪工作线程在上下文生命周期中的位置，在阶段转换时做编排判断 |
| 上下文管理 = 会话太长，trim 掉探索过程 | 上下文管理 = 工作线程从探索阶段进入编码阶段的**阶段转换信号** |

trim 创造的新 session 本质上是任务从一个阶段进入下一个阶段的信号。管理员的协调逻辑（A→B→C、指标检查、重试）天然需要在这个信号之上运作。

### 2.2 平台定位

群聊不是编程小助手的附属品，而是**全场景 agent 的统一接入面**：

```
群聊（平台层）
├── 身份系统 — 任何 workspace 的统一接入协议
├── 管理员 — 跨场景的协调与上下文感知中枢
├── 消息流 — 所有 agent 交互的共同叙事层
│
├── 编程小助手（第一个深度集成住客）
├── 生活助理（未来）
├── 记账 agent（未来）
└── ...
```

因此，会话血缘和生命周期感知**不能硬编码编程小助手的语义**（trim、branch 等），而应设计为一种**通用信号协议**。

### 2.3 用户心智的主场景

> 用户的主心智、控制面还是在一个个 session。创建新任务时，更多心智走编程小助手原生界面和各种习惯。管理员是另一个层次的协调管理。

这意味着：
- 群聊不替代编程小助手的会话管理界面
- 用户日常在编程小助手中工作（输入、trim、branch、task 管理）
- 群聊和管理员是**上层协调层**，通过事件被动感知 session 的状态变化
- 原生界面的任何上下文管理操作，其结果自动传播到群聊，不需要用户手动同步

### 2.4 关于 Task/Issue 正式抽象的决策

**不引入正式的 Task/Issue 实体。** 理由：

1. **创建成本**：每次派发都要分类"这是新 task 还是延续已有 task"——简单任务被过度复杂化
2. **维护成本**：task 需要状态管理，谁来判断状态？管理员判断=认知压力，系统自动判断=标准模糊
3. **教训参照**：会话池就是"需要导入才能建立关联"的正式抽象，结果太麻烦，不想用

**替代方案**：使用"工作线程"（Work Thread）作为隐含概念，从血缘关系中涌现，零创建成本、零维护成本。详见第 3 节。

---

## 3. 核心概念定义

### 3.1 会话血缘（Session Lineage）

当一个关联了群聊的 session 被执行上下文管理操作（trim、compact、summary），产生的后续 session 与原 session 之间形成**血缘关系**。

群聊只维护通用的血缘记录：`{ from, to, reason, timestamp }`。

群聊不理解 `reason` 的语义（trim 是什么、精简了哪些消息），只做存储和展示。

### 3.2 工作线程（Work Thread）

由血缘关系串联的一组 session，代表一条从"开始到现在"的完整工作脉络。

工作线程的关键特征：
- **零创建成本**：不需要用户或管理员显式创建，从 session 创建 + 血缘关系中自动涌现
- **零维护成本**：不需要状态管理，阶段从信号推断
- **自动标签**：工作线程的标签来自触发它的第一条用户消息 + 最近完成的 task 标题
- **自动阶段推断**：无 task 完成 = 探索阶段；有 task 完成 + 最近 trim = 编码阶段；全部完成 = 可能已完成

**血缘分组规则**：
- trim / compact / summary 产生的后续 session → **同一条工作线程**（内在连续，可信任）
- branch 产生的新 session → **新的工作线程**（明确的分叉点）

### 3.3 血缘继承（Lineage Inheritance）

当 session-A 被执行上下文管理操作产生 session-B 时：

1. 如果 session-A 关联了群聊 X，则 session-B **自动继承**群聊 X 的关联
2. 不需要用户手动"重新导入"
3. 血缘记录 `{ from: session-A, to: session-B, reason, timestamp }` 写入群聊 X
4. session-B 成为该工作线程的**活跃头部**（active head）
5. session-A 不从会话池消失，但不再是活跃头部
6. 管理员的后续 @派发 自动路由到活跃头部

### 3.4 工作线程与正式抽象的边界

工作线程不是正式实体。它没有 ID、没有 lifecycle 状态机、不需要被创建或关闭。它只是血缘数据在展示层的投影。

如果未来验证中发现以下信号，才考虑升级为正式抽象：
- 5+ 条工作线程同时活跃，管理员的自然语言推理开始出错
- 非线性编排（DAG）成为常态
- 用户主动表达分类需求（"把这个归到 auth 重构下"）

当前阶段，隐含工作线程 + 推断标签 + 自动路由 是最合适的复杂度。

---

## 4. 设计原则：推送事件 + 按需拉取

### 4.1 两层感知模型

**推送层（被动接收）**：稀疏的结构化事件，让管理员知道"有事情在发生"。

**拉取层（主动查询）**：管理员需要做编排决策时，主动调用工具获取详细信息。

| 维度 | 推送（事件通知） | 拉取（工具查询） |
|---|---|---|
| 时机 | 操作发生时自动触发 | 管理员需要决策时主动调 |
| 内容量 | 一句话 | task 列表 + 会话摘要 |
| 频率 | 稀疏（一天几条） | 按需（一次决策一次） |
| 认知压力 | 低 | 只在决策时刻，可控 |

### 4.2 推送事件类型

| 事件 | 触发时机 | 管理员看到的内容 |
|---|---|---|
| `session_created` | 群聊派发创建新会话 | "新会话：auth 重构"（已有，`task_started` 事件覆盖） |
| `session_continued` | trim/compact/summary 产生后续会话 | "会话已精简，后续会话已自动关联" |
| `task_completed` | agent 完成一个 task | "任务完成：理解 auth 模块结构" |
| `session_idle` | 会话长时间无活动（可选） | "会话已空闲 15 分钟" |

所有事件复用现有 `notifyAdminForActivity` + `kind: 'event'` 通道。

### 4.3 拉取工具

| 工具 | 作用 | 返回内容 |
|---|---|---|
| `gc_session_threads` | 列出群聊的所有工作线程 | 每个线程的活跃 session ID、阶段标记、血缘深度、标签 |
| `gc_session_tasks` | 查询指定 session 的 task 列表 | 每个 task 的标题、状态（completed/in_progress/pending） |
| `gc_session_summary` | 获取指定 session 的简要摘要 | 做了什么、关键产出（复用现有 session summary 机制） |

---

## 5. 管理员上下文积累过程

### 5.1 场景设定

群聊"auth 重构"，成员为管理员 + 编程小助手·主代理。模式 plan。

### 5.2 时间线

**T0 — 群聊创建**

管理员 session 首次激活，`isNew=true`，注入静态背景块：

```
[system-reminder (catch-up)]
─── 群聊基本信息 ───
群名：auth 重构 | 工作目录：D:\project\auth-service
成员：编程小助手·主代理、管理员

─── GROUP.md ───
（群聊背景文档，如有）

─── 群记忆 ───
（如有历史群记忆）
```

管理员知道：这是一个 auth 重构项目的群。

---

**T1 — 用户 @编程小助手 派发任务**

```
用户：@编程小助手 重构 auth 模块
```

系统自动派发（plan 模式）。管理员收到通知：

```
[system-reminder (catch-up)]
─── 自动派发状态 ───
目标：编程小助手（programming-helper:main）
操作：创建了新会话「auth 重构」
sessionId: session-001

─── 你未读的群聊消息（共1条）───
[T1] 用户：@编程小助手 重构 auth 模块

[user]
用户 @了 编程小助手
```

管理员知道：工作线程 #1 开始了，活跃头部 = session-001。

---

**T2 — agent 完成探索阶段第一个 task**

agent 在原生界面工作。用户追加指令、调整方案——**这些不同步到群聊。**

task 完成事件触发：

```
[system-reminder (catch-up)]
─── 你未读的群聊消息（共1条）───
[T2] [系统事件] 编程小助手 [会话:auth 重构 #1] 任务完成：理解 auth 模块结构

[user]
系统事件：编程小助手 [会话:auth 重构 #1] 任务完成
```

管理员知道：探索阶段的第一个 task 完成了。但看不到用户追加的具体指令和工具调用。

---

**T3 — 用户 trim session-001**

用户在原生界面点击 trim。产生 session-002。

血缘继承触发：session-002 自动继承群聊关联，session-002 成为活跃头部。

```
[system-reminder (catch-up)]
─── 你未读的群聊消息（共1条）───
[T3] [系统事件] 编程小助手 [会话:auth 重构] 会话已精简
  原会话：session-001 → 后续会话：session-002

[user]
系统事件：编程小助手 [会话:auth 重构] 会话已精简
```

管理员知道：工作线程从探索阶段进入编码阶段。后续 @编程小助手 的派发自动路由到 session-002。

**对比**：当前实现下，T3 对管理员完全不可见。session-002 是孤儿。

---

**T4 — 用户 @管理员 请求编排决策**

```
用户：@管理员 auth 这边探索做完了，接下来怎么安排？
```

管理员激活，通过拉取工具获取详情：

```
gc_session_threads →
  工作线程 #1: "重构 auth 模块"
    活跃头部：session-002
    血缘：session-001 →(trim)→ session-002
    阶段：编码（已完成 2 task，最近有 trim）

gc_session_tasks(session-002) →
  ✓ 理解 auth 模块结构
  ✓ 识别 3 处需要修改的接口
  ○ 修改 login.ts（进行中）
  ○ 运行测试
```

管理员基于完整态势做出编排建议。

---

### 5.3 上下文积累的节奏

| 时间段 | 事件密度 | 管理员角色 |
|---|---|---|
| 任务启动 | 低 | 观察，不介入 |
| 探索阶段 | 中（task 完成事件） | 可选：检查进度 |
| trim 发生 | 低（1 条血缘事件） | **关键节点**：编排决策 |
| 编码阶段 | 低 | 等待或准备下一步 |
| 编码完成 | 中 | **关键节点**：决定下一步 |

管理员的工作模式是**稀疏监听 + 关键节点决策**。

---

## 6. 用户视角：无感知的协调

### 6.1 设计目标

编程小助手侧的用户体验**完全不变**。trim、branch、task 管理、会话列表展示——全部照旧。

用户感受到的唯一变化是**不需要做的事情**：不再需要 trim 后手动导入新会话到群聊。

### 6.2 用户的一天

| 环节 | 以前 | 设计后 |
|---|---|---|
| 在编程小助手里干活 | trim、branch、task 管理 | **完全一样** |
| trim 后的会话列表 | 多一个新 session | **完全一样**（可选：标注血缘） |
| trim 后需要去群聊操作 | 手动导入新 session + 解释 | **不需要了** |
| 问管理员"下一步怎么安排" | 管理员不知道 trim 后的 session | 管理员自动知道 |

### 6.3 会话起点

两种起点都支持，但推荐从群聊开始：

**起点 A（推荐）**：群聊 @派发 → 创建 session（自动关联群聊）→ 用户切到编程小助手干活 → trim → 自动继承。管理员全程可见。

**起点 B（后拉入）**：编程小助手先创建 session → 后续决定让管理员介入 → 轻量关联到群聊（如在群聊说一句"@管理员 追踪 session-XXX"）→ 关联后的一切自动追踪。关联前的历史管理员不知道，但这是物理现实。

---

## 7. 新事件如何融入已有注入规范

### 7.1 已有规范回顾

管理员每次激活遵循两层结构：
- 第一层 `system-reminder (catch-up)`：水位线追赶，含原始消息全文（证据）
- 第二层 `user`：一句话事件通知（态度指令）

### 7.2 新事件遵循同一规范

所有新增事件是 `kind: 'event'` 的消息，走 `notifyAdminForActivity` 通道。注入结构完全不变。

**session_continued 注入示例**：
```
[system-reminder (catch-up)]
─── 你未读的群聊消息（共1条）───
[T3] [系统事件] 编程小助手 [会话:auth 重构] 会话已精简
  原会话：session-001 → 后续会话：session-002

[user]
系统事件：编程小助手 [会话:auth 重构] 会话已精简
```

### 7.3 事件描述对照表（扩展版）

在 `notifyAdminForActivity` 的 `event.type` 分支上扩展：

| `event.type` | user 块描述 | 触发场景 | 新增? |
|---|---|---|---|
| `task_started` | `系统事件：{name}{session} 已开始处理` | 消息派发成功 | 否 |
| `session_interrupted` | `系统事件：{name}{session} 会话已被管理员中断` | 管理员手动中断 | 否 |
| `agent_offline` | `系统事件：{name}{session} 进程已退出` | agent 进程死亡 | 否 |
| `session_continued` | `系统事件：{name}{session} 会话已精简` | trim/compact/summary | **是** |
| `task_completed` | `系统事件：{name}{session} 任务完成：{taskTitle}` | TodoFeature task 完成 | **是** |

### 7.4 拉取工具的注入

拉取工具通过 GroupAdminFeature 注册，返回的结构化数据直接进入管理员 reasoning 上下文，不需要特殊的注入逻辑。与现有 `gc_overview` / `gc_sessions` 等工具完全一致的机制。

---

## 8. 数据链路全景

### 8.1 现有数据结构

#### 群聊 JSON（`chat`）

存储位置：`%USERPROFILE%\.agentdev\AgentDevClaw\group-chats\{chatId}.json`

```
chat = {
  id, name, workDir, createdAt, updatedAt,
  members: [{ identityRef, displayName, sessionModel }],
  messages: [{
    id, text, from, timestamp,
    routing: { targetWorkspaceId, targetIdentityRef, targetSessionId, status, ... },
    kind,                    // 'message' | 'event'
    event: { type, ... },    // kind='event' 时存在
  }],
  sessions: {                // identityRef → sessionId 持久映射
    "programming-helper:main": "session-001",
    "work-group:admin": "session-admin-xxx"
  },
  adminSessionHistory: [...], // 管理员滚动前的旧 session ID
  importedSessions: [{        // 手动导入的外部会话
    sessionId, workspaceId, workspaceName, importedAt
  }],
  initiativeMode: 'assist',   // assist | plan | execute
  autonomyMode: 'auto',
  adminMemory: { range, limitMode, tokenLimit, ratioLimit },
  adminNeedsContextInit: null, // 标记新 admin session 需要完整上下文
  lastActiveAt: {},
}
```

#### Session Index

存储位置：`%USERPROFILE%\.agentdev\AgentDevClaw\prebuilt-sessions\{agentId}\index.json`

```
index = {
  sessions: [{
    id, title, taskTitle, createdAt, updatedAt,
    openDirectory,            // 项目目录
    sessionType,              // 'normal' | 'exploration'
  }],
  activeSessionId: null,
}
```

#### Session 文件（单个会话快照）

存储位置：`%USERPROFILE%\.agentdev\AgentDevClaw\prebuilt-sessions\{agentId}\{sessionId}.json`

```
session = {
  sessionId, title, savedAt,
  runtime: {
    context: {
      messages: [...],         // 完整对话历史
      enrichedMessages: [...],
    },
    featureStates: {           // 各 Feature 的持久化状态
      todo: { tasks: [...] },  // TodoFeature 的 task 列表
      ...
    },
  },
  rollbackHistory: [...],
}
```

### 8.2 现有上下文管理操作的完整链路

所有产生新 session 的操作，及其服务端入口：

| 操作 | API 端点 | 函数 | 产出 |
|---|---|---|---|
| branch | `POST /protoclaw/sessions/branch` | `session.js` 内联 | 从指定消息切点创建新 session |
| compact + resume | `POST /protoclaw/context_handoffs/compact_and_resume` | `compactAndResumeCurrentSession()` | 压缩上下文后创建新 session |
| summary resume | `POST /protoclaw/context_handoffs/summary_resume` | `compactAndResumeFromProvidedSummary()` | 从摘要创建新 session |
| compacted resume | `POST /protoclaw/context_handoffs/compacted_resume` | `createCompactedResumeFromHandoff()` | 从导出的 handoff 创建新 session |

**共同模式**：这些操作都接收一个 `sourceSessionId`，产出一个 `newSessionId`。这正是血缘记录 `{ from, to, reason }` 的数据来源。

trim 操作（纯前端裁剪 + 新建会话）也走 compact_and_resume 或 summary_resume 的服务端链路，不是纯前端操作。

### 8.3 数据扩充：新增字段

#### 群聊 JSON 新增

```
chat.sessionLineage = [
  {
    from: "session-001",           // 源 session ID
    to: "session-002",             // 后续 session ID
    reason: "trim",                // trim | compact | summary | branch
    timestamp: 1752000000000,
    identityRef: "programming-helper:main",  // 归属身份
  },
]
```

与现有 `chat.sessions`、`chat.importedSessions`、`chat.adminSessionHistory` 并列。

#### Session Index 记录新增（可选优化）

```
index.sessions[i].groupChatId = "chat-xxx"  // 正向索引，避免反查群聊
```

当前阶段可以不做，先用反查（遍历群聊的 `chat.sessions` 和消息 routing）。当性能成为瓶颈时再加正向索引。

### 8.4 数据流：血缘继承的完整链路

```
用户在编程小助手原生界面触发 trim
  │
  ▼
前端调用 POST /protoclaw/context_handoffs/compact_and_resume
  │  body: { sessionId: "session-001", ... }
  │
  ▼
session.js: compactAndResumeCurrentSession()
  │  读取 session-001 → 压缩 → 创建 session-002
  │  写入 session index
  │
  ▼
session.js: 操作完成后，调用血缘回调（新增）
  │  notifySessionLineage({ agentId, fromSessionId: "session-001",
  │    toSessionId: "session-002", reason: "trim" })
  │
  ▼
group-chat.js: notifySessionLineage()
  │  1. 反查：哪个群聊关联了 session-001？
  │     遍历 group-chats/*.json 的 chat.sessions + 消息 routing
  │  2. 如果找到关联的群聊 chat-X：
  │     a. 写入 chat-X.sessionLineage 血缘记录
  │     b. 更新 chat-X.sessions[identityRef] = "session-002"（活跃头部替换）
  │     c. 写入 kind='event' 消息到 chat-X.messages
  │     d. plan/execute 模式下：notifyAdminForActivity() 通知管理员
  │  3. 如果没找到关联：静默跳过（该 session 不属于任何群聊）
  │
  ▼
bridge.ts 轮询 /protoclaw/gc/inbox → 拿到 session_continued 事件
  │  idle: contextText → @CallStart system-reminder, text → user
  │  busy: → @StepStart system-reminder
  │
  ▼
管理员看到"会话已精简，后续会话已自动关联"
```

### 8.5 数据流：task 完成事件的链路

task 状态变化发生在 agent 子进程内部（TodoFeature）。需要跨进程传递到 server 主进程。

```
agent 子进程: TodoFeature 标记 task 为 completed
  │
  ├─ 方案 A（推荐）：agent 通过 bridge 向 server 推送
  │    bridge.ts 增加 task 状态监听
  │    → POST /protoclaw/gc/task_event
  │    body: { chatId, sessionId, taskTitle, status: "completed" }
  │
  ├─ 方案 B：agent 在 task 完成时主动调用群聊通知工具
  │    增加 gc_report_task 工具
  │    agent 自主判断何时调用
  │
  ▼
group-chat.js: 接收 task_event
  │  1. 写入 kind='event' 消息到 chat.messages
  │  2. plan/execute 模式下：notifyAdminForActivity()
  │
  ▼
管理员收到"任务完成：理解 auth 模块结构"
```

具体选哪个方案需要在实现时评估。方案 A 更可靠（确定性触发），方案 B 更灵活但依赖 agent 的判断。

### 8.6 数据流：拉取工具的链路

```
管理员调用 gc_session_tasks(sessionId)
  │
  ▼
group-admin/index.ts → MCP bridge → HTTP API
  GET /protoclaw/gc/session_tasks?sessionId=xxx&agentId=yyy
  │
  ▼
group-chat.js（新增端点）
  │  1. 读取 session 文件：readSessionFile(agentId, sessionId)
  │  2. 提取 runtime.context.featureStates.todo.tasks
  │  3. 返回结构化 task 列表
  │
  ▼
管理员 reasoning 上下文获得 task 列表
```

gc_session_threads 的链路：
```
管理员调用 gc_session_threads()
  │
  ▼
group-chat.js: 读取 chat.sessionLineage + chat.sessions
  │  1. aggregateSessionPool(chat) → 扁平 session 列表
  │  2. groupByLineage(sessions, lineage) → 工作线程列表
  │  3. 为每个工作线程推断标签和阶段
  │
  ▼
返回工作线程列表
```

### 8.7 数据一致性保证

| 数据 | 写入方 | 读取方 | 一致性策略 |
|---|---|---|---|
| `chat.sessionLineage` | `notifySessionLineage()`（server） | bridge 轮询、拉取工具 | 通过 `writeGroupChat()` 原子写入 |
| `chat.sessions[ref]` 活跃头部 | `notifySessionLineage()` 更新 | 派发路由、拉取工具 | 同上，与 lineage 写入在同一个 `writeGroupChat` 调用中 |
| session index | 各 context management 操作 | 拉取工具、会话池聚合 | 已有 `updateSessionIndex()` 保证原子性 |
| TodoFeature tasks | agent 子进程（TodoFeature 内部） | gc_session_tasks（server 读 session 文件） | session 文件在 task 完成后由 agent runtime 写入，server 端读取时可能有一致性延迟（秒级），可接受 |

关键约束：**血缘记录和活跃头部更新必须在同一个 `writeGroupChat` 调用中完成**，避免中间状态。

---

## 9. 开发规划

### 9.1 模块总览

```
需要改动的模块：
├── server/routes/session.js          ← 血缘回调触发点
├── server/routes/group-chat.js       ← 血缘写入、事件通知、拉取工具 API、工作线程视图
├── local-features/group-admin/src/   ← 新工具注册、task 事件推送
│   ├── index.ts                      ← gc_session_threads, gc_session_tasks, gc_session_summary
│   └── bridge.ts                     ← task 事件监听 + 推送（方案 A）
└── server/routes/session-helpers.js  ←（可能）compactAndResume 等函数增加回调参数

需要新增的接口：
├── POST /protoclaw/gc/session_lineage        ← 血缘写入（内部调用，非管理员直接使用）
├── GET  /protoclaw/gc/session_tasks           ← 拉取指定 session 的 task 列表
├── GET  /protoclaw/gc/session_threads         ← 拉取工作线程列表
├── GET  /protoclaw/gc/session_summary         ← 拉取会话摘要
└── POST /protoclaw/gc/task_event              ← task 事件推送（bridge → server）
```

### 9.2 开发阶段

#### Phase 1：血缘继承（核心链路打通）

**目标**：trim 后的 session 自动继承群聊关联，管理员收到通知。

**改动范围**：

1. **`server/routes/group-chat.js`** — 新增函数和事件类型
   - 新增 `notifySessionLineage({ agentId, fromSessionId, toSessionId, reason })` 函数
     - 反查群聊关联（遍历 `group-chats/*.json`）
     - 写入 `chat.sessionLineage`
     - 更新 `chat.sessions[identityRef]` 活跃头部
     - 写入 `kind='event'` 消息
     - plan/execute 模式下调用 `notifyAdminForActivity()`
   - 在 `notifyAdminForActivity` 的 `event.type` 分支增加 `session_continued`
   - 导出 `notifySessionLineage` 供 session.js 调用

2. **`server/routes/session.js`** — 在上下文管理操作完成后触发血缘回调
   - `POST /protoclaw/sessions/branch` 端点：创建新 session 后调用 `notifySessionLineage({ reason: 'branch' })`
   - `compactAndResumeCurrentSession` 回调路径：完成后调用 `notifySessionLineage({ reason: 'compact' })`
   - `compactAndResumeFromProvidedSummary` 回调路径：完成后调用 `notifySessionLineage({ reason: 'summary' })`
   - 需要将 `notifySessionLineage` 从 group-chat.js 导入，或通过共享模块

3. **`server/routes/session-helpers.js`** — 传递回调
   - `compactAndResumeCurrentSession` 等函数可能需要接受 `onComplete` 回调参数
   - 或者在函数返回值中携带 `{ fromSessionId, toSessionId }`，由调用方（session.js 端点）触发血缘

**通讯方式**：纯 server 主进程内部函数调用。不涉及跨进程。session.js 和 group-chat.js 都在同一个 Express app 中。

**验证标准**：在关联群聊的会话上执行 trim 后，群聊自动出现 session_continued 事件，管理员能看到。后续 @派发自动路由到新 session。

---

#### Phase 2：Task 完成事件传播

**目标**：agent 完成 task 时，群聊自动收到 task_completed 事件。

**改动范围**：

1. **`local-features/group-admin/src/bridge.ts`** — 监听 task 状态变化
   - 在 `@CallFinish` 或 step 级 hook 中检测 TodoFeature 的 task 状态变化
   - 对比上一次的 task 列表和当前的，找出新完成的 task
   - 通过 HTTP 调用 `POST /protoclaw/gc/task_event` 推送到 server

2. **`server/routes/group-chat.js`** — 接收 task 事件
   - 新增 `POST /protoclaw/gc/task_event` 端点
   - 写入 `kind='event'` 消息到群聊
   - plan/execute 模式下通知管理员

3. **`local-features/group-admin/src/index.ts`** — `notifyAdminForActivity` 增加 `task_completed` 分支

**通讯方式**：agent 子进程 → HTTP → server 主进程。与现有 bridge 轮询 `/protoclaw/gc/inbox` 使用相同的 HTTP 通道，只是方向反过来（bridge 主动 POST 到 server）。

**复杂度**：比 Phase 1 高。TodoFeature 的 task 状态变化检测需要确定性的 diff 逻辑。需要处理 edge case（task 被删除、task 标题修改等）。

---

#### Phase 3：拉取工具

**目标**：管理员能通过工具获取工作线程视图和 session 详情。

**改动范围**：

1. **`server/routes/group-chat.js`** — 新增 API 端点
   - `GET /protoclaw/gc/session_tasks?sessionId=xxx&agentId=yyy` — 读取 session 文件中的 TodoFeature tasks
   - `GET /protoclaw/gc/session_threads?chatId=xxx` — 聚合工作线程视图
   - `GET /protoclaw/gc/session_summary?sessionId=xxx&agentId=yyy` — 复用现有 session summary 机制

2. **`local-features/group-admin/src/index.ts`** — 注册新工具
   - `gc_session_threads`：调用 `/protoclaw/gc/session_threads`
   - `gc_session_tasks`：调用 `/protoclaw/gc/session_tasks`
   - `gc_session_summary`：调用 `/protoclaw/gc/session_summary`

3. **`server/routes/group-chat.js`** — 工作线程聚合逻辑
   - 新增 `groupByLineage(sessionPool, lineageMap)` 函数
   - 推断工作线程标签（来自第一条用户消息 / 最近 task 标题）
   - 推断阶段（基于 task 完成模式 + 血缘深度）

**通讯方式**：管理员 agent → MCP bridge → HTTP → server。与现有 `gc_overview`、`gc_sessions` 完全一致。

---

#### Phase 4：工作线程视图集成（可选）

**目标**：`gc_overview` 和 `gc_sessions` 的输出中包含工作线程信息。

**改动范围**：
- `group-chat.js` 的 `aggregateSessionPool` 增加血缘分组
- `group-admin/index.ts` 的 `gc_overview` 工具返回值增加工作线程摘要
- `gc_dispatch` 的 session 列表展示按工作线程组织

**验证标准**：管理员的会话认知压力是否降低。

---

### 9.3 接口通讯方式总结

| 链路 | 通讯方式 | 说明 |
|---|---|---|
| session 操作 → 血缘写入 | server 内部函数调用 | `session.js` 调用 `group-chat.js` 导出的 `notifySessionLineage()` |
| task 事件推送 | HTTP POST | bridge.ts → `POST /protoclaw/gc/task_event` → group-chat.js |
| 拉取工具查询 | HTTP GET | bridge.ts → `GET /protoclaw/gc/session_*` → group-chat.js |
| 事件通知管理员 | 现有 `enqueueGcInbox` + bridge 轮询 | 复用现有 `/protoclaw/gc/inbox` 通道，零改动 |
| session 文件读取 | 文件系统 | `readSessionFile()` 直接读取 session JSON |

所有新链路都建立在现有的 HTTP + 文件系统基础设施上，不引入新的通讯协议。

---

## 10. Mode 演进的影响

### 10.1 当前 Mode 行为

| Mode | 管理员参与 | 差异 |
|---|---|---|
| assist（观察） | 不参与 | 无注入 |
| plan（规划） | 通知观察 | systemNote 含自动派发状态 |
| execute（执行） | 全权协调 | 管理员需自行派发 |

三个 mode 在注入结构上完全一致，差异在 runtime 行为。

### 10.2 新事件的 Mode 兼容性

session_continued 和 task_completed 是**与 mode 无关的结构化信号**：

| 事件 | assist | plan | execute |
|---|---|---|---|
| session_continued | 写入群聊但不通知管理员 | 通知管理员 | 通知管理员 |
| task_completed | 同上 | 通知管理员 | 通知管理员 |

**新事件不改变现有 mode 的语义，只增加管理员可感知的信号种类。**

### 10.3 未来 Mode 预判

可能出现的 `lifecycle` 模式：管理员只在 session 生命周期事件时激活，不响应每条群聊消息。比 plan 更稀疏，比 assist 更主动。当前不预设，待验证后设计。

---

## 11. 渐进验证路径

### Step 1：血缘继承（Phase 1）

**验证标准**：trim 后，管理员是否能在不需要"重新导入+重新解释"的情况下继续协调。

如果不通：管理员理解能力不够，及早止损。如果通了：链路修复方向正确。

### Step 2：Task 完成事件（Phase 2）

**验证标准**：管理员是否能在 task 完成后做合理的下一步判断。

### Step 3：拉取工具（Phase 3）

**验证标准**：管理员在编排决策时，是否能通过工具获取足够信息。

### Step 4：工作线程视图（Phase 4，可选）

**验证标准**：管理员的会话认知压力是否降低。

---

## 12. 开放问题

### 12.1 血缘回调的函数引用方式

`session.js` 需要调用 `group-chat.js` 导出的 `notifySessionLineage()`。当前两个模块都挂在同一个 Express app 上。可以直接 import。但如果未来模块拆分，需要考虑通过事件总线或共享模块解耦。

### 12.2 session↔群聊关联的反查效率

反查需要遍历所有群聊文件。当群聊和会话数量增长时可能成为瓶颈。

**解法**：在 session index 记录中增加 `groupChatId` 正向索引。当前可不做，用反查先跑起来。

### 12.3 TodoFeature task 状态的读取

`gc_session_tasks` 需要读取 session 文件中的 `runtime.context.featureStates.todo.tasks`。这依赖 TodoFeature 的持久化格式。需要确认：
- TodoFeature 是否在每次 task 变更时都写入 session 文件？
- 还是只在 session 保存时写入？

如果写入不及时，拉取工具可能看到过期的 task 状态。

### 12.4 事件聚合

当群聊中有多个工作线程同时推进时，事件密度可能上升。是否需要聚合机制（"3 个任务完成"而非三条独立事件）？当前不做聚合，先验证原始密度是否可接受。

### 12.5 血缘链的展示深度

catch-up 中只展示最近一次血缘转换。完整血缘链通过拉取工具获取。是否足够？

---

## 13. 被否定的方案

### 13.1 ~~让 agent 自主做 trim~~

trim 的精确范围选择对 agent 心智成本太高。trim 的决策依赖完整会话语义理解，通过 tool call 参数难以表达。agent 做错 trim 的代价比 summary 更高。

**替代**：trim 由人完成，结果（血缘信号）自动传播给管理员。

### 13.2 ~~全量同步原生界面内容到群聊~~

信息量太大，管理员被淹没。与"user 块保持极简"原则矛盾。

**替代**：推送结构化事件，需要详情时拉取。

### 13.3 ~~群聊拥有独立的会话池~~

创造平行宇宙，用户需要手动导入，trim 后脱节。

**替代**：群聊只维护血缘关系，会话真相始终在 workspace 原生层。

### 13.4 ~~引入正式 Task/Issue 实体~~

创建和维护成本高。简单任务被过度复杂化。管理员有认知压力。

**替代**：工作线程从血缘涌现，零创建零维护成本。

### 13.5 ~~群聊降级为编程小助手的上层视图~~

群聊的定位是全场景统一接入面，编程小助手只是第一个住客。降级锁死平台定位。

**替代**：群聊保持平台定位，编程小助手的能力通过事件协议"上提"。

---

## 附录：与现有实现的对接点速查

| 新设计概念 | 对接的现有组件 | 对接方式 |
|---|---|---|
| session_continued 事件 | `notifyAdminForActivity` 的 `kind: 'event'` | 新增 `event.type` 分支 |
| 血缘记录 | 群聊 JSON | 新增 `chat.sessionLineage` 数组 |
| 活跃头部更新 | `chat.sessions[identityRef]` | 血缘写入时同步更新 |
| 血缘回调触发 | `session.js` 各 context management 端点 | 操作完成后调用 `notifySessionLineage()` |
| task 事件推送 | `bridge.ts` → HTTP → `group-chat.js` | 新增 `POST /protoclaw/gc/task_event` |
| gc_session_threads | `aggregateSessionPool()` | 新增 `groupByLineage()` 分组 |
| gc_session_tasks | session 文件 `featureStates.todo.tasks` | 新增读取端点 |
| gc_session_summary | 现有 session summary 机制 | 复用或包装 |
| 工作线程标签 | 第一条用户消息 + task 标题 | 纯推断，不需要新数据源 |

---

## 附录 B：Phase 1 实施记录

> **实施日期**：2026-07-08
> **实施范围**：Phase 1 血缘继承 + 统一事件格式化 + 原子归档 + 纯归档事件

### B.1 与原始设计的差异

实施过程中发现并修正了原始设计的若干问题，实际实现与设计文档有以下差异：

#### B.1.1 reason 类型收敛

原始设计（§8.3）定义了 4 种 reason：`trim | compact | summary | branch`。

实际实现中收敛为 **3 种**：`branch | summary | trim`。

| 原设计 reason | 实际 reason | 说明 |
|---|---|---|
| `branch` | `branch` | 不变 |
| `compact` | `summary` | compact 和 summary 对用户语义相同（"压缩/摘要上下文后继续"），合并 |
| `summary` | `summary` | 不变 |
| `compacted`（从 handoff 恢复） | `summary` | 同上，语义等价 |
| `trim` | `trim` | 不变 |

此外，原设计的 `reasonMap` 中 `trim: '精简'` 这条映射实际上是死代码——trim 前端走的是 `compact_and_resume` API，之前从未传 `reason: 'trim'`。实施中修复了这一点：前端 trim 操作现在显式传 `reason: 'trim'`。

#### B.1.2 Event 数据结构扩充

原设计（§8.3）的 event 仅包含 `{ from, to, reason, timestamp, identityRef }`。

实际实现的 event 对象补充了以下字段：

```javascript
event: {
  type: 'session_continued',       // 或 'session_archived'
  identityRef,
  identityName,
  workspaceId,

  // 目标会话（新会话）
  sessionId,                       // = toSessionId
  sessionTitle,                    // 新会话标题

  // 源会话
  fromSessionId,
  fromSessionTitle,                // ← 新增：原设计缺失，现已补齐

  // 目标会话
  toSessionId,

  // 操作语义
  reason: 'branch' | 'summary' | 'trim',  // 收敛后的 3 种
  archived: boolean,               // ← 新增：原会话是否已被归档
  trimCutRounds: number,           // ← 新增：仅 trim 时有值
}
```

**为什么需要这些字段**：管理员（无论人类还是 AI）收到通知时，需要回答"谁的会话变了、发生了什么、从哪到哪、原会话什么状态"。原设计仅传 ID 和 reason，管理员无法理解完整上下文。

#### B.1.3 原子归档（archiveOriginal）

原设计（§8.4）的数据流是"先创建新 session → 再通知血缘"，归档作为前端独立操作发生在通知之后。

**问题**：服务端生成 lineage event 时不知道原会话是否会被归档，事件中缺少归档状态信息。

**实施解法**：前端在调用 `compact_and_resume`、`summary_resume`、`branch` 等 API 时传入 `archiveOriginal: true`。服务端在一个原子操作中完成：

1. 创建新 session
2. 归档原 session（如果 `archiveOriginal` 为 true）
3. 发送包含 `archived` 状态的 lineage event

前端不再独立调用 archive API。

#### B.1.4 纯归档事件（session_archived）

原设计未覆盖"用户纯归档一个会话（不涉及新会话创建）"的场景。

实施中新增 `notifySessionArchived()` 函数和 `session_archived` 事件类型：
- 触发条件：用户在会话列表右键 → 归档会话
- 行为：从 `chat.sessions[identityRef]` 活跃头部中移除该 session，写入 `session_archived` 事件消息
- 管理员看到：`编程小助手 会话已归档，不再接收新任务`

#### B.1.5 统一格式化函数

原设计中 `formatCatchUpPrompt`（catch-up 路径）和 `notifyAdminForActivity`（实时通知路径）各自独立格式化事件，存在输出不一致的问题。实际发现 `formatCatchUpPrompt` 完全没有处理 `session_continued` 事件类型，直接输出原始内部字符串 `session_continued`。

实施中抽取了统一的 `formatSessionLifecycleEvent(event)` 函数，两条路径都调用它，确保输出一致。

### B.2 管理员实际看到的注入提示词

以下是各场景下管理员实际收到的格式化输出（由 `formatSessionLifecycleEvent` 生成）：

#### 摘要交接（仅摘要，不归档）
```
编程小助手 会话变更：
  操作：摘要交接
  原会话：「重构认证模块 #abc12345」（仍可查看）
  新会话：「重构认证模块（续）#def67890」
```

#### 摘要交接（原会话已归档）
```
编程小助手 会话变更：
  操作：摘要交接，原会话已归档
  原会话：「重构认证模块 #abc12345」→ 已归档
  新会话：「重构认证模块（续）#def67890」
```

#### 精简历史（附带轮次信息）
```
编程小助手 会话变更：
  操作：精简历史（精简 5 轮）
  原会话：「实现导出功能 #abc12345」（仍可查看）
  新会话：「实现导出功能 #def67890」
```

#### 创建分支
```
编程小助手 会话变更：
  操作：创建分支
  原会话：「修复登录Bug #abc12345」（仍可查看）
  新会话：「修复登录Bug #def67890」
```

#### 纯归档
```
编程小助手 会话已归档，不再接收新任务
```

### B.3 修改的文件清单

| 文件 | 改动内容 |
|------|---------|
| `server/routes/group-chat.js` | 新增 `formatSessionLifecycleEvent()` 统一格式化函数；`notifySessionLineage` 补全 `fromSessionTitle`/`archived`/`trimCutRounds` 字段，读取原会话标题；新增 `notifySessionArchived()` 处理纯归档事件；`formatCatchUpPrompt` 和 `notifyAdminForActivity` 统一调用 `formatSessionLifecycleEvent` |
| `server/routes/session.js` | 四个路由（`compact_and_resume`/`summary_resume`/`compacted_resume`/`branch`）全部接受 `archiveOriginal` 参数，服务端原子完成归档后再发通知；`reason` 收敛为 `branch`/`summary`/`trim`；trim 路径传 `trimCutRounds`；archive 路由调用 `notifySessionArchived` |
| `server.js` | 传递 `notifySessionArchived` 到 session 路由上下文 |
| `public/src/app-main.js` | `createCompactedResumeSession` 新增 `options` 参数传递 `archiveOriginal`/`reason`/`trimCutRounds`；summary 操作不再前端独立调 archive API |
| `public/src/modules/session-dialogs.js` | trim 和 branch 的 submit handler 传递 `reason: 'trim'`/`trimCutRounds`/`archiveOriginal`；不再调用 `archiveSessionAfterMutation`，改为仅停止旧 runtime |

### B.4 实施中发现并修复的预存 Bug

#### `session-helpers.js` projectRoot 路径错误

**症状**：摘要交接操作报错 `Cannot find module 'D:\code\AgentDevClaw\server\routes\scripts\run-compact-mirror.js'`

**根因**：`session-helpers.js` 第 1356 行将 `projectRoot: __dirname` 传给 `exportSummarizedHandoffPackage`。由于 `session-helpers.js` 位于 `server/routes/` 目录，`__dirname` = `D:\code\AgentDevClaw\server\routes`，而非项目根目录。下游 `summarized-handoff.js` 用这个错误的 projectRoot 去拼接 `scripts/run-compact-mirror.js` 路径，导致模块找不到。

**修复**：新增 `const PROJECT_ROOT = path.resolve(__dirname, '..', '..')`，用 `PROJECT_ROOT` 替换 `__dirname`。与 `session.js` 中已有的 `PROJECT_ROOT` 定义方式一致。

**为什么之前没暴露**：这条代码路径（`summarized-nine-section` 策略）可能在之前从未被实际触发过。

### B.5 实施后的 Event 数据一致性

`notifySessionLineage` 在一个 `writeGroupChat` 调用中原子完成三件事：

1. 写入 `chat.sessionLineage` 血缘记录（`{ from, to, reason, timestamp, identityRef }`）
2. 更新 `chat.sessions[identityRef]` 活跃头部
3. 写入 `kind='event'` 事件消息（携带完整的 `fromSessionTitle`/`sessionTitle`/`reason`/`archived`/`trimCutRounds`）

然后异步调用 `notifyAdminForActivity`（仅 plan/execute 模式）。

### B.6 Phase 2-3 实施状态（2026-07-08 更新）

| Phase | 内容 | 状态 | Commit |
|---|---|---|---|
| Phase 2 | Task 完成事件传播 | 已实施 | `06d60ee` |
| Phase 3 | 拉取工具（gc_session_threads / gc_session_tasks / gc_session_summary） | 已实施 | `06d60ee` |
| Phase 4 | 工作线程视图集成（前端 UI） | 未实施 | 见附录 C |

Phase 2 实施：`trackGroupChatDispatch` 轮询 `/todo` 端点，diff 检测新完成的 task，写入 `task_completed` 事件消息并通知管理员。`notifyAdminForActivity` 和 `formatCatchUpPrompt` 增加 `task_completed` 分支。

Phase 3 实施：新增 `groupByLineage()` 和 `inferThreadPhase()` 函数，将扁平会话池聚合为工作线程。注册 3 个 API 端点（`session_threads`、`session_tasks`、`session_summary`）和 3 个管理员工具（`gc_session_threads`、`gc_session_tasks`、`gc_session_summary`）。

另注：Phase 1 commit 后，生命周期事件通知策略有调整——`session_continued` 和 `session_archived` 不再主动唤醒管理员，降级为仅写入 catch-up 水位线。

---

## 附录 C：前端态势感知与工作面板设计

> **设计日期**：2026-07-09
> **设计范围**：群聊前端 UI 的三区职责划分、工作面板、态势栏简化、事件渲染
> **前置条件**：Phase 1-3 已实施（血缘数据、生命周期事件、拉取工具 API 均已就绪）

---

### C.1 产品语义重新定义

当前所有设计痛点的根源是：**"群聊"这个隐喻在误导设计决策。**

真实的群聊（微信/QQ）语义是：消息 = 人际沟通，每条消息有独立的信息价值，状态感知靠"谁在线"。

但这个产品的实际语义是：

> **一个以会话生命周期为管理对象的 Agent 协调工作台。**

用户在群聊面板中花时间最多的操作不是"读消息"，而是**判断当前态势、决定下一步操作**。消息流是叙事背景，态势判断和操作执行才是核心交互。

---

### C.2 三区职责模型

基于以上认知，定义三个区域的职责边界：

#### C.2.1 消息流（Message Area）—— 叙事层

**核心职责**：讲一个连贯的项目故事。

用户扫一眼消息流，应该能快速回答"这个群发生了什么、谁在做什么"，而不是"session-002 的 task 3 完成了吗"——后者是面板的事。

包含：
- 用户派发消息（@agent + 任务描述）
- Agent 的文本回复和报告
- 关键生命周期节点作为**薄分隔线**

不包含：
- Task 完成通知（碎，属于面板）
- Session pool 浏览
- 运行时状态详情

#### C.2.2 态势感知栏（Awareness Bar）—— 外围感知层

**核心职责**：用最小认知成本回答"谁在线、有事吗"。

用户不需要点击任何东西，扫一眼就知道全局状态。

设计原则：信息极简，不增加交互负担。当前 popover 的扁平会话池列表已超出"快速感知"的范围，需要降级为索引页。

#### C.2.3 右侧面板（Right Panel）—— 指挥层

**核心职责**：当用户需要理解、决策、操作时，在这里完成。

用户打开面板的动机是"我要看看具体情况"或"我要做某个操作"。信息密度可以高，因为用户是主动打开的。

包含：工作线程全景、派发操作入口、会话导航入口、设置。

---

### C.3 消息流事件渲染规则

| 事件类型 | 消息流表现 | 面板表现 |
|---|---|---|
| `task_started` | 卡片（保持现状） | 线程卡片中的 session 节点 |
| `session_continued` | 薄分隔线 | 时间轴中的血缘转换标记 |
| `task_completed` | 不出现 | 时间轴中的完成标记 |
| `session_archived` | 薄分隔线 | 线程标记为已归档 |

分隔线视觉：单行居中文字，上下留白，半透明，像 git log 中的 commit separator。不打断叙事节奏。

```
────── 编程小助手 会话精简 · 后续已自动关联 ──────
```

`task_completed` 不在消息流中出现——task 进度是面板的核心信息，重复出现在消息流中会产生噪音。

---

### C.4 态势感知栏：做减法

#### C.4.1 成员 Chip 增强

在成员 chip 上添加**工作线程数 badge**（如果 >1）：

```
当前:  [dot] 编程小助手
增强:  [dot] 编程小助手 [3]    <- 右上角小数字 badge
```

badge 告诉用户"这个成员有 3 条工作线程"，暗示更多信息在面板中。不暗示"hover 我能看到全部细节"。

#### C.4.2 Popover 降级为索引页

当前 popover 混合了四种功能：会话池浏览、派发路由、会话导航、中断控制。信息量在 trim 后迅速膨胀。

新的 popover 内容：

```
编程小助手
---------------------------
3 条工作线程
2 编码中 / 1 探索中

活跃头部:
  [dot] 重构 auth 模块      [查看]
  [dot] 修复登录Bug         [查看]

[打开工作面板]
```

变化：
- 不再展示完整扁平会话池
- 只显示工作线程数概要 + 活跃头部标题
- 保留会话导航（"查看"跳转到对应 session）
- 移除"派发至此"和"中断"操作（迁移到工作面板）
- 新增"打开工作面板"按钮跳转到右侧面板

---

### C.5 工作面板设计

#### C.5.1 时间轴方向

时间轴采用**自下而上**的排列方向：

- 最上方 = 最新进展（活跃头部）
- 向下滚动 = 查看历史

这样用户打开面板时，最新状态在视线最自然的位置（顶部），历史信息在下方按需展开。

#### C.5.2 阶段标识

使用文字标签 + 颜色编码，不使用表情符号：

| 阶段 | 文字 | 颜色 |
|---|---|---|
| 探索 | 探索 | 蓝色 |
| 编码 | 编码 | 橙色 |
| 可能完成 | 待确认 | 绿色 |
| 未知 | - | 灰色 |

#### C.5.3 线程卡片结构

每个工作线程是一个卡片，包含：

1. **卡片头部**：线程标题 + 阶段标签 + "派发至此"按钮
2. **时间轴**：session 节点从上到下排列（最新在最上方）
3. **每个节点**：session 标题 + 运行时状态点 + 可展开的 task 列表
4. **血缘转换标记**：节点之间的连接段，标注操作类型（精简 N 轮 / 摘要交接 / 创建分支）
5. **折叠策略**：默认只展示活跃头部节点，其余折叠，点击"展开全部"逐级展开历史

视觉结构示意：

```
[卡片头部]
  重构 auth 模块                    [编码]
  [+ 派发至此线程]

[时间轴 - 自下而上，最新在顶部]

  [实心圆] session-002「精简后续」  <- 当前活跃
           运行中
           -- task 列表 --
             [dot] 修改 login.ts (进行中)
             [o] 运行测试

  [连接段] 精简 5 轮

  [空心圆] session-001「初始探索」  <- 历史（折叠态）
           已归档

  [展开全部]
```

圆点编码：
- 实心圆 + 呼吸动画 = 运行中（活跃头部）
- 实心圆 = 在线空闲
- 半透明圆 = 离线
- 空心圆 = 已归档的历史节点

Task 列表编码：
- `[check]` = 已完成
- `[filled-dot]` = 进行中
- `[empty-circle]` = 待执行

#### C.5.4 "派发至此线程"交互

每条工作线程卡片头部有"派发至此线程"按钮。点击后：

1. 在输入框自动插入 `@成员名 `
2. 自动设置 session selection 为该线程的活跃头部（`mode: 'specific'`）
3. 输入框获得焦点
4. session bar 显示派发路由（"指定会话：线程标题"）

用户不需要通过 @mention -> 二级面板 -> 会话池的多步操作。

#### C.5.5 面板 tab 注册

在 `app-ui.js` 的 `featurePanels` 注册表中新增 `threads` 条目：

```js
threads: {
  title: () => '工作面板',
  render: () => window._wgGetThreadsHtml ? window._wgGetThreadsHtml() : '<div class="feature-panel-empty"><div>加载中...</div></div>',
},
```

渲染逻辑放在新模块 `public/src/modules/wg-threads-panel.js`。

---

### C.6 操作可达性矩阵

| 操作 | @mention 面板 | 成员 Popover | 工作面板 | 消息流 |
|---|:---:|:---:|:---:|:---:|
| 派发到指定线程 | 二级面板选会话 | - | "派发至此"按钮 | - |
| 派发到新建会话 | "新建"选项 | - | 新建按钮 | - |
| 查看会话内容 | - | 活跃头部跳转 | 点击节点 | session badge |
| 查看 task 进度 | - | - | 展开节点 | - |
| 中断运行中的会话 | - | - | 中断按钮 | - |
| 快速感知全局 | - | 线程数摘要 | 全景视图 | - |

原则：每个操作至少 1 条路径，高频操作（派发、查看）2-3 条路径。

---

### C.7 数据流与刷新策略

#### 工作面板数据获取

```
用户打开工作面板 tab
  -> GET /protoclaw/gc/session_threads?chatId=xxx
  -> 得到工作线程列表（含 lineage + phase）
  -> 对活跃线程，GET /protoclaw/gc/session_tasks?sessionId=xxx
  -> 渲染时间轴
```

刷新触发：
1. 长轮询检测到群聊变更 -> 重新拉 session_threads（线程结构变化时）
2. 独立定时器 15s -> 只刷新活跃线程的 runtime status + task 进度

两个频率分离：线程结构变化是低频事件，runtime status 变化是高频事件。

#### 态势栏 badge 数据获取

`fetchRuntimeStatus` 已有 5 秒定时器。扩展为附带获取线程数（或扩展 `runtime_status` API 返回每个成员的线程数）。

---

### C.8 实施计划

| 优先级 | 改动 | 文件 | 依赖 |
|---|---|---|---|
| P0 | 工作面板模块 | 新建 `wg-threads-panel.js` | 无（API 已就绪） |
| P0 | 工作面板 tab 注册 + 数据接入 | `app-ui.js` + `wg-threads-panel.js` | 工作面板模块 |
| P0 | 工作面板 CSS | `layout.css` 或 `work-group.css` | 工作面板模块 |
| P1 | 态势栏 popover 简化 | `wg-popover.js` + `wg-core.js` | 工作面板 tab（"打开工作面板"跳转目标） |
| P1 | 成员 chip 工作线程数 badge | `wg-core.js` | session_threads 数据可用 |
| P1 | 消息流事件分隔线 | `wg-core.js` 的 `renderEventMessage` | 无 |
| P2 | Phase 4 后端：aggregateSessionPool 返回血缘分组 | `group-chat.js` | 验证前端消费无问题后 |

后端几乎不需要新改动——Phase 1-3 已准备就绪。本次主要是前端消费层。

---

### C.9 与现有代码的对接点

| 新设计 | 对接的现有组件 | 改动类型 |
|---|---|---|
| 工作面板 tab | `featurePanels` 注册表（`app-ui.js`） | 新增 `threads` 条目 |
| 工作面板渲染 | 新模块 `wg-threads-panel.js` | 新文件 |
| 面板数据源 | `GET /protoclaw/gc/session_threads` | 已有，零改动 |
| Task 进度数据 | `GET /protoclaw/gc/session_tasks` | 已有，零改动 |
| 态势栏 badge | `renderAwarenessBar()` + `fetchRuntimeStatus()`（`wg-core.js`） | 小改 |
| Popover 简化 | `_renderPopoverSessionList()` -> 重写（`wg-popover.js`） | 中等改动 |
| "派发至此"操作 | `insertMentionWithSession()` + `setSessionSelection()`（`wg-core.js`） | 已有函数复用 |
| 事件分隔线 | `renderEventMessage()` 扩展（`wg-core.js`） | 小改 |

---

### C.10 UI 升级实施修订（2026-07-12）

实际数据验证后，对附录 C 的初版卡片方案作以下修订。修订目标不是增加信息量，
而是保证用户首先看到“现在需要关注什么”，需要时再进入 session 与 task 细节。

#### C.10.1 四个状态维度必须分离

- **生命周期**：`current / available / archived / missing`。描述该血缘头部是否仍可继续或只可查看记录。
- **运行态**：`running / idle / offline`。只对未归档、可运行的 session 有意义。
- **工作状态**：进行中、已完成。由 head 的运行态与 Task 完成情况投影。
- **Task 进度**：`completed / total`。它描述执行进度，不等同于 session 生命周期。

`activeHeadId` 仅表示血缘叶节点，不再被 UI 直接翻译为“活跃”。接口同时返回
`lineageHeadId`、`lifecycle`、`isCurrent`、`isArchived`、`canDispatch`。

#### C.10.2 面板改为三层信息结构

1. **态势摘要**：运行中、进行中、已完成、历史四个计数。
2. **线程摘要**：稳定线程标题、运行状态、上下文用量、Task 进度、最近更新时间和操作。
3. **按需详情**：完整 session 血缘、转换原因和 Task 列表。

默认展示“进行中”和“已完成”；已归档或缺失的线程进入折叠的历史区。
单 Agent 群聊不重复显示 Agent 分组标题，多 Agent 时才显示归属。

#### C.10.3 操作显隐规则

| 线程状态 | 可见操作 |
|---|---|
| 运行中 / 空闲 / available | 派发指令、查看会话；运行中额外显示中断 |
| Task 全完成 | 派发指令、查看会话；归入已完成区 |
| archived | 查看记录；不显示派发 |
| missing | 不显示会误导用户的操作 |

成员 Popover 只保留线程数量、状态摘要、当前头部导航和“查看全部工作线程”；
派发与中断不再混入 Popover。态势栏 badge 只统计未归档线程。

所有非历史线程都可直接展开 head session 的 Task。上下文用量复用编程小助手会话栏口径：
优先显示最后一次请求的 input tokens，占 context length 的比例，并标记自动压缩阈值。

#### C.10.4 血缘投影规则修订

工作线程必须从 `sessionLineage` 构图，session pool 和 session index 只负责补标题、
运行与可用性元数据。归档后的后续 session 即使不在扁平会话池，也不能从血缘中消失。

同一源节点存在多个后续节点时，按每个叶节点投影一条工作线程，共享历史前缀。
这条规则同时覆盖显式 branch 和“从历史节点再次 trim”产生的结构性分叉。

#### C.10.5 消息流事件必须指明对象

生命周期分隔线使用完整事件载荷，不再只显示 Agent 名：

```
编程小助手 ·「源会话标题」会话精简 4 轮，已续接到「后续会话标题」
```

分隔线可点击跳转到后续会话。纯归档事件显示具体 session 标题；Task 完成仍只更新
工作面板，避免污染消息叙事流。

---

*本文档随设计讨论持续更新。最后更新：2026-07-09*
