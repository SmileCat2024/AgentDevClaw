----------------------- MODULE DedupContinuity -----------------------
EXTENDS Naturals
CONSTANTS KeepReceipt, ChangeGeneration, InboxRetry
VARIABLE s
vars == <<s>>
Init == s = [history |-> TRUE, receipt |-> TRUE, transformed |-> FALSE,
  evicted |-> FALSE, attempted |-> FALSE, queued |-> FALSE,
  duplicateExecution |-> FALSE]
Transform == /\ ~s.transformed
  /\ s' = [s EXCEPT !.transformed = TRUE, !.receipt = KeepReceipt]
Evict == /\ ~s.evicted
  /\ s' = [s EXCEPT !.evicted = TRUE, !.history = FALSE]
Retry == /\ ~s.attempted /\ s.transformed
  /\ s' = [s EXCEPT !.attempted = TRUE,
    !.queued = (~InboxRetry /\ ~ChangeGeneration /\ ~s.history)]
Consume == /\ s.queued
  /\ s' = [s EXCEPT !.queued = FALSE, !.duplicateExecution = ~s.receipt]
Next == Transform \/ Evict \/ Retry \/ Consume \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == \A k \in DOMAIN s : s[k] \in BOOLEAN
NoDuplicateExecution == ~s.duplicateExecution
InboxDeliveredNotRetried == InboxRetry => ~s.queued
GenerationRejectsOldInput == ChangeGeneration => ~s.queued
=============================================================================
