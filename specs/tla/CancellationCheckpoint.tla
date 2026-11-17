-------------------- MODULE CancellationCheckpoint --------------------
EXTENDS Naturals, FiniteSets
\* Inbox and Viewer do not share a transaction. Fixed IDs distinguish epochs.
CONSTANTS IncludePending, ScopedRuntimeClear
VARIABLE s
vars == <<s>>
Init == s = [inbox |-> {1, 2}, viewer |-> {1}, cancelled |-> {},
  checkpoint |-> FALSE, frame |-> FALSE, received |-> FALSE,
  appended |-> FALSE, runtimeQueue |-> {}, lostNew |-> FALSE,
  accepted |-> FALSE, mirrorLost |-> FALSE, mirrored |-> FALSE]
Checkpoint == /\ ~s.checkpoint
  /\ s' = [s EXCEPT !.checkpoint = TRUE, !.viewer = {}, !.cancelled = {1},
    !.frame = TRUE, !.accepted = TRUE,
    !.inbox = IF IncludePending THEN {} ELSE @]
AppendAfterCheckpoint == /\ s.checkpoint /\ ~s.appended
  /\ s' = [s EXCEPT !.appended = TRUE, !.inbox = @ \cup {3},
    !.viewer = @ \cup {3}, !.runtimeQueue = @ \cup {3}]
DeliverOldPending == /\ s.checkpoint /\ 2 \in s.inbox /\ 2 \notin s.viewer
  /\ s' = [s EXCEPT !.viewer = @ \cup {2}]
ReceiveInterrupt == /\ s.frame /\ ~s.received
  /\ s' = [s EXCEPT !.received = TRUE,
    !.runtimeQueue = IF ScopedRuntimeClear THEN @ ELSE {},
    !.lostNew = (~ScopedRuntimeClear /\ 3 \in s.runtimeQueue)]
MirrorCancellation == /\ s.received /\ ~s.mirrored /\ ~s.mirrorLost
  /\ s' = [s EXCEPT !.mirrored = TRUE, !.inbox = @ \ {1}]
LoseMirror == /\ s.received /\ ~s.mirrored /\ ~s.mirrorLost
  /\ s' = [s EXCEPT !.mirrorLost = TRUE]
Next == Checkpoint \/ AppendAfterCheckpoint \/ DeliverOldPending
  \/ ReceiveInterrupt \/ MirrorCancellation \/ LoseMirror \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.inbox \subseteq 1..3 /\ s.viewer \subseteq 1..3
  /\ s.cancelled \subseteq 1..3 /\ s.runtimeQueue \subseteq 1..3
NewInputNotCancelled == 3 \notin s.cancelled
PreCheckpointPendingNotDelivered == s.checkpoint => 2 \notin s.viewer
PostCheckpointRuntimeInputSurvives == ~s.lostNew
AcceptedIsNotGlobalCompletion == (s.accepted /\ ~s.mirrored) => 1 \in s.inbox
=============================================================================
