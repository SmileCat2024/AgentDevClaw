------------------------- MODULE ReceiptBoundary -------------------------
EXTENDS Naturals, Sequences, FiniteSets

\* Bounded observation model, not a normative replacement for ADR-0047.
\* ReuseContextReceipt=TRUE maps to the idle mailbox's Context-based shortcut.
\* FALSE isolates the busy drain's always-save receipt boundary for comparison.
CONSTANTS CommandCount, ReuseContextReceipt, AllowSaveFailure
Commands == 1..CommandCount
Range(s) == {s[i] : i \in 1..Len(s)}

VARIABLES queue, contextReceipts, snapshotReceipts, consumed, cancelled,
          phase, active, saveFaultUsed, restartUsed, ordinaryCallUsed,
          exposedCancelled
vars == <<queue, contextReceipts, snapshotReceipts, consumed, cancelled,
          phase, active, saveFaultUsed, restartUsed, ordinaryCallUsed,
          exposedCancelled>>

Init ==
    /\ queue = [i \in Commands |-> i]
    /\ contextReceipts = {}
    /\ snapshotReceipts = {}
    /\ consumed = {}
    /\ cancelled = {}
    /\ phase = "idle"
    /\ active = 0
    /\ saveFaultUsed = FALSE
    /\ restartUsed = FALSE
    /\ ordinaryCallUsed = FALSE
    /\ exposedCancelled = {}

Claim ==
    /\ phase = "idle"
    /\ Len(queue) > 0
    /\ active' = Head(queue)
    /\ phase' = IF ReuseContextReceipt /\ Head(queue) \in contextReceipts
                 THEN "ack" ELSE "append"
    /\ UNCHANGED <<queue, contextReceipts, snapshotReceipts, consumed,
                   cancelled, saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

AppendContext ==
    /\ phase = "append"
    /\ contextReceipts' = contextReceipts \cup {active}
    /\ phase' = "save"
    /\ UNCHANGED <<queue, snapshotReceipts, consumed, cancelled, active,
                   saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

SaveSnapshot ==
    /\ phase = "save"
    /\ snapshotReceipts' = contextReceipts
    /\ phase' = "ack"
    /\ UNCHANGED <<queue, contextReceipts, consumed, cancelled, active,
                   saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

\* Agent's catch retains Context. The arbiter settles, then idle polling retries.
SaveFails ==
    /\ phase = "save"
    /\ AllowSaveFailure
    /\ ~saveFaultUsed
    /\ saveFaultUsed' = TRUE
    /\ phase' = "idle"
    /\ active' = 0
    /\ UNCHANGED <<queue, contextReceipts, snapshotReceipts, consumed,
                   cancelled, restartUsed, ordinaryCallUsed, exposedCancelled>>

AckAccepted ==
    /\ phase = "ack"
    /\ active \in Range(queue)
    /\ active \notin cancelled
    /\ queue' = Tail(queue)
    /\ consumed' = consumed \cup {active}
    /\ phase' = "ready"
    /\ UNCHANGED <<contextReceipts, snapshotReceipts, cancelled, active,
                   saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

\* Viewer cancellation wins before ack; runtime gets a rejected ack.
CancelQueued ==
    /\ Len(queue) > 0
    /\ cancelled' = cancelled \cup Range(queue)
    /\ queue' = <<>>
    /\ UNCHANGED <<contextReceipts, snapshotReceipts, consumed, phase,
                   active, saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

AckRejected ==
    /\ phase = "ack"
    /\ active \in cancelled
    /\ phase' = "idle"
    /\ active' = 0
    /\ UNCHANGED <<queue, contextReceipts, snapshotReceipts, consumed,
                   cancelled, saveFaultUsed, restartUsed, ordinaryCallUsed,
                   exposedCancelled>>

RunModel ==
    /\ phase = "ready"
    /\ exposedCancelled' = exposedCancelled \cup (contextReceipts \cap cancelled)
    /\ phase' = "idle"
    /\ active' = 0
    /\ UNCHANGED <<queue, contextReceipts, snapshotReceipts, consumed,
                   cancelled, saveFaultUsed, restartUsed, ordinaryCallUsed>>

\* A later independent user call reads the retained Context, including residues.
OrdinaryCall ==
    /\ phase = "idle"
    /\ ~ordinaryCallUsed
    /\ ordinaryCallUsed' = TRUE
    /\ exposedCancelled' = exposedCancelled \cup (contextReceipts \cap cancelled)
    /\ UNCHANGED <<queue, contextReceipts, snapshotReceipts, consumed,
                   cancelled, phase, active, saveFaultUsed, restartUsed>>

\* Process loss discards volatile Context; the last completed snapshot survives.
Restart ==
    /\ ~restartUsed
    /\ restartUsed' = TRUE
    /\ contextReceipts' = snapshotReceipts
    /\ phase' = "idle"
    /\ active' = 0
    /\ UNCHANGED <<queue, snapshotReceipts, consumed, cancelled,
                   saveFaultUsed, ordinaryCallUsed, exposedCancelled>>

Next == Claim \/ AppendContext \/ SaveSnapshot \/ SaveFails \/ AckAccepted
        \/ CancelQueued \/ AckRejected \/ RunModel \/ OrdinaryCall \/ Restart
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ queue \in Seq(Commands)
    /\ Len(queue) <= CommandCount
    /\ contextReceipts \subseteq Commands
    /\ snapshotReceipts \subseteq Commands
    /\ consumed \subseteq Commands
    /\ cancelled \subseteq Commands
    /\ exposedCancelled \subseteq Commands
    /\ phase \in {"idle", "append", "save", "ack", "ready"}
    /\ active \in 0..CommandCount
    /\ saveFaultUsed \in BOOLEAN
    /\ restartUsed \in BOOLEAN
    /\ ordinaryCallUsed \in BOOLEAN

\* Contract checks are separate from the observations and policy questions.
NoConsumptionAfterCancellation == consumed \cap cancelled = {}
NoSilentDisappearance == Range(queue) \cup consumed \cup cancelled = Commands
AckRequiresSnapshot == consumed \subseteq snapshotReceipts

\* Policy probe: does "audit only" prohibit sending the residue to a later LLM?
CancelledPayloadNeverReachesModel == exposedCancelled = {}
=============================================================================
