# @agentdevjs/force-continuation

A session-local AgentDev Feature that keeps a task moving after recoverable interruptions: provider output truncation (`max_tokens` / `length`) and the framework-level ReAct step budget being exhausted (`CallOutcome.reason = limit_reached`).

## Behavior and safety boundary

- **Default: disabled.** Mounting the Feature never turns on automatic continuation.
- The master switch gates three independently toggleable candidates: provider `max_tokens`, provider `length`, and framework `limit_reached`.
- When enabled, its `StepFinish` guard adds one clear continuation reminder and returns `Approve` only after a no-tool model response whose provider stop reason is an enabled truncation candidate.
- Framework `limit_reached` is handled at the Call boundary: the Claw host `CallArbiter` asks the Feature whether to start a follow-up Call segment.
- It never overrides a user cancellation, API failure, runtime error, or ordinary `end_turn` response.
- Consecutive forced continuations are capped (default: 3; configurable from 1 to 10) to prevent loops.
- State is snapshot/restored with the session: enabled status, trigger switches, recent stop reasons, and the latest terminal state are retained.

## Configuration

```ts
new ForceContinuation({
  enabled: false,
  maxConsecutiveContinuations: 3,
  triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
});
```

The Feature manifest exposes the same values to compatible configuration UIs. In Claw's Programming Helper, the right-side **Force Continuation / 强制继续** panel is the intended session-local switch surface.

## Observability

The Feature deliberately exposes **no tools to the Agent** — it is a fully automatic policy and the side-panel session IPC is its only control surface. It participates in `StepFinish` and `CallFinish` inspector hooks, and the panel reads the current switch/counter/stop-reason state through the host bridge.

## Development

```bash
npm install
npm run build
```
