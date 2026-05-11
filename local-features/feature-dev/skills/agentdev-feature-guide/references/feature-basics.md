# Feature Basics

## What A Feature Is In AgentDev

A Feature is the framework's main capability unit. In current AgentDev, a Feature usually owns some combination of:

- tools
- tool templates
- small internal state
- context injection
- initialization / cleanup
- reverse hook logic

If the capability needs the agent to understand how to use it, when to use it, and how it should appear in the debugger, it probably belongs in a Feature.

## Current `AgentFeature` Surface

```ts
interface AgentFeature {
  readonly name: string;
  readonly dependencies?: string[];
  readonly source?: string;
  readonly description?: string;

  getTools?(): Tool[];
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;
  getPackageInfo?(): PackageInfo | null;
  getTemplateNames?(): string[];
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;
  onInitiate?(ctx: FeatureInitContext): Promise<void>;
  onDestroy?(ctx: FeatureContext): Promise<void>;
  captureState?(): FeatureStateSnapshot;
  restoreState?(snapshot: FeatureStateSnapshot): void | Promise<void>;
  beforeRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;
  afterRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;
}
```

Three fields matter more than older docs often imply:

- `description`: shown in debugger feature details
- `source`: used by `getPackageInfoFromSource()` to detect package info
- `getPackageInfo()` + `getTemplateNames()`: replace old `getTemplatePaths()`

If you are adding a built-in Feature, fill them in.

## Current `FeatureInitContext`

```ts
interface FeatureInitContext {
  agentId: string;
  config: AgentConfig;
  logger: Logger;
  featureConfig?: unknown;
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  registerTool(tool: Tool): void;
}
```

Important facts:

- there is no general `agent` object here
- `logger` is already a Feature-friendly structured logger
- this is initialization-time context, not a general runtime escape hatch

## Rollback And Session Restore Surface

If a Feature owns in-memory runtime state that affects behavior, it should usually implement:

- `captureState()`
- `restoreState()`

If it needs rollback lifecycle notifications, it may also implement:

- `beforeRollback()`
- `afterRollback()`

Use this only for real logical state. Examples:

- task maps
- counters
- mode toggles
- read-history sets
- incremental injection caches

This is optional, not mandatory.

Add rollback / restore support when:

- the Feature mutates in-memory state that users expect to rewind
- session restore should continue from a meaningful logical state

Skip it when:

- the Feature is effectively stateless
- the state is only a cheap cache
- rebuilding from scratch is clearer and correct

Do not use it for live runtime resources such as:

- clients
- sockets
- subprocesses
- worker pools
- child agents

Those should be rebuilt or explicitly degraded after restore.

## Smallest Valid Feature

```ts
import type { AgentFeature } from '../../core/feature.js';

export class MyFeature implements AgentFeature {
  readonly name = 'my-feature';
  readonly description = 'Short description visible in the debugger.';
}
```

## Choose The Right Mechanism

### Use `getTools()`

When the tool set is static and known synchronously.

### Use `getAsyncTools()`

When you must discover or connect first, for example:

- MCP discovery
- remote tool listing
- loading dynamic capability descriptions

### Use `getContextInjectors()`

When `tool.execute(args, context)` needs extra runtime data.  
Do not assume that `agent` or `feature` is injected for free.

### Use `onInitiate()`

When the Feature needs one-time setup:

- initialize clients
- register data sources
- discover resources
- emit startup logs

### Use `getPackageInfo()` + `getTemplateNames()`

When the Feature has viewer templates. Return:

- `getPackageInfo()`: package name, version, root path (from `getPackageInfoFromSource()`)
- `getTemplateNames()`: array of template names (without `.render.js` suffix)

Example:
```ts
getPackageInfo(): PackageInfo | null {
  if (!this._packageInfo) {
    this._packageInfo = getPackageInfoFromSource(this.source);
  }
  return this._packageInfo;
}

getTemplateNames(): string[] {
  return ['my-tool'];  // → /template/.../my-tool.render.js
}
```

The framework auto-generates template URLs based on whether the package is:
- Standalone npm package (`@agentdev/*`): `/template/@agentdev/my-feature/tool.render.js`
- Built-in feature: `/template/agentdev/my-feature/tool.render.js`

### Use reverse hooks

When the Feature needs runtime control:

- rewrite input
- inject reminders
- block tools
- keep a step running

## Recommended Directory Shape

```text
src/features/my-feature/
├── index.ts
├── tools.ts
├── types.ts
├── templates/
│   └── my-tool.render.ts
├── test/
│   └── smoke.test.ts
└── README.md
```

Only keep files that earn their keep.  
If you need a ready-made starter, use:

- `src/features/example-feature`

## Dependency Guidance

`dependencies` should mean real, narrow runtime dependency. Use it when:

- the Feature is meaningless without another Feature
- you read another Feature's explicit public API with `getFeature()`

Do not use it just because two Features both touch the same domain.

## Debugger Implications

Feature state is increasingly surfaced through snapshots and logs. That means a good built-in Feature should usually provide:

- `description`
- stable tool names
- useful structured logs
- predictable hook behavior

Design for inspectability, not just successful execution.
