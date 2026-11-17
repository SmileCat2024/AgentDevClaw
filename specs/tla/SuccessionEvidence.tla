---------------------- MODULE SuccessionEvidence ----------------------
EXTENDS Naturals
\* One delivered command. Board evidence and Session ownership are separate.
\* DeferredEvidence and MutateMissingEvidence are model-only controls.
CONSTANTS Integrity, DeferredEvidence, MutateMissingEvidence
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "start", snapshot |-> FALSE, context |-> FALSE,
  emitted |-> FALSE, board |-> FALSE, sampled |-> FALSE, observed |-> FALSE,
  committed |-> FALSE, rejected |-> FALSE, classified |-> FALSE,
  unresolved |-> FALSE, notice |-> FALSE, crashed |-> FALSE]
Start == /\ s.phase = "start"
  /\ s' = [s EXCEPT !.phase = "append", !.emitted = ~DeferredEvidence]
Append == /\ s.phase = "append"
  /\ s' = [s EXCEPT !.context = TRUE, !.phase = "save"]
Save == /\ s.phase = "save"
  /\ s' = [s EXCEPT !.snapshot = TRUE, !.phase = "ready", !.emitted = TRUE]
SaveFails == /\ s.phase = "save"
  /\ s' = [s EXCEPT !.phase = "failed"]
ReceiveEvidence == /\ s.emitted /\ ~s.board
  /\ s' = [s EXCEPT !.board = TRUE]
ReadEvidence == /\ ~s.sampled
  /\ s' = [s EXCEPT !.sampled = TRUE,
    !.observed = (Integrity = "ok" /\ s.board)]
Commit == /\ s.sampled /\ ~s.committed /\ ~s.rejected
  /\ Integrity /= "unreadable"
  /\ LET proof == s.observed \/ MutateMissingEvidence
     IN s' = [s EXCEPT !.committed = TRUE, !.classified = proof,
       !.unresolved = ~proof, !.notice = ~proof]
RejectRead == /\ s.sampled /\ Integrity = "unreadable" /\ ~s.rejected
  /\ s' = [s EXCEPT !.rejected = TRUE]
Crash == /\ ~s.crashed
  /\ s' = [s EXCEPT !.crashed = TRUE, !.context = s.snapshot,
    !.phase = "stopped"]
Next == Start \/ Append \/ Save \/ SaveFails \/ ReceiveEvidence
  \/ ReadEvidence \/ Commit \/ RejectRead \/ Crash \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.phase \in {"start", "append", "save", "ready", "failed", "stopped"}
  /\ \A k \in DOMAIN s \ {"phase"} : s[k] \in BOOLEAN
EvidenceOrUnresolved == s.committed => (s.classified \/ s.unresolved)
MissingNeverProvesConsumption == (s.committed /\ ~s.observed) => s.unresolved
UnreadableCannotAdvance == Integrity = "unreadable" => ~s.committed
NoticeAtomicWithUnresolved == s.notice = s.unresolved
ClassificationRequiresSnapshot == s.classified => s.snapshot
=============================================================================
