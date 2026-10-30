---
status: accepted
---

# Keep Source allocation separate from worker admission attempts

A worker that fails before native admission must not permanently disable its Factory. Keep the
Factory's canonical Source allocation and its original Namespace and Source claim, but retain each
worker admission separately with its own immutable Pod, private store, profile and native identity.
There is at most one active admission per allocation. Retiring one never deletes its Pod or store.

A newly commissioned execution may recover bootstrap only after observing the exact original
terminal Pod, while the admission has no native identity and all prior execution is settled.
Persist the commissioning actor, original observation and new admission before any external create.
An unavailable observation, changed UID, active execution or established native identity refuses
this path. It never resumes old RAM, rebinds a Runtime Attempt or resends model inference.
Recovery after an admitted worker's loss remains a separate explicit decision.

The original admission is copied into an additive journal without rewriting its identities.
New Runtime Attempts and reserve slots freeze their admission independently of Source allocation.
This requires a transactional forward step from the current Greenfield schema. It does not
reintroduce historical pre-Greenfield migrations or accept partial schemas. Fresh and repeated
installs use the same path; retained installations upgrade through guarded bootstrap, not manual SQL.

New admissions check actual private-volume backing capacity once before native startup. Insufficient
space fails explicitly instead of leaving an initializing Pod waiting for nonexistent cleanup.
This check is not disk reclamation or dynamic sizing; those remain separate duties.
Factorybox's pinned allocation and native safety checks remain authoritative.
