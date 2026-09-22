# Context Mutation and Session Integrity Investigation

Date: 2026-06-18  
Repository: AgentDevClaw  
Primary area: prebuilt workspace sessions, context handoff, rollback checkpoints, compact/resume

## Summary

Rollback itself is not the main failure. When a session has a coherent mapping between user-message `turn`, runtime `callIndex`, and `rollbackHistory[].callIndex`, the current rollback and partial-compact flow works. The persistent failure cases come from malformed session records.

The dominant malformed patterns are:

- Compacted or trimmed resume sessions replay old `seedMessages` with their original `turn` values, while the new runtime starts `_callIndex` from `-1`. The first real user input in the resumed session becomes `turn=0`, producing histories such as `0,1,2,3,4,5,0`.
- Step-level auto-save can persist messages before the enclosing `onCall()` reaches `commitCallCheckpoint()`. If the process is stopped, restarted, interrupted, or crashes in that window, the session can contain user/assistant/tool messages for a turn without the matching rollback checkpoint.
- Older branch-session creation logic reset `runtime.callIndex` to `0` and preserved an incomplete checkpoint set. This explains branch sessions with many user turns but only `rollbackHistory=[0]`.
- Some repeated `turn` values are not necessarily corruption: queued input or IM messages can append multiple user messages under one `callIndex`. That is valid at the framework level, but unsafe for a UI that treats every user message as an independently rollbackable call.

The durable fix should not be another one-off patch in the rollback button. It should clarify the session invariants and route all future context-changing features through a small number of framework-owned, atomic session transformation APIs.

## Expected Invariants

For the current rollback model, a normal interactive call should satisfy:

```text
user message turn === checkpoint.callIndex === runtime call index for that user call
```

More precisely:

- `runtime.callIndex` is the last completed or current call index.
- Every rollbackable user call must have exactly one checkpoint with the same `callIndex`.
- A checkpoint for call `N` represents the runtime state before call `N`'s user message is injected.
- `rollbackHistory` may intentionally omit checkpoints that were pruned after a rollback to an earlier call, but then the corresponding user messages should no longer be offered as rollback targets unless new checkpoints are created.
- Messages injected as imported context, summaries, or replayed history must not be confused with new local user calls unless the runtime call counter and checkpoints are also made consistent.

The important distinction is:

```text
message history is not the same thing as call history
```

Rollback is based on call history. UI rendering is based on messages. Any feature that mutates messages must either preserve call history or explicitly declare the resulting messages non-rollbackable.

## Evidence From Real Sessions

The following real workspace session categories were observed under:

```text
C:\Users\zty20\.agentdev\AgentDevClaw\workspaces\programming-helper\sessions
```

### Healthy Control Session

`session-1781755408012-b390bb`

Observed shape:

```text
users: 0,1,2
runtime.callIndex: 2
rollbackHistory: 0,1,2
```

This session was tested manually and rollback/partial compact behaved normally. This proves the current rollback path can work when the session record is coherent.

### Compacted Resume With Turn Reset

`session-1779699729225-d6d14c`

Index metadata:

```text
resumeMode: compacted
handoffPath: ...\handoff-1779699723699-17789cb3.json
```

Handoff shape:

```text
mode: trim-transcript
seed user turns: 0,1,2,3,4,5
```

Final session shape:

```text
user turns: 0,1,2,3,4,5,0
runtime.callIndex: 0
rollbackHistory: 0
```

This is a structural mismatch: replayed seed messages retain old turns, but the newly started runtime begins its local call index at `0`.

### Step Auto-Save Without Matching Checkpoint

`session-1781754115648-14191f`

Observed shape:

```text
user turns: 0,1,2,3
rollbackHistory: 0,2,3
missing checkpoint: 1
```

Checkpoint details show:

```text
checkpoint 2 runtime contains users 0 and 1
checkpoint 1 is absent
```

This means call 1's messages were already persisted into the runtime context, but the checkpoint for call 1 was never committed or was later removed. The most plausible path is step auto-save persisting an in-progress call, followed by process stop/restart/interruption before `onCall()` reached its final `commitCallCheckpoint()`.

### Branch Session With Reset Counter

`session-1781754438242-f3d1ab`

Observed shape:

```text
title: 分支会话 ...
user turns: 0,1,2,3,4
runtime.callIndex: 0
rollbackHistory: 0
```

This matches the previously identified branch-session issue: branch snapshots were created with `runtime.callIndex` reset to `0`, rather than using the maximum retained user turn.

## Root Cause 1: Handoff Replay Is Not a Runtime Snapshot

`trim-transcript` handoff is a message replay format. It preserves a selected subset of old conversation messages:

```js
seedMessages.push({ ...message, turn });
```

Then `ContextHandoffSeedFeature` injects them during the first `CallStart`:

```ts
ctx.context.add({ ...message, turn });
```

This is reasonable if the seed messages are treated as imported context. It is not sufficient if the resumed session is meant to behave like a normal continuation with rollback support.

The missing operation is one of:

- Rewrite seed message turns into a reserved imported-context turn space.
- Advance the runtime `_callIndex` to the maximum seed user turn before accepting new user input.
- Create synthetic rollback checkpoints for replayed turns.
- Mark seed messages as non-local/non-rollbackable and hide rollback affordances for them.

The current code effectively does none of these consistently. It replays old turns and then lets local calls start from zero.

### Why `summarized-nine-section` Is Less Dangerous But Still Needs Rules

Summarized handoff currently creates a single system seed message:

```js
{
  role: 'system',
  turn: 0,
  content: '以下是前一会话的工作摘要...'
}
```

This does not create multiple user turns, so it avoids the worst replay issue. But it still uses `turn=0`, which can overlap with the first local user call. That may be fine for rendering, but it is not semantically precise.

Summary context should ideally use one of:

- no `turn`,
- a reserved turn such as `-1`,
- explicit metadata like `source: 'handoff-summary'`,
- a framework-level context segment type.

## Root Cause 2: Step Auto-Save Persists Half-Committed Calls

The current execution order in `Agent.onCall()` is:

1. Increment `_callIndex`.
2. Capture pre-call runtime checkpoint.
3. Run `CallStart` hooks.
4. Add the user message.
5. Run ReAct steps.
6. Step auto-save may save after each step.
7. Commit call rollback checkpoint only after ReAct finishes.

This creates a valid crash window:

```text
messages for call N persisted
checkpoint for call N not yet persisted
```

That state is good enough for viewing history, but not good enough for rollback.

This is probably why some sessions have continuous user turns but missing checkpoints, especially missing only one checkpoint in the middle or at the tail.

## Root Cause 3: Branching Must Preserve Runtime Counters

A branch is not a new empty conversation if it preserves old messages. It is a new session file with an already-populated context.

Therefore the branch runtime must be initialized with:

```text
runtime.callIndex = max retained local user call index
rollbackHistory = retained checkpoints that correspond to retained messages
```

The current repair direction in `server.js` follows this model by computing `maxUserTurn` and filtering checkpoints. That is correct as a first-order fix.

However, if the source session is already malformed, the branch will inherit malformation unless the branch creation path also validates and repairs or marks unsafe rollback targets.

## Root Cause 4: Multiple User Messages Can Belong to One Call

The ReAct loop can inject queued input at step boundaries:

```ts
context.addUserMessage(queuedInput, callIndex)
```

This means repeated user turns can be legitimate:

```text
turn 4: original user input
turn 4: queued/IM follow-up while call 4 is still active
```

This is not a rollback-history corruption by itself. The problem appears when UI code treats every user message as a rollbackable call boundary.

The UI should distinguish:

- rollbackable call-start user messages,
- additional user messages inside the same call,
- imported seed user messages,
- synthetic summary/system messages.

## Restart, Interruption, and Half-Finished Calls

Restart and interruption matter in two different ways.

### Runtime Restart After Handoff

`startManagedAgent()` currently re-adds `PROTOCLAW_HANDOFF_PATH` whenever a session index record has `metadata.handoffPath`.

That means compacted-resume sessions are forever launched with handoff seed available. In a fully saved session, `ContextHandoffSeedFeature` should restore `injected=true` and skip injection. But if the first injection occurred and the process was killed before feature state was saved, the next restart will inject again.

Even without double injection, the first injection still has the callIndex alignment problem described above.

### User Interrupt or Process Stop During a Call

When a call is interrupted at a safe point, the runtime may have:

- user message already written,
- assistant/tool messages partially written,
- feature state updated,
- no final call checkpoint committed.

Step auto-save increases recoverability but also increases the chance of persisting a state that is valid for display and invalid for rollback.

This does not mean step auto-save is wrong. It means step auto-save snapshots need an explicit "in-progress call" representation.

## Design Principle: Context Mutations Must Be Transactional

Features that change context are not just editing an array of messages. They are editing a runtime state machine.

The state machine includes:

- `runtime.context.messages`,
- `runtime.context.enrichedMessages`,
- `runtime.context.sequence`,
- `runtime.callIndex`,
- `rollbackHistory`,
- `namedCheckpoints`,
- feature state snapshots,
- usage statistics,
- viewer/debugger state,
- session index metadata.

Future context-changing features should not hand-edit only `messages`.

They should use a transaction-like operation:

```text
begin context transform
  validate source state
  compute new context
  compute new callIndex
  compute rollback checkpoints
  compute feature states
  save snapshot atomically
  publish viewer update
end context transform
```

If any part cannot be computed safely, the resulting session should disable rollback for affected messages.

## Recommended Long-Term API Shape

Introduce framework-owned APIs rather than feature-local message surgery.

### 1. `restoreSessionSnapshot` Remains Low-Level

This is still useful, but should be treated as raw state restore, not as an editing primitive for product features.

### 2. Add A Session Transform API

Example shape:

```ts
await agent.transformSession({
  reason: 'compact-resume' | 'trim' | 'branch' | 'partial-compact',
  transform(current) {
    return {
      runtime,
      rollbackHistory,
      namedCheckpoints,
      featureStates,
      metadata,
    };
  },
});
```

The framework should validate:

- user turns are monotonic within local call history,
- rollback checkpoints refer to existing local calls,
- no rollbackable UI marker points to a missing checkpoint,
- imported context is marked as imported,
- `_callIndex` is not behind the max local call index.

### 3. Separate Imported Context From Local Conversation

Handoff seed messages should not masquerade as local user calls.

A better schema would mark them:

```json
{
  "role": "user",
  "content": "...",
  "turn": 3,
  "source": "handoff-seed",
  "rollbackable": false,
  "origin": {
    "sessionId": "source-session",
    "turn": 3
  }
}
```

Alternatively, imported context can be stored as a separate context segment:

```json
{
  "contextSegments": [
    { "kind": "system", "messages": [...] },
    { "kind": "imported-history", "messages": [...] },
    { "kind": "local-history", "messages": [...] }
  ]
}
```

The second model is cleaner long term, but more invasive.

### 4. Make Rollback Capability Explicit

The frontend should not infer rollbackability from `msg.role === 'user'`.

Better options:

- Backend exposes available rollback call indices.
- Message objects include `rollbackable: true`.
- Input requests include `rollbackTargets`.
- ViewerWorker exposes checkpoint metadata.

Example:

```json
{
  "actions": [
    {
      "id": "rollback_to_call",
      "targets": [0, 1, 2]
    }
  ]
}
```

Then the UI only shows "回退到此轮" for messages whose turn is in the actual checkpoint set.

## Recommended Immediate Fixes

### Fix 1: Stop Auto-Reinjecting Handoff For Already-Started Sessions

`startManagedAgent()` currently adds `PROTOCLAW_HANDOFF_PATH` from session metadata on every start.

Safer rule:

- Only pass `PROTOCLAW_HANDOFF_PATH` when the session file does not exist, or when the existing session has no messages.
- If the session snapshot already has `context-handoff-seed` state `injected=true`, do not pass the handoff env.
- If the snapshot has any local user messages, do not pass handoff env.

This prevents repeated injection after restart.

### Fix 2: Align Call Index After Handoff Seed Injection

If replayed seed messages are kept as real messages, then after injecting them:

```text
agent._callIndex = max(seed user turns)
```

But this alone is incomplete because rollback checkpoints for seed turns still do not exist. Therefore either:

- mark seed messages non-rollbackable, or
- create synthetic checkpoints for seed turns, or
- remap seed turns into imported/nonlocal space and start local turns from `0`.

The lowest-risk immediate fix is:

- mark seed messages `source: 'handoff-seed'`,
- mark them `rollbackable: false`,
- set local call index so new calls do not collide.

### Fix 3: Commit Pending Rollback Checkpoint Before Step Auto-Save

Before the first step auto-save of call `N`, the session should already contain a rollback checkpoint for call `N`.

The checkpoint can be captured before user injection as it is today, but it should be persisted into `_callCheckpoints` earlier. If the call later fails, the checkpoint remains valid: it still represents the state before the call began.

This changes the failure mode from:

```text
messages for turn N exist, checkpoint N missing
```

to:

```text
messages for turn N exist, checkpoint N exists
```

If the call is later rolled back, the checkpoint can still be pruned.

### Fix 4: Add Session Integrity Diagnostics

Add a validation helper used by:

- session load,
- session list metadata writeback,
- branch creation,
- compact/resume creation,
- rollback target rendering.

It should report:

- duplicate or decreasing user turns,
- user turns with no matching checkpoint,
- checkpoints with no corresponding user turn,
- `runtime.callIndex` behind max local user turn,
- handoff seed messages mixed with local rollbackable messages.

Do not silently repair everything at first. Emit structured logs and annotate unsafe sessions so UI can avoid offering rollback actions that will fail.

### Fix 5: Branch From Malformed Sources Conservatively

Branch creation should:

- compute retained user turns,
- keep only checkpoints that exist and correspond to retained turns,
- set `runtime.callIndex` to max retained local turn,
- if checkpoints are incomplete, mark missing turns non-rollbackable.

## Principles For Future Context-Changing Features

### 1. Do Not Treat Context As A Plain Message Array

Any feature that inserts, deletes, rewrites, summarizes, trims, branches, or replays messages must also reason about call counters, checkpoints, feature state, and UI capabilities.

### 2. Imported History Is Not Local History

Imported messages may be useful context, but they did not happen in this runtime. They should carry origin metadata and should not automatically become rollback targets.

### 3. Summary Is A System Continuity Artifact

Summaries should be modeled as continuity artifacts, preferably system messages or separate context segments. They should not consume a local user turn unless the user explicitly submitted them as a new request.

### 4. Replayed Transcript Requires Rebased Turns

If replayed transcript is meant to participate in local call history, rebase it deliberately and create matching checkpoints. If not, keep its original origin turns but mark it imported and non-rollbackable.

### 5. Save Points Must Be Semantically Complete

Every persisted snapshot should declare whether it is:

- a complete call-boundary snapshot,
- an in-progress call snapshot,
- a transformed/imported snapshot.

Rollback should only operate on complete call-boundary snapshots.

### 6. UI Actions Must Be Capability-Driven

The UI should not guess that a message can be rolled back. It should ask runtime/session metadata what actions are valid.

### 7. Context Transformations Should Be Idempotent

Restarting a runtime should not replay the same handoff seed again. Handoff consumption should be recorded in durable session state, not only in volatile process state.

### 8. Prefer Framework-Level Primitives

Product-level code should request operations such as "branch", "compact tail", "resume from summary", or "trim history". The framework should own the invariant-preserving transformation.

## Open Questions

1. Should replayed handoff transcript be rollbackable at all?

   My recommendation: no, at least initially. Mark it imported and non-rollbackable.

2. Should summaries have `turn`?

   My recommendation: no, or use a reserved nonlocal turn. A summary is continuity context, not a user call.

3. Should step auto-save persist in-progress calls?

   Yes, but it must mark them as in-progress or commit the pre-call rollback checkpoint before any step save.

4. Should duplicate user turns always be considered invalid?

   No. Duplicate turns can be valid for queued input in the same call. They are only invalid if the UI treats each duplicate as an independent rollback target.

5. Should old malformed sessions be auto-repaired?

   Cautiously. For old sessions, prefer detection and UI guardrails first. Automatic repair can be added later for clear cases, such as `runtime.callIndex` behind max turn in branch sessions.

## Suggested Execution Strategy

Short term:

1. Add session integrity diagnostics.
2. Hide rollback/partial-compact actions for user messages without matching checkpoints.
3. Stop passing handoff env into already-started sessions.
4. Fix step auto-save/checkpoint ordering.
5. Preserve current branch repair.

Medium term:

1. Mark handoff seed messages as imported and non-rollbackable.
2. Rebase or reserve turns for summaries and imported context.
3. Expose rollback targets explicitly from backend/runtime.
4. Add tests for compacted resume, trim replay, restart after first seed injection, interrupt during step auto-save, and branch from malformed source.

Long term:

1. Introduce a framework-level session transform API.
2. Separate imported context segments from local conversation history.
3. Make every context-changing feature transactional and idempotent.

## Final Diagnosis

The bug is stubborn because it is not one bug. It is several context mutation paths violating the same hidden invariant in different ways.

The invariant was previously implicit:

```text
message turn, runtime callIndex, and rollback checkpoint index must describe the same local call timeline
```

Compacted resume, trim replay, partial save, and branch creation all create or preserve context outside the normal `onCall()` lifecycle. Once context can enter the session by paths other than a completed `onCall()`, the framework needs explicit rules for how that context maps to call history.

The long-term design should make that mapping explicit rather than relying on every feature to remember to update `messages`, `callIndex`, `rollbackHistory`, and feature state by hand.
