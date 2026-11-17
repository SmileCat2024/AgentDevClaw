-------------------------- MODULE ReceiptBoundaryDeep --------------------------
EXTENDS Naturals, Sequences, FiniteSets

\* Viewer receipt protocol. This is NOT a WorkThread-record model: Viewer
\* consumption does not directly change the Inbox command's delivered status.
\* One Viewer agent/session slot; two runtime incarnations, optional identity
\* adoption. Global thread head and other runtime slots live in SuccessionWindow.
CONSTANTS CommandCount, HistoryCap, EnableIdentityChange, EnableRetry,
          AllowSaveFailure, ProbeMemoryShortcut, FairProgress,
          MutateLeaseFence, MutateFifo
Commands == 1..CommandCount
Range(s) == {s[i] : i \in DOMAIN s}
KeepLast(s) == IF Len(s) <= HistoryCap THEN s
               ELSE SubSeq(s, Len(s)-HistoryCap+1, Len(s))

VARIABLE s
vars == <<s>>
Init == s = [
  queue |-> [i \in Commands |-> i],
  queuedGen |-> [c \in Commands |-> 1],
  leaseRuntime |-> [c \in Commands |-> 0],
  leaseGen |-> [c \in Commands |-> 0],
  generation |-> 1, runtime |-> 1,
  context |-> {}, snapshot |-> {}, consumed |-> {}, cancelled |-> {},
  consumedLog |-> <<>>, cancelledLog |-> <<>>,
  active |-> 0, clientRuntime |-> 0, clientGen |-> 0, phase |-> "idle",
  restarted |-> FALSE, adopted |-> FALSE, failed |-> FALSE,
  repeated |-> FALSE, ackLost |-> FALSE, ordinary |-> FALSE,
  badDurability |-> FALSE, badFence |-> FALSE, badOrder |-> FALSE,
  retryRejected |-> FALSE, requeued |-> FALSE, exposedCancelled |-> {}]

\* Claim is repeatable; a same-incarnation retry returns the persisted lease.
\* Runtime/gen change invalidates the earlier lease. Cancel does not clear the
\* client Context or its in-flight HTTP request.
Claim ==
  /\ s.phase = "idle" /\ Len(s.queue) > 0
  /\ LET c == IF MutateFifo THEN s.queue[Len(s.queue)] ELSE Head(s.queue)
     IN /\ s.queuedGen[c] = s.generation
        /\ s' = [s EXCEPT !.active = c, !.clientRuntime = s.runtime,
               !.clientGen = s.generation,
               !.leaseRuntime[c] = s.runtime, !.leaseGen[c] = s.generation,
               !.phase = IF ProbeMemoryShortcut /\ c \in s.context
                          THEN "ack" ELSE "append",
               !.badOrder = @ \/ (c /= Head(s.queue))]
AppendContext ==
  /\ s.phase = "append"
  /\ s' = [s EXCEPT !.context = @ \cup {s.active}, !.phase = "save"]
SaveSnapshot ==
  /\ s.phase = "save"
  /\ s' = [s EXCEPT !.snapshot = s.context, !.phase = "ack"]
SaveFails ==
  /\ AllowSaveFailure /\ ~s.failed /\ s.phase = "save"
  /\ s' = [s EXCEPT !.failed = TRUE, !.phase = "idle", !.active = 0]

ExactIdentity == s.clientRuntime = s.runtime /\ s.clientGen = s.generation
ExactLease == s.active \in Range(s.queue)
              /\ s.leaseRuntime[s.active] = s.clientRuntime
              /\ s.leaseGen[s.active] = s.clientGen
CanAck == (ExactIdentity /\ ExactLease) \/
          (MutateLeaseFence /\ s.active \in Range(s.queue))
AckAccepted ==
  /\ s.phase = "ack" /\ CanAck
  /\ s' = [s EXCEPT
       !.queue = SelectSeq(@, LAMBDA c : c /= s.active),
       !.consumed = @ \cup {s.active},
       !.consumedLog = KeepLast(Append(@, s.active)),
       !.badDurability = @ \/ (s.active \notin s.snapshot),
       !.badFence = @ \/ ~ExactIdentity,
       !.phase = "response"]
ReceiveResponse ==
  /\ s.phase = "response"
  /\ s' = [s EXCEPT !.phase = "ready"]
LoseResponse ==
  /\ EnableRetry /\ ~s.ackLost /\ s.phase = "response"
  /\ s' = [s EXCEPT !.ackLost = TRUE, !.phase = "retry"]
RetryAck ==
  /\ s.phase = "retry"
  /\ s' = [s EXCEPT
       !.retryRejected = @ \/ ~ExactIdentity \/
                          (s.active \notin Range(s.consumedLog)),
       !.phase = "idle", !.active = 0]
AckRejected ==
  /\ s.phase = "ack" /\ ~CanAck
  /\ s' = [s EXCEPT !.phase = "idle", !.active = 0]
RunModel ==
  /\ s.phase = "ready"
  /\ s' = [s EXCEPT !.phase = "idle", !.active = 0,
       !.exposedCancelled = @ \cup (s.context \cap s.cancelled)]
OrdinaryCall ==
  /\ s.phase = "idle" /\ ~s.ordinary
  /\ s' = [s EXCEPT !.ordinary = TRUE,
       !.exposedCancelled = @ \cup (s.context \cap s.cancelled)]
CancelQueued ==
  /\ Len(s.queue) > 0
  /\ s' = [s EXCEPT !.cancelled = @ \cup Range(s.queue),
       !.cancelledLog = KeepLast(@ \o s.queue), !.queue = <<>>]

\* An independent delayed request can be retried while an earlier client's
\* ack response is pending. This is a request-admission probe, NOT a claim
\* that WorkThread's normal delivered-command path necessarily resends it.
Resubmit(c) ==
  /\ EnableRetry /\ ~s.repeated
  /\ c \in s.consumed \cup s.cancelled
  /\ c \notin Range(s.consumedLog) \cup Range(s.cancelledLog) \cup Range(s.queue)
  /\ s' = [s EXCEPT !.queue = Append(@, c), !.queuedGen[c] = s.generation,
       !.leaseRuntime[c] = 0, !.leaseGen[c] = 0,
       !.repeated = TRUE, !.requeued = TRUE]

\* Runtime registration can change while an earlier request is still in flight.
\* Crash discards volatile Context and pending client work; Viewer queue/log
\* persist. A successful snapshot is restored before another claim.
Restart ==
  /\ ~s.restarted
  /\ s' = [s EXCEPT !.restarted = TRUE, !.runtime = 2,
       !.context = s.snapshot, !.phase = "idle", !.active = 0]
ReplaceRegistration ==
  /\ EnableIdentityChange /\ ~s.adopted
  /\ s' = [s EXCEPT !.adopted = TRUE, !.generation = 2]

Next == Claim \/ AppendContext \/ SaveSnapshot \/ SaveFails \/ AckAccepted
  \/ ReceiveResponse \/ LoseResponse \/ RetryAck \/ AckRejected \/ RunModel
  \/ OrdinaryCall \/ CancelQueued \/ Restart \/ ReplaceRegistration
  \/ (\E c \in Commands : Resubmit(c)) \/ UNCHANGED vars
Progress == Claim \/ AppendContext \/ SaveSnapshot \/ AckAccepted
            \/ ReceiveResponse \/ RetryAck \/ AckRejected \/ RunModel
Spec == Init /\ [][Next]_vars /\ (FairProgress => WF_vars(Progress))

TypeOK ==
  /\ s.queue \in Seq(Commands) /\ Len(s.queue) <= CommandCount
  /\ Cardinality(Range(s.queue)) = Len(s.queue)
  /\ s.context \subseteq Commands /\ s.snapshot \subseteq Commands
  /\ s.consumed \subseteq Commands /\ s.cancelled \subseteq Commands
  /\ Len(s.consumedLog) <= HistoryCap /\ Len(s.cancelledLog) <= HistoryCap
  /\ s.runtime \in 1..2 /\ s.generation \in 1..2
  /\ s.active \in 0..CommandCount
  /\ s.phase \in {"idle", "append", "save", "ack", "response", "retry", "ready"}
NoSilentDisappearance == Range(s.queue) \cup s.consumed \cup s.cancelled = Commands
NoCrossIdentityAck == ~s.badFence
FifoClaim == ~s.badOrder
AckRequiresSnapshot == ~s.badDurability
CancelledPayloadNeverReachesModel == s.exposedCancelled = {}
NoReAdmissionAfterHistoryEviction == ~s.requeued
NoCancelledReAdmission == ~(s.requeued /\ s.repeated /\ (Range(s.queue) \cap s.cancelled /= {}))
AckRetryAlwaysAccepted == ~s.retryRejected
\* Under bounded faults and unchanged identity, all original queue entries
\* eventually leave the queue for consumed/cancelled. No business completion
\* or external-tool exactly-once guarantee is implied.
EventuallyDisposed == <> (s.queue = <<>>)
=============================================================================
