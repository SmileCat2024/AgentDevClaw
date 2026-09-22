# 会话元数据同步修复方案

> 日期：2026-06-08
> 状态：规划中
> 范围：AgentDevClaw + AgentDev 框架（少量）

---

## 一、问题定义

对话界面中，**模型名称**和**上下文用量百分比**两个信息的显示严重不稳定。具体表现为：

1. 历史对话的模型名会随全局配置变化而全部改变（不是该对话实际使用的模型）
2. 右上角 context bar 的 token 用量和历史列表里同一对话的用量对不上
3. 切换对话时空窗期内显示上一个 runtime 的残留数据
4. contextLength 随配置变化导致百分比无意义跳变
5. 同时运行多个 agent 时，A agent 的用量可能串到 B agent 的界面上

**一句话根因：session 文件中没有持久化模型名和 contextLength，前端只好每次从全局配置实时推算，再加上实时 overview 是 runtime 级全局单例，两路数据从不交汇。**

---

## 二、需要动框架吗？—— 分层判断

### 框架现状

| 能力 | 现状 | 是否需要改框架 |
|------|------|----------------|
| session 文件结构 | `runtime.usageStats` 已持久化（token 用量 OK），但**没有**模型名、contextLength | 需要扩展 |
| `LLMClient` 接口 | 只有 `chat()` 方法，**不暴露模型名** | 需要扩展 |
| `buildOverviewSnapshot()` | 只返回 context 指标 + usageStats，**不含模型名** | 需要扩展 |
| `AgentOverviewSnapshot` 类型 | 无模型相关字段 | 需要扩展 |
| `AgentRuntimeSnapshot`（session-store 版） | 无模型相关字段 | 可选扩展 |

### 结论

**需要动框架，但改动量很小，且全部是纯增量的向后兼容扩展。** 不需要改任何现有字段语义或流程。

框架侧需要做的事情：
1. `LLMClient` 接口增加可选的 `modelName` getter
2. `AgentOverviewSnapshot` 增加可选的 `modelName` 和 `contextLength` 字段
3. `buildOverviewSnapshot()` 把这两个字段带上去

Claw 侧做主体工作：
1. 在 session 创建/保存时把模型名和 contextLength 写入 session index
2. 前端 context bar 改为以 session 元数据为主、overview 为辅
3. 消除 session 切换时的数据残留

---

## 三、框架侧改动（AgentDev）

### 改动 1：`LLMClient` 接口增加可选模型名

文件：`AgentDev/src/core/types.ts`

```typescript
export interface LLMClient {
  chat(messages: Message[], tools: Tool[], options?: LLMChatOptions): Promise<LLMResponse>;
  /** 可选：返回当前 LLM 实例使用的模型名（用于调试显示） */
  readonly modelName?: string;
}
```

实现侧（`AnthropicLLM` / `OpenAILLM`）暴露已有的私有 `modelName`：

```typescript
// anthropic.ts / openai.ts
get modelName(): string { return this.modelName; }
```

**影响**：纯增量，不影响任何现有代码。`modelName` 是 optional，旧实现不实现也不会 break。

### 改动 2：`AgentOverviewSnapshot` 增加模型信息字段

文件：`AgentDev/src/core/types.ts`

```typescript
export interface AgentOverviewSnapshot {
  updatedAt: number;
  context: AgentContextMetrics;
  usageStats: UsageStatsSnapshot;
  runtime?: AgentRuntimeSnapshot;
  /** 可选：当前使用的模型名（由 agent 实例注入） */
  modelName?: string;
  /** 可选：当前模型的上下文窗口长度（由 agent 实例注入） */
  contextLength?: number;
}
```

**影响**：纯增量。所有已有的 overview 消费者不需要改动。

### 改动 3：`buildOverviewSnapshot()` 注入模型信息

文件：`AgentDev/src/core/agent.ts`

```typescript
private buildOverviewSnapshot(): AgentOverviewSnapshot {
  // ... 现有逻辑不变 ...
  return {
    updatedAt: Date.now(),
    context: { messageCount, charCount, toolCallCount, turnCount },
    usageStats: this.usageStats.toSnapshot(),
    // ↓ 新增
    ...(typeof (this.llm as any)?.modelName === 'string'
      ? { modelName: (this.llm as any).modelName }
      : {}),
  };
}
```

**影响**：Claw 启动 agent 时已通过 `resolveAgentModelLLM` 拿到了 `modelName` 并创建 LLM。只要 LLM 实例暴露了 `modelName` getter，overview 就自动带上。

---

## 四、Claw 侧改动（主体工作）

### 改动 A：session index 增加模型元数据持久化

**问题**：当前 `resolveSessionModelInfo(agentId, role)` 每次都从 metadata.json + 全局配置实时推算模型名，导致历史 session 的模型名跟着配置变。

**方案**：在 session 创建时和每次保存时，把当时的 `modelName` 和 `contextLength` 写入 session index record。

#### A1. 扩展 session index record 结构

当前 session index（`.agentdev/AgentDevClaw/prebuilt-sessions/{agentId}/index.json`）的每条 record：

```json
{
  "id": "session-xxx",
  "title": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "formId": "...",
  "agentName": "...",
  ...
}
```

新增字段：

```json
{
  "id": "session-xxx",
  "modelName": "glm-5.1",
  "contextLength": 200000,
  ...
}
```

#### A2. 写入时机

1. **session 创建时**（`createPrebuiltSession`）：从 `resolveSessionModelInfo` 取当前模型配置，写入 index record
2. **session 保存后**（`callArbiter.on('callFinished')` → `agent.saveSession`）：在 Claw 侧的 session 保存钩子中更新 index record 的 `updatedAt`（已有），同时检查 `modelName` 是否存在，不存在则补写

这样做的优点：
- 新 session 立即有模型名
- 旧 session（在本次修改之前创建的）不会丢失数据，只是回退到现有逻辑（从全局配置推算）
- 模型名只在创建时写一次，后续不会因为改了全局配置而被覆盖

#### A3. `summarizePrebuiltSession` 优先使用 index record 的模型名

```javascript
// 当前逻辑（实时推算）
const sessionModelInfo = (modelInfoMap && modelInfoMap[modelRole]) || {};
return {
  ...
  modelName: sessionModelInfo.modelName || '',
  contextLength: sessionModelInfo.contextLength || null,
};

// 修改后（优先用 index record）
const persistedModelName = cleanSessionText(record.modelName);
const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
  ? record.contextLength : null;
const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole]) || {};
return {
  ...
  modelName: persistedModelName || fallbackModelInfo.modelName || '',
  contextLength: persistedCL || fallbackModelInfo.contextLength || null,
};
```

**回退兼容**：如果 index record 没有 `modelName`（旧数据），仍然回退到全局配置推算。行为和现在完全一致。

---

### 改动 B：前端 context bar 以 session 元数据为准

**问题**：`updateChatContextBar` 优先用全局 `currentOverviewSnapshot.usageStats.lastRequestUsage`，这个值来自当前 runtime 的 ViewerWorker，可能和当前 workspace session 无关。

**方案**：改变优先级——**先看 session 自身的元数据，overview 只在"当前正在运行的就是这个 session"时才用。**

#### B1. 判断 "当前 runtime 是否就是这个 session"

```javascript
function isRuntimeBoundToSession(runtimeRecord, agent, activeSessionId) {
  if (!runtimeRecord || !activeSessionId) return false;
  const runtimeSessionId = runtimeRecord.active_workspace_session_id
    || runtimeRecord.runtime_session_id;
  // runtime 的 selectedSessionId 对上了，才认为 overview 属于当前 session
  return runtimeSessionId === activeSessionId
    || runtimeRecord.parent_id === agent.id;
}
```

#### B2. 修改 `updateChatContextBar` 的用量来源优先级

```javascript
// 当前：overview 优先
// 1. currentOverviewSnapshot.lastRequestUsage
// 2. activeSession.tokenUsage.lastRequestUsage
// 3. activeSession.tokenUsage.totalTokens

// 修改后：session 元数据优先，overview 仅在确认绑定关系时使用
var used = 0;
var isLastRequest = false;

// 只有当 runtime 确实属于当前 session 时，才用 overview 实时数据
if (isRuntimeBoundToSession(runtimeRecord, agent, activeId)) {
  var liveUsage = currentOverviewSnapshot?.usageStats?.lastRequestUsage;
  if (liveUsage?.totalTokens) {
    used = liveUsage.totalTokens;
    isLastRequest = true;
  }
}

// 否则从 session 自身的持久化数据取
if (!used && activeSession?.tokenUsage) {
  var lr = activeSession.tokenUsage.lastRequestUsage;
  if (lr?.totalTokens) {
    used = lr.totalTokens;
    isLastRequest = true;
  } else {
    used = activeSession.tokenUsage.totalTokens || 0;
  }
}
```

#### B3. 模型名只从 session 取，不依赖 overview

```javascript
// 当前
var modelName = activeSession ? activeSession.modelName : '';

// 保持不变。但 session.modelName 的来源已经通过改动 A 变为持久化的值。
```

---

### 改动 C：消除 session 切换时的 overview 残留

**问题**：切换 session 时，`currentOverviewSnapshot` 不会立即清空，新 runtime 启动前会短暂显示旧数据。

**方案**：在触发 session 切换的入口点，立即将 `currentOverviewSnapshot` 重置为空。

涉及位置（`app-main.js`）：
- `activatePrebuiltSession` 系列（点击历史列表中的"打开"按钮）
- `selectWorkspaceSurface` 当涉及 runtime 切换时

```javascript
// 在发起 session 切换时，立即重置 overview
if (typeof resetRuntimeBackedSurfaceState === 'function') {
  // 这已经会调用 setCurrentOverviewSnapshot(getEmptyOverviewSnapshot())
  resetRuntimeBackedSurfaceState();
}
```

注意：`resetRuntimeBackedSurfaceState` 已经做了这件事（`app-ui.js:6040`）。问题是有些切换路径没有调用它。需要检查所有 session 切换路径，确保都走了这个清理。

---

### 改动 D：`readWorkspaceSessionSnapshot` 返回空 sessions 的隐患

**问题**：`getConnectedAgents()` → `readWorkspaceSessionSnapshot()` 返回 `sessions: []`（空数组），然后 `loadAgents()` 会把这个空数组覆盖到 `allAgents[x].workspace_sessions.sessions`。虽然有 `loadedAgentDetailIds` 保护机制，但时序上仍有间隙。

**方案**：让 `readWorkspaceSessionSnapshot` 至少返回 index record 的基本信息（不含 tokenUsage，但含 id、title、updatedAt 等轻量字段），避免闪空。

或者更简单的方案：在 `loadAgents` 的合并逻辑中，当新数据的 `sessions` 为空但旧数据有 sessions 时，保留旧数据的 sessions 而不覆盖。

```javascript
// app-main.js loadAgents() 中
return {
  ...agent,
  // 当新获取的 workspace_sessions.sessions 为空但旧数据有值时，保留旧数据
  workspace_sessions: prev?.workspace_sessions?.sessions?.length > 0
    && !(agent.workspace_sessions?.sessions?.length > 0)
    ? prev.workspace_sessions
    : agent.workspace_sessions,
};
```

---

## 五、改动优先级与分阶段

### Phase 1：纯 Claw 侧，不动框架（高优先）

| 改动 | 工作量 | 效果 |
|------|--------|------|
| **A**：session index 持久化 modelName/contextLength | 中 | 历史对话模型名不再随配置漂移 |
| **B**：context bar 优先用 session 元数据 | 小 | 右上角和历史列表用量一致 |
| **C**：切换时重置 overview | 小 | 消除残留闪烁 |
| **D**：loadAgents 保护 sessions 不被空覆盖 | 小 | 消除列表闪空 |

Phase 1 完成后，大部分问题已解决。模型名在 session 创建时持久化、context bar 不再从无关 runtime 取数据、切换不再残留。

### Phase 2：框架侧（中优先，可与 Phase 1 并行）

| 改动 | 工作量 | 效果 |
|------|--------|------|
| 框架：`LLMClient.modelName` getter | 小 | agent runtime 能报告自己的模型名 |
| 框架：`AgentOverviewSnapshot` 增加 modelName/contextLength | 小 | overview API 自带模型信息 |

Phase 2 完成后，overview API 自带模型名，前端可以直接用 overview 的模型名作为实时显示来源，不再需要回退推算。

### Phase 3（低优先，长期）

- 让 session 文件的 `AgentRuntimeSnapshot` 也持久化 `modelName` 和 `contextLength`（框架侧 `captureRuntimeSnapshot`）
- 这样从 session 文件恢复后也能立刻知道模型信息，不需要查 index
- 不过这只是锦上添花，Phase 1+2 已经解决了实际问题

---

## 六、不做的事情

1. **不改 `AgentRuntimeSnapshot`（session-store 版）的现有字段**：`initialized`、`callIndex`、`context`、`featureStates`、`usageStats` 都不动
2. **不改 `captureRuntimeSnapshot` / `restoreRuntimeSnapshot` 的流程**：Phase 3 可选做
3. **不给 overview 加 contextLength 的运行时感知**：contextLength 是静态配置值，不需要运行时动态计算
4. **不重建整个前端状态管理架构**：这是另一个独立的大工程

---

## 七、验收标准

1. 创建一个编程小助手 session，右上角显示模型名 "glm-5.1"
2. 修改全局模型配置为 "deepseek-v4-pro"，右上角仍然显示 "glm-5.1"（该 session 创建时的模型）
3. 新建另一个 session，右上角显示 "deepseek-v4-pro"
4. 切换回第一个 session，右上角立即显示 "glm-5.1"，无闪烁
5. 同时启动 qqbot（用不同模型），编程小助手界面不受 qqbot 的 overview 影响
6. 右上角的 token 百分比与历史列表中同一对话的百分比一致（不考虑实时增量）
7. 历史列表不再出现 sessions 闪空

---

## 八、涉及文件清单

### 框架侧（AgentDev）

| 文件 | 改动类型 |
|------|----------|
| `src/core/types.ts` | 新增 `LLMClient.modelName?`，扩展 `AgentOverviewSnapshot` |
| `src/llm/anthropic.ts` | 暴露 `get modelName()` |
| `src/llm/openai.ts` | 暴露 `get modelName()` |
| `src/core/agent.ts` | `buildOverviewSnapshot` 注入 modelName |

### Claw 侧（AgentDevClaw）

| 文件 | 改动类型 |
|------|----------|
| `server.js` → `createPrebuiltSession` | 创建 session 时写入 modelName/contextLength 到 index |
| `server.js` → `summarizePrebuiltSession` | 优先读 index record 的模型信息 |
| `public/src/app-ui.js` → `updateChatContextBar` | 改用量来源优先级 |
| `public/src/app-main.js` → `loadAgents` | 保护 sessions 不被空覆盖 |
| `public/src/app-main.js` → session 切换入口 | 确保 overview 重置 |
