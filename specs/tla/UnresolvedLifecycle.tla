----------------------- MODULE UnresolvedLifecycle -----------------------
EXTENDS Naturals
CONSTANTS CarryOpenNotice, ProtectOpen, FairDelivery, Manual, LoseNotice, LegacyUnattributable
VARIABLE s
vars == <<s>>
Init == s = [head |-> 0, open |-> FALSE, resolution |-> "none",
  reissues |-> 0, archived |-> FALSE, closed |-> FALSE, noticeHead |-> 0,
  pending |-> FALSE, seen |-> FALSE, lost |-> FALSE, attempted |-> FALSE,
  pruned |-> FALSE, reopened |-> FALSE]
FirstSuccession == /\ s.head = 0
  /\ s' = [s EXCEPT !.head = 1, !.open = TRUE,
    !.noticeHead = IF Manual THEN 0 ELSE 1, !.pending = ~Manual]
SecondSuccession == /\ s.head = 1 /\ ~s.archived /\ ~s.closed
  /\ s' = [s EXCEPT !.head = 2, !.seen = FALSE,
    !.open = IF LegacyUnattributable THEN TRUE ELSE @,
    !.reopened = (LegacyUnattributable /\ s.resolution # "none"),
    !.noticeHead = IF ~Manual /\ CarryOpenNotice /\ s.open THEN 2 ELSE s.noticeHead,
    !.pending = IF ~Manual /\ CarryOpenNotice /\ s.open THEN TRUE ELSE s.pending]
Resolve(r) == /\ s.open /\ (r \in {"consumed", "discard", "reissue"})
  /\ (r # "reissue" \/ ~s.closed)
  /\ s' = [s EXCEPT !.open = FALSE, !.resolution = r,
    !.reissues = IF r = "reissue" THEN @ + 1 ELSE @]
RetryResolve == /\ ~s.open /\ s.resolution # "none" /\ UNCHANGED vars
Archive == /\ s.head > 0 /\ ~s.archived
  /\ s' = [s EXCEPT !.archived = TRUE, !.pending = FALSE]
Unarchive == /\ s.archived /\ ~s.closed /\ s' = [s EXCEPT !.archived = FALSE]
Close == /\ s.head > 0 /\ ~s.closed
  /\ s' = [s EXCEPT !.closed = TRUE, !.pending = FALSE]
Prune == /\ s.head > 0 /\ ~s.pruned
  /\ s' = [s EXCEPT !.pruned = TRUE,
    !.lost = (~ProtectOpen /\ s.open), !.open = IF ProtectOpen THEN @ ELSE FALSE]
Deliver == /\ s.pending /\ ~s.archived /\ ~s.attempted
  /\ s' = [s EXCEPT !.attempted = TRUE, !.pending = FALSE,
    !.seen = (~LoseNotice /\ s.noticeHead = s.head)]
Next == FirstSuccession \/ SecondSuccession \/ (\E r \in {"consumed", "discard", "reissue"}: Resolve(r))
  \/ RetryResolve \/ Archive \/ Unarchive \/ Close \/ Prune \/ Deliver \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars /\ (FairDelivery => WF_vars(Deliver))
TypeOK == /\ s.head \in 0..2 /\ s.reissues \in 0..1
  /\ s.resolution \in {"none", "consumed", "discard", "reissue"}
NoSilentLoss == ~s.lost
AtMostOneReissue == s.reissues <= 1
ExplicitResolutionStaysClosed == ~s.reopened
ManualDoesNotSeedNotice == Manual => s.noticeHead = 0
OpenNoticeFollowsHead == (s.head = 2 /\ s.open /\ ~s.archived /\ ~s.closed) => s.noticeHead = 2
DeliveredNoticeIsNotDiscovery == (s.attempted /\ LoseNotice) => ~s.seen
EventuallySeen == (s.head = 1 /\ s.open /\ ~s.archived /\ ~s.closed /\ s.pending) ~> (s.seen \/ ~s.open \/ s.archived \/ s.closed \/ s.head = 2)
=============================================================================
