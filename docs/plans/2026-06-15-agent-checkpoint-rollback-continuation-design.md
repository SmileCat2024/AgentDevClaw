# Agent 自主 Checkpoint、Rollback 与 Continuation 完整设计

> 日期：2026-06-15  
> 状态：调研完成，方案确认，尚未实现  
> 涉及仓库：`AgentDev`、`AgentDevClaw`  
> 核心目标：允许 Agent 自主建立检查点，在失败探索后携带摘要回退，并在不依赖用户操作的情况下继续执行

---

## 1. 文档目的

本文档完整记录以下内容：

1. 最初提出的产品需求。
2. 对 AgentDev、AgentDevClaw 当前实现的源码调查结果。
3. 讨论过程中考虑过的不同方案及其问题。
4. 对早期判断的修正。
5. 最终确认的控制流与工程契约。
6. 队列、持久化、前端渲染、Feature 状态和外部副作用等制约因素。
7. 后续实现时必须满足的验证条件。

本文档不是实现记录，也不表示当前框架已经支持该能力。它是后续设计、开发和评审的基线。

---

## 2. 原始需求

最初需求是设计一个名为 `checkpoint` 的 Feature，使 Agent 可以自主完成以下过程：

1. Agent 在会话运行到某个位置时调用工具建立检查点。
2. Agent 继续探索、调用工具和推理。
3. 如果后续进行了较长但失败的探索，Agent 可以主动调用另一个工具请求回退。
4. 回退请求包含一个 `summary` 字段，由 Agent 概括从上一个检查点到当前发生的事情、尝试过的方法和失败原因。
5. 系统恢复到检查点。
6. 被丢弃分支的原始消息不再参与后续上下文。
7. `summary` 被注入恢复后的上下文。
8. Agent 在检查点基础上继续执行，不依赖用户确认、重新输入或其他手工操作。

同时需要确认：

- 能否尽量复用现有 user input rollback 经验。
- 是否能保持 AgentDev 现有架构的简洁性。
- 前端能否正确显示消息减少、回退和续跑。
- 改造难度和影响面是否可控。
- 回退过程中到达的新用户消息、IM 消息和 dispatch 消息应如何处理。

需求明确不包括：

- 当前阶段直接实现该 Feature。
- 承诺撤销文件、网络请求、Shell 命令等外部副作用。
- 依赖用户执行任何恢复操作。

---

## 3. 需求中的关键语义

### 3.1 Agent 自主

检查点建立、失败判断、摘要生成、回退请求和恢复后的续跑都由 Agent 发起。

用户不需要：

- 点击回退按钮。
- 编辑历史输入。
- 再次提交 summary。
- 手工唤醒 Agent。

### 3.2 回退的是上下文分支

目标不是单纯删除前端消息，而是恢复：

- Context。
- Agent call index。
- 支持快照的 Feature 内存状态。
- rollback history。
- 与会话快照相关的运行时状态。

### 3.3 保留失败分支中的知识

失败分支本身被丢弃，但 Agent 生成的 summary 被带回新分支。

因此它不是简单 undo，而是：

```text
恢复历史状态 + 携带被丢弃分支的压缩经验 + 继续执行
```

### 3.4 保持原外部请求未完成

如果一次用户消息触发了任务，期间发生 checkpoint 和 rollback，那么从用户、IM 或 dispatch 调用方的角度，这仍应当是一项尚未完成的工作。

它不应因为某个内部 `onCall` 段结束，就提前返回半成品结果。

---

## 4. 当前架构调查结果

## 4.1 Agent `onCall`

AgentDev 的公开执行入口是：

```ts
agent.onCall(input): Promise<string>
```

当前 `onCall` 会：

1. 创建或复用 persistent Context。
2. 增加 `_callIndex`。
3. 捕获 pre-call runtime snapshot。
4. 注入用户输入。
5. 执行 ReAct 循环。
6. 保存 Context。
7. 提交 call rollback checkpoint。
8. 执行 CallFinish 生命周期。
9. 清理 `_currentCallInput` 等运行状态。

关键代码：

- `D:/code/AgentDev/src/core/agent.ts:203`
- `D:/code/AgentDev/src/core/agent.ts:283`
- `D:/code/AgentDev/src/core/agent.ts:310`
- `D:/code/AgentDev/src/core/agent.ts:314`
- `D:/code/AgentDev/src/core/agent.ts:415`

### 调查结论

`onCall` 是一个完整的运行边界。只要等它彻底退出，再恢复 runtime，就不会存在旧 ReAct 栈继续持有和写入旧 Context 的问题。

---

## 4.2 现有 call rollback

AgentDev 已提供：

```ts
agent.rollbackToCall(callIndex)
```

它会：

1. 查找目标 call checkpoint。
2. 恢复 runtime snapshot。
3. 删除目标之后的 rollback checkpoints。
4. 向调试器推送恢复后的 Context。
5. 返回目标 call 的 `draftInput`。

关键代码：

- `D:/code/AgentDev/src/core/agent.ts:584`
- `D:/code/AgentDev/src/core/agent.ts:591`
- `D:/code/AgentDev/src/core/agent.ts:592`

现有 user input rollback 正是在 Agent 空闲时调用该 API，然后把 draft 交还给用户编辑。

### 调查结论

现有 rollback 机制本身适合作为 checkpoint 恢复的基础，但当前 checkpoint 索引语义面向“回到某个用户 call 之前”，而不是面向 Agent 自主建立的命名检查点。需要在其上增加稳定映射或命名快照层。

---

## 4.3 Step checkpoint

ReAct 循环在每个 step 开始时创建 StepCheckpoint。发生非中断异常时会恢复：

- Context snapshot。
- 实现了 `captureState()` 和 `restoreState()` 的 Feature 状态。

关键代码：

- `D:/code/AgentDev/src/core/agent/react-loop.ts:94`
- `D:/code/AgentDev/src/core/agent/react-loop.ts:367`
- `D:/code/AgentDev/src/core/checkpoint.ts`

### 调查结论

StepCheckpoint 证明框架已有“Context + Feature state”的恢复模型，但它适用于异常恢复，不适合直接承担跨多个推理步骤、由 Agent 主动触发的分支跳转。

---

## 4.4 ToolExecutor

当前工具执行流程是：

1. 执行 ToolUse hooks。
2. 调用 `tool.execute()`。
3. 将返回值无条件写成 tool result。
4. 将异常捕获并转换为失败 tool result。
5. 执行 ToolFinished hooks。

关键代码：

- `D:/code/AgentDev/src/core/agent/tool-executor.ts:43`
- `D:/code/AgentDev/src/core/agent/tool-executor.ts:228`
- `D:/code/AgentDev/src/core/agent/tool-executor.ts:233`
- `D:/code/AgentDev/src/core/agent/tool-executor.ts:240`

### 调查结论

控制工具不能依赖抛异常表达 rollback，因为异常会被 ToolExecutor 吞掉并转换为普通失败结果。

控制工具应当：

1. 正常完成。
2. 写入协议合法的 tool result。
3. 通过一个窄的运行时契约登记 continuation request。
4. 让 ReAct 循环在工具批次结束后停止当前 `onCall`。

---

## 4.5 CallArbiter

AgentDevClaw runtime 已有 `CallArbiter`，所有主要输入来源通过它串行进入 `agent.onCall()`：

- viewer input。
- queued input。
- dispatch。
- 动态挂载的 QQ/微信 carrier。

关键代码：

- `D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:250`
- `D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:268`
- `D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:344`

当前完成流程是：

```text
onCall settle
→ active=false
→ emit callFinished
→ resolve waitForCompletion
→ activeEnvelope=null
→ kick 下一条队列消息
```

关键代码：

- `D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:377`

### 已确认的问题

`callFinished` listener 是同步触发的，但 listener 返回的 Promise 不会被等待。现有 session save listener 也是 fire-and-forget。

因此如果在普通 `callFinished` listener 里做：

```text
rollback → save → enqueue continuation
```

下一条外部消息可能已经开始执行，产生：

- rollback 与新 call 并发。
- save 与新 Context 写入并发。
- continuation 被外部消息插队。
- 原 envelope 提前 resolve。
- IM 或 dispatch 提前收到中间结果。

### 调查结论

checkpoint continuation 必须成为 Arbiter 主执行路径的一部分，不能仅通过普通完成监听器拼接。

---

## 4.6 排队输入

ViewerWorker 保存 queued inputs，并在 Claw transport 下转发给 runtime 的 queued input handler。

Claw runtime 将其转换为 CallArbiter envelope。

关键代码：

- `D:/code/AgentDev/src/core/viewer-worker.ts:1062`
- `D:/code/AgentDev/src/core/viewer-worker.ts:1090`
- `D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:1074`

在 Arbiter queue 模式下，ReAct 自身的 step-level dequeue 被 ViewerWorker 禁用，避免同一消息既进入 Arbiter 又被活跃 ReAct step 注入。

关键代码：

- `D:/code/AgentDev/src/core/viewer-worker.ts:1144`
- `D:/code/AgentDev/src/core/agent/react-loop.ts:416`

### 调查结论

现有队列可以继续使用。checkpoint 期间到达的新消息应正常入队，但必须等当前逻辑 envelope 的所有 continuation segments 完成后才能执行。

---

## 4.7 前端消息回退

AgentDevClaw 前端轮询完整消息数组：

- 消息增加时增量追加。
- 消息减少时完整重建。
- 消息数量相同但最后一条变化时更新最后一条。

关键代码：

- `D:/code/AgentDevClaw/public/src/app-main.js:4534`
- `D:/code/AgentDevClaw/public/src/app-main.js:4546`

### 调查结论

rollback 后只要后端推送恢复后的完整 Context，Claw 前端可以正确处理消息数量减少。

仍有两个显示层问题：

1. summary continuation 如果使用普通 user role，会显示为普通用户消息。
2. 每个物理 `onCall` 都发送 call.start/call.finish，内部续跑时状态栏可能短暂闪为 completed。

这两个问题不影响数据正确性，但最终体验可能需要专用 metadata、渲染或逻辑 envelope 级 runtime 状态。

---

## 5. 讨论过的方案及结论

## 5.1 方案 A：工具内部直接调用 `rollbackToCall`

### 思路

`rollback_to_checkpoint` 工具执行时直接恢复 runtime，然后 ToolExecutor 和 ReAct 循环继续运行。

### 问题

当前 `onCall` 和 ReActRunner 持有局部变量 `context`。`rollbackToCall()` 会替换 `persistentContext`，但旧执行栈仍持有原 Context。

随后可能发生：

1. rollback 恢复了新 `persistentContext`。
2. ToolExecutor 向旧 Context 写 tool result。
3. ReActRunner继续使用旧 Context。
4. `onCall` 收尾阶段再次执行 `this.persistentContext = context`。
5. 已恢复的 Context 被旧分支覆盖。

### 结论

在现有结构下不可靠，不采用。

---

## 5.2 方案 B：ReAct 内部 Context Transition

### 思路

ToolExecutor 返回特殊 union result。ReActRunner 识别 transition，在同一个 `onCall` 内原地执行：

```text
restore Context → 注入 summary → continue loop
```

### 优点

- 控制流集中。
- 无需退出 `onCall`。
- 理论上可以保持同一个 call。

### 经进一步审查发现的风险

1. 多工具批次可能产生不完整的 tool call/tool result 配对。
2. 固定 `maxTurns` 已被失败分支消耗，恢复后可能没有剩余步数。
3. Feature restore 不是事务性的，可能部分恢复。
4. 跨 call checkpoint 会产生 call index、输入和 rollback history 的混合时间线。
5. ReAct、ToolExecutor 和 Context 都需要理解 transition，影响核心执行层。
6. OpenAI 历史 tool call 编译兼容性需要同步处理。

### 结论

可实现，但核心层耦合和证明成本较高。不是最终优先方案。

---

## 5.3 方案 C：结束当前 `onCall`，宿主恢复后发起普通新消息

### 思路

控制工具让当前 `onCall` 结束。`callFinished` 后执行 rollback，再把 summary 作为一条高优先级消息重新入队。

### 问题

如果 continuation 是普通 queue entry：

- 原 envelope 已完成。
- IM/dispatch 可能收到中间结果。
- 新外部消息可能插队。
- continuation 和外部消息的顺序依赖队列操作细节。
- 保存、恢复和下一条消息可能并发。

即使使用 `queue.unshift()`，它仍然把一个逻辑任务拆成多个独立外部请求，调用方语义错误。

### 结论

不采用“普通高优先级队列消息”模型。

---

## 5.4 最终方案：逻辑 Envelope 内的连续 `onCall` Segments

### 核心思想

一个外部 envelope 可以由多个顺序执行的物理 `onCall` segment 组成。

```text
External Envelope E1
  ├─ onCall segment A
  ├─ checkpoint barrier
  ├─ onCall segment B
  ├─ onCall segment C
  ├─ rollback barrier
  ├─ onCall segment D
  └─ final completion
```

在 E1 完成之前：

- Arbiter 始终保留 E1 为 active envelope。
- 外部 queue 不出队。
- E1 的 completion waiter 不 resolve。
- 不发送最终 IM/dispatch 结果。

### 重要澄清

这不是在活跃 `onCall` 内递归调用另一个 `onCall`。

错误模型：

```text
onCall A
  └─ onCall B
```

正确模型：

```text
await onCall A 完全退出
await apply control barrier
await onCall B 完全退出
```

所谓“子 call”只是一种产品理解。实现上应称为 continuation segment，避免产生递归和父子栈的误解。

---

## 6. 最终方案的三个契约

## 6.1 契约一：Exclusive Tool Batch

checkpoint 和 rollback 属于控制工具，必须独占一次 assistant tool call 批次。

建议 Tool 增加：

```ts
interface Tool {
  name: string;
  description: string;
  executionMode?: 'normal' | 'exclusive';
}
```

这里推荐 `exclusive`，不推荐 `unique`：

- `unique` 容易被理解为全局唯一、注册唯一或名称唯一。
- `exclusive` 清楚表达“独占当前工具调用批次”。

### 校验规则

在执行任何工具之前，先检查完整 tool calls batch：

```ts
const hasExclusive = calls.some(call => isExclusive(call.name));

if (hasExclusive && calls.length !== 1) {
  rejectEntireBatch();
}
```

### 失败行为

如果一个批次包含 exclusive 工具和其他工具：

1. 一个工具都不能执行。
2. 不产生任何外部副作用。
3. 为批次中每个 tool call 补齐失败 tool result。
4. 告知模型 exclusive 工具必须单独调用。
5. ReAct 可以继续下一步，让模型自行纠正。

示例错误：

```text
The checkpoint control tool must be the only tool call in this assistant turn.
No tool in this batch was executed. Retry with only checkpoint.
```

### 为什么必须整批预检

不能按顺序执行：

```text
普通工具执行成功
→ 遇到 exclusive 工具
→ 才报错
```

因为普通工具可能已经修改文件、发送请求或产生其他不可撤销副作用。

---

## 6.2 契约二：Call Boundary / Continuation Request

控制工具不直接回退 Context，只登记一个受类型约束的请求：

```ts
type CallContinuationRequest =
  | {
      kind: 'checkpoint';
      checkpointId: string;
    }
  | {
      kind: 'rollback';
      checkpointId: string;
      summary: string;
    };
```

当前物理 `onCall` 在控制工具写入正常 tool result 后，于合法边界停止。

### 推荐结果模型

内部执行 API 可以返回：

```ts
type CallOutcome =
  | {
      kind: 'completed';
      response: string;
      completed: boolean;
    }
  | {
      kind: 'continuation';
      response: string;
      request: CallContinuationRequest;
    };
```

为了兼容现有 `onCall(): Promise<string>`，可以有两种实现：

#### 方式一：新增内部执行 API

```ts
agent.runCallSegment(input): Promise<CallOutcome>
agent.onCall(input): Promise<string>
```

普通调用者继续使用 `onCall`。理解 continuation 的宿主使用 `runCallSegment`。

#### 方式二：结果外置读取

`onCall` 仍返回 string，但 Arbiter 在返回后原子读取：

```ts
agent.consumeContinuationRequest()
```

该读取必须满足：

- 请求只能消费一次。
- 请求与刚结束的 call 绑定。
- 不能被下一次 call 覆盖。
- call 异常时不会遗留陈旧请求。

### 推荐判断

结构化 `CallOutcome` 更清楚、更容易测试；外置读取改动更小，但需要严格防止陈旧状态。实现时应优先评估兼容成本，而不是仅以改动行数决定。

---

## 6.3 契约三：Logical Envelope Ownership

CallArbiter 不再把“一次 `agent.onCall()` 返回”等同于“envelope 完成”。

建议主循环概念如下：

```ts
async function executeEnvelope(envelope) {
  let segmentInput = envelope.text;

  while (true) {
    const outcome = await agent.runCallSegment(segmentInput);

    if (outcome.kind === 'completed') {
      await commitFinalState(envelope, outcome);
      return outcome.response;
    }

    segmentInput = await applyContinuationBarrier(
      envelope,
      outcome.request,
    );
  }
}
```

Arbiter 的外层队列逻辑保持：

```ts
activeEnvelope = dequeue();
await executeEnvelope(activeEnvelope);
resolveEnvelope(activeEnvelope);
activeEnvelope = null;
kickNextEnvelope();
```

### 强约束

在 `executeEnvelope()` 返回之前：

- `_active` 必须保持 true。
- `_activeEnvelope` 必须保持原 envelope。
- `_queue` 中的外部消息保持 FIFO。
- `waitForCompletion(envelope.id)` 不得 resolve。
- `callFinished` 的外部完成语义不得触发。
- IM/dispatch 最终响应不得发送。

---

## 7. Checkpoint 完整时序

假设用户消息形成 envelope `E1`。

## 7.1 Segment A

Agent 正常执行：

```text
user task
assistant reasoning
assistant → checkpoint({ checkpointId: "cp-1" })
tool → checkpoint boundary requested
```

checkpoint 必须是该批次唯一工具。

## 7.2 当前 call 结束

控制工具执行成功后：

1. ToolExecutor 写入正常 tool result。
2. ReActRunner 识别已登记 continuation request。
3. 不再请求下一次 LLM。
4. 当前 `onCall` 正常执行 CallFinish。
5. 当前 `onCall` 的 `finally` 完成。
6. Agent 已处于 idle 状态。

## 7.3 建立恢复边界

Arbiter 进入 checkpoint barrier：

1. 生成或定位 checkpoint runtime snapshot。
2. 将 checkpointId 映射到稳定恢复目标。
3. 更新 rollback history。
4. 保存 session。
5. 确认保存成功。
6. 推送必要的调试状态。

只有上述步骤成功后，checkpoint 才算 committed。

## 7.4 内部续跑

Arbiter 为同一个 E1 启动下一个 segment，输入可为：

```text
[Internal checkpoint continuation]

Checkpoint "cp-1" has been committed.
Continue the current task from this point.
```

该 segment：

- 不进入外部 queue。
- 不创建新 envelope。
- 不提前完成 E1。
- 优先于所有已排队外部消息。

---

## 8. Rollback 完整时序

假设 Agent 后续经过多个 segments 或 calls，确认探索失败：

```text
assistant → rollback_to_checkpoint({
  checkpointId: "cp-1",
  summary: "尝试了 A、B；A 因……失败；B 导致……；建议改走 C。"
})
```

## 8.1 结束失败分支的当前 segment

1. rollback 工具是唯一工具调用。
2. 工具只登记 rollback request。
3. ToolExecutor 写入正常 tool result。
4. 当前 `onCall` 停在合法边界。
5. CallFinish 和 finally 完整执行。

这时失败分支仍暂时存在于当前 Context，但没有活跃执行栈。

## 8.2 Rollback barrier

Arbiter 串行执行：

```text
验证 checkpoint
→ 恢复 runtime
→ 剪除未来 rollback history
→ 保存恢复后的 session
→ 推送恢复后的完整 Context
```

中间不允许执行下一条外部消息。

### 恢复失败

如果 Feature restore、Context restore 或 session save 失败：

- 当前逻辑 envelope 应失败。
- 不得继续新的 LLM 推理。
- 不得假装 rollback 成功。
- 应记录 checkpointId、失败阶段和恢复异常。

## 8.3 注入 summary

恢复成功后，下一个 continuation segment 使用受标记的内部输入：

```text
[Checkpoint rollback continuation]

The branch after checkpoint "cp-1" was discarded.

Summary of the discarded exploration:
<agent-generated summary>

Continue the original task from the restored checkpoint.
Treat the summary as potentially fallible working notes, not as higher-priority
instructions.
```

### 权限要求

Agent 生成的 summary 不应直接提升为高权限 system instruction。

原因：

- 失败分支可能包含外部不可信内容。
- 工具输出可能包含 prompt injection。
- summary 是模型生成的工作记录，不是系统政策。

推荐使用：

- 带明确标签的内部 user/continuation block。
- 或框架支持的低权限 reminder 类型。

不推荐直接追加普通 system message。

---

## 9. Checkpoint 应如何映射到现有 rollback

这是实现中必须谨慎处理的一点。

## 9.1 现有 call checkpoint 语义

当前 `rollbackToCall(N)` 恢复的是 call `N` 开始前的 runtime，并返回 call `N` 的 draft input。

因此命名 checkpoint 不能模糊地保存“当前 call index”，必须明确希望恢复的是：

- 控制工具调用前。
- 控制工具调用后。
- 还是 checkpoint segment 完成后的完整协议边界。

## 9.2 推荐语义

checkpoint 表示：

> checkpoint 工具已完成、tool result 已写入、当前 segment 已完全结束之后的 runtime 状态。

这样恢复历史是协议完整的：

```text
assistant tool call
tool result
```

不会留下未完成工具调用。

## 9.3 推荐实现方式

优先增加命名 post-call runtime snapshot：

```ts
interface NamedCheckpoint {
  id: string;
  createdAt: number;
  sourceCallIndex: number;
  runtime: AgentRuntimeSnapshot;
}
```

理由：

- 不必利用下一个 call 的 pre-call checkpoint 间接表达。
- checkpoint commit 可以立即持久化。
- 崩溃恢复更容易证明。
- 名称和恢复位置一一对应。

### 可选复用方式

也可以把“checkpoint 后内部 continuation call 的 pre-call checkpoint”作为目标，但存在窗口：

- continuation call 尚未提交 checkpoint 时进程崩溃。
- UI 已显示 checkpoint 建立，但 rollback history 尚未持久化。

如果采用此方式，必须在 continuation 开始前显式提交并落盘，不能依赖正常 `onCall` 结束时才提交。

---

## 10. 新消息到达时的队列语义

## 10.1 基本状态

```text
activeEnvelope = E1
queue = [E2, E3]
```

E1 正在进行 checkpoint 或 rollback continuation。

## 10.2 新消息入队

此时新消息 E4 到达：

```text
activeEnvelope = E1
queue = [E2, E3, E4]
```

它可以正常进入队列并在前端显示为 pending，但不得进入 Agent Context。

## 10.3 E1 内部续跑

```text
E1 segment A
E1 checkpoint barrier
E1 segment B
E1 rollback barrier
E1 segment C
```

整个过程 queue 保持冻结：

```text
queue = [E2, E3, E4]
```

## 10.4 E1 最终完成

只有 E1 真正完成后：

```text
resolve E1
deliver final result
activeEnvelope = null
dequeue E2
```

### 不采用的行为

- 不将 continuation `unshift()` 到普通 queue。
- 不清空 E2、E3、E4。
- 不把 E2 注入 E1 的 Context。
- 不允许 E2 在 rollback 和 summary 注入之间执行。
- 不在 checkpoint segment 结束时 resolve E1。

---

## 11. IM、Dispatch 与 Viewer 的完成语义

## 11.1 Viewer input

Viewer 发起的原输入对应 E1。

checkpoint/rollback 期间：

- 输入框可以继续接受 queued input。
- E1 保持 running。
- queued bubbles 保持 pending。
- E1 完成后才重新挂出正常下一轮交互状态。

## 11.2 IM

IM carrier 当前等待：

```ts
waitForCompletion(envelope.id)
```

因此只要 envelope 不提前完成：

- checkpoint 不会触发中间回复。
- rollback 不会触发中间回复。
- IM 最终只收到 E1 的最终结果。

如果产品未来希望报告“已建立检查点”等进度，应走独立 progress notification，而不是伪装成 call completion。

## 11.3 Dispatch

Dispatch 同样等待 envelope 完成后调用 `/dispatch/respond`。

因此：

- 内部 segment 不应产生独立 dispatch response。
- dispatch watchdog 需要考虑长任务和多次 continuation 的总耗时。
- checkpoint 不应重置 schedule identity。

---

## 12. 持久化与崩溃一致性

## 12.1 当前风险

现有 `callFinished` session save 是异步 fire-and-forget，Arbiter 不等待它。

checkpoint/rollback 不能复用这种宽松语义，因为恢复边界必须可证明。

## 12.2 Checkpoint commit 顺序

推荐：

```text
segment 完整退出
→ 捕获命名 runtime snapshot
→ 更新 checkpoint registry
→ saveSession 并等待完成
→ 标记 checkpoint committed
→ 启动 continuation segment
```

如果 save 失败：

- checkpoint 不算建立。
- 不应告诉模型 checkpoint 已可靠建立。
- 当前 envelope 应失败或进入明确的恢复策略。

## 12.3 Rollback commit 顺序

推荐：

```text
segment 完整退出
→ restore checkpoint
→ prune discarded future checkpoints
→ saveSession 并等待完成
→ push restored Context
→ 启动 summary continuation
```

如果保存恢复状态失败，不应继续 summary segment。否则内存时间线与磁盘时间线不一致，进程崩溃后会重新出现已丢弃分支。

## 12.4 原子性边界

文件型 SessionStore 当前没有数据库事务。这里的“事务屏障”是控制流意义上的：

- 恢复期间不允许其他 call 运行。
- 后续 segment 必须等待保存。
- 失败时停止继续推进。

它不代表对进程崩溃具有真正原子写保证。

如需进一步加强，可使用：

```text
写临时文件 → fsync/close → 原子 rename
```

但这属于 SessionStore hardening，不是 checkpoint 第一版的必要前提。

---

## 13. Feature 状态恢复的限制

只有同时实现以下方法的 Feature 才会进入快照：

```ts
captureState()
restoreState()
```

## 13.1 非事务恢复

当前多个 Feature 按顺序恢复。如果中间 Feature 失败：

- 前面的 Feature 可能已经恢复。
- 后面的 Feature 尚未恢复。
- runtime 处于混合状态。

因此 rollback barrier 必须 fail closed，不能在 restore 异常后继续 Agent 推理。

长期可考虑：

- 恢复前捕获 compensation snapshot。
- 失败时尝试恢复 compensation snapshot。
- 或让 restoreFeatureSnapshots 提供事务性两阶段接口。

## 13.2 SubAgent

SubAgent restore 会关闭现有 child agents 并清理 pending 状态。

它不能恢复：

- 子进程的真实执行栈。
- 已经进行到一半的外部工作。
- 子 Agent 未落入快照的临时状态。

因此 checkpoint 文案不能承诺“恢复所有子代理到原执行位置”。

## 13.3 FileHistory

FileHistory 的 `restoreState` 主要恢复内存中的历史元数据，不自动把工作区文件回退到旧内容。

文件实际回退需要显式 rewind 机制。

---

## 14. 外部副作用边界

Context rollback 不等于世界状态 rollback。

以下副作用默认不会被撤销：

- 文件写入。
- Git 操作。
- Shell 命令。
- 数据库修改。
- HTTP 请求。
- 创建 issue、PR、工单。
- 发送邮件或 IM。
- MCP 服务端状态变化。
- 已启动的外部进程。

## 14.1 产品语义

checkpoint 第一版应明确描述为：

> 对 Agent 会话上下文和可快照 Feature 状态建立恢复点。

而不是：

> 对 Agent 做过的一切建立完整事务快照。

## 14.2 Agent 行为约束

工具说明和系统提示应提醒 Agent：

- 在 checkpoint 后优先进行只读探索。
- rollback 前 summary 应记录已经产生的外部副作用。
- 恢复后不得假设外部操作已撤销。
- 必要时主动检查文件、Git、远端资源的真实状态。

---

## 15. Step 预算与循环保护

## 15.1 为什么 segment 方案改善了 maxTurns 问题

原地 Context Transition 继续使用同一个 ReAct loop，会消耗同一个固定 `maxTurns`。

最终方案每个 continuation 都启动新的完整 `onCall` segment，因此每个 segment 有新的 ReAct step budget。

## 15.2 新风险

Agent 可能循环：

```text
checkpoint
→ 探索
→ rollback
→ checkpoint
→ 探索
→ rollback
```

虽然每个 segment 都有限，但逻辑 envelope 可以无限延长。

## 15.3 必须增加的 envelope 级限制

建议至少包含：

```ts
interface ContinuationBudget {
  maxSegments: number;
  maxCheckpoints: number;
  maxRollbacks: number;
  maxElapsedMs?: number;
}
```

超过限制时：

- 终止逻辑 envelope。
- 返回明确错误。
- 不继续自动恢复。
- 保留最后一个一致的持久化状态。

还应防止：

- rollback 到同一个 checkpoint 后立刻再次提交相同 summary。
- checkpointId 冲突。
- rollback 到已被剪除或不属于当前 envelope/session 的 checkpoint。

---

## 16. 前端渲染与运行状态

## 16.1 消息回退

Claw 前端已支持消息数量减少后完整重建，因此恢复后的历史可以正确显示。

用户将看到：

1. 失败探索消息曾经出现。
2. rollback 后这些消息从当前会话消失。
3. summary continuation 出现在恢复后的分支。
4. Agent 继续输出。

这是正确的当前时间线表达。

## 16.2 Summary 的显示

第一版可以把 summary continuation 作为普通 user message 注入，但会让界面看起来像用户发送了这段话。

更好的长期方案：

- Message 增加 `source: 'checkpoint-continuation'`。
- 前端以“恢复记录”或“内部续跑”样式显示。
- 它仍以低权限 user/reminder 语义发送给 LLM。

显示样式与 LLM role 不必完全绑定。

## 16.3 Runtime 状态闪烁

物理 segment A 结束时，Agent 会发送 `call.finish`；segment B 开始时又发送 `call.start`。

如果前端只看物理 call，可能出现：

```text
running → completed → running
```

推荐让 Claw runtime 对外暴露逻辑 envelope 状态：

```text
running
checkpointing
rolling_back
continuing
completed
failed
```

在 active envelope 未结束时，物理 `call.finish` 不应把整体 UI 切到真正 idle。

这可以由宿主状态覆盖完成，无需让 AgentDev 的每个普通调用者理解 envelope。

## 16.4 调试消息推送顺序

Claw transport 的 message push 当前是异步 fire-and-forget。rollback 会在短时间内发送：

```text
失败分支完整消息
→ 恢复后的较短消息
→ summary continuation 消息
```

并发 HTTP push 理论上可能乱序。

为了稳定显示，建议：

- 对每个 agent 的 push 串行化。
- 或给消息快照增加单调递增 revision。
- 前端拒绝旧 revision 覆盖新 revision。

---

## 17. Provider 与消息协议约束

## 17.1 工具调用必须闭合

恢复点不能留下：

```text
assistant(toolCalls)
```

却没有对应：

```text
tool(toolCallId)
```

这也是控制工具必须正常返回 tool result、并在工具批次完成后才结束 call 的原因。

## 17.2 多工具批次

exclusive batch 规则不是体验优化，而是消息协议和副作用安全条件。

## 17.3 OpenAI 历史 tool calls

调查中发现 OpenAI compiler 对历史 assistant `toolCalls` 的重放能力需要单独验证和修正。

checkpoint 会让工具历史跨多个物理 calls 被重新发送给模型，因此实现前必须增加跨 provider 测试：

- Anthropic。
- OpenAI compatible。
- 至少一个实际使用的兼容服务。

---

## 18. 推荐的 Feature 边界

CheckpointFeature 适合负责：

- 注册 `checkpoint` 工具。
- 注册 `rollback_to_checkpoint` 工具。
- 保存 Feature 自己的命名 checkpoint metadata。
- 提供工具说明和渲染模板。
- 通过注入器访问受限的 continuation request sink。
- 必要的 captureState/restoreState。

CheckpointFeature 不应负责：

- 自己递归调用 `agent.onCall()`。
- 自己操作 CallArbiter queue。
- 在工具 execute 中直接恢复 Agent runtime。
- 自己完成 session save。
- 自己向 IM 或 dispatch 返回最终结果。

这些职责属于：

- Agent 核心：合法结束一个 call segment。
- Runtime/Arbiter：跨 segment 调度、恢复屏障和 envelope 完成。
- SessionStore：持久化。

---

## 19. 推荐接口草案

以下仅用于明确职责，不是最终 API 承诺。

## 19.1 Tool

```ts
interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  executionMode?: 'normal' | 'exclusive';
  execute(args: unknown, context?: unknown): Promise<unknown>;
}
```

## 19.2 Continuation request

```ts
type CallContinuationRequest =
  | {
      kind: 'checkpoint';
      checkpointId: string;
    }
  | {
      kind: 'rollback';
      checkpointId: string;
      summary: string;
    };
```

## 19.3 Segment outcome

```ts
type CallSegmentOutcome =
  | {
      kind: 'completed';
      response: string;
      completed: boolean;
      turns: number;
    }
  | {
      kind: 'continuation';
      response: string;
      completed: false;
      turns: number;
      request: CallContinuationRequest;
    };
```

## 19.4 Named checkpoint

```ts
interface NamedCheckpoint {
  id: string;
  envelopeId: string;
  createdAt: number;
  sourceCallIndex: number;
  runtime: AgentRuntimeSnapshot;
}
```

## 19.5 Arbiter envelope extensions

```ts
interface CallEnvelope {
  id: string;
  source: string;
  text: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  segmentCount: number;
  checkpointCount: number;
  rollbackCount: number;
  result: string | null;
  error: string | null;
}
```

---

## 20. 推荐 Arbiter 伪代码

```ts
async function runEnvelope(envelope) {
  envelope.status = 'running';
  let input = envelope.text;

  while (true) {
    assertWithinContinuationBudget(envelope);

    const outcome = await agent.runCallSegment(input);
    envelope.segmentCount += 1;

    if (outcome.kind === 'completed') {
      await saveFinalSession();
      envelope.result = outcome.response;
      envelope.status = 'completed';
      return;
    }

    if (outcome.request.kind === 'checkpoint') {
      envelope.checkpointCount += 1;

      await checkpointBarrier({
        checkpointId: outcome.request.checkpointId,
        envelopeId: envelope.id,
      });

      input = buildCheckpointContinuation(outcome.request);
      continue;
    }

    envelope.rollbackCount += 1;

    await rollbackBarrier({
      checkpointId: outcome.request.checkpointId,
      envelopeId: envelope.id,
    });

    input = buildRollbackContinuation(outcome.request);
  }
}
```

外层：

```ts
async function kick() {
  if (activeEnvelope || queue.length === 0) return;

  activeEnvelope = queue.shift();
  active = true;

  try {
    await runEnvelope(activeEnvelope);
  } catch (error) {
    activeEnvelope.status = 'failed';
    activeEnvelope.error = normalizeError(error);
  } finally {
    await emitLogicalCallFinished(activeEnvelope);
    resolveCompletionWaiter(activeEnvelope);
    activeEnvelope = null;
    active = false;
    kick();
  }
}
```

### 关键区别

只有 `runEnvelope()` 完成后才执行：

- logical callFinished。
- waiter resolve。
- IM/dispatch final delivery。
- 下一条 queue 消费。

物理 segment finish 只能用于内部观测，不能再等价于外部请求完成。

---

## 21. 错误处理矩阵

| 阶段 | 失败 | 必须行为 |
|---|---|---|
| exclusive batch 校验 | 与其他工具混用 | 全批次不执行，补齐失败结果，让模型重试 |
| checkpoint tool | 参数无效 | 普通失败 tool result，不进入 continuation |
| checkpoint snapshot | 捕获失败 | 逻辑 envelope 失败 |
| checkpoint save | 落盘失败 | checkpoint 不 committed，逻辑 envelope 失败 |
| rollback target lookup | checkpoint 不存在 | 逻辑 envelope 失败或返回可纠正错误，不恢复 |
| Feature restore | 部分恢复失败 | fail closed，不继续 LLM |
| rollback save | 落盘失败 | 不启动 summary continuation |
| summary validation | 空或过大 | 拒绝或截断策略必须明确 |
| continuation budget | 超限 | 终止 envelope，保留最后一致状态 |
| continuation LLM | API 失败 | 使用现有 call 错误语义，但不得释放错误的恢复状态 |

---

## 22. 安全与滥用约束

## 22.1 Summary 大小

应限制：

- 字符数。
- token 估算。
- 可选结构字段数量。

避免 Agent 把完整失败分支原样塞回上下文，失去 checkpoint 的压缩价值。

## 22.2 Checkpoint 数量

命名 checkpoint 应有：

- 单 envelope 上限。
- 单 session 上限。
- 淘汰策略。
- checkpointId 长度和字符限制。

## 22.3 Checkpoint 归属

至少校验：

- checkpoint 属于当前 session。
- 是否限制为当前 active envelope 创建。
- 是否允许跨 envelope rollback。

### 推荐第一版

只允许回退到当前逻辑 envelope 内创建的 checkpoint。

理由：

- 调用方身份清楚。
- 不会删除其他外部用户消息。
- 不会让旧 envelope 的等待者和新时间线混合。
- call index 和 queue 语义最容易证明。

跨 envelope checkpoint 可以作为后续能力，但风险显著更高。

---

## 23. 为什么第一版应限制为同一逻辑 Envelope

跨 envelope 回退意味着：

```text
E1 已经完成并向用户返回
E2 已经完成
E3 正在运行
E3 请求回到 E1 中的 checkpoint
```

这会带来：

- 已完成请求的历史被重写。
- E2 的用户输入从 Context 消失，但它已经收到响应。
- E2/E3 可能产生不可撤销副作用。
- rollback history 和 queue completion history不一致。
- IM/dispatch 外部世界无法“撤回已完成”。

所以第一版应该明确：

> checkpoint 是当前逻辑任务内部的分支恢复能力，不是任意会话时间旅行。

---

## 24. 对“是否新增原语”的最终回答

最终方案不需要引入以下重量级原语：

- 活跃 Context 任意跳转。
- 递归 `onCall`。
- 可恢复执行栈。
- 真正嵌套的 parent/child call。
- 通用事务引擎。

但仍然需要两个很小的框架契约：

1. 工具可以声明 `exclusive`，要求独占工具调用批次。
2. 一个 `onCall` segment 可以在合法边界返回 continuation request，而不是只能表达最终完成。

Arbiter 层再增加一个调度约定：

> 当前 active envelope 可以顺序执行多个非递归 `onCall` segments；在它最终完成前，不消费外部 queue。

因此可以说：

- 没有增加复杂的新执行原语。
- 增加了窄而明确的控制契约。
- “子 call”是逻辑理解，不是栈内嵌套。

---

## 25. 改造范围评估

## 25.1 AgentDev 核心

预计涉及：

- Tool 类型和 ToolRegistry metadata。
- ReAct 工具批次预检。
- 控制请求登记/消费。
- ReAct 在工具结果闭合后结束 segment。
- 可选的结构化 segment outcome。
- 命名 runtime snapshot API 或等价能力。

风险：中等。

主要原因：

- 会触碰工具执行和 call 完成语义。
- 必须保证普通 Tool 和普通 `onCall` 行为完全不变。

## 25.2 Checkpoint Feature

预计涉及：

- 两个 exclusive tools。
- checkpoint metadata。
- 参数校验。
- 工具描述和渲染。
- 可选 Feature snapshot。

风险：低到中等。

## 25.3 AgentDevClaw Runtime

预计涉及：

- CallArbiter 从单段 call 改为逻辑 envelope executor。
- 物理 segment finish 与逻辑 envelope finish 分离。
- 恢复/保存 barrier。
- continuation budget。
- 状态观测。

风险：中等，是主要工作量。

## 25.4 前端

基础正确显示无需大改。

体验增强可能涉及：

- continuation message 样式。
- checkpoint/rollback 状态。
- message revision。
- 避免 completed/running 闪烁。

风险：低到中等。

## 25.5 SessionStore

第一版可复用现有接口，但应让 checkpoint barrier 显式 await save。

如加强原子写，风险和工作量中等。

---

## 26. 必须补充的测试

## 26.1 Exclusive tool tests

1. 单独调用普通工具，行为不变。
2. 单独调用 exclusive 工具，正常执行。
3. exclusive + 普通工具，全批次不执行。
4. 两个 exclusive 工具同批次，全批次不执行。
5. 校验失败时每个 tool call 都有失败 result。
6. 校验失败后模型可在下一步重试。

## 26.2 Segment tests

1. checkpoint request 在 tool result 写入后结束 segment。
2. 不会执行同 batch 的其他工具。
3. 不会多调用一次 LLM。
4. CallFinish 和 finally 正常执行。
5. continuation request 只能消费一次。
6. 普通 `onCall` API 无行为回归。

## 26.3 Arbiter tests

1. E1 多 segment 期间 E2 不启动。
2. E1 waiter 只在最终 segment 后 resolve。
3. E1 checkpoint 时新消息 E3 正常入队。
4. rollback save 完成前不启动 continuation。
5. continuation 失败后 E1 标记 failed，随后 E2 可继续。
6. IM/dispatch 只收到一次最终结果。
7. listener 异步操作不会与下一 envelope 并发。

## 26.4 Rollback tests

1. Context 恢复到 checkpoint。
2. 失败分支消息消失。
3. summary 出现在恢复分支。
4. checkpoint 之后创建的 future checkpoints 被剪除。
5. checkpoint 不存在时不改变 Context。
6. Feature restore 失败时不继续推理。
7. session save 失败时不启动 continuation。

## 26.5 Crash/restart tests

1. checkpoint committed 后进程重启，仍可找到 checkpoint。
2. checkpoint save 前崩溃，不显示为 committed。
3. rollback save 后崩溃，重启不会恢复被丢弃分支。
4. continuation 未完成时重启，有明确恢复或失败语义。

## 26.6 Frontend tests

1. 消息长度减少时完整重绘。
2. rollback 后 summary continuation 正确出现。
3. queue bubbles 在 continuation 期间保持。
4. logical envelope 未完成时不显示真正 idle。
5. 旧 revision 不覆盖恢复后的新消息快照。

## 26.7 Provider tests

1. Anthropic 工具历史闭合。
2. OpenAI tool_calls/tool results 历史闭合。
3. rollback 后第一轮 LLM 能读取 summary。
4. exclusive batch 失败结果在两种 provider 下均合法。

---

## 27. 验收标准

第一版只有同时满足以下条件才可认为可靠：

1. checkpoint 和 rollback 工具均为 exclusive。
2. exclusive batch 在任何工具执行前完成整体校验。
3. 控制工具不直接恢复 Context。
4. 控制工具写入合法 tool result 后才结束 segment。
5. 下一个 `onCall` 只在前一个完全退出后启动。
6. continuation 不进入普通外部 queue。
7. active envelope 在所有 segments 完成前不释放。
8. 外部 queued calls 保持 FIFO 且不会插队。
9. checkpoint 和 rollback barrier 都等待 session save。
10. restore/save 失败时 fail closed。
11. summary 不使用高权限 system role。
12. 有 envelope 级 continuation 次数限制。
13. 前端能正确显示消息减少和恢复后的续跑。
14. IM/dispatch 只收到一次最终结果。
15. 文档和工具说明明确外部副作用不会自动撤销。

---

## 28. 最终设计判断

最终确认的方案是：

> `onCall` 继续作为普通、完整、非递归的执行单元。控制工具可以要求当前 `onCall` 在工具结果闭合后结束，并返回一个 continuation request。CallArbiter 在同一个 active envelope 内，串行执行恢复屏障和后续 `onCall` segment。只有整个逻辑 envelope 真正完成后，才释放外部队列并向调用方交付最终结果。

这个方案的优点：

- 复用现有 `onCall` 生命周期。
- 复用现有 call rollback 和 session snapshot。
- 恢复时没有活跃 ReAct 栈。
- 不要求 Context 支持任意栈内跳转。
- 不需要递归 `onCall`。
- 队列顺序、IM 和 dispatch 完成语义容易证明。
- 改造集中在窄契约和 Arbiter，不破坏 Feature 的总体美感。

它的边界也必须保持清醒：

- 它保证的是 Agent 内部时间线恢复，不是外部世界事务回滚。
- 第一版应限制在同一逻辑 envelope 内。
- Feature restore 和持久化失败必须保守终止。
- continuation 需要独立预算，不能无限执行。

---

## 29. 一句话心智模型

```text
一个外部请求占有一个 envelope；
一个 envelope 可以顺序运行多个完整 onCall；
checkpoint/rollback 只结束当前 onCall，不结束 envelope；
恢复和保存完成后，同一 envelope 立即续跑；
整个 envelope 完成后，才轮到外部队列中的下一条消息。
```

