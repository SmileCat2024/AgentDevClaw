# Runtime input lease protocol

## Purpose

`shared-by-project` and `isolated` are host-placement choices. They must not
change the way an interactive user turn is addressed, accepted, or restored.
This document defines the common input contract used by both modes.

## Identity model

Every submitted interaction is addressed through four distinct identities:

1. **Logical session** — the Claw workspace/session record selected by the
   user.
2. **Host process** — an isolated process, or a process shared by sessions in
   the same project group.
3. **Runtime Agent** — the stable AgentDev `viewerAgentId` allocated for one
   Agent instance inside that host. This is the route used by ViewerWorker.
4. **Input lease** — the one active, request-scoped permission for that
   runtime to consume a user response.

The relation is always `logical session -> runtime Agent -> input lease`.
The host process is deliberately not part of the input route, so sharing a
host never merges its sessions' input state.

## Invariants

- A host must finish its shared DebugHub connection barrier before any Agent
  registers or emits input state.
- Each runtime Agent owns **zero or one** active input lease. A later lease is
  a state replacement only during reconnect reconciliation; it is never an
  additional UI card.
- The ViewerWorker owns a per-runtime FIFO mailbox for normal text turns.
  A text turn is accepted while the runtime is connected even before its input
  loop has opened a lease.
- A choice lease is exclusive. A free-form turn is rejected with
  `input_mode_conflict` until that choice is resolved or interrupted.
- Reconnect registration is a full snapshot: it replaces a worker's former
  lease, including mode and questions. It must not append to it.
- Every input control captures the runtime Agent ID when it is rendered.
  Completion of an old card may not mutate whichever chat became selected
  later.

`callActive` is presentation state only. It is never an admission condition
for a connected runtime's mailbox.

## Delivery state machine

```text
connected runtime + no lease
  -- user turn --> mailbox
  -- text lease opens --> atomically deliver oldest mailbox item

connected runtime + text lease
  -- user turn --> deliver to that lease, then clear it

connected runtime + choice lease
  -- user turn --> input_mode_conflict
  -- matching choice response --> deliver, then clear it
```

The same transitions apply to a newly created session, a compacted successor,
and a long-lived session restored into either process mode.

## Ownership by layer

| Layer | Owns | Must not infer |
| --- | --- | --- |
| AgentDev `DebugHub` | host connection barrier, runtime registration, local promise/lease lifecycle | selected UI Agent |
| AgentDev `ViewerWorker` | runtime lease, mailbox, atomic delivery and reconnect reconciliation | call activity as input eligibility |
| Claw runtime manager | logical-session to runtime-Agent mapping and host placement | a shared host as a shared input identity |
| Claw browser | rendering and submitting controls bound to the rendered runtime | the target from `currentRuntimeAgentId` at completion time |

## Compatibility

`isolated` mode is simply a host containing one runtime Agent. In
`shared-by-project`, several runtime Agents use the same host connection but
retain separate leases and mailboxes. No mode-specific input API or fallback
route is permitted.
