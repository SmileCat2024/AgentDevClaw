------------------------- MODULE SuccessionWindow -------------------------
EXTENDS Naturals, Sequences, FiniteSets
\* Cross-process delivery window, separate from the Viewer receipt model.
\* Commands start pending in Inbox. A single delivery request captures head,
\* then Viewer accepts/rejects, then WorkThread finalizes its result. Those
\* three events are intentionally NOT one atomic step (real HTTP await).
CONSTANTS CommandCount, FairRecovery, AllowSuccession
Commands == 1..CommandCount
VARIABLE s
vars == <<s>>
Init == s = [head |-> 1, adopted |-> 1, barrier |-> FALSE, held |-> FALSE,
  closed |-> FALSE, committed |-> FALSE, recovering |-> FALSE,
  inbox |-> [c \in Commands |-> "pending"],
  deliveredGen |-> [c \in Commands |-> 0],
  viewer |-> [g \in 1..2 |-> {}],
  consumed |-> [g \in 1..2 |-> {}],
  unresolved |-> {}, request |-> 0, target |-> 0, stage |-> "idle",
  gatedStart |-> FALSE, staleAccepted |-> FALSE]

BeginRequest ==
 /\ s.stage = "idle" /\ ~s.barrier /\ ~s.held /\ ~s.closed
 /\ \E c \in Commands :
      /\ s.inbox[c] = "pending"
      /\ \A earlier \in 1..(c-1) : s.inbox[earlier] /= "pending"
      /\ s' = [s EXCEPT !.request = c, !.target = s.head, !.stage = "wire",
           !.gatedStart = @ \/ s.barrier \/ s.held \/ s.closed]
ViewerAccept ==
 /\ s.stage = "wire"
 \* Old runtime slots retain their old identity until retired. Global head
 \* advancement alone does not revoke old Viewer registration.
 /\ s.target = 1 \/ s.adopted = 2
 /\ s' = [s EXCEPT !.viewer[s.target] = @ \cup {s.request},
      !.stage = "accepted",
      !.staleAccepted = @ \/ (s.target /= s.head)]
ViewerReject ==
 /\ s.stage = "wire" /\ s.target = 2 /\ s.adopted /= 2
 /\ s' = [s EXCEPT !.stage = "idle", !.request = 0]
Finalize ==
 /\ s.stage = "accepted"
 /\ s' = [s EXCEPT
      !.inbox[s.request] = IF @ = "pending" THEN "delivered" ELSE @,
      !.deliveredGen[s.request] = s.target, !.stage = "idle", !.request = 0]
Consume(g,c) ==
 /\ c \in s.viewer[g] /\ c \notin s.consumed[g]
 /\ s' = [s EXCEPT !.consumed[g] = @ \cup {c}]
BeginHandoff ==
 /\ AllowSuccession /\ ~s.committed /\ ~s.barrier /\ ~s.held /\ ~s.closed
 /\ s' = [s EXCEPT !.barrier = TRUE]
CommitHead ==
 /\ s.barrier /\ ~s.committed /\ ~s.held /\ ~s.closed
 \* Evidence read before the transaction is abstracted as a complete current
 \* set; stale/missing evidence requires a separate future fault model.
 /\ s' = [s EXCEPT !.head = 2, !.barrier = FALSE, !.committed = TRUE,
      !.unresolved = @ \cup {c \in Commands : s.inbox[c] = "delivered"
                             /\ c \notin s.consumed[1]}]
AdoptIdentity ==
 /\ s.head = 2 /\ s.adopted = 1
 /\ s' = [s EXCEPT !.adopted = 2]
Hold == /\ ~s.held /\ s' = [s EXCEPT !.held = TRUE]
Close == /\ ~s.closed /\ s' = [s EXCEPT !.closed = TRUE, !.held = TRUE]
\* Later explicit reconciliation (e.g. next succession's evidence scan),
\* not an automatic periodic action promised by current production code.
Reconcile ==
 /\ s.committed /\ ~s.recovering
 /\ s' = [s EXCEPT !.recovering = TRUE,
      !.unresolved = @ \cup {c \in Commands : s.inbox[c] = "delivered"
               /\ s.deliveredGen[c] = 1 /\ c \notin s.consumed[1]}]
Next == BeginRequest \/ ViewerAccept \/ ViewerReject \/ Finalize
 \/ BeginHandoff \/ CommitHead \/ AdoptIdentity \/ Hold \/ Close \/ Reconcile
 \/ (\E g \in 1..2, c \in Commands : Consume(g,c)) \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.head \in 1..2 /\ s.adopted \in 1..2
 /\ s.unresolved \subseteq Commands
 /\ \A c \in Commands : s.inbox[c] \in {"pending", "delivered"}
NoNewRequestThroughGate == ~s.gatedStart
\* A deliberate strong probe, NOT the existing Viewer fencing guarantee.
NoAcceptanceAfterHeadChanged == ~s.staleAccepted
\* G2 probe: an old-head accepted command finalized after commit can escape
\* that commit's classification until a later explicit scan.
NoLateUnclassifiedDelivery == \A c \in Commands :
 (s.committed /\ s.inbox[c] = "delivered" /\ s.deliveredGen[c] = 1)
 => c \in s.unresolved \/ c \in s.consumed[1]
=============================================================================
