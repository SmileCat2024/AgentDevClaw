# Rollback Checkpoint 捕获时机问题：根因分析与修复方案

> 日期：2026-07-02  
> 状态：根因已确认，方案已设计，尚未实现  
> 涉及仓库：`AgentDev`（框架本体）、`AgentDevClaw`（产品壳层）  
> 核心文件：`AgentDev/src/core/agent.ts`

---

## 一、问题描述

### 1.1 三个用户可见症状

| # | 症状 | 触发场景 |
|---|------|---------|
| A | 编辑第一轮用户消息时，注入的上下文内容（交接摘要、CLAUDE.md 等）从聊天界面消失 | 点击第一轮 user message 的「编辑此轮」→「回退到此轮」 |
| B | summary / trim / branch 后的新会话首次加载是空的（只有「欢迎使用 xx」），直到用户发送首轮输入才能看到上下文 | 执行 compact resume / trim resume / branch 后切换到新会话 |
| C | branch 会话中编辑第一轮，同样丢失注入内容 | branch 会话中点击「编辑此轮」 |

三个症状的**统一根因**是同一个：rollback checkpoint 的捕获时机在 CallStart 钩子之前。

### 1.2 为什么这些内容「跟着首轮用户输入绑定」

所有通过 `@CallStart` 钩子注入的内容（CLAUDE.md、交接摘要、flow 状态等），在生命周期上处于一种半绑定状态：

- 它们存在于对话 context 中（用户能看到）
- 但它们**不在** rollback checkpoint 中（回退后丢失）
- 它们**不在** session 快照中，直到首次 `onCall()` 完成后才被 `saveSession` 持久化
- 它们只在 `onCall()` 触发时才出现（即用户发消息时）

因此表现为「这些内容似乎跟首轮用户输入绑在一起」。

---

## 二、根因分析

### 2.1 onCall 中的时序

以下是 `AgentDev/src/core/agent.ts` 的 `onCall()` 方法中，与 checkpoint 和注入相关的关键步骤：

```
Line 304-323  首次初始化（仅 isFirstCall 时）：
              ├─ onInitiate hooks 执行
              ├─ templateResolver.resolve() → context.addSystemMessage()    ← 系统提示词进 context
              └─ _initialized = true

Line 326      ★★★ preCallRuntime = captureRuntimeSnapshot(context, _callIndex - 1)  ★★★
              │  此时 context = [system_prompt]
              │  Feature 状态尚未被 CallStart 修改

Line 331      _pendingInput = input

Line 334      hooksRegistry.executeVoid(CallStart, ...)                      ← Feature 注入发生在这里
              ├─ MemoryFeature: 读取 CLAUDE.md → context.add({ role: 'system', ... })
              ├─ ContextHandoffSeedFeature: 注入 seedMessages / sourceSummary
              ├─ FlowFeature: 注入 flow 状态、节点 prompt
              └─ 其他 Feature 的 @CallStart 钩子...

Line 345-346  finalInput = _pendingInput ?? input
              context.addUserMessage(finalInput, _callIndex)                 ← 用户消息进 context

Line 352-356  commitCallCheckpoint({
                callIndex: _callIndex,
                draftInput: finalInput,
                runtime: preCallRuntime,    ← 用的是 Line 326 的快照！
              })
```

**问题就在 Line 326 和 Line 334 之间的缝隙。**

preCallRuntime 在 CallStart 钩子**之前**捕获。此时 context 只有 `[system_prompt]`。CallStart 钩子在 preCallRuntime 捕获**之后**才往 context 里注入内容。但 checkpoint 存储的是 preCallRuntime（旧的快照）。

结果：checkpoint 里**不包含**任何 CallStart 钩子注入的内容。

### 2.2 真实 session 数据验证

从 `~/.agentdev/AgentDevClaw/prebuilt-sessions/qqbot/session-1780761186779-67cb7a.json` 验证：

```
运行时 context:     11 条消息 [system, user, assistant, tool, assistant, user, ...]

checkpoint[0]:       callIndex=0 → context 只有 1 条消息 [system]
checkpoint[1]:       callIndex=1 → context 有 5 条消息 [system, user, assistant, tool, assistant]
```

checkpoint 0 的 context 只有 1 条（system_prompt），CallStart 注入的所有内容都被剥离。

### 2.3 三个症状的精确触发链路

#### 症状 A：编辑第一轮丢失注入内容

```
用户点击第一轮的「编辑此轮」→「回退到此轮」
    ↓
前端调用 submitInputAction(requestId, 'rollback_to_call', { callIndex: 0 })
    ↓
runtime 调用 agent.rollbackToCall(0)
    ↓
restoreRuntimeSnapshot(preCallRuntime)
    context 恢复为 [system_prompt] —— 只有这一条
    Feature 状态恢复为 CallStart 之前的值
    ↓
pushToDebug([system_prompt]) → 前端只显示 system prompt
    ↓
CLAUDE.md、交接摘要、flow 状态 —— 全部从聊天界面消失
```

用户重新发消息后，由于 `_callIndex` 被恢复到 -1，`nextCallIndex = 0`，`isFirstCall = true`，CallStart 钩子会重新执行并重新注入。但回退到重新输入之间的视觉空窗非常令人困惑。

#### 症状 B：新会话首次加载为空

```
createCompactedResumeFromHandoff() 创建新 session + 启动 runtime
    ↓
run-prebuilt-agent.js:
    agent.use(new ContextHandoffSeedFeature({ handoff }))   ← Feature 已挂载，有内容
    agent.loadSession(sessionId) → 失败（新 session，无快照）
    context = []
    pushToDebug([]) → 前端显示空的「欢迎使用 xx」
    ↓
ContextHandoffSeedFeature 有内容，但只在 @CallStart 时注入
@CallStart 只在 onCall() 时触发
onCall() 只在用户发消息时触发
    ↓
用户首轮输入之前：context 始终为空
```

这不是 bug 而是架构设计的必然：Feature 的注入逻辑绑定在 `@CallStart` 生命周期上，而 `@CallStart` 只在 `onCall()` 中执行。新 session 在首次用户输入之前，永远不会触发 `onCall()`。

#### 症状 C：branch 继承了 checkpoint 问题

Branch 创建时直接复制了源 session 的 messages 和 rollbackHistory。第一个 checkpoint（callIndex=0）仍然是 `[system_prompt]`，所以 branch 会话中编辑第一轮同样会丢失注入内容。

### 2.4 为什么「CLAUDE.md 似乎不受影响」

| 内容 | 注入方式 | 在 checkpoint 中 | 回退后存活 |
|------|---------|-----------------|-----------|
| 系统提示词（system.md 模板） | `templateResolver.resolve()` → Line 318 | **是**（在 Line 326 之前） | **是** |
| CLAUDE.md（MemoryFeature） | `@CallStart` → Line 334 | **否**（在 Line 326 之后） | **否** |
| 交接摘要 / seed messages | `@CallStart` → Line 334 | **否** | **否** |

用户观察到的「CLAUDE.md 不受影响」，实际上指的是**系统提示词模板内容**（它在 checkpoint 中，确实不受影响）。真正的 CLAUDE.md 文件内容（由 MemoryFeature 通过 `@CallStart` 注入）和交接摘要一样，回退后都会消失。

此外，MemoryFeature 没有任何状态跟踪（无 `captureState` / `restoreState`，无 `injected` 标志），只靠 `ctx.isFirstCall` 守卫。回退后 `isFirstCall` 始终为 true，所以 CLAUDE.md 每次都能可靠地重新注入——这让用户觉得「它没丢」。

---

## 三、涉及的关键代码位置

### 3.1 框架侧（AgentDev 仓库）

| 文件 | 行号 | 作用 |
|------|------|------|
| `src/core/agent.ts` | **326** | **preCallRuntime 捕获点（根因所在）** |
| `src/core/agent.ts` | 334 | CallStart 反向钩子执行（注入发生处） |
| `src/core/agent.ts` | 352-356 | checkpoint 提交（使用 Line 326 的快照） |
| `src/core/agent.ts` | 647-660 | `rollbackToCall()` 实现 |
| `src/core/agent.ts` | 1427-1436 | `captureRuntimeSnapshot()` 实现 |
| `src/core/agent.ts` | 1438-1453 | `restoreRuntimeSnapshot()` 实现 |
| `src/core/context.ts` | 55-58 | `Context.add()` — Feature 注入消息的通用入口 |
| `src/core/context.ts` | 190-197 | `Context.addUserMessage()` |
| `src/core/context.ts` | 262-269 | `Context.addSystemMessage()` |
| `src/features/memory/index.ts` | 64-95 | MemoryFeature 的 CLAUDE.md 注入（`@CallStart`，无状态） |

### 3.2 产品侧（AgentDevClaw 仓库）

| 文件 | 行号 | 作用 |
|------|------|------|
| `local-features/context-handoff-seed/src/index.ts` | 155-210 | 交接摘要 / seed messages 注入（`@CallStart`，有 `injected` 状态） |
| `local-features/context-handoff-seed/src/index.ts` | 143-153 | `captureState()` / `restoreState()` — injected 标志的持久化 |
| `scripts/run-prebuilt-agent.js` | 1572-1579 | 挂载 ContextHandoffSeedFeature |
| `scripts/run-prebuilt-agent.js` | 1607-1650 | 新 session 的 loadSession + pushToDebug（症状 B 的触发点） |
| `scripts/run-prebuilt-agent.js` | 1363-1462 | `triggerPartialCompact` — 从此处压缩的实现 |
| `server/routes/session.js` | 202-366 | branch 创建逻辑 |
| `server/routes/session-helpers.js` | 1268-1339 | compacted resume 创建逻辑 |
| `public/src/app-main.js` | 7146-7154 | `canRollbackMessage()` — 前端回退按钮显示逻辑 |
| `public/src/app-main.js` | 7326-7345 | `requestRollbackEdit()` — 前端回退请求入口 |

---

## 四、修复方案

### 4.1 方案概述

将 preCallRuntime 的捕获点从 **CallStart 钩子之前** 移到 **CallStart 钩子之后、用户消息加入之前**。

### 4.2 核心改动（AgentDev 框架）

**文件：`AgentDev/src/core/agent.ts`**

当前代码（Line 326-356）：

```typescript
      // ★ 当前：在 CallStart 钩子之前捕获
      preCallRuntime = await this.captureRuntimeSnapshot(context, this._callIndex - 1);

      // 设置输入缓存
      this._pendingInput = input;

      // 执行 CallStart 反向钩子
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, { input, context, isFirstCall, agent: this });
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();

      // ... 通知 ...

      // 添加用户输入
      finalInput = this._pendingInput ?? input;
      context.addUserMessage(finalInput, this._callIndex);
      this.pushToDebug(context.getAll());

      // 提交 checkpoint（使用旧的 preCallRuntime）
      this.commitCallCheckpoint({
        callIndex: this._callIndex,
        draftInput: finalInput,
        runtime: preCallRuntime,
      });
```

修改后：

```typescript
      // 设置输入缓存
      this._pendingInput = input;

      // 执行 CallStart 反向钩子
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, { input, context, isFirstCall, agent: this });
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();

      // ★ 修改后：在 CallStart 钩子之后、用户消息之前捕获
      // 此时 context 包含系统提示词 + 所有 Feature 注入的内容
      preCallRuntime = await this.captureRuntimeSnapshot(context, this._callIndex - 1);

      // ... 通知 ...

      // 添加用户输入
      finalInput = this._pendingInput ?? input;
      context.addUserMessage(finalInput, this._callIndex);
      this.pushToDebug(context.getAll());

      // 提交 checkpoint（现在包含 Feature 注入的内容）
      this.commitCallCheckpoint({
        callIndex: this._callIndex,
        draftInput: finalInput,
        runtime: preCallRuntime,
      });
```

**改动量：1 行代码的位置移动。** 把 `preCallRuntime = ...` 从 CallStart 钩子之前移到之后。

### 4.3 为什么这个改动是安全的

#### Feature 幂等性分析

改动后，回退到某一轮时，context 会包含该轮 CallStart 钩子注入的内容。当用户重新发消息时，CallStart 钩子会再次执行。关键问题是：**Feature 是否会重复注入？**

| Feature | 防重入机制 | 改动后行为 |
|---------|-----------|-----------|
| MemoryFeature | `if (!ctx.isFirstCall) return;` | 回退后 `isFirstCall` 仍为 true → 会重新执行。但由于 context 已有上次注入的 CLAUDE.md，会**追加一条重复的** system 消息 |
| ContextHandoffSeedFeature | `if (this.injected \|\| !ctx.isFirstCall) return;` | 回退后 `injected` 从 checkpoint 恢复为 **true** → **不会重复注入** ✓ |
| FlowFeature | 内部状态管理 | 取决于 flow 状态是否被 checkpoint 恢复 |

#### MemoryFeature 的重复注入问题及修复

MemoryFeature 是唯一有风险的 Feature。它在回退后 `isFirstCall = true` 会重新读取 CLAUDE.md 并注入，但 context 中已经有了上次注入的副本。

**修复方案：给 MemoryFeature 增加状态跟踪**

在 `AgentDev/src/features/memory/index.ts` 中：

```typescript
export class MemoryFeature implements AgentFeature {
  // ... 现有字段 ...
  private _injected = false;  // 新增

  @CallStart
  async injectCLAUDEContent(ctx: CallStartContext): Promise<void> {
    if (!ctx.isFirstCall) return;
    if (this._injected) return;  // 新增：防止重复注入

    // ... 现有读取和注入逻辑 ...

    this._injected = true;  // 新增：标记已注入
  }

  // 新增：状态快照
  captureState(): FeatureStateSnapshot {
    return { injected: this._injected };
  }

  // 新增：状态恢复
  restoreState(snapshot: FeatureStateSnapshot): void {
    this._injected = Boolean((snapshot as any)?.injected);
  }
}
```

**双路径同步提醒：** MemoryFeature 同时存在于：
- `AgentDev/packages/memory-feature/src/` （tgz 包源码）
- `AgentDev/src/features/memory/` （框架内部副本）

两侧都要改，两个构建都要做。

### 4.4 症状 B 的额外修复（新会话首次加载为空）

核心改动（4.2）解决了症状 A 和 C，但**不解决症状 B**。症状 B 的根因是 `@CallStart` 钩子只在 `onCall()` 时触发，新 session 在首次用户输入前不会触发 `onCall()`。

**修复思路：在 `run-prebuilt-agent.js` 中，当 `loadSession()` 失败且存在 handoff 时，主动执行一次 CallStart 钩子的注入逻辑。**

**文件：`scripts/run-prebuilt-agent.js`（Line 1607-1650 区域）**

当前代码：

```javascript
  if (sessionId) {
    let sessionLoaded = false;
    try {
      await agent.loadSession(sessionId, sessionStore);
      sessionLoaded = true;
    } catch {
      console.log('[ProtoClaw Runtime] 创建新会话: ' + sessionId);
    }
    // ... feature continuity import ...
  }

  // Line 1640-1644
  if (!IS_EXPLORATION) {
    const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
    agent['pushToDebug']?.(messages);
    // ...
  }
```

修改后（在 loadSession 失败时，预注入 handoff 内容）：

```javascript
  if (sessionId) {
    let sessionLoaded = false;
    try {
      await agent.loadSession(sessionId, sessionStore);
      sessionLoaded = true;
    } catch {
      console.log('[ProtoClaw Runtime] 创建新会话: ' + sessionId);

      // ★ 新增：对新 session 预注入 CallStart 钩子内容
      // 这样 pushToDebug 时就能看到 handoff 摘要等注入内容
      if (typeof agent['preInjectCallStart'] === 'function') {
        await agent['preInjectCallStart']();
      }
    }
    // ... feature continuity import ...
  }
```

在 `AgentDev/src/core/agent.ts` 中新增方法：

```typescript
  /**
   * 预注入 CallStart 钩子内容（不触发完整 onCall 流程）。
   * 用于新 session 在首次用户输入前就能展示注入的上下文。
   */
  async preInjectCallStart(): Promise<void> {
    const context = this.persistentContext ?? new Context();
    this.persistentContext = context;

    // 首次初始化（与 onCall 中的逻辑一致）
    if (!this._initialized) {
      await executeHook(
        this,
        () => (this as any).onInitiate({ context }),
        { hookName: 'onInitiate', input: '' }
      );

      if (this.templateResolver && context.getAll().length === 0) {
        const systemMsg = await this.templateResolver.resolve();
        if (systemMsg) {
          context.addSystemMessage(systemMsg, 0);
        }
      }

      this._initialized = true;
    }

    // 执行 CallStart 钩子（isFirstCall = true）
    await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, {
      input: '',
      context,
      isFirstCall: true,
      agent: this,
    });
    this.syncRegisteredToolsToDebug();
    this.pushInspectorSnapshot();
  }
```

### 4.5 对 partial compact（从此处压缩）的影响

`triggerPartialCompact` 中调用 `rollbackToCallAndSave(callIndex, ...)` 后，会检查回退后的消息数是否与预期一致。改动后，回退到第一轮时 context 会包含 Feature 注入的内容，消息数会**多于**之前的预期。

具体来说，`triggerPartialCompact` 在 Line 1450 处检查：

```javascript
const postRollbackMessages = ctx.getAll();
if (postRollbackMessages.length === keptMessages.length) {
  ctx.addSystemMessage(summaryContent, reminderTurn, 'partial-compact');
} else {
  // fallback: explicit restore
}
```

改动后，如果回退到第一轮，`postRollbackMessages` 会包含注入的 CLAUDE.md 等，长度不再等于 `keptMessages.length`。这会触发 fallback 路径。

**这不是破坏**——fallback 路径会正确处理。但如果要对第一轮做 partial compact，可能需要调整 `keptMessages` 的计算逻辑，把 Feature 注入的消息也计入。

### 4.6 对 branch 创建的影响

Branch 创建（`server/routes/session.js` Line 202-366）直接从源 session 快照中复制 messages 和 rollbackHistory。改动后，新的 session 快照中 checkpoint 0 会包含注入内容，branch 复制时也会继承这些内容。

**这是正向改进**——branch 会话中编辑第一轮不再丢失注入内容。无需额外改动。

---

## 五、改动影响面评估

### 5.1 受影响的代码路径

| 路径 | 改动影响 | 风险等级 |
|------|---------|---------|
| rollbackToCall() | checkpoint 恢复后包含更多内容 | 低 — 这是预期改进 |
| partial compact（从此处压缩） | 第一轮的 `postRollbackMessages.length` 会变化 | 低 — fallback 路径可处理 |
| branch 创建 | 无需改动，自动受益 | 无 |
| saveSession / loadSession | checkpoint 序列化格式不变 | 无 |
| 前端渲染 | 回退后显示的消息更多（包含注入内容） | 低 — 用户期望的行为 |
| ContextHandoffSeedFeature | `injected` 状态正确恢复为 true → 不重复注入 | 无 |
| MemoryFeature | **需要增加状态跟踪**，否则会重复注入 CLAUDE.md | **中** — 必须同步修改 |
| FlowFeature | 取决于 flow 状态是否被 checkpoint 正确恢复 | 需验证 |
| 其他 `@CallStart` Feature | 需要逐一检查幂等性 | 低 — 大部分有 isFirstCall 或状态守卫 |

### 5.2 需要验证的 Feature 清单

以下 Feature 使用 `@CallStart` 钩子，改动后需确认它们的防重入机制：

| Feature | 文件位置 | 当前守卫 | 改动后是否安全 |
|---------|---------|---------|--------------|
| MemoryFeature | `AgentDev/src/features/memory/index.ts` | `isFirstCall` | **不安全** — 需增加 `injected` 状态 |
| ContextHandoffSeedFeature | `local-features/context-handoff-seed/src/index.ts` | `injected \|\| !isFirstCall` | **安全** ✓ |
| FlowFeature | `local-features/flow/src/index.ts` | 内部 workflow/node 状态 | **需验证** |

### 5.3 双路径 Feature 同步

MemoryFeature 是双路径 Feature（见 CLAUDE.md 3D 节），同时存在于：

- `AgentDev/packages/memory-feature/src/index.ts`
- `AgentDev/src/features/memory/index.ts`

两侧都要改，两个构建都要做：
1. 修改 `packages/memory-feature/src/` → `npm run build` → `npm pack` → 复制 tgz 到 Claw
2. 修改 `src/features/memory/` → `npm run build`（框架 dist）
3. 更新 Claw 中安装的 tgz 包

---

## 六、实施顺序

### Phase 1：框架核心改动

1. **修改 `AgentDev/src/core/agent.ts`**
   - 将 `preCallRuntime` 捕获点从 CallStart 钩子之前移到之后
   - 新增 `preInjectCallStart()` 方法（用于症状 B 的修复）

2. **修改 `AgentDev/src/features/memory/index.ts`**
   - 增加 `_injected` 状态字段
   - 增加 `captureState()` / `restoreState()` 方法
   - 在 `@CallStart` 方法中增加 `if (this._injected) return;`

3. **同步修改 `AgentDev/packages/memory-feature/src/index.ts`**
   - 与上述相同的改动

4. **构建框架**：`cd AgentDev && npm run build`

5. **打包 tgz**：`cd AgentDev/packages/memory-feature && npm run build && npm pack`

6. **更新 Claw 的 tgz**：复制到 `resources/features/`，更新安装

### Phase 2：产品侧改动

7. **修改 `scripts/run-prebuilt-agent.js`**
   - 在 `loadSession()` 失败时调用 `agent.preInjectCallStart()`

8. **构建 local-features**：`npm run build:local-features`

### Phase 3：验证

9. **验证症状 A**：在有注入内容的会话中编辑第一轮，确认注入内容不再消失
10. **验证症状 B**：创建 compacted resume 会话，确认首次加载就能看到交接摘要
11. **验证症状 C**：在 branch 会话中编辑第一轮，确认注入内容保留
12. **验证 partial compact**：对第一轮做「从此处压缩」，确认摘要正确追加
13. **验证 MemoryFeature 不重复注入**：编辑第一轮后重新发消息，确认 CLAUDE.md 没有翻倍
14. **验证 FlowFeature**：在 flow 会话中编辑第一轮，确认 flow 状态正确恢复

---

## 七、参考代码索引

### 7.1 onCall 完整时序（修改前）

```
agent.ts onCall(input)
│
├─ [304] if (!_initialized)
│   ├─ [306] executeHook(onInitiate)
│   ├─ [315] templateResolver.resolve() → context.addSystemMessage()
│   └─ [322] _initialized = true
│
├─ [326] preCallRuntime = captureRuntimeSnapshot(context, _callIndex - 1)     ★ 当前捕获点
│
├─ [331] _pendingInput = input
│
├─ [334] hooksRegistry.executeVoid(CallStart)                                 ★ Feature 注入点
│   ├─ MemoryFeature.injectCLAUDEContent()
│   ├─ ContextHandoffSeedFeature.injectHandoffSummary()
│   └─ FlowFeature hooks
│
├─ [345] finalInput = _pendingInput ?? input
├─ [346] context.addUserMessage(finalInput, _callIndex)
├─ [347] pushToDebug(context.getAll())
│
├─ [352] commitCallCheckpoint({ runtime: preCallRuntime })                    ★ 使用旧快照
│
├─ [362] reactRunner.run(input, context, ...)
│
└─ [382] hooksRegistry.executeVoid(CallFinish)
```

### 7.2 onCall 完整时序（修改后）

```
agent.ts onCall(input)
│
├─ [304] if (!_initialized)
│   ├─ [306] executeHook(onInitiate)
│   ├─ [315] templateResolver.resolve() → context.addSystemMessage()
│   └─ [322] _initialized = true
│
├─ [331] _pendingInput = input
│
├─ [334] hooksRegistry.executeVoid(CallStart)                                 ★ Feature 注入点
│   ├─ MemoryFeature.injectCLAUDEContent()
│   ├─ ContextHandoffSeedFeature.injectHandoffSummary()
│   └─ FlowFeature hooks
│
├─ ★ 新位置: preCallRuntime = captureRuntimeSnapshot(context, _callIndex - 1)  ★ 修改后捕获点
│
├─ [345] finalInput = _pendingInput ?? input
├─ [346] context.addUserMessage(finalInput, _callIndex)
├─ [347] pushToDebug(context.getAll())
│
├─ [352] commitCallCheckpoint({ runtime: preCallRuntime })                    ★ 现在包含注入内容
│
├─ [362] reactRunner.run(input, context, ...)
│
└─ [382] hooksRegistry.executeVoid(CallFinish)
```

### 7.3 回退后行为对比

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| 回退到第一轮 | context = [system_prompt] | context = [system_prompt, CLAUDE.md, 交接摘要, ...] |
| 重新发消息后 | CallStart 钩子重新注入（内容出现） | CallStart 钩子被状态守卫跳过（内容已在 context 中） |
| 视觉体验 | 注入内容消失再出现 | 注入内容始终保持可见 |
| CLAUDE.md | 可能重复注入（无状态守卫） | 不重复注入（增加了状态守卫） |

### 7.4 captureRuntimeSnapshot / restoreRuntimeSnapshot

```typescript
// agent.ts Line 1427-1453

private async captureRuntimeSnapshot(context?: Context, callIndexOverride?: number): Promise<AgentRuntimeSnapshot> {
  await this.ensureFeatureTools();
  return {
    initialized: this._initialized,
    callIndex: callIndexOverride ?? this._callIndex,
    context: context?.toJSON(),           // ← 整个 context 被序列化
    featureStates: captureFeatureSnapshots(this.features),  // ← 所有 Feature 的 captureState()
    usageStats: this.usageStats.toSnapshot(),
  };
}

private async restoreRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): Promise<void> {
  if (snapshot.context) {
    this.persistentContext = Context.fromJSON(snapshot.context);  // ← 恢复 context
  } else {
    this.persistentContext = undefined;
  }
  await restoreFeatureSnapshots(snapshot.featureStates, this.features);  // ← 恢复 Feature 状态
  this._initialized = snapshot.initialized;
  this._callIndex = snapshot.callIndex;
  this._currentStep = 0;
  if (snapshot.usageStats) {
    this.usageStats.fromSnapshot(snapshot.usageStats);
  }
}
```

### 7.5 ContextHandoffSeedFeature 的状态管理（已正确实现）

```typescript
// local-features/context-handoff-seed/src/index.ts

captureState(): FeatureStateSnapshot {
  return { injected: this.injected };
}

restoreState(snapshot: FeatureStateSnapshot): void {
  this.injected = Boolean(snapshot?.injected);
}

@CallStart
async injectHandoffSummary(ctx: CallStartContext): Promise<void> {
  if (this.injected || !ctx.isFirstCall) {  // ← 双重守卫
    return;
  }
  // ... 注入逻辑 ...
  this.injected = true;
}
```

修改后，checkpoint 会包含 `injected: true`。回退恢复后 `injected` 为 true，钩子直接 return，不会重复注入。✓

### 7.6 MemoryFeature 的状态管理（当前缺失，需要补充）

```typescript
// 当前（无状态跟踪）：
@CallStart
async injectCLAUDEContent(ctx: CallStartContext): Promise<void> {
  if (!ctx.isFirstCall) return;  // ← 唯一守卫，回退后 isFirstCall=true 会重复注入
  // ... 读取并注入 CLAUDE.md ...
}

// 修改后（增加状态跟踪）：
private _injected = false;

@CallStart
async injectCLAUDEContent(ctx: CallStartContext): Promise<void> {
  if (!ctx.isFirstCall) return;
  if (this._injected) return;  // ← 新增守卫
  // ... 读取并注入 CLAUDE.md ...
  this._injected = true;
}

captureState() { return { injected: this._injected }; }
restoreState(s: any) { this._injected = Boolean(s?.injected); }
```

---

## 八、历史相关文档

| 文档 | 关联 |
|------|------|
| `docs/plans/2026-06-15-agent-checkpoint-rollback-continuation-design.md` | Agent 自主 checkpoint/rollback 的完整设计 |
| `docs/plans/2026-06-18-rollback-compact-diagnostic-notes.md` | rollback + partial compact 的诊断记录 |
| `docs/plans/context-compaction-structured-output-design.md` | 上下文压缩结构化输出设计 |
| `docs/plans/context-compaction-successor-session-notes.md` | 压缩续接会话的前期讨论备忘 |
| `docs/reference/frontend-rendering-patterns.md` | 前端渲染机制与去重策略 |
