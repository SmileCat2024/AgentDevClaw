---------------------- MODULE RetirementRecovery ----------------------
EXTENDS Naturals
CONSTANTS StopBeforeCommit, RecoverRegistration, FairRecovery, StopFails
VARIABLE s
vars == <<s>>
Init == s = [head |-> 1, oldAlive |-> TRUE, newReady |-> FALSE,
  adopted |-> FALSE, pending |-> TRUE, committed |-> FALSE,
  crashed |-> FALSE, registry |-> TRUE, recovered |-> FALSE,
  staleClaim |-> FALSE, stopTried |-> FALSE]
Prepare == /\ ~s.newReady /\ ~s.crashed
  /\ s' = [s EXCEPT !.newReady = TRUE]
Stop == /\ ~s.stopTried /\ ~s.crashed
  /\ (StopBeforeCommit \/ s.committed)
  /\ s' = [s EXCEPT !.stopTried = TRUE, !.oldAlive = IF StopFails THEN @ ELSE FALSE]
Commit == /\ s.newReady /\ ~s.committed /\ ~s.crashed
  /\ (~StopBeforeCommit \/ ~s.oldAlive)
  /\ s' = [s EXCEPT !.head = 2, !.committed = TRUE]
Adopt == /\ s.committed /\ ~s.adopted /\ ~s.crashed
  /\ s' = [s EXCEPT !.adopted = TRUE]
OldClaim == /\ s.committed /\ s.oldAlive /\ s.registry /\ ~s.crashed
  /\ s' = [s EXCEPT !.staleClaim = TRUE]
Crash == /\ ~s.crashed /\ ~s.recovered
  /\ s' = [s EXCEPT !.crashed = TRUE, !.registry = FALSE,
    !.oldAlive = FALSE, !.newReady = FALSE, !.adopted = FALSE]
Recover == /\ s.crashed /\ ~s.recovered
  /\ s' = [s EXCEPT !.recovered = TRUE, !.crashed = FALSE,
    !.registry = RecoverRegistration, !.newReady = s.committed,
    !.adopted = (RecoverRegistration /\ s.committed)]
Deliver == /\ s.committed /\ s.pending /\ s.adopted /\ s.registry /\ ~s.crashed
  /\ s' = [s EXCEPT !.pending = FALSE]
Next == Prepare \/ Stop \/ Commit \/ Adopt \/ OldClaim \/ Crash \/ Recover \/ Deliver \/ UNCHANGED vars
Progress == Prepare \/ Stop \/ Commit \/ Adopt \/ Recover \/ Deliver
Spec == Init /\ [][Next]_vars /\ (FairRecovery => WF_vars(Progress))
TypeOK == s.head \in 1..2
CommittedHeadSurvivesCrash == s.committed => s.head = 2
NoOldClaimAfterCommit == ~s.staleClaim
ReadyBeforeCommit == s.committed => (s.newReady \/ s.crashed \/ s.recovered)
EventuallyDelivered == <> (~s.pending)
=============================================================================
