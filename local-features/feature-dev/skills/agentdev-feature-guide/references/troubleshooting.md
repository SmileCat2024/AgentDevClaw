# Troubleshooting

This guide focuses on the mistakes that most often confuse an agent working in the current codebase.

## 1. Feature hook methods are ignored

### Symptom

You wrote methods like:

- `onCallStart`
- `onStepStart`
- `onToolUse`

inside a Feature, and nothing happens.

### More likely cause

You used Agent forward-hook names as if they were the Feature runtime surface.

### Fix

For Feature runtime behavior, prefer:

- `@CallStart`
- `@StepStart`
- `@StepFinish`
- `@ToolUse`
- `@ToolFinished`

## 2. `getAsyncTools()` does not give you a general Agent object

### Fact

`FeatureInitContext` does not expose a general `agent`.

### Use instead

- `config`
- `featureConfig`
- `getFeature()`
- `registerTool()`
- `logger`

If you need special runtime objects, create an explicit contract rather than assuming they already exist.

## 3. Tool execution context is missing `agent` or `feature`

### Fact

Tool runtime context is mainly created through `getContextInjectors()`.

### Check

1. Does the Feature implement `getContextInjectors()`?
2. Does its pattern match the tool name?
3. Does the tool read the same injected field structure?

## 4. Templates exist, but the viewer still falls back to JSON

Check in this order:

1. The tool's `render` value
2. The Feature's `getTemplateNames()` return value
3. Whether tsup entry includes `"src/templates/*.render.ts"` (独立包)
4. The compiled `.render.js` file in dist
5. `export default` for Feature templates
6. Whether you rebuilt after changing templates

## 5. Multiple `@StepFinish` or `@ToolUse` methods conflict

That is a real framework constraint, not a weird edge case.

### Fix

Merge the decisions into one method and return one final decision.

## 6. `query_logs` does not show logs you saw in the terminal

This is often expected.

### Current rule

`query_logs` only returns structured logs that were actually delivered to the debugger hub.

### Common reasons terminal output is missing from `query_logs`

- it was plain process output outside runtime log scope
- it happened while the debugger was disconnected
- it was infrastructure output rather than hub-delivered structured logging

### Important implication

Do not tell the agent "the debugger MCP contains all logs".  
Current semantics are narrower and more honest than that.

## 7. A log appears in the terminal but not in the Logs panel

Ask these questions:

1. Was it emitted through structured logging, or only raw `console.*`?
2. Was there an active debugger connection at emission time?
3. Did the log fall back locally because the hub was unavailable?

Current behavior is:

- hub connected: structured log goes to debugger
- hub unavailable: structured log falls back to local console

That fallback is intentional. It prevents silent loss, but it also means those fallback logs are not queryable through debugger MCP later.

## 8. MCP tools are registered twice or names collide

Common cause:

- global `MCPFeature` mounted a server
- a business Feature mounted the same server again

### Fix

- let the business Feature own that server
- use `excludeMcpServers` to prevent duplicate global auto-mounting

## 9. Feature debugger state looks stale

If tools or hook details do not match the current runtime state, first check whether the state you changed is part of the existing snapshot flow.

Current debugger sync is reliable for:

- registered tools
- feature inspector state
- hook snapshots

If you invent new mutable Feature state and never surface it through snapshot construction, the debugger will not guess it.

## 10. Rollback runs, but Feature state does not actually go back

### Common cause

The Feature mutates in-memory state, but does not implement:

- `captureState()`
- `restoreState()`

### Another common cause

The snapshot contains references to mutable objects instead of representing a stable value snapshot.

### Fix

1. Put real logical state into `captureState()`
2. Restore that state in `restoreState()`
3. Do not rely on hidden mutable references
4. Prefer simple serializable shapes

Good:

- arrays
- plain objects
- strings
- numbers
- booleans

Bad default choice:

- live client instances
- subprocess handles
- workers
- unresolved promises

## 11. Session restore feels different from rollback

That is often a Feature design bug, not an Agent bug.

Current model is:

- step rollback restores a checkpoint in-process
- session restore creates a new Agent and restores a saved checkpoint

If a Feature behaves differently between those two paths, check whether it mixes:

- logical state
- runtime resource state

without separating them.

## 12. A Feature tries to restore live runtime that should have been degraded

Typical examples:

- subagent pools
- websocket gateways
- worker pools
- remote clients with active sessions

If you cannot honestly resume them, do not fake it.

Safer behavior:

- clear the live runtime
- rebuild the resource normally
- or mark the Feature as degraded by explicit warning/logging

## 13. Docs say something exists, but code does not

Treat that as a documentation bug until proven otherwise.

### Safer order of operations

1. inspect current code
2. inspect current skill references
3. separate implemented behavior from intended future direction

For this repository, a precise limitation is more useful than a broad promise.
