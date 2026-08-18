---
name: agent-studio-workflow
description: Use when developing a Feature, defining its tests, or running Test Runtime verification in an Agent Studio project.
---

# Agent Studio Workflow

## Start from conversation

The injected "Agent Studio 项目状态" block shows the current project each turn. When a project is already active, continue with it; do not re-ask for directory or name. When there is none, confirm in conversation what to build, which directory it lives in, and whether a target Agent is involved. Call `studio_initialize_project` once clear, then keep working.

## Development loop

Standard order:

```text
studio_initialize_project   create/update agent-studio.json
(write the Feature module source first)
studio_add_feature          register it: name + modulePath (any order — assembly is auto-sorted)
studio_define_test          save a test: input + session policy + executable assertions
studio_start_runtime        start the Test Runtime
studio_run_test             run the test (assertions are machine-judged)
studio_get_run              inspect a run record
(fix source from assertion failures and evidence, repeat studio_run_test)
studio_save_checkpoint      persist the stateful session as a named checkpoint (optional)
studio_stop_runtime         stop; sessions persist and restore on next start
```

Auxiliary: `studio_get_project`, `studio_remove_feature` (unregister and unload from the Runtime), `studio_list_tests`.

### Feature module requirements

- An ESM JavaScript file (`.js` / `.mjs`); create the file before calling `studio_add_feature`.
- The module exports one feature class (the only class export, or the default export).
- The class instance's `name` property must equal the registered name.
- `modulePath` resolves against the project directory; absolute paths also work.
- Registration order is free: the Runtime assembles in `static inject` dependency order automatically. Cycles or missing dependencies fail at start/sync with the full dependency graph in the error.

### Module templates

Tool-only feature (most common — no `static hooks` / `static inject` needed):

```js
// features/my-feature/index.mjs
const myTool = {
  name: 'my_tool',
  description: 'What it does and when the model should call it.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '...' },
    },
    additionalProperties: false,
  },
  execute: async (args) => ({ ok: true, answer: args.question }), // string or object
};

export class MyFeature {
  name = 'my-feature';            // must equal the studio_add_feature name
  description = '...';
  getTools() { return [myTool]; } // tools are exposed via getTools()
}
```

Feature with lifecycle hooks:

```js
export class MyFeature {
  name = 'my-feature';

  // static hooks is an OBJECT MAP: key = method name, entry = { lifecycle, kind, role? }.
  // It is NOT an array, and entries have no `method` field.
  static hooks = {
    onCallStart: { lifecycle: 'CallStart', kind: 'observe' },
    beforeTool: { lifecycle: 'ToolUse', kind: 'guard', role: 'advisor' },
  };

  static inject = ['other-feature']; // string array of feature names this depends on; omit when standalone

  onCallStart(ctx) { /* observe: side effects only, no return value */ }
  beforeTool(ctx) {
    // guard: return 'continue' | 'approve' | 'deny' | { action: 'deny', reason: '...' }
    // These literals ARE the runtime decision values (lowercase strings); never
    // `import 'agentdev'` inside a project module — the project directory has no
    // resolvable node_modules, and the import failure breaks mount. See
    // agentdev-feature-guide → reverse-hooks-reference → "JS 与 TS 双态速查".
    return 'continue';
  }
  getTools() { return []; }
}
```

### Declaration schema quick reference

- `lifecycle` — one of: `AgentInitiate`, `AgentDestroy`, `CallStart`, `CallFinish`, `StepStart`, `StepFinish`, `ToolUse`, `ToolFinished`, `ToolResultTransform`.
- `kind` — `observe` (any lifecycle, side effects only) | `guard` (only `ToolUse` / `StepFinish`, returns a decision) | `transform` (only `ToolResultTransform`, rewrites the tool result).
- `role` — `policy` | `advisor`; valid on `guard` only, defaults to `advisor`; at most one `policy` per lifecycle across the assembly.
- `static hooks = {}` or omitting it entirely means "no lifecycle hooks" — correct for tool-only features.
- `static inject` is a string array (`['dep-name']`); a non-array value is ignored as if undeclared.

## Test definition

`studio_define_test` stores a stable `id`, `title`, the `input` sent to the Runtime, a `sessionPolicy`, and an `assertions` list. `passed` is machine-judged from run evidence; a run without assertions records evidence but never advances a Feature to `verified`.

### Session policy

- `fresh` (default) — empty context and empty Feature state. Use for deterministic single-scenario verification.
- `stateful` — continues the `default` session (conversation history and Feature state). Use for multi-step flows.
- `checkpointed` — restores from a named checkpoint and does not write back. Run stateful to reach a state, `studio_save_checkpoint { name }` to snapshot it, then regression tests always start from the same state.

### Executable assertions

Five kinds:

| kind | required | judges |
|---|---|---|
| `tool-executed` | `tool` | the tool actually executed (not denied) at least `count` times (default 1) |
| `tool-denied` | `tool` | the call was denied by a guard; `reasonIncludes` checks a substring of the denial reason |
| `tool-result-path` | `tool`, `path`, `equals` | the tool's delivered result (post-transform, as the model received it) at the JSON path (e.g. `$.openCount`) deep-equals the expected value; `occurrence` picks the Nth call (default last) |
| `reply-includes` | `text` | the final model reply contains the text |
| `hook-observed` | `lifecycle` | the hook actually fired; `feature` / `method` / `subject` (associated tool) narrow the match |

Notes:

- `tool-result-path` sees the transform-delivered result — assert masked values there, not raw ones.
- For guard-rejection tests use `tool-denied`; do not put the rejected tool in a `tool-executed` assertion.
- `description` fields (test and assertion level) carry intent for humans; they never affect the verdict.

## Test Runtime

`studio_start_runtime` spawns an independent process that mounts every project Feature in `static inject` dependency order (init failures fail the start), running a minimal agent whose system message is built from the project name, goal, and target Agent. The model resolves from the `modelPreset` argument, then the agent-studio configuration, then the global default.

- The Runtime runs in the project directory environment; file, shell, and network effects are real.
- Sessions and checkpoints live under the project's `.agent-studio/` directory; the stateful session survives stop/start.
- Each `studio_run_test` first syncs source: new Features are mounted, changed modules hot-reload. A reload or init failure rolls back to the last working revision automatically; the Runtime stays testable.
- The Runtime appears in the left-side agent list as `studio-sandbox:<project>`; users can view its session but cannot type into it — test input comes only from `studio_run_test`. Its logs join the debug stream tagged `studio-run:<runId>`, so debugging tools can filter records for a single test run.

## Reading run results

The `studio_run_test` return value is the full result; use `studio_get_run` to revisit (with `runId` for the full record, without for a recent list).

- `passed: true` — every assertion passed. `passed: false` — check `assertionResults`: each entry carries `ok` and a concrete `detail` (expected vs actual value, path, counts).
- `phase: "reload"` with `ok: false` — hot-reload failed and the test never ran; check `stage` and `error` in `reloadSummary`. The Runtime already rolled back; fix the source and retry.
- `toolCalls` — per-tool evidence in call order: `feature` attribution, `denied` flag (with the guard reason when denied), and `result` — the final delivered result the model received.
- `hooks` — every hook that actually fired: feature / method / lifecycle / kind / subject / decision / durationMs.
- `featureCoverage` — evidence grouped by owning Feature: executed tools, denied tools, and hook signatures.
- `featureRevisions` — the source fingerprint each Feature was actually running in this run; use it to confirm which revision a result belongs to.
- `session` — the policy used, where it restored from, and where it saved.
- For a quick check without a saved test, pass `input` + `assertions` directly.

## Framework references

Three companion skills ship with this feature. Invoke them before and during implementation — do not guess framework contracts from memory:

- `agentdev-feature-guide` — the complete Feature development reference: capability boundaries, tool contracts, lifecycle methods, hook design, state capture/restore, configuration manifests, and troubleshooting. Read it before designing any Feature beyond a simple tool; its `references/` directory has per-topic deep dives (runtime, tools, quality, examples).
- `agentdev-agent-assembly` — how to assemble an agent from features (BasicAgent, feature ordering, target agent configuration).
- `agentdev-feature-packaging` — packaging and delivering a verified Feature as a distributable artifact.

For the module declaration schema (`static hooks`, `static inject`, lifecycle values), the quick reference above covers daily use; `agentdev-feature-guide` is the authority.

## Status terms

- `implemented` — source exists (initial state after `studio_add_feature`).
- `mounted` — the Test Runtime has loaded the Feature's current source. A hot reload returns the Feature here: the previous `verified` no longer holds.
- `verified` — some passed run's evidence (executed tools / denials / fired hooks) is attributed to this Feature. Each Feature keeps its own ledger; `verification` records the source runId, time, and coverage detail.
- `packaged` — a distributable artifact exists.
- `published` — a shared repository or external system has changed.

Only Runtime-produced results support the first three; never claim `mounted` or `verified` from source edits alone. Confirm with the user before packaging, publishing, or calling APIs with real external effects. Feature reload rollback restores code and state inside the Runtime only; external side effects that already happened are not undone.
