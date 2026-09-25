# AgentDev 框架模型热切换调研报告

> **状态**：调研完成（v2 — 下游风险全面摸排），待讨论确认  
> **日期**：2026-07-25  
> **涉及仓库**：AgentDev（框架侧）、AgentDevClaw（产品侧）  
> **结论**：本文的 setLLM 建议为调研意见，不代表当前框架 API 决策
> **路径说明**：本文记录的 checkout 配置路径为调研时快照；当前应用模型与身份配置位于 Claw 用户数据目录，见应用配置边界计划。
> **v2 变更**：新增 §4.0 引用拓扑全表、§4.2.2 ContextGuard 自动恢复机制、§4.9/4.10 子代理与 config.llm 分析、§8.0 风险优先级矩阵、§8.3 patch 链修正、§8.7/8.8 边界条件

---

## 目录

1. [问题陈述](#1-问题陈述)
2. [当前架构：模型如何绑定到运行时](#2-当前架构模型如何绑定到运行时)
3. [问题根源分析](#3-问题根源分析)
4. [下游影响面：全链路排查](#4-下游影响面全链路排查)
5. [方案设计：框架原生 setLLM](#5-方案设计框架原生-setllm)
6. [逐项改动清单](#6-逐项改动清单)
7. [运行时序图](#7-运行时序图)
8. [风险评估与边界条件](#8-风险评估与边界条件)
9. [待讨论的开放问题](#9-待讨论的开放问题)

---

## 1. 问题陈述

### 用户痛点

在 AgentDevClaw（以下简称 Claw）的编程小助手中，用户在一个会话进行到一半时想换模型，必须：

1. 打开模型配置面板
2. 修改预设绑定
3. **手动右键重启 Agent**
4. 等待进程终止 → 重新 spawn → 加载 session → 重连 ViewerWorker → 重连 MCP → 重启 IM Gateway

整个过程耗时数秒到十余秒，MCP 连接断开重连，IM 通道暂时不可用，用户体验断裂。

### 期望

在对话界面直接切换到任意已配置的模型预设，**不重启 Agent 子进程**，下一次 LLM 调用即走新模型。对话上下文、Feature 状态、MCP 连接、IM Gateway 全部保持不变。

### 调研范围

从 AgentDev 框架侧（Agent 类、ReAct 循环、LLM 接口、Overview Snapshot）到 Claw 产品侧（进程管理、IPC 通道、session 元数据同步、ContextGuard、用量上报、前端渲染），逐层排查模型信息绑定与传播链路，评估热切换的可行性与影响面。

---

## 2. 当前架构：模型如何绑定到运行时

### 2.1 LLM 对象的创建

模型在 Agent 子进程启动时被解析一次：

```
spawn run-prebuilt-agent.js (新子进程)
    ↓
resolveAgentModelLLM(agentPath, 'default')
    → 同步读取用户数据 presets.json + agent-configs/<agentId>.json
    → 调用框架的 createLLM(config) 创建 LLMClient 实例
    ↓
new AgentClass({ llm: resolved.llm })
    → BasicAgent 构造函数: this.llm = config.llm (赋值一次)
    ↓
agent.loadSession(sessionId, sessionStore)  ← 从磁盘恢复对话上下文
```

**关键代码位置**：
- Claw 侧模型解析：`server/model-preset-resolver.js` → `resolveAgentModelLLM()`
- Claw 侧 Agent 构造：`scripts/run-prebuilt-agent.js:413-426`
- 框架侧 LLM 创建：`src/llm/index.ts` → `createLLM()`
- 框架侧 Agent 赋值：`src/core/agent.ts:147` → `this.llm = config.llm`

### 2.2 LLMClient 接口定义

```typescript
// AgentDev/src/core/types.ts:384-388
export interface LLMClient {
  chat(messages: Message[], tools: Tool[], options?: LLMChatOptions): Promise<LLMResponse>;
  /** 可选：返回当前 LLM 实例使用的模型名（用于调试显示） */
  readonly modelName?: string;
}
```

接口非常简洁——只有 `chat()` 方法和可选的 `modelName` 属性。三种实现：`AnthropicLLM`、`OpenAILLM`、`OpenAIResponsesLLM`，每种在构造时固化 `apiKey`、`baseUrl`、`model` 等参数。

### 2.3 LLM 在 Agent 内部的传播路径

```
AgentBase.constructor(config)
    this.llm = config.llm                    ← 第①层：Agent 属性
        ↓
ensureExecutorsInitialized()  (延迟初始化，只执行一次)
    this.reactRunner = new ReActLoopRunner({
        llm: this.llm,                       ← 第②层：值快照到 plain object
        tools: this.tools,
        ...
    })
        ↓
ReActLoopRunner.run()
    this.agent.llm.chat(messages, tools)     ← 第③层：实际调用点
```

**第②层是关键卡点**：`ensureExecutorsInitialized()` 有守卫 `if (this.toolExecutor && this.reactRunner) return;`，不会重新执行。即使修改 `this.llm`，已创建的 `reactRunner.agent.llm` 指向的还是旧对象引用。

不过，由于 `reactRunner.agent` 是一个 plain object，它的 `llm` 属性存储的是**对象引用**。如果我们在修改 `this.llm` 的同时，也修改 `this.reactRunner.agent.llm`（或让 ReActLoopRunner 通过闭包/getter 访问最新的 `this.llm`），就能打通这条路径。

### 2.4 模型信息在系统中的 7 个独立持有者

> **注**：本表为快速概览。完整的引用拓扑（含每个引用的可变性分析与热切换后行为）见 [§4.0](#40-引用拓扑llm-引用在系统中的完整传播图)。

| # | 持有者 | 位置 | 保存的信息 | 当前是否可变 | 拓扑编号 |
|---|--------|------|-----------|-------------|---------|
| 1 | `AgentBase.llm` | 框架 `agent.ts:86` | LLMClient 实例（含 modelName） | 无 setter，protected 属性 | L1 |
| 2 | `ReActLoopRunner.agent.llm` | 框架 `react-loop.ts:37` | LLMClient 引用快照 | 不可变（构造时固化） | L3 |
| 3 | `resolved` / `resolvedUsageModel` | Claw `run-prebuilt-agent.js:413-414` | modelName, contextLength, compressRatio, provider 等 | `const`/`let`，启动后不变 | M1/M2 |
| 4 | `ContextGuard.thresholdTokens` | Claw `context-guard/index.ts:38` | 压缩阈值 token 数 | `private readonly`，无 setter | M3 |
| 5 | Session Index 元数据 | Claw session index.json | modelName, contextLength, compressRatio | 由 `session_meta_sync` 更新，但数据源是 #3 | M4 |
| 6 | `overview.modelName` | 框架 `agent.ts:1689` | 当前模型名（实时） | 读 `this.llm.modelName`，如果 llm 变了会跟随 | L4 |
| 7 | System Prompt 文本 | Context 消息中的 system message | `SYSTEM_CURRENT_MODEL` 占位符已解析为文本 | 不可变（已 baked） | — |

---

## 3. 问题根源分析

### 3.1 为什么现在必须重启进程

根本原因是**模型信息在多个位置被冻结为启动时常量**，没有运行时更新的通道：

1. **LLM 对象不可替换**：Agent 构造后 `this.llm` 就固定了，ReActLoopRunner 拿到的是同一引用的快照
2. **模型元数据不可变**：`resolved` 是 `const`，ContextGuard 的 `thresholdTokens` 是 `readonly`
3. **没有 IPC 通道传递模型变更**：现有 IPC 只处理 IM carrier mount/unmount 和 todo-control，没有 model-swap
4. **前端切换按钮名不副实**：`phToggleModelSlot` 只写配置文件，不通知运行时

### 3.2 当前重启的代价

每次 `restart_agent`（`agent-lifecycle.js:324`）执行：

```
stopManagedAgent → kill 子进程
    ↓ 进程内所有状态丢失：
    - Agent 实例（内存中的 Context、Feature 状态、Checkpoints）
    - MCP server 连接（需要重新启动 MCP 进程）
    - IM Gateway 连接（QQ/微信 WebSocket 断开重连）
    - CallArbiter 队列
    ↓
startManagedAgent → spawn 新子进程
    ↓ 新进程初始化：
    - import agent.js → new AgentClass() → createLLM()
    - agent.withViewer() → 连接 ViewerWorker
    - agent.loadSession() → 从磁盘恢复 Context（消息历史无损）
    - MCP Feature onInitiate → 重新启动 MCP 进程
    - IM Gateway 启动 → 重新连接
    - CallArbiter 初始化
    ↓
READY
```

整个过程涉及进程创建、模块加载、网络连接重建。在 MCP server 较多的场景下，重启后 MCP 初始化可能需要数秒。

### 3.3 对话上下文是否"无损"

**是的**。Session 快照（`AgentSessionSnapshot`）包含：

- `context`：完整的消息列表（system + user + assistant + tool calls）
- `featureStates`：各 Feature 的可序列化状态
- `usageStats`：用量统计
- `rollbackHistory`：回滚检查点
- `namedCheckpoints`：命名检查点

LLM 对象本身**不序列化**——它不属于快照。因此重启后恢复的对话内容是完全无损的，只是 LLM 的指向变了。

但热切换的优势在于：**连从磁盘恢复都不需要**——内存中的 Context 和 Feature 状态原封不动，只是 LLM 对象的指向变了。

---

## 4. 下游影响面：全链路排查

### 4.0 引用拓扑：LLM 引用在系统中的完整传播图

在分析各下游系统之前，先建立完整的引用拓扑。以下穷举了代码库中所有持有 LLM 引用或模型元数据的位置，并标注其可变性。

#### 4.0.1 框架侧 LLM 对象引用（`AgentDev/src/`）

| # | 持有者 | 代码位置 | 引用方式 | 热切换后是否自动跟随 |
|---|--------|---------|---------|-------------------|
| L1 | `AgentBase.llm` | `agent.ts:86,147` | `protected llm = config.llm` | **是**（`setLLM()` 直接赋值） |
| L2 | `AgentBase.config.llm` | `agent.ts:90,146` | `this.config = config`（构造时传入） | **否**（config 对象的 llm 属性仍是旧引用） |
| L3 | `ReActLoopRunner.agent.llm` | `agent.ts:1458` → `react-loop.ts:37` | plain object 属性，值快照 | **否**（关键卡点，详见 §4.1） |
| L4 | `buildOverviewSnapshot()` | `agent.ts:1689` | 每次调用时读 `this.llm.modelName` | **是**（实时读取） |
| L5 | `createAgentByType()` 工厂闭包 | `agent.ts:974,981` | 箭头函数捕获 `this`，调用时读 `this.llm` | **是**（延迟求值） |
| L6 | `BasicAgent` 子代理工厂闭包 | `BasicAgent.ts:180-181` | 同上 | **是** |
| L7 | `ExplorerAgent` 子代理工厂闭包 | `ExplorerAgent.ts:134-135` | 同上 | **是** |

**关键结论**：L3 是唯一不会自动跟随的位置。L2 虽然不跟随，但仅在 `FeatureInitContext` 中暴露，而 `onInitiate` 只在首次 `onCall` 执行一次，热切换发生在运行时，不会再读 L2。

#### 4.0.2 Claw 侧模型元数据持有者（`AgentDevClaw/`）

| # | 持有者 | 代码位置 | 数据内容 | 可变性 |
|---|--------|---------|---------|--------|
| M1 | `resolved`（`main()` 内 const） | `run-prebuilt-agent.js:413` | modelName, contextLength, compressRatio, provider, llm 等 | **const，不可变** |
| M2 | `resolvedUsageModel`（模块级 let） | `run-prebuilt-agent.js:41` | 同 M1 的子集 | **let，可从 IPC handler 更新** |
| M3 | `ContextGuardFeature.thresholdTokens` | `context-guard/index.ts:38` | 压缩阈值 token 数 | **private readonly，不可变** |
| M4 | Session Index 元数据 | 服务端 `session_meta_sync` 写入 | modelName, contextLength, compressRatio | 由 `callFinished` 事件驱动更新，数据源是 M1/M2 |
| M5 | 前端 `_modelInfoCache` | `session-ui.js:85` | contextLength, compressRatio | 持久化缓存，由 session 数据覆写 |

#### 4.0.3 LLM 对象的 monkey-patch 状态

| # | patch 位置 | 代码位置 | patch 内容 | 热切换后状态 |
|---|-----------|---------|-----------|-------------|
| P1 | `llm.chat` | `context-guard/index.ts:127-134` | 包装为 `guardedChat`，拦截 response.usage | 旧 LLM 保留 patch（无害），新 LLM 未 patch（**需修复**） |
| P2 | `llm.__clawContextGuardInstalled` | `context-guard/index.ts:134` | 布尔标记，防止重复 patch | 新 LLM 上无此标记 |

---

### 4.1 ReAct 循环中的 LLM 调用（引用拓扑 L3）—— 关键卡点

**问题本质**：

`ensureExecutorsInitialized()`（`agent.ts:1432`）有守卫 `if (this.toolExecutor && this.reactRunner) return;`，只在首次 `onCall` 时执行一次。其中创建 ReActLoopRunner 时传入了一个 plain object：

```typescript
// agent.ts:1456-1458
this.reactRunner = new ReActLoopRunner(
    {
        llm: this.llm,    // ← 此处创建了一个新对象，llm 属性存储的是当前 this.llm 的值
        tools: this.tools,
        // ...
    },
    ...
);
```

JavaScript 中 `{ llm: this.llm }` 创建的是一个新对象，其 `llm` 属性持有赋值时刻 `this.llm` 指向的对象引用。之后即使 `this.llm` 被重新赋值指向新对象，plain object 的 `.llm` 属性仍然指向旧对象。

ReActLoopRunner 实际调用点（`react-loop.ts:134`）：

```typescript
response = await this.agent.llm.chat(...)  // ← this.agent 是那个 plain object
```

**热切换影响**：如果 `setLLM()` 只更新 `this.llm`（L1），而不更新 plain object 的 `llm` 属性（L3），ReAct 循环会继续调用旧 LLM。热切换完全失效。

**修复方案**：见 [§5.2](#52-reactlooprunner-改造)。

**风险**：这是整个热切换方案的**前置阻断点**。如果不解决 L3，其他所有下游修复都没有意义——因为 LLM 调用根本没走新模型。

---

### 4.2 ContextGuard：阈值 + chat patch（引用拓扑 M3, P1/P2）

ContextGuard 有两个独立的受影响面，需要分开分析。

#### 4.2.1 thresholdTokens 不可变（M3）

**当前代码**（`context-guard/index.ts:38,53-67`）：

```typescript
private readonly thresholdTokens: number | null;  // ← readonly

constructor(config: ContextGuardConfig = {}) {
    // ... 从 contextLength × compressRatio 计算 ...
    this.thresholdTokens = Math.floor(contextLength * Math.min(100, compressRatio) / 100);
}
```

**热切换风险**：从 200K context 切到 8K context，阈值仍为 `160000`（200000 × 80%），guard 不会在正确时机触发压缩，可能导致上下文溢出。

**修复**：去掉 `readonly`，增加 `updateThreshold(contextLength, compressRatio)` 方法。

**注意 `restoreState()` 的行为**（`context-guard/index.ts:108-118`）：rollback 恢复 Feature 状态时，`thresholdTokens` 使用 `this.thresholdTokens`（即当前实例值），不从快照中恢复。这意味着如果先 `updateThreshold()` 再发生 rollback，阈值不会被回退——这是正确行为，因为阈值取决于当前模型而非历史状态。

#### 4.2.2 chat patch 的自动恢复机制（P1/P2）—— 原报告遗漏的关键发现

**原报告的分析**（§4.4, §8.3）：热切换后新 LLM 的 `chat` 未被 patch，guard 失效，需要通过 `onLLMSwap` 钩子手动重新 patch。

**实际代码行为**：

ContextGuard 的 patch 逻辑挂载在 `@CallStart` 生命周期钩子上（`context-guard/index.ts:120-138`）：

```typescript
@CallStart
async installUsageGuard(ctx: any): Promise<void> {
    const agent = ctx?.agent;           // ← agent.ts:348 传入的是 this（真实 Agent 实例）
    const llm = agent.llm as any;       // ← 读 agent.llm（L1），是 setLLM() 更新后的新 LLM
    if (!llm || typeof llm.chat !== 'function' || llm.__clawContextGuardInstalled) return;
    // ... patch llm.chat ...
    llm.__clawContextGuardInstalled = true;
}
```

**关键时序**（`agent.ts:307-383`）：

```
onCall(input)
  ↓
line 348: @CallStart 钩子执行 → installUsageGuard(ctx)
    ctx.agent = this（真实 Agent 实例）
    agent.llm = 新 LLM（setLLM 已更新）
    新 LLM.__clawContextGuardInstalled === undefined → 执行 patch ✓
  ↓
line 380: ensureExecutorsInitialized() → 已初始化，return
  ↓
line 383: reactRunner.run() → this.agent.llm.chat()
    如果 L3 已修复 → 用新 LLM（已 patch）✓
    如果 L3 未修复 → 用旧 LLM（patch 浪费）✗
```

**结论**：

- **如果 §4.1（L3 修复）已完成**：ContextGuard 的 chat patch 会在下一次 `@CallStart` **自动恢复**，不需要 `onLLMSwap` 钩子。
- **`onLLMSwap` 钩子的价值**：让 patch 在 `setLLM()` 调用时立即完成，而不是等到下一次 `onCall`。对于"swap 后立即发送消息"的典型场景，两者效果相同（因为 `@CallStart` 总是在 LLM 调用之前执行）。但如果存在"swap 后不经过 `onCall` 直接调用 LLM"的路径（目前不存在），则 `onLLMSwap` 是必要的。
- **建议**：优先确保 L3 修复正确。`onLLMSwap` 钩子作为 belt-and-suspenders 保留，但不是阻断项。

---

### 4.3 Overview Snapshot 中的 modelName（引用拓扑 L4）

**当前代码**（`agent.ts:1689-1691`）：

```typescript
...(typeof (this.llm as any)?.modelName === 'string'
    ? { modelName: (this.llm as any).modelName }
    : {}),
```

`buildOverviewSnapshot()` 在 `this.llm` 更新后，自然读到新 LLM 的 `modelName`。该方法在以下时机被调用：

- `recordUsage()` — 每次 LLM 响应返回后
- `endCallUsage()` — 每次 call 结束时
- `pushOverviewSnapshot()` — 可被 `setLLM()` 主动调用

**前端消费路径**（`chat-context-bar.js:78-85`）：

```javascript
// 模型名：有 runtime 时优先从 overview 实时取，回退到 session 元数据
if (runtimeRecord && overview.modelName) {
    modelName = overview.modelName;    // ← overview 实时数据，优先级最高
}
if (!modelName && activeSession) {
    modelName = activeSession.modelName || '';  // ← session 元数据（来自 session_meta_sync）
}
```

**热切换后**：

1. `setLLM()` 调用 `pushOverviewSnapshot()` → overview 立即携带新模型名
2. 前端下一次 poll → `overview.modelName` = 新模型名 → 对话栏立即显示新名

**结论**：**完全自动修复**。前提是 `setLLM()` 内部调用了 `pushOverviewSnapshot()`。

---

### 4.4 Session 元数据同步：resolved / resolvedUsageModel（引用拓扑 M1, M2, M4）

这是 Claw 侧受影响面最大的部分。需要区分两个变量的作用域：

#### 4.4.1 `resolved`（`const`，`main()` 函数内部）

```javascript
// run-prebuilt-agent.js:413
const resolved = resolveAgentModelLLM(agentPath, 'default');
```

`resolved` 是 `main()` 内部的 `const`，通过闭包被 `callFinished` handler 捕获：

```javascript
// run-prebuilt-agent.js:634-636（callFinished handler 内）
modelName: resolved?.modelName || resolvedUsageModel?.modelName || undefined,
contextLength: resolved?.contextLength ?? undefined,
compressRatio: resolved?.compressRatio ?? undefined,
```

**问题**：`const` 不能从 IPC handler 重新赋值。IPC handler 注册在 `runtime-im-bridge.js:260`（另一个 `process.on('message')` 回调），无法访问 `main()` 内部的 `resolved`。

**修复**：将 `resolved` 从 `const` 改为可变容器。两种方式：

- 方式 A：改为 `let resolved`（最小改动，但需要将 IPC handler 注册移到 `main()` 内部或通过闭包暴露）
- 方式 B：使用模块级可变容器对象 `const modelState = { resolved: null }`（IPC handler 可直接访问）

推荐方式 B，因为 IPC handler 在 `runtime-im-bridge.js` 中，无法直接访问 `main()` 局部变量。

#### 4.4.2 `resolvedUsageModel`（`let`，模块级）

```javascript
// run-prebuilt-agent.js:41
let resolvedUsageModel = null;
```

模块级 `let`，可从任何地方更新。被 `callFinished` handler 中的用量上报消费：

```javascript
// run-prebuilt-agent.js:606
model: buildModelUsageMeta(resolvedUsageModel, IS_EXPLORATION ? 'exploration' : 'default'),
```

`buildModelUsageMeta`（`usage-report.js:1-11`）从中提取 `modelName`、`provider`、`protocol`、`presetName`、`baseUrl` 等。

**修复**：IPC handler 中直接 `resolvedUsageModel = newResolved`。

#### 4.4.3 session_meta_sync 的延迟窗口

`callFinished` 事件在 onCall 完成后才触发。swap 成功后到第一次 `callFinished` 之间，session index 中的 modelName/contextLength/compressRatio 仍是旧值。

这意味着：
- 会话列表中该 session 的模型名显示短暂错误
- token 进度条的 contextLength 短暂错误

**缓解**：swap 成功后，IPC handler 中立即做一次 `session_meta_sync`（不等 `callFinished`），主动推送新模型元数据。

---

### 4.5 用量上报（引用拓扑 M2）

**当前代码**（`run-prebuilt-agent.js:596-612`）：

```javascript
const usageResult = await reportUsageEvent(SERVER_ORIGIN, {
    // ...
    model: buildModelUsageMeta(resolvedUsageModel, ...),  // ← 从 resolvedUsageModel 提取
    usage: callSummary.totalUsage,
});
```

**热切换后**：不更新 `resolvedUsageModel`，新模型产生的用量会被归到旧模型名下。用量历史面板（`usage-info-overlay.js:289,320,621`）会显示错误的模型名。

**修复**：同 §4.4.2，IPC handler 中更新 `resolvedUsageModel`。

---

### 4.6 System Prompt 中的 SYSTEM_CURRENT_MODEL

**解析时机**（`agent.ts:329-335`）：

```typescript
// 仅在首次 onCall、context 为空时执行
if (this.templateResolver && context.getAll().length === 0) {
    const systemMsg = await this.templateResolver.resolve();
    if (systemMsg) {
        context.addSystemMessage(systemMsg, this._callIndex);
    }
}
```

`TemplateResolver.resolve()`（`template-resolver.ts:62-92`）读取 `this.systemContext.SYSTEM_CURRENT_MODEL`，通过 `PlaceholderResolver` 替换占位符，生成最终的 system prompt 文本。该文本被写入 Context 的第一条 system message 后不再改变。

**热切换后**：

1. **SystemContext 对象本身可更新**：`BasicAgent._systemContext.SYSTEM_CURRENT_MODEL = newName` 可以修改属性值。Claw 在启动时已做此操作（`run-prebuilt-agent.js:434`）。
2. **但已写入 Context 的 system message 文本不会变**：`TemplateResolver.resolve()` 不会被再次调用（`context.getAll().length === 0` 守卫不满足）。

**影响**：纯 cosmetic。system prompt 中"你当前使用的模型是 xxx"文字不会变，但不影响模型实际推理能力。

**结论**：可接受不处理。`setLLM()` 中更新 SystemContext 属性即可（为将来可能的模板重解析做准备）。

---

### 4.7 前端 Token 进度条（引用拓扑 M4, M5）

**前端读取链**（`session-ui.js:92-127`）：

```
contextLength 优先级链：
  1. session.contextLength       ← 来自 session_meta_sync（M4）
  2. agent.workspace_sessions.contextLength  ← 来自 session index 聚合
  3. _modelInfoCache[key]        ← 持久化缓存（M5），被 1/2 覆写
  4. 200000                      ← 硬编码默认值
```

**热切换后**：

- 如果 §4.4 已修复（IPC handler 更新 resolved），下一次 `callFinished` 上报会携带新的 contextLength/compressRatio → session 数据更新 → `_modelInfoCache` 被覆写 → 前端进度条正确。
- 如果还做了 §4.4.3 的即时 `session_meta_sync`，延迟窗口几乎消除。
- `_modelInfoCache` 的 fallback 行为不会造成问题：它只在 session 数据缺失 contextLength 时才使用缓存值，一旦 session 数据有了新值，缓存会被覆写。

**结论**：在 §4.4 修复后自动恢复。延迟窗口内的数值不一致可接受。

---

### 4.8 前端模型切换按钮（phToggleModelSlot）

**当前代码**（`ph-project-actions.js:231-303`）：

```javascript
window.phToggleModelSlot = async () => {
    // ... swap primary/secondary in config ...
    const resp = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        body: JSON.stringify({ agentId: 'programming-helper', modelPresets: newModelPresets }),
    });
    // ... show toast "Model switched" ...
};
```

PUT 只写用户数据目录 `agent-configs/<agentId>.json` 配置文件（`model-config.js:532-560`），不通知运行时。

**热切换后需要**：PUT handler 在写盘成功后，向运行中的 agent 子进程发 IPC `swap-model` 消息。

**PUT 写盘与 resolveAgentModelLLM 读盘的一致性**：

PUT 写入用户数据目录 `agent-configs/<agentId>.json`（`model-config.js:550-556`）。
`resolveAgentModelLLM` 读取同一文件（`model-preset-resolver.js:121-127`），且用户配置优先于 metadata.json 默认值。

因此 IPC handler 中重新调用 `resolveAgentModelLLM(agentPath, 'default')` 会读到 PUT 写入的新配置，保证一致性。

**更好的设计**：用户应能在对话界面直接选择任意预设（而不仅仅是 primary/secondary 两个槽位切换），选择后立即触发热切换。

---

### 4.9 子代理工厂闭包（引用拓扑 L5, L6, L7）—— 自动安全

`BasicAgent` 构造函数注册的子代理工厂（`BasicAgent.ts:180-181`）：

```typescript
this.registerAgentType('BasicAgent', () => new BasicAgent({ llm: this.llm }));
this.registerAgentType('ExplorerAgent', () => import('./ExplorerAgent.js').then(m => new m.ExplorerAgent({ llm: this.llm })));
```

这些是箭头函数，捕获了 `this`（Agent 实例）。当工厂被调用时（`createAgentByType`），`this.llm` 在调用时刻求值，读到的是 `setLLM()` 更新后的新 LLM。

`AgentBase.createAgentByType()` 中的 fallback 工厂（`agent.ts:974,981`）同理。

**结论**：**完全自动安全**。热切换后新创建的子代理自动使用新 LLM。已存在的子代理实例有自己的 `llm` 副本，但子代理是短生命周期的（spawn → execute → destroy），不需要热切换。

---

### 4.10 config.llm 引用（引用拓扑 L2）—— 无影响

`AgentBase.config`（`agent.ts:90`）保存了构造时传入的完整 `AgentConfig` 对象。`config.llm` 仍指向旧 LLM。

**暴露路径**：`FeatureInitContext.config`（`feature.ts:33`）包含 `AgentConfig`。如果某个 Feature 的 `onInitiate()` 读取 `ctx.config.llm`，会得到旧 LLM。

**实际影响**：无。`onInitiate()` 只在首次 `onCall` 时执行一次（`agent.ts:319-338`），热切换发生在运行时，不会再触发 `onInitiate()`。且经全量搜索（`AgentDev/src/features/` + `AgentDevClaw/local-features/`），没有任何 Feature 从 `ctx.config` 读取 `.llm`。

**结论**：**无需处理**。

---

## 5. 方案设计：框架原生 setLLM

### 5.1 设计理念

**不使用 wrapper / proxy 模式**，而是将模型替换作为 Agent 的**一等公民能力**：

- Agent 暴露 `setLLM(llm: LLMClient)` 公开方法
- 框架内部保证所有持有 LLM 引用的位置同步更新
- 提供 `onLLMSwap` 生命周期钩子，让 Feature 感知模型变更
- Claw 侧通过 IPC 触发，不需要重启进程

### 5.2 ReActLoopRunner 改造

**当前问题**：ReActLoopRunner 的构造函数接收一个 plain object，其中 `llm` 是值快照。

**改造方案**：让 ReActLoopRunner 通过 getter 访问 LLM，而非直接持有引用。

方案 A（推荐，改动最小）：ReActLoopRunner 的 `agent` 参数直接传入 Agent 实例引用

```typescript
// 改造前 (react-loop.ts:36-52)
constructor(
    private agent: {
        llm: any;
        tools: ToolRegistry;
        // ...
    },
    ...
)

// 改造后
constructor(
    private agent: AgentBase,  // 直接引用 Agent 实例
    ...
)
```

由于 `this.agent` 是对 Agent 实例的引用，`this.agent.llm` 会实时读取 Agent 上的最新值。`setLLM()` 只需要更新 `Agent.llm`，ReActLoopRunner 自动跟随。

**注意**：这需要 ReActLoopRunner 能访问 Agent 实例的 `llm` 属性。当前 `llm` 是 `protected`，在编译后的 JS 中不受限制。或者改为 `public readonly` + 内部通过方法修改。

方案 B（更保守）：保持 plain object，但在 `setLLM()` 中同时更新 `reactRunner.agent.llm`

```typescript
// agent.ts
setLLM(llm: LLMClient): void {
    this.llm = llm;
    if (this.reactRunner) {
        (this.reactRunner as any).agent.llm = llm;
    }
}
```

方案 B 更保守但侵入 ReActLoopRunner 内部结构。**推荐方案 A**，因为它消除了引用不同步的可能性。

### 5.3 Agent.setLLM() 方法设计

```typescript
// AgentDev/src/core/agent.ts

/** 可替换的模型元数据（与 LLM 实例解耦） */
interface LLMMeta {
    modelName?: string;
    contextLength?: number | null;
    compressRatio?: number;
}

class AgentBase {
    // 将 llm 从 protected 改为可更新的
    protected llm: AgentConfig['llm'];
    
    // 新增：模型元数据（可热更新）
    protected _llmMeta: LLMMeta = {};
    
    // 新增：LLM 变更回调列表
    private _llmSwapCallbacks: Array<(newLLM: LLMClient, oldLLM: LLMClient) => void> = [];

    /**
     * 热替换 LLM 实例
     * 
     * - 更新内部 LLM 引用（Agent.llm + ReActLoopRunner 内部引用）
     * - 更新模型元数据
     * - 触发 onLLMSwap 钩子，通知所有注册的 Feature
     * - 推送 Overview Snapshot（使前端立即看到新模型名）
     * 
     * @param llm 新的 LLM 实例
     * @param meta 可选：模型元数据（contextLength、compressRatio 等）
     * 
     * @throws 如果当前有正在运行的 onCall（调用方应确保在 call 间隙执行）
     */
    setLLM(llm: LLMClient, meta?: LLMMeta): void {
        if (this.isRunning()) {
            throw new Error('Cannot swap LLM while onCall is running');
        }
        
        const oldLLM = this.llm;
        this.llm = llm;
        
        if (meta) {
            this._llmMeta = { ...meta };
        }
        
        // 更新 SystemContext 中的模型名
        if (meta?.modelName) {
            const ctx = this.getSystemContext?.();
            if (ctx) {
                ctx.SYSTEM_CURRENT_MODEL = meta.modelName;
            }
        }
        
        // 通知 ReActLoopRunner（方案 B 时需要，方案 A 时不需要）
        // if (this.reactRunner) { (this.reactRunner as any).agent.llm = llm; }
        
        // 触发 Feature 的 onLLMSwap 回调
        for (const callback of this._llmSwapCallbacks) {
            try {
                callback(llm, oldLLM);
            } catch (error) {
                this.logger.warn('onLLMSwap callback error', { error });
            }
        }
        
        // 推送新 Overview Snapshot
        this.pushOverviewSnapshot();
        
        this.logger.info('LLM swapped', {
            newModel: (llm as any)?.modelName,
            oldModel: (oldLLM as any)?.modelName,
        });
    }

    /**
     * 注册 LLM 变更回调
     * Feature 在 onInitiate 中调用此方法，在 setLLM 时收到通知
     */
    onLLMSwap(callback: (newLLM: LLMClient, oldLLM: LLMClient) => void): void {
        this._llmSwapCallbacks.push(callback);
    }

    /**
     * 获取当前模型元数据
     */
    getLLMMeta(): LLMMeta {
        return { ...this._llmMeta };
    }
}
```

### 5.4 ContextGuard 改造

利用 `onLLMSwap` 钩子，ContextGuard 可以自动响应模型变更：

```typescript
// context-guard/src/index.ts

export class ContextGuardFeature implements AgentFeature {
    // thresholdTokens 改为可变
    private thresholdTokens: number | null;
    
    async onInitiate(ctx: FeatureInitContext): Promise<void> {
        this.logger = ctx.logger;
        // ...existing code...
        
        // 注册 LLM 变更回调
        const agent = (ctx as any).agent;
        if (agent && typeof agent.onLLMSwap === 'function') {
            agent.onLLMSwap((newLLM) => {
                this.handleLLMSwap(newLLM);
            });
        }
    }
    
    /**
     * 更新压缩阈值
     */
    updateThreshold(contextLength: number | null, compressRatio: number | null): void {
        const cl = Number(contextLength);
        const cr = Number(compressRatio ?? 80);
        this.thresholdTokens = Number.isFinite(cl) && cl > 0
            && Number.isFinite(cr) && cr > 0
            ? Math.floor(cl * Math.min(100, cr) / 100)
            : null;
        this.state.thresholdTokens = this.thresholdTokens;
        this.logger?.info('Context guard threshold updated', { thresholdTokens: this.thresholdTokens });
    }
    
    /**
     * LLM 变更时重新 patch 新 LLM 的 chat 方法
     */
    private handleLLMSwap(newLLM: any): void {
        // 清除旧 LLM 的 guard 标记（旧 LLM 不再使用，无需清理）
        // 对新 LLM 重新安装 guard
        const agent = this.callArbiter; // or get from somewhere
        this.installUsageGuardOnLLM(newLLM);
    }
    
    private installUsageGuardOnLLM(llm: any): void {
        if (!llm || typeof llm.chat !== 'function' || llm.__clawContextGuardInstalled) return;
        
        const originalChat = llm.chat.bind(llm);
        const feature = this;
        llm.chat = async function guardedChat(...args: any[]) {
            const response = await originalChat(...args);
            feature.observeUsage(response?.usage);
            return response;
        };
        llm.__clawContextGuardInstalled = true;
    }
}
```

**注意**：`onInitiate` 的 `FeatureInitContext` 中目前没有 `agent` 引用。需要扩展 `FeatureInitContext` 增加对 agent 的访问，或者通过其他方式注册回调。

另一种更干净的方式：在 Agent 的 `setLLM()` 内部遍历所有 Feature，调用 Feature 可选的 `onLLMSwap()` 方法（类似现有的 `onDestroy` 模式）。

### 5.5 Feature 接口扩展

```typescript
// AgentDev/src/core/feature.ts

export interface AgentFeature {
    // ...existing members...
    
    /**
     * LLM 变更时调用（可选）
     * Feature 可在此重新绑定对 LLM 的引用、更新阈值等
     */
    onLLMSwap?(newLLM: LLMClient, oldLLM: LLMClient): void;
}
```

在 `Agent.setLLM()` 中：

```typescript
// 通知所有 Feature
for (const feature of this.features.values()) {
    if (typeof feature.onLLMSwap === 'function') {
        try {
            feature.onLLMSwap(llm, oldLLM);
        } catch (error) {
            this.logger.warn(`Feature ${feature.name} onLLMSwap error`, { error });
        }
    }
}
```

### 5.6 Claw 侧 IPC + 路由

#### IPC handler（run-prebuilt-agent.js）

```javascript
// 新增可变状态容器
let currentModel = resolved;       // 替代 const resolved
resolvedUsageModel = resolved || null;

process.on('message', async (msg) => {
    if (msg.type === 'swap-model') {
        // 1. 检查是否在运行中
        if (agent?.isRunning?.()) {
            console.warn('[ProtoClaw Runtime] Cannot swap model while onCall is running');
            return;
        }
        
        // 2. 重新解析模型预设
        const newResolved = resolveAgentModelLLM(agentPath, 'default');
        if (!newResolved?.llm) {
            console.error('[ProtoClaw Runtime] Failed to resolve new model preset');
            return;
        }
        
        // 3. 调用框架的热替换 API
        agent.setLLM(newResolved.llm, {
            modelName: newResolved.modelName,
            contextLength: newResolved.contextLength,
            compressRatio: newResolved.compressRatio,
        });
        
        // 4. 更新 Claw 侧的模型元数据持有者
        currentModel = newResolved;
        resolvedUsageModel = newResolved;
        
        // 5. 更新 ContextGuard 阈值（如果 setLLM 内部没有通过 Feature 钩子处理）
        const contextGuard = agent.features?.get?.('context-guard');
        if (contextGuard && typeof contextGuard.updateThreshold === 'function') {
            contextGuard.updateThreshold(newResolved.contextLength, newResolved.compressRatio);
        }
        
        // 6. 更新 SystemContext
        try {
            const ctx = agent.getSystemContext?.();
            if (ctx) ctx.SYSTEM_CURRENT_MODEL = newResolved.modelName;
        } catch {}
        
        console.log(`[ProtoClaw Runtime] Model swapped to ${newResolved.modelName}`);
    }
});
```

#### 服务端路由（model-config.js 或 agent-lifecycle.js）

在 `PUT /protoclaw/agent_model_presets` 成功写盘后，向运行中的 agent 子进程发送 IPC：

```javascript
app.put('/protoclaw/agent_model_presets', express.json(), async (req, res, next) => {
    // ...existing write logic...
    
    // 写盘成功后，通知运行中的 runtime 热切换
    const { agentId, modelPresets } = req.body;
    // 查找该 agent 的运行中 runtime，发送 swap-model IPC
    // 注意：一个 agentId 可能有多个 sessionId（多 session 模式），
    //       需要向所有活跃 runtime 发送
    // sendIPCtoSession 是定向到特定 sessionId 的，
    //       可能需要遍历所有活跃 session
    
    res.json({ ok: true, agentId, modelPresets });
});
```

**注意**：当前的 `sendIPCtoSession(targetAgentId, targetSessionId, message)` 是定向到特定 session 的。模型切换应该影响该 agent 的**所有活跃 session runtime**。需要增加一个 `sendIPCToAllSessions(agentId, message)` 辅助函数，或在外部遍历调用。

---

## 6. 逐项改动清单

### 框架侧（AgentDev）

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/core/agent.ts` | 新增 `setLLM(llm, meta?)` 方法 | 核心 API，替换 LLM + 更新元数据 + 触发钩子 + 推送 overview |
| `src/core/agent.ts` | 新增 `onLLMSwap(callback)` 注册方法 | 供 Feature 和外部消费者注册回调 |
| `src/core/agent.ts` | 新增 `_llmMeta` 属性 + `getLLMMeta()` | 与 LLM 实例解耦的模型元数据 |
| `src/core/agent.ts` | `llm` 属性从 `protected` 改为可内部更新 | 或者保持 protected，通过方法修改 |
| `src/core/agent.ts` | `setLLM()` 中遍历 Feature 调用 `feature.onLLMSwap?.()` | 类似 onDestroy 模式 |
| `src/core/feature.ts` | `AgentFeature` 接口增加可选 `onLLMSwap?` 方法 | Feature 声明式响应 LLM 变更 |
| `src/core/types.ts` | 新增 `LLMMeta` 接口 | modelName, contextLength, compressRatio |
| `src/core/agent/react-loop.ts` | 方案 A：构造函数改为接收 Agent 实例引用；方案 B：不改（在 setLLM 中手动更新引用） | 消除引用不同步风险 |
| `src/index.ts` | 导出 `LLMMeta` 类型 | 消费方使用 |

### 产品侧（AgentDevClaw）

| 文件 | 改动 | 说明 |
|------|------|------|
| `scripts/run-prebuilt-agent.js` | `resolved` 改为 `let`（或用可变容器） | 允许运行时更新 |
| `scripts/run-prebuilt-agent.js` | 新增 `swap-model` IPC handler | 接收模型切换指令，调用 `agent.setLLM()` |
| `scripts/run-prebuilt-agent.js` | IPC handler 中更新 `currentModel` / `resolvedUsageModel` | 确保 session_meta_sync 和 usage 上报使用新值 |
| `local-features/context-guard/src/index.ts` | `thresholdTokens` 改为可变 | 去掉 readonly |
| `local-features/context-guard/src/index.ts` | 新增 `updateThreshold(contextLength, compressRatio)` 方法 | 运行时更新压缩阈值 |
| `local-features/context-guard/src/index.ts` | 实现 `onLLMSwap()` 或在 IPC handler 中手动调用 `updateThreshold()` | 响应模型变更 |
| `server/routes/model-config.js` | `PUT /protoclaw/agent_model_presets` 后发 IPC 到运行中 runtime | 触发热切换 |
| `server/shared/ipc.js` 或 agent-lifecycle | 增加 `sendIPCToAllSessions(agentId, message)` | 模型切换影响所有活跃 session |
| `public/src/modules/ph-project-actions.js` | `phToggleModelSlot` 在 PUT 成功后等待 IPC 确认 | 确保前端 toast 反映真实状态 |
| 前端（新增） | 对话界面增加任意预设选择入口 | 用户不仅限于 primary/secondary 切换 |

---

## 7. 运行时序图

### 热切换成功时序

```
用户                前端                 Claw Server          Agent 子进程          框架 Agent
 |                   |                      |                     |                    |
 |--选择新模型------->|                      |                     |                    |
 |                   |---PUT agent_model--->|                     |                    |
 |                   |    _presets          |                     |                    |
 |                   |                      |--写配置文件          |                    |
 |                   |                      |---IPC swap-model--->|                    |
 |                   |                      |                     |                    |
 |                   |                      |             resolveAgentModelLLM()        |
 |                   |                      |             (重新读 config/presets.json)  |
 |                   |                      |                     |                    |
 |                   |                      |                     |---agent.setLLM()-->|
 |                   |                      |                     |                    |
 |                   |                      |                     |              this.llm = newLLM
 |                   |                      |                     |              trigger Feature.onLLMSwap()
 |                   |                      |                     |              ContextGuard.updateThreshold()
 |                   |                      |                     |              pushOverviewSnapshot()
 |                   |                      |                     |<---------OK-------|
 |                   |<---200 OK------------|                     |                    |
 |                   |    (toast: 已切换)   |                     |                    |
 |                   |                      |                     |                    |
 |--发送消息-------->|                      |                     |                    |
 |                   |--POST input-------->|                     |                    |
 |                   |                      |---IPC input-------->|                    |
 |                   |                      |                     |---onCall()------->|
 |                   |                      |                     |                    |
 |                   |                      |                     |    新LLM.chat()  ← 新模型
 |                   |                      |                     |    recordUsage() → overview.modelName = 新值
 |                   |                      |                     |    callFinished   |
 |                   |                      |                     |    session_meta_sync (携带新 modelName)
 |                   |                      |                     |                    |
 |                   |<--poll overview------|<---GET overview-----|<-------------------|
 |                   |    modelName=新值    |                     |    overview推送    |
 |                   |                      |                     |                    |
 |                   |  对话栏显示新模型名   |                     |                    |
 |  <---界面更新-----|                      |                     |                    |
```

### 热切换被拒绝时序（正在运行 onCall）

```
用户           前端            Claw Server       Agent 子进程
 |              |                 |                  |
 |--选模型----->|---PUT---------->|                  |
 |              |                 |--IPC swap-model->|
 |              |                 |                  |--agent.isRunning() == true
 |              |                 |                  |--log: "Cannot swap, onCall running"
 |              |                 |                  |--(静默忽略 or 返回错误)
 |              |                 |<----(无操作)-----|
 |              |<---200 OK-------|                  |
 |              |                 |                  |
 |              |  toast: "已切换  |                  |
 |              |  (待下次生效)"   |                  |
 |              |                 |                  |
 |              |    下一次 onCall 完成后，          |
 |              |    session_meta_sync 会上报旧模型   |
 |              |    (因为 swap 没执行成功)           |
```

**改进建议**：IPC handler 应返回成功/失败状态，前端据此显示不同的 toast 文案。或者改为"排队"模式——swap 请求暂存，在当前 onCall 完成后自动执行。

---

## 8. 风险评估与边界条件

### 8.0 风险优先级矩阵

| 优先级 | 风险项 | 引用拓扑 | 影响 | 不修复的后果 |
|--------|--------|---------|------|-------------|
| **P0 阻断** | ReActLoopRunner plain object `llm` 引用过期 | L3 | LLM 调用不走新模型 | 热切换完全失效 |
| **P1 严重** | `resolved` const 不可变，session_meta_sync 上报旧值 | M1 | 会话列表模型名错误 | 非活跃会话显示错误模型 |
| **P1 严重** | `resolvedUsageModel` 未更新，用量归到旧模型 | M2 | 用量历史错误 | 成本统计偏差 |
| **P1 严重** | ContextGuard `thresholdTokens` readonly | M3 | 压缩阈值不随模型变化 | 小 context 模型可能溢出 |
| **P2 中等** | ContextGuard chat patch 未恢复 | P1/P2 | 用量拦截失效 | **自动恢复**（见 §4.2.2） |
| **P2 中等** | session_meta_sync 延迟窗口 | M4 | 短暂显示不一致 | 下次 callFinished 后自愈 |
| **P3 低** | System Prompt SYSTEM_CURRENT_MODEL | — | prompt 文本中模型名不变 | 纯 cosmetic |
| **P3 低** | config.llm 引用过期 | L2 | FeatureInitContext 中 llm 为旧值 | 无实际影响（onInitiate 只执行一次） |

### 8.1 并发安全

**`setLLM()` 绝不能在 `onCall` 运行期间执行。**

`isRunning()` 的实现（`agent.ts:661-663`）：

```typescript
isRunning(): boolean {
    return this._currentCallInput !== undefined;
}
```

`_currentCallInput` 在 `onCall` 入口设置（`agent.ts:290`），在 `finally` 块中清除（`agent.ts:491`）。因此 `isRunning()` 在 call 间隙返回 `false`，可以安全执行 `setLLM()`。

ReAct 循环中，一个 onCall 包含多次 LLM 调用（多 step）。如果中途换 LLM，可能出现：
- step 1 用模型 A 调用
- step 2 用模型 B 调用
- 两个模型的工具定义格式可能不兼容（如 Anthropic vs OpenAI 的 tool schema 差异）

**防护**：`setLLM()` 内部检查 `this.isRunning()`，如果运行中则抛异常。Claw 侧 IPC handler 也应先检查。

**但更好的用户体验**：如果用户在运行中切换，前端 toast 显示"将在当前任务完成后生效"，Claw 侧排队等待 `callFinished` 事件后再执行 swap。

### 8.2 跨 Provider 切换

从 Anthropic 切到 OpenAI（或反向）时：

- **工具格式差异**：Anthropic 用 `input_schema`，OpenAI 用 `parameters`。框架内部在 `compileContext` 时做了适配，所以 Context 中的消息格式是统一的。新 LLM 在 `chat()` 时会自行处理格式转换。
- **thinking / reasoning 差异**：Anthropic 有 `thinkingBlocks`，OpenAI Responses 有 `reasoning`。切换后旧消息中的 thinking 内容会被保留在 Context 中，新模型能读取但不一定能完全理解。
- **Token 计数差异**：不同 Provider 的 token 计数方式不同。ContextGuard 的阈值基于新模型的 contextLength 重新计算是正确的。
- **maxTokens 截断**：不同模型的 `maxTokens` 上限不同。如果旧模型设置了较高的 `maxTokens`，切换到新模型后可能超出其上限，导致 `max_tokens` 截断。预设配置中的 `maxTokens` 字段会在 `resolveModelPresetLLM` 时传入新 LLM 实例，因此这个问题不存在——每个预设独立配置 maxTokens。

**结论**：跨 Provider 切换功能上可行，但可能存在微妙的格式兼容性问题。建议第一版只支持同 Provider 内切换（如同为 OpenAI 兼容的不同模型），验证通过后再开放跨 Provider。

### 8.3 ContextGuard patch 链完整性 —— 已修正

**原评估**（已过时）：热切换后新 LLM 的 `chat` 未被 patch，guard 失效，必须通过 `onLLMSwap` 钩子手动重新 patch。

**修正后的评估**（详见 §4.2.2）：

ContextGuard 的 `@CallStart` 钩子在**每次** `onCall` 开始时执行（`agent.ts:348`），且钩子上下文中的 `ctx.agent` 是真实的 Agent 实例（`agent: this`）。因此：

1. `setLLM()` 更新 `this.llm` → 新 LLM 就位
2. 下一次 `onCall` → `@CallStart` 触发 → `installUsageGuard(ctx)` → `ctx.agent.llm` = 新 LLM → 检测到 `__clawContextGuardInstalled` 缺失 → 执行 patch

**前提条件**：§4.1（L3 引用修复）必须完成，否则 ReAct 循环不走新 LLM，patch 无意义。

**结论**：chat patch **会在下一次 `@CallStart` 自动恢复**。`onLLMSwap` 钩子是 belt-and-suspenders，不是阻断项。但如果选择不实现 `onLLMSwap`，需确保不存在"swap 后不经 `onCall` 直接调用 LLM"的路径（当前不存在此路径）。

### 8.4 多 Session 场景

Claw 的多 session 模型下，一个 agentId 可能有多个活跃 session runtime（不同 sessionId）。每个 runtime 是独立的子进程，持有独立的 Agent 实例。

**现有基础设施**：

```javascript
// server/shared/agent-access.js:24-28
export function listAgentRuntimes(agentId) {
    const normalizedAgentId = sanitizeSessionFragment(agentId);
    return Array.from(managedAgents.values())
        .filter((runtime) => sanitizeSessionFragment(runtime.agentId || runtime.id) === normalizedAgentId);
}
```

`listAgentRuntimes(agentId)` 返回该 agentId 下所有活跃 runtime。遍历后逐一调用 `sendIPCtoSession` 即可广播。

**注意**：当前 `sendIPCtoSession` 需要 `(agentId, sessionId)` 二元组。如果 runtime 的 `selectedSessionId` 为 null（首页模式），需要使用 `NO_SESSION_TOKEN` 作为 sessionId。

**边界**：如果某个 runtime 正在运行 onCall，该 runtime 的 swap 会失败/排队，但不影响其他 runtime 的 swap。

### 8.5 子代理（SubAgent）的 LLM 继承 —— 自动安全

详见 §4.9。箭头函数闭包捕获 `this`，在 `createAgentByType()` 调用时刻读 `this.llm`。热切换后新创建的子代理自动使用新 LLM。无需额外处理。

### 8.6 session_meta_sync 的延迟窗口

详见 §4.4.3。swap 后到第一次 `callFinished` 之间，session index 中的模型元数据是旧值。

**缓解方案**：swap 成功后，IPC handler 中立即做一次 `session_meta_sync`（不等 `callFinished`），主动推送新模型元数据到 session index。

### 8.7 ContextGuard `restoreState()` 在热切换后的行为

`restoreState()`（`context-guard/index.ts:108-118`）在 rollback 恢复 Feature 状态时，`thresholdTokens` 使用 `this.thresholdTokens`（当前实例值），不从快照中恢复：

```typescript
restoreState(raw: unknown): void {
    // ...
    this.state = {
        // ...
        thresholdTokens: this.thresholdTokens,  // ← 用当前实例值，不从 raw 恢复
        // ...
    };
}
```

这意味着：如果先 `updateThreshold()` 更新了阈值，之后发生 rollback，恢复的阈值是**更新后的值**（而非构造时的原始值）。这是正确行为——阈值取决于当前绑定的模型，与历史状态无关。

### 8.8 IPC handler 的 `agentPath` 可用性

IPC handler 中需要调用 `resolveAgentModelLLM(agentPath, 'default')` 重新解析模型。`agentPath` 在 `run-prebuilt-agent.js:272` 定义为模块级 `const`：

```javascript
const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
```

模块级 `const` 在整个文件内可见。如果 IPC handler 注册在 `runtime-im-bridge.js` 中，需要将 `agentPath` 通过 context 对象传入；如果注册在 `run-prebuilt-agent.js` 中，可直接访问。

推荐方式：在 `run-prebuilt-agent.js` 中注册第二个 `process.on('message', ...)` handler（Node.js 允许多个 handler 共存），直接访问模块级变量。

---

## 9. 待讨论的开放问题

### Q1：是否在 PUT 写盘后自动触发 IPC swap？

**选项 A**：PUT 成功后自动向所有活跃 runtime 发 IPC swap-model
- 优点：用户无感，改完预设就生效
- 缺点：用户可能只是修改配置，不想立即影响运行中的会话

**选项 B**：前端增加"应用到运行时"按钮，用户显式触发
- 优点：用户有控制权
- 缺点：多一步操作

**选项 C**：前端在保存预设后弹出一个选项："立即应用 / 下次重启生效"
- 兼顾灵活性和控制力

### Q2：前端模型选择器如何设计？

当前只有 primary/secondary 双槽位切换（`phToggleModelSlot`）。用户希望"在对话界面直接选择任意预设"。

**建议方案**：在 chat-context-bar 的模型名区域增加下拉菜单，列出所有已配置的预设。选择后：
1. PUT 更新 agent 的 default preset 配置
2. 发 IPC swap-model
3. 显示 toast 反馈

### Q3：是否需要 `onLLMSwap` 生命周期钩子，还是用 Feature 的 `onLLMSwap()` 方法？

两者可以共存：

- **Agent.onLLMSwap(callback)**：通用回调注册，外部消费者（如 Claw 的 run-prebuilt-agent.js）可用
- **Feature.onLLMSwap()**：Feature 声明式接口，Agent.setLLM() 内部自动遍历调用

建议两者都提供，覆盖不同的使用场景。

### Q4：跨 Provider 切换是否在第一版支持？

建议第一版**仅支持同 Provider** 切换（参数校验：新旧 LLM 的 provider 一致），降低风险。验证通过后再放开。

或者不做限制，但在文档中标注跨 Provider 切换的已知限制（thinking 格式兼容性等）。

### Q5：ContextGuard patch 新 LLM 的时机

是通过 Feature 的 `onLLMSwap()` 方法自动处理，还是在 `Agent.setLLM()` 内部统一处理？

**倾向**：Feature `onLLMSwap()`。原因：ContextGuard 的 patch 逻辑是 Feature 自己的事，框架不应该知道 Feature 怎么用 LLM。`setLLM()` 只负责通知"LLM 变了"，具体怎么响应由 Feature 自己决定。

### Q6：`FeatureInitContext` 是否需要增加 agent 引用？

当前 Feature 在 `onInitiate(ctx)` 时拿到的 `ctx` 没有 agent 引用。如果要注册 `onLLMSwap` 回调或直接调用 `agent.setLLM()`，需要通过其他途径获取 agent。

**建议**：扩展 `FeatureInitContext` 增加 `agent` 引用。这是一个影响面稍大但合理的改动——Feature 很多场景都需要访问 agent（如读取 systemContext、获取其他 Feature 等）。

---

## 附录：关键文件索引

### 框架侧（AgentDev）

| 文件 | 说明 |
|------|------|
| `src/core/agent.ts:86` | `protected llm` 属性定义 |
| `src/core/agent.ts:147` | 构造函数中 `this.llm = config.llm` |
| `src/core/agent.ts:1456-1479` | `ensureExecutorsInitialized()` — ReActLoopRunner 创建 |
| `src/core/agent.ts:1663-1693` | `buildOverviewSnapshot()` — 读 `this.llm.modelName` |
| `src/core/agent/react-loop.ts:32-70` | `ReActLoopRunner` 构造函数 |
| `src/core/agent/react-loop.ts:134` | `this.agent.llm.chat()` 调用点 |
| `src/core/types.ts:384-388` | `LLMClient` 接口 |
| `src/core/types.ts:523-535` | `AgentOverviewSnapshot` 接口（含 modelName） |
| `src/core/feature.ts` | `AgentFeature` 接口 |
| `src/llm/index.ts` | `createLLM()` 工厂函数 |
| `src/agents/system/BasicAgent.ts:94-182` | `BasicAgent` 构造函数 |
| `src/agents/system/BasicAgent.ts:180-181` | 子代理工厂（引用 `this.llm`） |

### 产品侧（AgentDevClaw）

| 文件 | 说明 |
|------|------|
| `scripts/run-prebuilt-agent.js:413-414` | `resolveAgentModelLLM()` + `resolvedUsageModel` 赋值 |
| `scripts/run-prebuilt-agent.js:425` | `new AgentClass({ llm: resolved.llm })` |
| `scripts/run-prebuilt-agent.js:333-334` | 现有 IPC handler 注册 |
| `scripts/run-prebuilt-agent.js:604-680` | `callFinished` handler（含 session_meta_sync） |
| `scripts/usage-report.js:1-11` | `buildModelUsageMeta()` |
| `server/model-preset-resolver.js:111-164` | `resolveAgentModelLLM()` |
| `server/routes/model-config.js:532-560` | `PUT /protoclaw/agent_model_presets` |
| `server/routes/agent-lifecycle.js:324-346` | `POST /protoclaw/restart_agent` |
| `server/routes/session.js:1532-1589` | `POST /protoclaw/session_meta_sync` |
| `server/shared/ipc.js` | `sendIPCtoSession()` |
| `local-features/context-guard/src/index.ts:31-191` | `ContextGuardFeature` 完整实现 |
| `local-features/context-guard/src/index.ts:53-67` | thresholdTokens 构造时计算 |
| `local-features/context-guard/src/index.ts:120-138` | LLM chat patch 逻辑 |
| `public/src/modules/chat-context-bar.js:78-85` | 模型名显示优先级逻辑 |
| `public/src/modules/session-ui.js:92-127` | `getSessionContextLength` / `getSessionCompressRatio` |
| `public/src/modules/ph-project-actions.js:231-303` | `phToggleModelSlot` — 前端模型切换 |
| `public/src/modules/overview-data.js:80,138` | overview snapshot 的 modelName 归一化 |
