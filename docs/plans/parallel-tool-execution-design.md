# 并行工具执行方案

> **状态**：已调研，待实施
> **影响范围**：AgentDev 框架本体（`D:\code\AgentDev`）
> **不涉及**：Claw 侧代码改动（feature 工具不需要改，只需在定义时加 `parallelizable: true`）
> **前置阅读**：本文假设读者已了解 AgentDev 的 ReAct 循环、Tool 生命周期钩子（`@ToolUse` / `@ToolFinished` / `@StepFinish`）、exclusive 工具、Decision 三态（`Approve` / `Deny` / `Continue`）等概念。

---

## 1. 问题陈述

### 1.1 现状

AgentDev 框架在向 LLM API 发请求时，已明确设置 `parallel_tool_calls: true`（`src/llm/openai-responses.ts:451`），鼓励模型一次性返回多个工具调用。Anthropic 适配器无此参数但 Claude 原生支持并行工具调用。

然而，框架收到多工具响应后，执行方式是**纯串行**的。

### 1.2 串行执行的证据

核心文件：`src/core/agent/react-loop.ts`，第 315-338 行：

```typescript
// react-loop.ts:315-338
if (!batchRejected) {
  for (let i = 0; i < response.toolCalls.length; i++) {
    const call = response.toolCalls[i];

    // 在执行每个工具前检查中断信号
    if (signal?.aborted) {
      interrupted = true;
      for (let j = i; j < response.toolCalls.length; j++) {
        const pendingCall = response.toolCalls[j];
        context.addToolMessage(pendingCall, {
          success: false,
          result: { error: 'Interrupted by user' },
        }, callIndex);
      }
      break;
    }

    if (call.name === 'wait') {
      waitCalled = true;
    }
    await this.executeToolFn(call, input, context, step, callIndex);  // ← 逐个 await
  }
} // end if (!batchRejected)
```

这是经典的 `for...await` 串行循环。每个工具完整走完生命周期（`@ToolUse` → 执行 → `@ToolFinished` → context 写入），才开始下一个。

### 1.3 性能影响

假设模型一轮返回 5 个工具调用（如读 5 个文件），每个工具耗时 2 秒：

- **串行（当前）**：5 × 2s = **10 秒**
- **并行（目标）**：≈ **2 秒**（取最慢的一个）

---

## 2. 当前架构深度剖析

### 2.1 ReAct 循环中的工具执行全链路

```
react-loop.ts: run()
  │
  ├─ LLM 调用（L131）→ 返回 response.toolCalls[]
  │
  ├─ context.addAssistantMessage(response)（L219）
  │
  ├─ 无工具调用 → StepFinish（L226-282）
  │
  └─ 有工具调用 ↓
     │
     ├─ Exclusive 批次预检（L289-313）
     │   如果批次含 exclusive 工具且 >1 个调用 → 整批拒绝
     │   每个调用补齐 error result → context.addToolMessage
     │
     ├─ 工具执行循环（L315-338）← 改造目标
     │   for each toolCall:
     │     检查 signal.aborted
     │     await executeToolFn(call, ...)
     │       └─ tool-executor.ts: execute()
     │           ├─ 检查 disabled（L95-135）
     │           ├─ 正向钩子 onToolUse（L141-153）
     │           │   返回 { action: 'block' } → 阻止
     │           ├─ 反向钩子 @ToolUse（L155-165）
     │           │   返回 Decision.Deny → 阻止
     │           ├─ 如果被阻止（L184-212）
     │           │   context.addToolMessage(error) ← 当前直接写 context
     │           │   触发 onToolFinished + @ToolFinished
     │           │   return
     │           ├─ 执行工具（L214-298）
     │           │   contextInjector 注入上下文（L219-225）
     │           │   AbortSignal 传入（L228-231）
     │           │   continuation request sink 注入（L234-239）
     │           │   emitNotification(tool.start)（L242-246）
     │           │   Promise.race([tool.execute(), abortPromise])（L262-265）
     │           │   context.addToolMessage(success/error) ← 当前直接写 context
     │           │   emitNotification(tool.complete)（L302-307）
     │           ├─ 正向钩子 onToolFinished（L310-314）
     │           └─ 反向钩子 @ToolFinished（L316-321）
     │
     ├─ interrupted 检查（L341-349）
     │
     ├─ continuation request 检查（L351-363）
     │
     ├─ pushToDebug(context.getAll())（L366）
     │
     └─ StepFinish 决策（L368-421）
```

### 2.2 关键文件索引

| 文件 | 路径 | 职责 |
|------|------|------|
| ReAct 循环 | `src/core/agent/react-loop.ts` (587行) | 工具批量执行调度、StepFinish 决策、中断处理 |
| 工具执行器 | `src/core/agent/tool-executor.ts` (338行) | 单个工具的完整生命周期：hook → 执行 → hook → context 写入 |
| Agent 主类 | `src/core/agent.ts` (1684行) | 初始化 ReActLoopRunner（L1371），传入 executeToolFn |
| 生命周期类型 | `src/core/lifecycle.ts` (354行) | Decision 枚举、HookResult、ToolContext、ToolResult 等类型 |
| 钩子注册表 | `src/core/hooks-registry.ts` (270行) | 反向钩子注册、顺序执行、Decision 短路 |
| 正向钩子执行器 | `src/core/agent/hooks-executor.ts` (92行) | 错误处理策略包装 |
| Context 管理 | `src/core/context.ts` (425行) | 消息数组管理、addToolMessage |
| 工具定义 | `src/core/tool.ts` (246行) | createTool、ToolRegistry、executionMode |
| 工具类型 | `src/core/types.ts` | Tool 接口定义 |
| 通知系统 | `src/core/notification.ts` (195行) | tool.start/tool.complete 通知 |
| Checkpoint | `src/core/checkpoint.ts` (82行) | Step 级别快照与回滚 |

### 2.3 钩子系统详解

#### 双层钩子架构

每个生命周期点有**正向钩子**和**反向钩子**两套机制：

```
                  正向钩子（Virtual Method）     反向钩子（@Decorator）
                  ────────────────────────       ──────────────────────
注册方式          Agent 子类 override 方法       Feature 用装饰器注册
执行方式          通过 executeHookFn 包装        通过 hooksRegistry 执行
返回值            HookResult | undefined         DecisionResult
流程控制          { action: 'block'/'allow' }    Decision.Deny/Approve/Continue
错误处理          按 getHookErrorHandling 策略    try-catch 不中断链
```

#### Tool 级钩子时序（在 tool-executor.ts 中）

```
1. 检查 disabled（L95）
   └─ 是 → addToolMessage(error) + onToolFinished + @ToolFinished → return

2. 正向钩子 onToolUse（L141-153）
   └─ { action: 'block' } → blocked = true

3. 反向钩子 @ToolUse（L155-165）
   └─ Decision.Deny → blocked = true

4. 被阻止？（L184）
   └─ 是 → addToolMessage(error) + onToolFinished + @ToolFinished → return

5. 执行工具（L214-298）
   ├─ 注入 contextInjectors（L219-225）
   ├─ 注入 AbortSignal（L228-231）
   ├─ 注入 continuation request sink（L234-239）
   ├─ emitNotification(tool.start)（L242-246）
   ├─ Promise.race([execute, abort])（L262-265）
   ├─ addToolMessage(success/error)（L283 或 L297）
   └─ emitNotification(tool.complete)（L302-307）

6. 正向钩子 onToolFinished（L310-314）

7. 反向钩子 @ToolFinished（L316-321）
```

#### 反向钩子注册表执行逻辑（hooks-registry.ts:141-213）

```typescript
// hooks-registry.ts:149
for (const { feature, methodName, source } of hooks) {
    const result = await method.call(feature, context);
    if (result !== undefined) {
        const decision = normalizeDecision(result);
        // Approve 或 Deny 立即短路
        if (decision === Decision.Approve || decision === Decision.Deny) {
            return { handled: true, decision, ... };
        }
        // Continue 继续下一个钩子
    }
}
return { handled: true, decision: Decision.Continue };
```

**关键点**：钩子链内部是串行的（`for...await`），每个钩子按 feature 注册顺序执行。任何一个返回 `Approve` 或 `Deny` 就短路。全部返回 `Continue` 则默认行为。

### 2.4 Exclusive 工具机制

定义在 `src/core/tool.ts:181-184`：

```typescript
isExclusive(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.executionMode === 'exclusive';
}
```

在 `react-loop.ts:289-313` 中的预检逻辑：

```typescript
if (response.toolCalls.length > 1) {
    const exclusiveNames = response.toolCalls
        .filter(call => this.agent.tools.isExclusive(call.name))
        .map(call => call.name);
    if (exclusiveNames.length > 0) {
        batchRejected = true;
        // 整批拒绝，所有调用补齐 error result
    }
}
```

**这是批次级预检**，在任何工具执行之前运行。exclusive 工具永远不会进入 Phase 1/Phase 2 分流。**完全不受并行化影响。**

### 2.5 中断机制

两层中断检查：

**外层（react-loop.ts:319-332）**：每个工具开始前检查 `signal?.aborted`，如果中断，当前及剩余工具补齐 interrupted result。

**内层（tool-executor.ts:248-273）**：工具执行时与 abort signal 竞争：

```typescript
// tool-executor.ts:262-265
data = await Promise.race([
    tool.execute(call.arguments, toolContext),
    abortPromise,  // signal.addEventListener('abort', () => reject(new ToolInterruptError()))
]);
```

### 2.6 Context 写入机制

`Context` 类（`src/core/context.ts`）维护两个数组：

```typescript
// context.ts:45-48
private messages: Message[] = [];           // legacy 消息数组
private enrichedMessages: EnrichedMessage[] = [];  // 带元数据的消息
```

`addToolMessage` 方法（L235-257）同时写入两个数组：

```typescript
addToolMessage(call: ToolCall, result: ToolExecResult, turn: number): void {
    const content = JSON.stringify({
        success: result.success,
        result: result.result,
        ...(result.error ? { error: result.error } : {}),
    });
    this.addMessage(                          // → enrichedMessages.push + updateIndexes
        { role: 'tool', turn, toolCallId: call.id, content },
        { turn }
    );
    this.messages.push(                       // → legacy 数组
        { role: 'tool', turn, toolCallId: call.id, content }
    );
}
```

### 2.7 Debug Push 时序

`pushToDebug` 在 `react-loop.ts` 中的调用点：

| 行号 | 时机 |
|------|------|
| L109 | Step 开始时（LLM 调用前） |
| L165-167 | 空响应（end_turn）时 |
| L220 | LLM 正常响应后 |
| L310 | Exclusive 批次拒绝后 |
| L343 | 工具执行被中断后 |
| L366 | **所有工具执行完毕后**（关键点） |

**L366 是最重要的**：它确保 debug viewer 在所有工具完成后看到完整 context。

### 2.8 Notification 系统

`emitNotification`（`src/core/notification.ts:61-86`）：

```typescript
export function emitNotification(notification: Notification): void {
    // ...
    if (notification.category === 'state' && !bypassThrottle) {
        const timeSinceLast = now - lastNotificationTime;
        if (timeSinceLast < THROTTLE_INTERVAL) {
            return;  // 跳过节流
        }
        lastNotificationTime = now;
    }
    debugHub.pushNotification(currentAgentId, notification);
}
```

`tool.start`（L137-146）和 `tool.complete`（L154-169）都是 `category: 'event'`，**不节流**。并发工具的通知调用在 Node.js 单线程下本身就是串行执行的。

---

## 3. 设计方案：Opt-in 两阶段并行

### 3.1 核心思路

1. Tool 定义新增 `parallelizable?: boolean` 属性（默认 false，向后兼容）
2. 工具批次到达后，先跑 Exclusive 预检（不变），然后分两阶段执行：
   - **Phase 1**：所有 `parallelizable: true` 的工具并发执行
   - **Phase 2**：剩余工具按原有串行逻辑逐个执行
3. 所有工具完成后，按 LLM 返回的**原始顺序**统一注入 context（`addToolMessage`）
4. 从 context 最终状态看，跟串行执行完全一致

### 3.2 执行流程图

```
response.toolCalls[] 到达
  │
  ├─ Step 1: Exclusive 批次预检（不变，react-loop.ts:289-313）
  │   含 exclusive 工具且 >1 → 整批拒绝
  │
  ├─ Step 2: 分流
  │   parallelGroup = toolCalls.filter(tc => tools.isParallelizable(tc.name))
  │   serialGroup   = toolCalls.filter(tc => !tools.isParallelizable(tc.name))
  │
  ├─ Step 3: Phase 1 — 并发执行 parallelGroup
  │   const results = await Promise.allSettled(
  │     parallelGroup.map(call => executeToolFn(call, ...))
  │   )
  │   // 每个工具走完整生命周期（@ToolUse → execute → @ToolFinished）
  │   // 结果收集到 Map<toolCallId, ToolExecResult>
  │   // 注意：executeToolFn 不再直接写 context，而是返回结果
  │
  ├─ Step 4: Phase 2 — 串行执行 serialGroup
  │   for (const call of serialGroup) {
  │     检查 signal.aborted
  │     const result = await executeToolFn(call, ...)
  │     // 结果继续收集到同一个 Map
  │   }
  │
  ├─ Step 5: 统一注入（按原始顺序）
  │   for (const call of response.toolCalls) {
  │     const result = resultsMap.get(call.id)
  │     context.addToolMessage(call, result, callIndex)
  │   }
  │
  ├─ Step 6: pushToDebug(context.getAll())（L366，不变）
  │
  └─ Step 7: StepFinish 决策（L368-421，不变）
```

### 3.3 为什么这个设计是安全的

#### 3.3.1 `@ToolUse` 钩子截断 — 安全

每个工具各自走自己的 `@ToolUse` 钩子链，各自独立决策 `Deny`/`Approve`/`Continue`。钩子链内部（`hooks-registry.ts:149`）仍然是 `for...await` 串行。并行时每个工具有独立的 `ToolContext`，互不干扰。

#### 3.3.2 `opencode-basic` 的 read→write 跨工具依赖 — 天然解决

`opencode-basic` feature（`src/features/opencode-basic/index.ts:125-195`）的 `@ToolUse` 钩子：

```typescript
@ToolUse
async validateWriteOperation(ctx: ToolContext): Promise<DecisionResult> {
    if (toolName === 'read') {
        this.readFiles.add(normalizedPath);   // 记录已读文件
        return Decision.Continue;
    }
    if (toolName === 'write') {
        // 检查 this.readFiles.has(normalizedPath)
        // 如果没读过 → blocked
    }
}
```

如果 `read` 标记为 parallelizable（Phase 1），`write` 不标记（Phase 2）：
- Phase 1 的所有 read 钩子都跑完
- Phase 2 的 write 钩子才执行
- readFiles 一定是最新的

**约束：`write` 和 `edit` 绝不能标记为 parallelizable。**

#### 3.3.3 `@StepFinish` 决策 — 完全不受影响

`@StepFinish` 在所有工具执行完毕后触发。无论 Phase 1 + Phase 2 怎么调度，StepFinish 看到的都是"这一步所有工具都已执行完毕"的状态。

Decision 三态语义不变：
- `Deny` → 结束 call
- `Approve` → 继续循环
- `Continue` → 默认进入下一个 step

#### 3.3.4 中断传播 — 更自然

Phase 1 并发执行时，每个工具内部已有 `Promise.race([execute, abort])`（`tool-executor.ts:262`）。Abort 触发后：
- Phase 1 所有工具通过 `Promise.race` 收到 `ToolInterruptError`
- `Promise.allSettled()` 返回后，检查哪些完成、哪些被中断
- Phase 2 按原逻辑：每个工具开始前检查 `signal.aborted`

比串行更高效——串行模式下如果第 1 个工具耗时长，后续工具要排队等它完成才能检查中断。

#### 3.3.5 `@ToolFinished` 钩子 — 安全

`@ToolFinished` 是纯通知（void），对 parallelizable 工具的 `@ToolFinished` 钩子会并发触发。已有的实现：

| Feature | `@ToolFinished` 行为 | 并发安全 |
|---------|---------------------|---------|
| `subagent`（`src/features/subagent/index.ts:173`）| `wait` 工具完成后阻塞等待子代理 | `wait` 不标记 parallelizable → 留在 Phase 2 → 安全 |
| `plugin-compat`（`src/features/plugin-compat/index.ts:300`）| 桥接 legacy `after_tool_call` | 只读，安全 |

#### 3.3.6 Continuation Request — 不受影响

Checkpoint/rollback 工具标记为 `exclusive`（`local-features/checkpoint/src/index.ts:72, 103`），永远是批次中唯一的工具，不参与并行分流。

#### 3.3.7 Context 结果注入顺序 — 设计已解决

所有结果延迟到 Step 5 统一注入。从 context 最终状态看，跟串行执行完全一致。LLM 在下一轮看到的消息顺序没有任何差别。

---

## 4. 风险分析

### 4.1 主要改造风险：`tool-executor.ts` 延迟写入

**当前状态**：`ToolExecutor.execute()` 在 4 个位置直接调用 `context.addToolMessage()`：

| 行号 | 场景 | 代码 |
|------|------|------|
| L120 | 工具 disabled | `context.addToolMessage(call, errorResult, callIndex)` |
| L195 | 被 hook block 或工具不存在 | `context.addToolMessage(call, errorResult, callIndex)` |
| L283 | 执行成功 | `context.addToolMessage(call, successResult, callIndex)` |
| L297 | 执行抛异常 | `context.addToolMessage(call, failResult, callIndex)` |

**改造**：`execute()` 方法改为返回 `Promise<ToolExecResult>` 而非 `Promise<void>`。它内部已经构造了 `ToolExecResult` 对象（`{ success, result }`），只是目前直接写进了 context 而非返回。

`react-loop.ts` 收集所有返回值，在 Step 5 按原始顺序调用 `context.addToolMessage()`。

**影响范围**：
- `tool-executor.ts` — 删除 4 处 `context.addToolMessage` 调用，改为 `return` 结果
- `react-loop.ts` — 工具执行循环改为收集结果，最后统一注入
- `agent.ts:1390` — `executeToolFn` 的类型签名从 `Promise<void>` 改为 `Promise<ToolExecResult>`

### 4.2 `@ToolFinished` 钩子看到的 context 状态

延迟注入后，`@ToolFinished` 钩子触发时 context 中还没有本工具的结果。

**实际影响**：无。`ToolResult` 类型（`lifecycle.ts:213-234`）通过 `result.success`/`result.data`/`result.error` 直接传递本工具结果。`context` 字段是给钩子读取会话上下文用的，不是读本工具结果的。

已验证所有 `@ToolFinished` 实现：
- `subagent`：检查 `ctx.toolName === 'wait'`，wait 是串行工具
- `plugin-compat`：`result.context.getAll()` 传给 legacy 插件，可能看到略微过时的 context（少了本批次其他工具的结果），但这是可接受的

### 4.3 `pushToDebug` 时序

`react-loop.ts:366` 在工具循环后调用 `pushToDebug`。只要结果注入（Step 5）在 pushToDebug 之前完成，debug viewer 看到的 context 就是完整的。

### 4.4 `readDedupState` 模块级共享 Map

`src/features/opencode-basic/tools.ts:60`：

```typescript
const readDedupState = new Map<string, ReadDedupEntry>();
```

`read`/`write`/`edit` 三个工具共享这个 Map。

- 并发 `read` 不同文件：各自操作不同 key，安全。
- 并发 `read` 同一文件：返回相同内容，Map 最后写入获胜但结果一致，安全。
- `write`/`edit` 操作这个 Map 的 `.set()`（L554, L1082）：只要它们在 Phase 2 串行执行，就没有竞争。

### 4.5 Phase 2 工具能否看到 Phase 1 结果

当前设计是"最终统一落盘"，Phase 2 执行时 context 里还没有 Phase 1 的结果。

**实际影响**：无。已验证所有内置 feature 的 `@ToolUse` 和 `@ToolFinished` 钩子——没有一个读取前序工具的结果。它们要么看自己的 `call.arguments`，要么看 feature 自身内部状态。

### 4.6 `waitCalled` 标记

`react-loop.ts:285` 声明 `let waitCalled = false`，在 L335 串行循环中设置。

改造后在结果收集阶段统一检查：遍历 `response.toolCalls`，看有没有 `call.name === 'wait'`。

**注意**：当前没有任何 feature 实际读取 `waitCalled` 字段（`lifecycle.ts:342` 定义了但无人消费），是 dead data。

### 4.7 被阻止工具的结果注入

当 `@ToolUse` 返回 `Deny` 或正向钩子返回 `{ action: 'block' }` 时，工具不执行但仍需要结果（error result）。改造后 `execute()` 返回 `{ success: false, result: { error: '...' } }`，在 Step 5 正常注入。

### 4.8 中断后的结果处理

Phase 1 中断时：
- `Promise.allSettled()` 返回，部分工具已完成（fulfilled），部分被中断（rejected）
- 已完成的收集结果，被中断的构造 `{ success: false, result: { error: 'Interrupted by user' } }`
- Phase 2 检查到 `signal.aborted`，跳过执行，为剩余工具构造 interrupted result
- Step 5 统一注入所有结果

---

## 5. 工具并行安全性分类

### 5.1 可以标记 `parallelizable: true`

| 工具 | Feature 源码位置 | 理由 |
|------|-----------------|------|
| `read` | `src/features/opencode-basic/tools.ts:313-491` | 纯读操作，不同文件无冲突；同文件并发读返回相同内容 |
| `glob` | `src/features/opencode-basic/tools.ts:1220-1280` | 纯文件搜索，只读 |
| `grep` | `src/features/opencode-basic/tools.ts:1316-1434` | ripgrep 搜索，只读，已支持 abort（L1380-1385） |
| `ls` | `src/features/opencode-basic/tools.ts:1107-1209` | 目录列表，只读 |
| `lsp_go_to_definition` | `src/features/lsp/index.ts:25-110` | LSP 协议设计支持并发，`executeOnFile`（L331-334）内部已用 `Promise.all` |
| `lsp_find_references` | 同上 | 同上 |
| `lsp_hover` | 同上 | 同上 |
| `lsp_document_symbol` | 同上 | 同上 |
| `lsp_workspace_symbol` | 同上 | 同上 |
| `lsp_go_to_implementation` | 同上 | 同上 |
| `lsp_prepare_call_hierarchy` | 同上 | 同上 |
| `lsp_incoming_calls` | 同上 | 同上 |
| `lsp_outgoing_calls` | 同上 | 同上 |
| `web_fetch` | `src/features/websearch/tools.ts:13-37` | 独立 HTTP 请求，天然并发安全 |
| `invoke_skill` | `src/features/skill/tools.ts:18-78` | 纯文件读取，只读 |
| `safe_trash_list` | `src/features/shell/tools-trash.ts`（通过 `src/features/shell/index.ts:151`） | 只读 trash 目录 |

### 5.2 不能标记 `parallelizable`

| 工具 | Feature 源码位置 | 原因 |
|------|-----------------|------|
| `write` | `src/features/opencode-basic/tools.ts:502-567` | 文件写入，同文件竞争 + `@ToolUse` read→write 依赖 |
| `edit` | `src/features/opencode-basic/tools.ts:1006-1096` | read-modify-write，同文件必然竞争（丢失更新） |
| `bash` | `src/features/shell/tools.ts`（createShellCommandTool） | 命令可能有副作用（cd 改 cwd、git commit、npm install） |
| `powershell` | `src/features/shell/powershell.ts` | 同上 |
| `safe_trash_delete` | `src/features/shell/tools-trash.ts` | 写 trash 元数据索引，并发可能竞争 |
| `safe_trash_restore` | `src/features/shell/tools-trash.ts` | 修改 trash 索引 |
| `task_create` | `src/features/todo/tools.ts`（通过 TodoToolFactory） | 自增 counter（`todo/index.ts:261`）+ Map 写入 |
| `task_update` | `src/features/todo/tools.ts` | 修改共享 Map |
| `task_clear` | `src/features/todo/tools.ts` | 销毁全部状态 |
| `task_list` | `src/features/todo/tools.ts` | 虽然只读，但 todo 工具语义上应串行（task_list 通常跟在 task_create 后面） |
| `task_get` | 同上 | 同上 |
| `enter_flow` | `local-features/flow/src/index.ts:183-211` | 状态机写入 `this.activeFlow` |
| `complete_node` | `local-features/flow/src/index.ts:212-274` | 状态机写入 `this.pendingTransition` |
| `exit_flow` | `local-features/flow/src/index.ts:276-292` | 状态机写入 |
| `spawn_agent` | `src/features/subagent/tools.ts:31-` | 创建子进程 + 修改 pool |
| `send_to_agent` | `src/features/subagent/tools.ts` | 发消息到子代理 |
| `close_agent` | `src/features/subagent/tools.ts` | 销毁子代理 |
| `list_agents` | `src/features/subagent/tools.ts` | 虽然只读，但 subagent 工具语义上应串行 |
| `wait` | `src/features/subagent/tools.ts` | 阻塞等待 + `@ToolFinished` 特殊语义（`subagent/index.ts:173-193`） |
| `ask_user_choice` | `src/features/user-input/index.ts:226-286` | UI 交互，必须串行展示 |
| `ask_user_choices` | `src/features/user-input/index.ts:287-` | 同上 |
| `set_checkpoint` | `local-features/checkpoint/src/index.ts:32-73` | 已是 `exclusive`（L72） |
| `rollback_to_checkpoint` | `local-features/checkpoint/src/index.ts:75-` | 已是 `exclusive`（L103） |
| `request_summary_compaction` | `local-features/context-compaction-control/src/index.ts:73-118` | 触发 context 压缩 |
| `request_summary_compaction_resume` | `local-features/context-compaction-control/src/index.ts:119-160` | 同上 |
| `record_compaction_context` | `local-features/context-compaction-control/src/index.ts:161-` | context 交接 |
| `agentdev_*` (6个) | `local-features/agent-dev/src/index.ts:365-` | 工作空间状态写入 |
| `feature-dev-*` (8个) | `local-features/feature-dev/src/index.ts:1086-` | Feature 开发工作流 |
| `capture` (visual) | `src/features/visual/tools.ts` | 截图，可能有 UI 副作用 |
| MCP 工具 (`mcp_*`) | `src/features/mcp/index.ts:178-194` | 安全性取决于具体 MCP 服务器实现，无法预判 |

### 5.3 双路径 feature 注意事项

根据 CLAUDE.md 的 "feature 双路径" 说明，以下 feature 同时存在于 `packages/*` 和 `src/features/*` 两处：

- `shell`：`packages/shell-feature/` + `src/features/shell/`
- `audit`：`packages/audit-feature/` + `src/features/audit/`
- `qqbot`：`packages/qqbot-feature/` + `src/features/qqbot/`
- `websearch`：`packages/websearch-feature/` + `src/features/websearch/`
- 其他（见 CLAUDE.md 3D 节）

如果修改这些 feature 的工具定义（添加 `parallelizable`），**两侧源码都要改，两个构建都要做**。

但 `parallelizable` 只需要在工具定义中加一个属性，影响面极小。

---

## 6. 实施计划

### Phase A：框架核心改造（AgentDev 仓库）

#### A1. 扩展 Tool 接口

**文件**：`src/core/types.ts`

在 `Tool` 接口中添加：

```typescript
// types.ts，Tool 接口内
/**
 * 工具是否可并行执行。
 *
 * - true: 该工具可以与同批次中其他 parallelizable 工具并发执行
 * - false/undefined: 串行执行（默认，向后兼容）
 *
 * 约束：
 * - exclusive 工具忽略此属性（exclusive 总是独占批次）
 * - 标记为 parallelizable 的工具应是无副作用的只读操作，
 *   或其副作用不会与同批次其他工具冲突
 */
parallelizable?: boolean;
```

**文件**：`src/core/tool.ts`

在 `createTool` 的 config 参数类型中添加 `parallelizable?: boolean`（L20-28）。

在 `ToolRegistry` 中添加查询方法：

```typescript
// tool.ts，ToolRegistry 类内
/**
 * 检查工具是否可并行执行
 */
isParallelizable(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.parallelizable === true && tool?.executionMode !== 'exclusive';
}
```

#### A2. 改造 `ToolExecutor.execute()` — 延迟 context 写入

**文件**：`src/core/agent/tool-executor.ts`

当前 `execute()` 返回 `Promise<void>`，在 4 个位置直接写 context。

**改造方式**：

1. 方法签名改为返回 `Promise<ToolExecResult>`（`ToolExecResult` 已在 `context.ts:26-30` 定义）：

```typescript
// tool-executor.ts:56-62 改为：
async execute(
    call: ToolCall,
    input: string,
    context: Context,
    step: number,
    callIndex: number
): Promise<ToolExecResult> {
```

2. 所有 `context.addToolMessage(call, errorResult, callIndex)` + `return` 改为 `return errorResult`：

   - **L116-134**（disabled 工具）：删除 `context.addToolMessage`，改为 `return { success: false, result: { error: result.error } }`
   - **L190-211**（blocked/not-found）：同上
   - **L278-283**（成功）：删除 `context.addToolMessage`，改为 `return { success: true, result: typeof data === 'string' ? data : JSON.stringify(data) }`
   - **L292-297**（异常）：删除 `context.addToolMessage`，改为 `return { success: false, result: { error: result.error } }`

3. 末尾添加 fallback return（确保所有路径都有返回值）。

**注意**：钩子（`onToolUse`、`@ToolUse`、`onToolFinished`、`@ToolFinished`）和通知（`emitNotification`）的调用位置和逻辑完全不变。它们在工具执行的前后正常触发，只是 context 写入被延迟了。

#### A3. 改造 `react-loop.ts` — 两阶段调度 + 统一注入

**文件**：`src/core/agent/react-loop.ts`

##### A3.1 修改 `executeToolFn` 类型

`react-loop.ts` 构造函数中（L56-62）`executeToolFn` 的类型签名：

```typescript
// 当前（L56-62）：
private executeToolFn: (
    call: ToolCall,
    input: string,
    context: Context,
    step: number,
    callIndex: number
) => Promise<void>,

// 改为：
private executeToolFn: (
    call: ToolCall,
    input: string,
    context: Context,
    step: number,
    callIndex: number
) => Promise<ToolExecResult>,
```

同时在 import 中添加 `ToolExecResult`：

```typescript
// react-loop.ts:12 当前：
import type { ToolExecResult } from '../context.js';
// 已存在，无需修改
```

##### A3.2 替换工具执行循环（L284-366）

将当前的串行循环（L315-338）替换为两阶段调度逻辑：

```typescript
// ========== 工具执行 ==========
let waitCalled = false;
let interrupted = false;
let batchRejected = false;

// ========== Exclusive batch pre-check（不变，L289-313）==========
if (response.toolCalls.length > 1) {
    const exclusiveNames = response.toolCalls
        .filter(call => this.agent.tools.isExclusive(call.name))
        .map(call => call.name);
    if (exclusiveNames.length > 0) {
        batchRejected = true;
        // ... 不变的整批拒绝逻辑 ...
    }
}

// ========== 结果收集 Map ==========
const resultsMap = new Map<string, ToolExecResult>();

if (!batchRejected) {
    // ========== 分流 ==========
    const parallelCalls = response.toolCalls.filter(
        call => this.agent.tools.isParallelizable(call.name)
    );
    const serialCalls = response.toolCalls.filter(
        call => !this.agent.tools.isParallelizable(call.name)
    );

    // ========== Phase 1: 并发执行 parallelizable 工具 ==========
    if (parallelCalls.length > 0) {
        // 中断预检查
        if (!signal?.aborted) {
            const parallelResults = await Promise.allSettled(
                parallelCalls.map(call =>
                    this.executeToolFn(call, input, context, step, callIndex)
                )
            );
            parallelCalls.forEach((call, i) => {
                const settled = parallelResults[i];
                if (settled.status === 'fulfilled') {
                    resultsMap.set(call.id, settled.value);
                } else {
                    // 工具执行抛出未捕获异常（理论上 executeToolFn 内部已 catch）
                    const errorMsg = settled.reason instanceof Error
                        ? settled.reason.message : String(settled.reason);
                    resultsMap.set(call.id, {
                        success: false,
                        result: { error: errorMsg },
                    });
                }
            });
        } else {
            // 中断：为所有 parallelizable 工具补齐 interrupted result
            for (const call of parallelCalls) {
                resultsMap.set(call.id, {
                    success: false,
                    result: { error: 'Interrupted by user' },
                });
            }
            interrupted = true;
        }
    }

    // ========== Phase 2: 串行执行剩余工具 ==========
    for (let i = 0; i < serialCalls.length; i++) {
        const call = serialCalls[i];

        if (signal?.aborted) {
            interrupted = true;
            // 为当前及剩余的 serial 工具补齐 interrupted result
            for (let j = i; j < serialCalls.length; j++) {
                resultsMap.set(serialCalls[j].id, {
                    success: false,
                    result: { error: 'Interrupted by user' },
                });
            }
            break;
        }

        if (call.name === 'wait') {
            waitCalled = true;
        }
        const result = await this.executeToolFn(call, input, context, step, callIndex);
        resultsMap.set(call.id, result);
    }
}

// ========== 统一注入：按原始顺序写入 context ==========
for (const call of response.toolCalls) {
    const result = resultsMap.get(call.id);
    if (result) {
        context.addToolMessage(call, result, callIndex);
    } else {
        // batchRejected 时整批已处理，这里不应该到达
        // 但作为安全网：
        context.addToolMessage(call, {
            success: false,
            result: { error: 'Tool result missing (internal error)' },
        }, callIndex);
    }
}
```

##### A3.3 处理 batchRejected 路径

当 `batchRejected = true` 时（exclusive 违规），当前代码在 L303-309 为每个调用直接写 context。这部分逻辑不变——它仍然直接调用 `context.addToolMessage`，因为它在 `!batchRejected` 块之外。

但需要注意：`batchRejected` 路径已经写入了 context，后续的统一注入不应该重复写入。当前的 `if (!batchRejected)` 块包裹了整个执行和注入逻辑，所以 batchRejected 时不会执行注入。**这需要确保统一注入也在 `if (!batchRejected)` 块内，或者在 batchRejected 时跳过注入。**

建议的代码结构：

```typescript
if (batchRejected) {
    // batchRejected 路径：已有 L303-309 的 addToolMessage，不需要额外注入
    this.pushToDebug(context.getAll());
} else {
    // Phase 1 + Phase 2 + 统一注入（上面的代码）
    // ...
    // 统一注入完成后
    this.pushToDebug(context.getAll());
}
```

#### A4. 框架构建与验证

```bash
cd D:/code/AgentDev && npm run build
# 重启 Claw 服务验证
```

### Phase B：标记 parallelizable 工具

#### B1. opencode-basic 工具

**文件**：`src/features/opencode-basic/tools.ts`

在以下 4 个工具的 `createTool` 配置中添加 `parallelizable: true`：

- `createReadTool`（L314）：在 `execute` 之前加 `parallelizable: true,`
- `createGlobTool`（L1221）：同上
- `createGrepTool`（L1317）：同上
- `createLsTool`（L1108）：同上

**不标记**：`createWriteTool`（L503）、`createEditTool`（L1007）

#### B2. LSP 工具

**文件**：`src/features/lsp/index.ts:38-109`

LSP 工具是通过 `operations.map(...)` 批量生成的。在 map 回调返回的对象中添加 `parallelizable: true`：

```typescript
// lsp/index.ts:38
return operations.map(({ name, op, desc }) => ({
    name,
    description: desc,
    parallelizable: true,  // ← 添加
    parameters: { ... },
    async execute(...) { ... },
}));
```

#### B3. websearch 工具

**文件**：`src/features/websearch/tools.ts:14`

在 `createTool` 配置中添加 `parallelizable: true`。

**注意**：websearch 是双路径 feature（`packages/websearch-feature/` + `src/features/websearch/`），两侧都要改。

#### B4. skill 工具

**文件**：`src/features/skill/tools.ts:18`

在 `createTool` 配置中添加 `parallelizable: true`。

#### B5. shell — safe_trash_list

**文件**：`src/features/shell/tools-trash.ts`

仅 `safe_trash_list` 工具添加 `parallelizable: true`。

**注意**：shell 是双路径 feature。

### Phase C：测试

#### C1. 现有测试验证

```bash
# 框架核心测试
cd D:/code/AgentDev && npm test

# 特别关注：
# - src/test/exclusive-tool-batch.test.ts（exclusive 预检不受影响）
# - src/test/continuation-request.test.ts（continuation 不受影响）
```

#### C2. 新增并行执行测试

建议新增 `src/test/parallel-tool-execution.test.ts`，验证：

1. **基本并行**：两个 parallelizable 工具同时执行，结果按原始顺序注入
2. **混合批次**：`[read(parallel), write(serial), grep(parallel)]` — read 和 grep 在 Phase 1 并行，write 在 Phase 2 串行，最终注入顺序为 read, write, grep
3. **全串行回退**：批次中无 parallelizable 工具时，行为与改造前完全一致
4. **中断传播**：Phase 1 中断时，所有 parallelizable 工具收到 interrupted result
5. **hook 正常触发**：parallelizable 工具的 `@ToolUse` 和 `@ToolFinished` 钩子正常触发
6. **exclusive 不受影响**：含 exclusive 工具的批次仍然整批拒绝

#### C3. Claw 侧验证

```bash
cd D:/code/AgentDevClaw
npm run build:local-features
npm run test:features
npm run test:core
```

启动 Claw 服务，在编程助手中让 LLM 同时读取多个文件，验证：
- 工具是否真正并发执行（通过时间戳观察）
- Debug viewer 中结果顺序是否正确
- 中断是否正常工作

---

## 7. API 设计

### 7.1 Tool 接口变更

```typescript
// src/core/types.ts — Tool 接口
interface Tool {
    name: string;
    description: string;
    parameters?: Record<string, any>;
    execute: (args: any, context?: any) => Promise<any>;
    render?: ToolRenderConfig;
    executionMode?: 'normal' | 'exclusive';  // 已有
    parallelizable?: boolean;                 // 新增，默认 false
}
```

### 7.2 `createTool` 变更

```typescript
// src/core/tool.ts:19-28
export function createTool(
    config: {
        name: string;
        description: string;
        parameters?: Record<string, any>;
        execute: (args: any, context?: any) => Promise<any>;
        render?: ToolRenderInput;
        executionMode?: 'normal' | 'exclusive';
        parallelizable?: boolean;  // ← 新增
    },
    sourceFile?: string
): Tool {
    // ... 不变的逻辑 ...
    // parallelizable 属性会自动传递到返回的 Tool 对象
}
```

### 7.3 ToolRegistry 新增方法

```typescript
// src/core/tool.ts — ToolRegistry 类
isParallelizable(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.parallelizable === true && tool?.executionMode !== 'exclusive';
}
```

### 7.4 使用示例

```typescript
// 标记工具为可并行
createTool({
    name: 'read',
    description: '...',
    parameters: { ... },
    execute: async (args) => { ... },
    parallelizable: true,  // ← 新增
});

// 不标记 = 旧行为（串行）
createTool({
    name: 'write',
    description: '...',
    parameters: { ... },
    execute: async (args) => { ... },
    // 无 parallelizable，默认 false
});
```

---

## 8. 不需要改动的部分

以下机制完全不受并行化影响，**不需要任何改动**：

| 机制 | 位置 | 不受影响的原因 |
|------|------|---------------|
| Exclusive 批次预检 | `react-loop.ts:289-313` | 在任何执行之前运行 |
| `@StepFinish` 决策 | `react-loop.ts:368-421` | 在所有工具完成后触发 |
| 正向钩子错误处理 | `hooks-executor.ts` | per-tool 独立 |
| 反向钩子注册表 | `hooks-registry.ts` | 钩子链内部串行，per-tool 独立 |
| Continuation request | `react-loop.ts:351-363` | exclusive 工具独占批次 |
| Step checkpoint/rollback | `checkpoint.ts` | per-step，不涉及 per-tool |
| Session save | `react-loop.ts:456-462` | per-step |
| Notification 系统 | `notification.ts` | event 类别不节流，单线程安全 |
| Debug push | `react-loop.ts:366` | 在注入后调用 |
| 所有 Feature 的 hook 实现 | 各 feature | per-tool 独立决策 |

---

## 9. 实施检查清单

- [ ] A1: `types.ts` 添加 `parallelizable` 到 Tool 接口
- [ ] A1: `tool.ts` 添加 `parallelizable` 到 `createTool` config
- [ ] A1: `tool.ts` 添加 `isParallelizable()` 到 ToolRegistry
- [ ] A2: `tool-executor.ts` — `execute()` 改为返回 `ToolExecResult`
- [ ] A2: `tool-executor.ts` — 删除 4 处 `context.addToolMessage` 调用
- [ ] A2: `tool-executor.ts` — 确保所有路径都有 return
- [ ] A3: `react-loop.ts` — 修改 `executeToolFn` 类型签名
- [ ] A3: `react-loop.ts` — 实现两阶段调度（Phase 1 + Phase 2）
- [ ] A3: `react-loop.ts` — 实现统一结果注入
- [ ] A3: `react-loop.ts` — 处理 batchRejected 与注入的关系
- [ ] A3: `react-loop.ts` — 确保 pushToDebug 在注入之后
- [ ] A4: `AgentDev` 仓库 `npm run build`
- [ ] B1: `opencode-basic/tools.ts` — read/glob/grep/ls 标记 `parallelizable: true`
- [ ] B2: `lsp/index.ts` — 9 个 LSP 工具标记 `parallelizable: true`
- [ ] B3: `websearch/tools.ts` — web_fetch 标记（双路径两侧都改）
- [ ] B4: `skill/tools.ts` — invoke_skill 标记
- [ ] B5: `shell/tools-trash.ts` — safe_trash_list 标记（双路径两侧都改）
- [ ] C1: 运行 `AgentDev` 全部测试
- [ ] C2: 新增并行执行测试
- [ ] C3: Claw 侧验证

---

## 10. 已知限制与未来方向

### 10.1 当前版本的限制

1. **Phase 2 工具看不到 Phase 1 结果**：统一落盘策略意味着 Phase 2 执行时 context 里没有 Phase 1 的结果。当前没有内置 feature 因此受影响，但如果未来有工具需要读取前序工具结果，需要注意。

2. **MCP 工具默认不并行**：MCP Feature 动态加载的外部工具默认不 parallelizable。如果需要，可以后续在 MCP 工具注册时增加配置。

3. **同文件并发写不保护**：如果 LLM 在同一批次中对同一文件调用两次 `edit`（即使 edit 不是 parallelizable，两个 edit 会串行在 Phase 2 执行），第二个 edit 基于第一个 edit 后的文件内容。这是正确的行为。但如果标记了一个不应该被标记的写工具为 parallelizable，则可能产生丢失更新。

4. **`@ToolFinished` 钩子看到略微过时的 context**：parallelizable 工具的 `@ToolFinished` 钩子触发时，同批次其他 parallelizable 工具的结果可能还未注入。对 `plugin-compat` 的 legacy 桥接可能有轻微影响。

### 10.2 未来可选增强

1. **per-feature parallelizable 声明**：允许 Feature 在 `getTools()` 返回时动态决定是否 parallelizable（例如 MCP Feature 根据服务器配置）。

2. **并行度限制**：添加 `maxParallel` 配置，防止一次并发太多工具（例如 10 个 LSP 查询同时打到一个服务器）。

3. **Phase 1 结果预注入**：如果未来有工具需要看到 Phase 1 结果，可以在 Phase 1 完成后先注入 Phase 1 结果（但会打破"完全按原始顺序"的保证）。

---

## 附录 A：完整文件变更清单

| 文件 | 仓库 | 变更类型 | 说明 |
|------|------|---------|------|
| `src/core/types.ts` | AgentDev | 修改 | Tool 接口添加 `parallelizable` 字段 |
| `src/core/tool.ts` | AgentDev | 修改 | createTool config 添加 `parallelizable`；ToolRegistry 添加 `isParallelizable()` |
| `src/core/agent/tool-executor.ts` | AgentDev | **重构** | `execute()` 返回 `ToolExecResult`，删除 4 处 context 写入 |
| `src/core/agent/react-loop.ts` | AgentDev | **重构** | 两阶段调度 + 统一注入 |
| `src/features/opencode-basic/tools.ts` | AgentDev | 修改 | read/glob/grep/ls 添加 `parallelizable: true` |
| `src/features/lsp/index.ts` | AgentDev | 修改 | 9 个 LSP 工具添加 `parallelizable: true` |
| `src/features/websearch/tools.ts` | AgentDev | 修改 | web_fetch 添加 `parallelizable: true` |
| `src/features/websearch/tools.ts` (packages 副本) | AgentDev | 修改 | 双路径同步 |
| `src/features/skill/tools.ts` | AgentDev | 修改 | invoke_skill 添加 `parallelizable: true` |
| `src/features/shell/tools-trash.ts` | AgentDev | 修改 | safe_trash_list 添加 `parallelizable: true` |
| `src/features/shell/tools-trash.ts` (packages 副本) | AgentDev | 修改 | 双路径同步 |
| `src/test/parallel-tool-execution.test.ts` | AgentDev | **新增** | 并行执行测试 |

## 附录 B：关键代码行号速查（改造前）

> 行号基于调研时的文件状态，实施时可能有偏移，请以函数名/变量名定位。

### react-loop.ts

| 行号 | 内容 | 改造涉及 |
|------|------|---------|
| L56-62 | `executeToolFn` 类型签名 | 改返回类型 |
| L284-285 | `let waitCalled = false` | 保留，改计算方式 |
| L289-313 | Exclusive 批次预检 | 不变 |
| L315-338 | 串行工具执行循环 | **替换为两阶段调度** |
| L341-349 | interrupted 检查 | 适配 |
| L351-363 | continuation request 检查 | 不变 |
| L366 | `pushToDebug` | 确保在注入后 |
| L368-421 | StepFinish 决策 | 不变 |

### tool-executor.ts

| 行号 | 内容 | 改造涉及 |
|------|------|---------|
| L56-62 | `execute()` 方法签名 | 改返回类型 |
| L95-135 | disabled 工具处理 | 删除 context 写入，改为 return |
| L141-153 | 正向钩子 onToolUse | 不变 |
| L155-165 | 反向钩子 @ToolUse | 不变 |
| L184-212 | blocked/not-found 处理 | 删除 context 写入，改为 return |
| L214-298 | 工具执行 | 删除 context 写入，改为 return |
| L310-321 | onToolFinished + @ToolFinished | 不变 |

### tool.ts

| 行号 | 内容 | 改造涉及 |
|------|------|---------|
| L19-28 | `createTool` config 类型 | 添加 `parallelizable` |
| L179-184 | `isExclusive()` | 旁边添加 `isParallelizable()` |

### types.ts

| 行号 | 内容 | 改造涉及 |
|------|------|---------|
| L146-151 | `executionMode` 字段 | 旁边添加 `parallelizable` 字段 |
