# 反向钩子详解

反向钩子是当前 Feature 运行时扩展的主力工具。

## 装饰器列表

可用装饰器：

- `@AgentInitiate`
- `@AgentDestroy`
- `@CallStart`
- `@CallFinish`
- `@StepStart`
- `@StepFinish`
- `@ToolUse`
- `@ToolFinished`

## 当前最重要的两条约束

1. `@StepFinish` 在单个 Feature 内只能有一个
2. `@ToolUse` 在单个 Feature 内只能有一个

这是当前实现的**流程控制型钩子唯一性约束**。如果需要多个判断，把逻辑合并到同一个方法里。

## `Decision`

```typescript
enum Decision {
  Approve = 'approve',
  Deny = 'deny',
  Continue = 'continue',
}
```

## 应怎么理解 `Decision`

### `Decision.Continue`

交给默认行为：

- `@ToolUse` 中表示放行
- `@StepFinish` 中表示按默认循环规则处理

### `Decision.Deny`

- `@ToolUse` 中表示阻止工具执行
- `@StepFinish` 中表示结束当前循环

### `Decision.Approve`

- `@ToolUse` 中通常等价于明确放行
- `@StepFinish` 中最重要，表示即使默认会结束，也要求继续下一轮

## 最常见的 4 类写法

### 1. 改写输入

```typescript
import { CallStart } from '../../core/hooks-decorator.js';

@CallStart
async handleSlashCommand(ctx: import('../../core/lifecycle.js').CallStartContext): Promise<void> {
  const currentInput = ctx.agent?.getUserInput() ?? ctx.input;
  if (currentInput.startsWith('/plain ')) {
    ctx.agent?.setUserInput(currentInput.slice('/plain '.length));
  }
}
```

### 2. 在 step 前插入提醒

```typescript
import { StepStart } from '../../core/hooks-decorator.js';

@StepStart
async injectReminder(ctx: import('../../core/lifecycle.js').StepStartContext): Promise<void> {
  ctx.context.add({ role: 'system', content: '注意保持任务状态最新。' });
}
```

### 3. 阻止危险工具

```typescript
import { ToolUse } from '../../core/hooks-decorator.js';
import { Decision } from '../../core/lifecycle.js';

@ToolUse
async blockDangerous(ctx: import('../../core/lifecycle.js').ToolContext) {
  if (ctx.call.name === 'bash') {
    const command = String(ctx.call.arguments?.command ?? '');
    if (command.includes('rm -rf')) {
      return { action: Decision.Deny, reason: '检测到危险删除命令' };
    }
  }
  return Decision.Continue;
}
```

### 4. 无工具时强制继续一轮

```typescript
import { StepFinish } from '../../core/hooks-decorator.js';
import { Decision } from '../../core/lifecycle.js';

@StepFinish
async continueWhenNeeded(ctx: import('../../core/lifecycle.js').StepFinishDecisionContext) {
  if (!ctx.llmResponse.toolCalls?.length && ctx.hasActiveSubAgents) {
    return Decision.Approve;
  }
  return Decision.Continue;
}
```

## 什么时候要同时考虑 rollback

反向钩子本身不等于必须实现 rollback。

只在下面这些情况里，再去考虑 `captureState()` / `restoreState()`：

- 钩子会更新计数器
- 钩子会维护任务表或模式状态
- 钩子会累积“上一次注入过什么”的状态

如果钩子只是：

- 读上下文
- 临时判断
- 注入一次消息

而没有维护持久状态，那么通常不需要额外写 rollback 支持。

## 为什么 Feature 更该用反向钩子

因为当前框架里，Feature 的运行时流程控制就是围绕它设计的：

- `HooksRegistry` 会自动收集装饰器
- `ToolExecutor` 和 `ReActLoopRunner` 会在关键节点执行它们
- `@StepFinish` / `@ToolUse` 可以直接控制流程

这比在 Feature 里假设正向钩子会自动被调度更符合当前实现。

## 反向钩子与调试器

最近的调试增强已经把 hook 信息显式暴露到调试器里：

- feature 详情里能看到 hook 数量和工具信息
- Reverse Hooks 面板能看到生命周期分组、方法名、描述、源码位置
- hook 运行期的结构化日志会附带 `feature / lifecycle / hookMethod`

这意味着写反向钩子时，名字、描述和日志都会直接影响后续排查体验。

## 易错点

### 1. 一个 Feature 写多个 `@StepFinish`

会冲突。请合并逻辑。

### 2. `@ToolUse` 里判断错字段

当前上下文里直接看：

- `ctx.call.name`
- `ctx.call.arguments`

不要凭空假设有 `ctx.toolName` 这种旧字段。

### 3. `@StepFinish` 里改错消息对象

当前最直接的方式是：

```typescript
ctx.context.add({ role: 'assistant', content: '...' });
```

### 4. 用返回值做纯通知

`@ToolFinished` / `@StepStart` / `@CallStart` 这类主要是处理，不要误以为返回值会控制流程。

## 什么时候不该用反向钩子

如果你只是：

- 初始化连接
- 注册工具
- 注入工具执行上下文

那应该用：

- `onInitiate`
- `getTools` / `getAsyncTools`
- `getContextInjectors`

不要一上来就把所有逻辑塞进装饰器。
