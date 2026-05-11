# Lifecycle Hooks And Extension Points

This file exists to answer one question quickly:

Which behavior should live in an Agent subclass, and which should live in a Feature?

## Short Answer

- Agent subclasses own forward lifecycle hooks
- Features own setup, tools, templates, context injection, and reverse-hook-based runtime control

## Current Runtime Layers

```text
Call
  -> Step
      -> Tool
```

There are also one-time lifecycle moments:

- Agent initiate
- Agent destroy

## Agent-Side Forward Hooks

These are the main forward hook surfaces on `Agent`:

- `onInitiate`
- `onDestroy`
- `onCallStart`
- `onCallFinish`
- `onStepStart`
- `onStepFinished`
- `onToolUse`
- `onToolFinished`
- `onInterrupt`

Use them when you are changing a specific Agent subclass or top-level runtime policy.

## Feature-Side Stable Entry Points

For Features, the reliable extension points are:

- `getTools`
- `getAsyncTools`
- `getTemplatePaths`
- `getContextInjectors`
- `onInitiate`
- `onDestroy`
- reverse hook decorators

If you are writing a Feature and instinctively start implementing `onStepStart()` as a normal method, stop and re-check the current framework boundary.

## Reverse Hook Decorators

Current decorators:

- `@AgentInitiate`
- `@AgentDestroy`
- `@CallStart`
- `@CallFinish`
- `@StepStart`
- `@StepFinish`
- `@ToolUse`
- `@ToolFinished`

The most important control points are:

- `@ToolUse`: tool allow / deny
- `@StepFinish`: continue / stop the loop

In one Feature, `@ToolUse` and `@StepFinish` are each singletons. Merge multiple decisions into one method.

## Input-Rewrite Boundary

`@CallStart` is special because it runs before the user message is finally injected into context. That is why it is the right place for:

- slash command parsing
- mode switching
- input cleanup or rewrite

Use `ctx.agent?.getUserInput()` and `ctx.agent?.setUserInput()` if you need to modify the pending input.

## Logging Boundary

Lifecycle and hook behavior now show up in the debugger through structured logs and snapshots. That means:

- hook methods should have clear intent
- logs emitted in runtime scope may appear in the Logs panel and debugger MCP
- if the debugger is disconnected, those logs fall back to local console instead of silently becoming MCP-visible later

Do not document or design hooks as if all runtime output is guaranteed to be queryable through `query_logs`.

## Practical Heuristic

Use an Agent subclass when you need:

- whole-agent policy
- top-level orchestration changes
- different global runtime semantics

Use a Feature when you need:

- a reusable capability package
- tools plus some control logic
- domain-specific runtime behavior that should compose with other Features
