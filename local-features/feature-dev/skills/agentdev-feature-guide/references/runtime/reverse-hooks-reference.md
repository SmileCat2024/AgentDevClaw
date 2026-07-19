# 反向钩子与运行时控制

## 目录

- [可用钩子](#可用钩子)
- [通知钩子与决策钩子](#通知钩子与决策钩子)
- [Decision 语义](#decision-语义)
- [CallStart](#callstart)
- [CallFinish](#callfinish)
- [StepStart](#stepstart)
- [StepFinish](#stepfinish)
- [ToolUse](#tooluse)
- [ToolFinished](#toolfinished)
- [执行顺序和短路](#执行顺序和短路)
- [继承与组合](#继承与组合)
- [调试说明](#调试说明)

## 可用钩子

Feature 运行时使用以下装饰器：

```ts
import {
  CallFinish,
  CallStart,
  Decision,
  StepFinish,
  StepStart,
  ToolFinished,
  ToolUse,
  type CallFinishContext,
  type CallStartContext,
  type StepFinishDecisionContext,
  type StepStartContext,
  type ToolContext,
  type ToolFinishedDecisionContext,
} from 'agentdev';
```

这些上下文类型都从包根导出，可以直接用于 Feature 方法签名。

一次性初始化和清理使用 Feature 方法 `onInitiate()` / `onDestroy()`。

## 通知钩子与决策钩子

通知钩子只做处理，返回 `void | Promise<void>`：

- `@CallStart`
- `@CallFinish`
- `@StepStart`
- `@ToolFinished`

同一个 Feature 可以为同一通知生命周期声明多个方法。仍建议按职责控制数量，避免执行顺序难以理解。

决策钩子返回 `DecisionResult`：

- `@ToolUse`
- `@StepFinish`

同一个 Feature 中，每个决策生命周期只能有一个装饰方法。多个判断应在该方法内部组合。

## Decision 语义

```ts
enum Decision {
  Approve = 'approve',
  Deny = 'deny',
  Continue = 'continue',
}
```

可以返回枚举值，也可以返回带说明的对象：

```ts
return {
  action: Decision.Deny,
  reason: '目标路径不在允许目录内',
  metadata: { path },
};
```

在 `@ToolUse` 中：

- `Approve`：明确允许工具执行；
- `Deny`：阻止工具并把原因作为错误结果；
- `Continue`：交给后续 Feature 的同类 hook 或默认放行逻辑。

在 `@StepFinish` 中：

- `Approve`：要求继续下一 step；
- `Deny`：结束当前 call；
- `Continue`：交给后续 hook 或默认 ReAct 结束规则。

## CallStart

上下文：

```ts
interface CallStartContext {
  input: string;
  context: Context;
  isFirstCall: boolean;
  agent?: Agent;
}
```

适合：

- slash command；
- 输入标准化；
- 模式切换；
- 在用户消息前注入系统提醒；
- 记录当前 call 的输入状态。

改写输入：

```ts
@CallStart
async normalizeCommand(ctx: CallStartContext): Promise<void> {
  const input = ctx.agent?.getUserInput() ?? ctx.input;
  if (input.startsWith('/plain ')) {
    ctx.agent?.setUserInput(input.slice('/plain '.length));
  }
}
```

链式改写时始终读 `ctx.agent.getUserInput()`，这样可以看到前一个 `@CallStart` 已写入的值。`ctx.input` 是原始输入。

不要把耗时远端请求放在每次 `@CallStart` 中，除非该请求确实是 call 的前置条件。

## CallFinish

上下文：

```ts
interface CallFinishContext {
  input: string;
  context: Context;
  response: string;
  steps: number;
  completed: boolean;
  finishReason: CallFinishReason;
}

type CallFinishReason =
  | 'completed'
  | 'interrupted'
  | 'api_error'
  | 'error'
  | 'max_steps'
  | 'continuation'
  | 'exception';
```

适合：

- 按结束原因记录指标；
- 发送完成通知；
- 清理 call 级临时状态；
- 同步本轮结果到外部系统。

```ts
@CallFinish
async recordCompletion(ctx: CallFinishContext): Promise<void> {
  this.lastFinishReason = ctx.finishReason;
  this.logger?.info('Call finished', {
    completed: ctx.completed,
    finishReason: ctx.finishReason,
    steps: ctx.steps,
  });
}
```

使用 `finishReason` 判断结束原因，不解析 `response` 文本。

## StepStart

上下文：

```ts
interface StepStartContext {
  step: number;
  callIndex: number;
  context: Context;
  input: string;
  agent?: Agent;
}
```

适合在 LLM 调用前加入动态提醒：

```ts
@StepStart
async injectPendingWork(ctx: StepStartContext): Promise<void> {
  if (this.pending.length === 0) return;
  ctx.context.add({
    role: 'system',
    content: `待处理事项：\n${this.pending.map(item => `- ${item}`).join('\n')}`,
  });
}
```

提醒应：

- 只在条件满足时注入；
- 保持简短；
- 避免每个 step 重复同一大段内容；
- 在 Feature 状态中记录已注入边界时，为该状态实现快照恢复。

## StepFinish

上下文在 `StepStartContext` 基础上增加：

```ts
interface StepFinishDecisionContext extends StepFinishedContext {
  llmResponse: LLMResponse;
  toolCallsCount: number;
  hasActiveSubAgents?: boolean;
  hasPendingMessages?: boolean;
  waitCalled?: boolean;
}
```

典型用途：

- LLM 没有工具调用，但存在必须继续处理的待办；
- 某个业务目标已经完成，主动结束 call；
- 根据本 step 的工具使用更新计数或提醒状态。

```ts
@StepFinish
async decideNextStep(ctx: StepFinishDecisionContext) {
  if (this.mustStop()) {
    return { action: Decision.Deny, reason: '目标已完成' };
  }
  if (ctx.toolCallsCount === 0 && this.pending.length > 0) {
    ctx.context.add({
      role: 'system',
      content: '仍有待处理事项，请继续完成。',
    });
    return Decision.Approve;
  }
  return Decision.Continue;
}
```

不要无条件返回 `Approve`，否则 call 会持续循环。为续跑条件设计明确的退出状态和测试。

## ToolUse

上下文：

```ts
interface ToolContext {
  call: ToolCall;
  tool: Tool;
  step: number;
  input: string;
  context: Context;
  getFeature<T extends AgentFeature>(name: string): T | undefined;
}
```

使用 `ctx.call.name` 和 `ctx.call.arguments` 判断调用：

```ts
@ToolUse
async validateWrite(ctx: ToolContext) {
  if (ctx.call.name !== 'record_update') return Decision.Continue;

  const id = String(ctx.call.arguments?.id ?? '').trim();
  if (!id) {
    return { action: Decision.Deny, reason: 'record_update.id 不能为空' };
  }

  ctx.call.arguments.id = id;
  return Decision.Continue;
}
```

适合：

- 权限和范围校验；
- Feature 模式前置条件；
- 参数标准化；
- 跨工具统一安全策略。

工具自己的 `execute()` 仍要验证安全关键参数。Hook 负责统一策略，工具负责自身不变量。

## ToolFinished

上下文：

```ts
interface ToolFinishedDecisionContext extends ToolResult {
  toolName: string;
  success: boolean;
  data: unknown;
  error?: string;
  duration: number;
  call: ToolCall;
  tool: Tool;
  step: number;
  input: string;
  context: Context;
  getFeature<T extends AgentFeature>(name: string): T | undefined;
}
```

适合：

- 审计工具结果；
- 更新 Feature 的业务状态；
- 对失败分类并记录日志；
- 把结果同步给另一个 Feature 的公开 API。

```ts
@ToolFinished
async auditResult(ctx: ToolFinishedDecisionContext): Promise<void> {
  if (!ctx.toolName.startsWith('record_')) return;
  this.logger?.info('Record tool finished', {
    toolName: ctx.toolName,
    success: ctx.success,
    duration: ctx.duration,
    error: ctx.error,
  });
}
```

`@ToolFinished` 是通知钩子，返回 `Decision` 不会控制流程。

## 执行顺序和短路

同一生命周期的 hooks 按 Feature 注册顺序执行。

通知钩子会依次执行。决策钩子遇到第一个 `Approve` 或 `Deny` 后立即停止；`Continue` 让后续 hook 继续判断。

因此：

- 把高优先级安全策略的 Feature 较早注册；
- 不需要抢占决策时返回 `Continue`；
- 只在确实要终止后续判断时返回 `Approve` 或 `Deny`；
- 避免多个 Feature 对同一生命周期给出互相矛盾的强制决策。

## 继承与组合

决策 hook 在单个 Feature 类中只有一个。需要多个判断时组合内部函数：

```ts
@ToolUse
async decideToolUse(ctx: ToolContext) {
  for (const rule of [
    () => this.checkMode(ctx),
    () => this.checkPath(ctx),
    () => this.checkQuota(ctx),
  ]) {
    const decision = await rule();
    if (decision !== Decision.Continue) return decision;
  }
  return Decision.Continue;
}
```

继承父 Feature 时覆盖父 hook 方法名，不再装饰：

```ts
override async decideNextStep(ctx: StepFinishDecisionContext) {
  const base = await super.decideNextStep(ctx);
  if (this.extraStopCondition()) return Decision.Deny;
  return base;
}
```

## 调试说明

为 hook 提供简短说明：

```ts
getHookDescription(lifecycle: string, methodName: string): string | undefined {
  if (lifecycle === 'ToolUse' && methodName === 'validateWrite') {
    return '校验记录写入范围并标准化 ID。';
  }
  return undefined;
}
```

Feature logger 会自动携带 Feature 命名空间。Hook 执行日志还会包含 lifecycle 和方法名。日志应记录决策依据，不要把完整敏感参数或大对象写入日志。
