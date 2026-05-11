---
name: agentdev-feature-guide
description: Practical guide for creating or updating AgentDev Features. Use when deciding whether a capability should be a Feature, wiring tools/templates/reverse hooks, packaging managed MCP tools, or debugging Feature behavior in the current codebase.
---

# AgentDev Feature Guide

Use this skill when the task is "make this capability fit AgentDev correctly", not when the task is "explain every subsystem in depth".

The target outcome is practical:

- choose the right extension point
- produce a Feature that matches current framework behavior
- avoid misleading the agent about what exists vs what is only a design idea

## What To Optimize For

In this repository, a good Feature is:

- small in theme
- obvious to an agent from tool names and descriptions
- explicit about runtime control points
- easy to inspect in the debugger
- easy to package into a reusable skill later

## Start With These Questions

Before writing code, decide which of these you actually need:

1. Static tools: use `getTools()`
2. Async discovery or remote capability loading: use `getAsyncTools()`
3. Extra runtime data for `tool.execute()`: use `getContextInjectors()`
4. Viewer rendering: use `getPackageInfo()` + `getTemplateNames()`
5. One-time setup or teardown: use `onInitiate()` / `onDestroy()`
6. Runtime flow control: use reverse hook decorators
7. Real state rollback or session restore: use `captureState()` / `restoreState()` only if the Feature actually needs it

If the answer is still "mostly tools plus a bit of state", it is a Feature.
If the answer is "one pure function and nothing else", it may just be a tool.

## The Current Mental Model

Do not treat Feature as "Agent subclass but smaller".

Current stable Feature surface:

- `getTools`
- `getAsyncTools`
- `getPackageInfo`
- `getTemplateNames`
- `getContextInjectors`
- `onInitiate`
- `onDestroy`
- `captureState`
- `restoreState`
- `beforeRollback`
- `afterRollback`
- reverse hook decorators such as `@CallStart`, `@ToolUse`, `@StepFinish`

Agent-level forward hooks still exist, but they are not the primary Feature runtime API.

## Practical Rules

### Rule 1: Prefer explicit over magical

- Explicit template names
- Explicit context injectors
- Explicit MCP tool renaming / disabling / describing
- Explicit logging with `FeatureInitContext.logger`

Avoid writing Features that only make sense if someone already knows hidden conventions.

### Rule 2: Design for the debugger

The debugger now exposes:

- feature snapshots
- hook snapshots
- structured logs
- debugger MCP

So when you create a Feature, include:

- `description`
- stable tool names
- useful logger usage
- clear hook intent

If a Feature is hard to read in the debugger, it is usually also hard for another agent to maintain.

当前还要注意：

- 调试宿主可能是本仓库内置 `ViewerWorker`，也可能是独立 `AgentDevClaw` host
- 两者都消费同一份 session metadata，而不是两套不同的 Feature 描述

### Rule 3: Be honest about logs

Current log semantics matter:

- `Logs` panel and `query_logs` read the same hub-delivered structured log stream
- logs emitted while the debugger is disconnected fall back to local console
- those fallback logs do not appear in debugger MCP results

Do not write docs or code that imply `query_logs` can see all process output.

### Rule 3.5: Treat template delivery as part of the runtime contract

当前调试器不是”扫描源码文件夹后自己猜模板”。它依赖：

- Feature `getPackageInfo()` + `getTemplateNames()`
- agent 根据包信息自动生成模板 URL
- 可执行的 `.render.js` 构建产物

模板 URL 格式由框架自动生成：

- **独立 npm 包**（`@agentdev/*`）：`/template/@agentdev/my-feature/tool.render.js`
- **框架内置 feature**：`/template/agentdev/my-feature/tool.render.js`

尤其在独立 `Claw` 宿主下，这个契约更明确：

- 宿主根据 URL 和 `projectRoot` 定位模板文件
- 独立包：`node_modules/@agentdev/my-feature/dist/templates/*.render.js`
- 内置 feature：`dist/features/my-feature/templates/*.render.js`

如果模板在调试器里长期存在，就把模板名和构建产物一起当成功能的一部分维护。

### Rule 4: Business MCP belongs with the business Feature

If a Feature owns a domain capability, it is often better to:

- keep the MCP config inside the Feature
- mount managed MCP tools there
- rename and describe tools there
- avoid relying on a second global mount elsewhere

Use global `MCPFeature` for convenience, not as a forced architecture for every MCP-backed capability.

### Rule 5: Treat rollback and session restore as first-class Feature contracts

Current AgentDev no longer treats rollback as a future idea. It already has:

- step-level checkpoints
- rollback on step failure
- persisted session restore

So when you build a Feature, decide explicitly:

1. what in-memory state must roll back with checkpoints
2. what runtime resources must be rebuilt after restore
3. what live runtime cannot be resumed honestly

Use the simplest truthful strategy:

- in-memory state: `captureState()` / `restoreState()`
- rollback notifications: `beforeRollback()` / `afterRollback()`
- external runtime: rebuild or degrade, do not fake resumption

Important:

- rollback support is not mandatory for every Feature
- add it only when the Feature's real user workflow needs state consistency after rollback or session restore
- if a Feature is effectively stateless, leave these methods out

### Rule 6: Snapshot state and runtime resources are different things

Good examples of snapshot state:

- task lists
- counters
- read-history sets
- mode toggles
- incremental injection state

Good examples of runtime resources:

- websocket connections
- MCP clients
- subprocesses
- worker pools
- child agents

Do not serialize the second category just because the Feature has both.

### Rule 7: Prefer the built-in example skeleton over inventing your own layout

This repository now includes:

- `src/features/example-feature`

That folder is the default copy/paste template for new built-in Features.
If you are unsure about file layout, lifecycle hooks, rollback hooks, or template wiring, start there and delete what you do not need.

### Rule 8: Feature tests live inside the Feature directory

Feature tests must be placed in `src/features/your-feature/test/`, not in `src/test/`.

The test runner auto-discovers:
- `src/test/**/*.test.ts` — core framework contract tests
- `src/features/*/test/**/*.test.ts` — feature-level tests

### Rule 9: All tests must use standard error handling

Every test file must use the `main().catch()` pattern:

```typescript
async function main(): Promise<void> {
  // test logic
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
```

Tests without this pattern will not exit properly on failure, blocking the test runner.

## Recommended Workflow

1. Read [Feature Basics](references/feature-basics.md)
2. Choose tools vs async tools vs reverse hooks
3. Decide snapshot state vs runtime resource boundaries
4. Read [Tools Guide](references/tools-guide.md) if any tool is involved
5. Read [Reverse Hooks](references/reverse-hooks.md) if runtime control is involved
6. Read [Rendering Guide](references/rendering-guide.md) if the Feature should render cleanly in the viewer
7. Read [Troubleshooting](references/troubleshooting.md) if the behavior is unclear or the framework feels "inconsistent"

## Minimal Procedural Checklist

Use this as a practical sequence, not as a rigid law:

1. Copy `src/features/example-feature`
2. Rename folder, class, tool names, template names, and exported types
3. Delete parts you do not need before adding new logic
4. Decide whether tools are static or async
5. Decide whether runtime control belongs in reverse hooks
6. Decide whether rollback/session restore is actually needed
7. Add `description` and `source`
8. Add at least one smoke test for the intended behavior
9. Rebuild and verify the debugger-host template path still resolves

If unsure, prefer deleting unused skeleton parts over keeping empty abstractions.

## Reference Map

| Need | File |
|------|------|
| What a Feature should contain | [references/feature-basics.md](references/feature-basics.md) |
| Agent vs Feature extension points | [references/lifecycle-hooks.md](references/lifecycle-hooks.md) |
| Building tools cleanly | [references/tools-guide.md](references/tools-guide.md) |
| Reverse hook flow control | [references/reverse-hooks.md](references/reverse-hooks.md) |
| Viewer templates | [references/rendering-guide.md](references/rendering-guide.md) |
| Common design patterns | [references/patterns.md](references/patterns.md) |
| Failure cases and false assumptions | [references/troubleshooting.md](references/troubleshooting.md) |
| Copy/paste starter shape | `src/features/example-feature` |

## What Not To Do

- Do not assume every `console.*` message will appear in debugger MCP.
- Do not assume Feature methods named like Agent forward hooks will automatically participate in runtime flow.
- Do not assume tool execution context includes `agent` by default.
- Do not let docs drift into "the framework probably supports this".
- Do not write a huge Feature when two smaller ones would be clearer.
- Do not fake restoration of live runtime such as child agents or worker pools.

## Default Output Style

When using this skill to help implement a Feature:

- give a minimal runnable shape first
- point to `src/features/example-feature` when the user needs a concrete starter
- call out only the constraints that matter for this task
- keep filenames and responsibilities obvious
- mention debugger/logging behavior when it affects agent understanding
- mention debugger host / template delivery constraints when rendering is involved
- prefer current, exact behavior over broad theoretical explanations
