----------------------------- MODULE writer -----------------------------
EXTENDS Naturals, FiniteSets

\* One active Change, two authorized humans, one Agent identity, finite epochs,
\* one retained candidate. No shared buffers, revocation, crashes, native
\* lifecycle internals, progress/fairness or Delivery execution are modeled.
\* Source/branch/compute acknowledgements are controlled external facts.
\* A missing previous Attempt or a preparation needing no compute fence has
\* vacuous compute confirmation. No native create/delete operation is modeled.
\*
\* Implementation map:
\* BeginAgent/ReclaimAgent: access/change-writer.ts claimAgentWriterIn, under
\* lockChangeWriterIn. A same-turn claim can advance epoch while prepare waits.
\* BeginTakeover/BeginRelease: access/writer-controller.ts takeOver/release
\* persist change_editing_decision and handoff before external fencing.
\* Human-to-human takeover assumes an already authorized editing transfer.
\* FenceSource/FenceBranch: fenceSource/protect([]); neither settles Agent input.
\* ConfirmCompute: writer-controller.ts stopped, including only native suspended
\* compute with confirmed-same-node Source. Generic paused is not confirmation.
\* ConfirmInput: agent/stop.ts confirm, exact Stop/Attempt/Session CAS after
\* queued-input settlement. Compute destruction alone cannot do this.
\* Publish/Recapture: prepareAgent or takeOver/release final transaction rechecks
\* captured epoch; retry captures the new epoch before repeating fences.
\* RetainCandidate/Review/Approve: abstract already-submitted exact-commit
\* Verification/review and an explicit human Delivery approval. These never
\* grant writing or change the Change's pinned requirement approval.
\* Native basis: 15-coding-functions protect_change_identity, 55-coding-triggers
\* immutable editing decisions, 20-delivery-functions guard_candidate_review,
\* 60-delivery-triggers immutable Delivery approval, schema/delivery.ts exact
\* approval/Verification/review foreign keys. This model does not run those
\* controllers; the companion generated checks run Writer plus native guards.

CONSTANTS Humans, Agent, Nobody, MaxEpoch, Commits
VARIABLES phase, epoch, holder, target, captured, kind, grants,
          sourceFenced, branchFenced, computeFenced, stopPending, publication,
          candidate, review, approval
vars == <<phase, epoch, holder, target, captured, kind, grants,
          sourceFenced, branchFenced, computeFenced, stopPending, publication,
          candidate, review, approval>>

Init ==
  /\ phase = "unassigned" /\ epoch = 1 /\ holder = Nobody
  /\ target = Nobody /\ captured = 0 /\ kind = "takeover" /\ grants = {}
  /\ sourceFenced = FALSE /\ branchFenced = FALSE /\ computeFenced = FALSE
  /\ stopPending = FALSE /\ publication = [expected |-> 0, actual |-> 0]
  /\ candidate = "" /\ review = "" /\ approval = ""

BeginAgent ==
  /\ phase \in {"unassigned", "human"} /\ epoch < MaxEpoch
  /\ phase' = "agent-preparing" /\ epoch' = epoch + 1
  /\ holder' = Nobody /\ target' = Agent /\ captured' = epoch + 1
  /\ sourceFenced' = FALSE /\ branchFenced' = FALSE /\ computeFenced' = FALSE
  /\ UNCHANGED <<kind, grants, stopPending, publication, candidate, review, approval>>

BeginTakeover(h) ==
  /\ phase \in {"unassigned", "agent", "human"} /\ h # holder
  /\ epoch < MaxEpoch /\ phase' = "handoff" /\ epoch' = epoch + 1
  /\ holder' = Nobody /\ target' = h /\ captured' = epoch + 1
  /\ kind' = "takeover" /\ stopPending' = (phase = "agent")
  /\ sourceFenced' = FALSE /\ branchFenced' = FALSE /\ computeFenced' = FALSE
  /\ UNCHANGED <<grants, publication, candidate, review, approval>>

BeginRelease ==
  /\ phase = "human" /\ epoch < MaxEpoch
  /\ phase' = "handoff" /\ epoch' = epoch + 1
  /\ holder' = Nobody /\ target' = Nobody /\ captured' = epoch + 1
  /\ kind' = "release"
  /\ sourceFenced' = FALSE /\ branchFenced' = FALSE /\ computeFenced' = FALSE
  /\ UNCHANGED <<grants, stopPending, publication, candidate, review, approval>>

Pending == phase \in {"agent-preparing", "handoff"}

FenceSource ==
  /\ Pending /\ ~sourceFenced /\ sourceFenced' = TRUE
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 branchFenced, computeFenced, stopPending, publication,
                 candidate, review, approval>>

FenceBranch ==
  /\ Pending /\ sourceFenced /\ ~branchFenced /\ branchFenced' = TRUE
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 sourceFenced, computeFenced, stopPending, publication,
                 candidate, review, approval>>

ConfirmCompute ==
  /\ Pending /\ branchFenced /\ ~computeFenced
  /\ computeFenced' = TRUE /\ grants' = {}
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind,
                 sourceFenced, branchFenced, stopPending, publication,
                 candidate, review, approval>>

ConfirmInput ==
  /\ phase = "handoff" /\ stopPending /\ stopPending' = FALSE
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 sourceFenced, branchFenced, computeFenced, publication,
                 candidate, review, approval>>

ReclaimAgent ==
  /\ phase = "agent-preparing" /\ epoch < MaxEpoch /\ epoch' = epoch + 1
  /\ UNCHANGED <<phase, holder, target, captured, kind, grants,
                 sourceFenced, branchFenced, computeFenced, stopPending,
                 publication, candidate, review, approval>>

Recapture ==
  /\ phase = "agent-preparing" /\ captured # epoch /\ captured' = epoch
  /\ sourceFenced' = FALSE /\ branchFenced' = FALSE /\ computeFenced' = FALSE
  /\ UNCHANGED <<phase, epoch, holder, target, kind, grants, stopPending,
                 publication, candidate, review, approval>>

Publish ==
  /\ Pending /\ sourceFenced /\ branchFenced /\ computeFenced /\ ~stopPending
  /\ epoch = captured \* STALE_FENCE_GUARD: final Writer transaction
  /\ epoch < MaxEpoch
  /\ publication' = [expected |-> captured, actual |-> epoch]
  /\ phase' = IF phase = "agent-preparing" THEN "agent"
              ELSE IF kind = "release" THEN "unassigned" ELSE "human"
  /\ epoch' = IF phase = "handoff" THEN epoch + 1 ELSE epoch
  /\ holder' = target
  /\ grants' = IF target = Nobody THEN grants ELSE grants \cup {target}
  /\ UNCHANGED <<target, captured, kind, sourceFenced, branchFenced,
                 computeFenced, stopPending, candidate, review, approval>>

RetainCandidate(c) ==
  /\ phase = "agent" /\ ~stopPending /\ candidate = "" /\ candidate' = c
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 sourceFenced, branchFenced, computeFenced, stopPending,
                 publication, review, approval>>

Review ==
  /\ candidate # "" /\ review = "" /\ review' = candidate
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 sourceFenced, branchFenced, computeFenced, stopPending,
                 publication, candidate, approval>>

Approve ==
  /\ review # "" /\ approval = "" /\ approval' = review
  /\ UNCHANGED <<phase, epoch, holder, target, captured, kind, grants,
                 sourceFenced, branchFenced, computeFenced, stopPending,
                 publication, candidate, review>>

Next == BeginAgent \/ BeginRelease \/ (\E h \in Humans: BeginTakeover(h))
        \/ FenceSource \/ FenceBranch \/ ConfirmCompute \/ ConfirmInput
        \/ ReclaimAgent \/ Recapture \/ Publish
        \/ (\E c \in Commits: RetainCandidate(c)) \/ Review \/ Approve
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"unassigned", "agent-preparing", "agent", "handoff", "human"}
  /\ epoch \in 1..MaxEpoch /\ captured \in 0..MaxEpoch
  /\ holder \in Humans \cup {Agent, Nobody}
  /\ target \in Humans \cup {Agent, Nobody}
  /\ grants \subseteq Humans \cup {Agent}
  /\ kind \in {"takeover", "release"}
  /\ sourceFenced \in BOOLEAN /\ branchFenced \in BOOLEAN
  /\ computeFenced \in BOOLEAN /\ stopPending \in BOOLEAN
  /\ candidate \in Commits \cup {""} /\ review \in Commits \cup {""}
  /\ approval \in Commits \cup {""}
WriterExclusive == Cardinality(grants) <= 1
StaleEpochRejected == publication.expected = publication.actual
ConfirmedGrant == phase \in {"agent", "human"} => ~stopPending /\ grants = {holder}
ExactApproval == approval # "" => approval = candidate /\ review = candidate
CandidateImmutable == [][candidate # "" => candidate' = candidate]_vars
ApprovalImmutable == [][approval # "" => approval' = approval]_vars
=============================================================================
