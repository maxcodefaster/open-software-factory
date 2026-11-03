---
status: accepted
---

# Recover an admitted worker without allocating another store

An admitted worker's loss must not permanently block its Factory or allocate another
bounded store on each recovery. A System Manager may explicitly commission a successor
after observing the exact original terminal Pod and settling all prior execution.
Keep the original Pod, admission, Runtime Attempts, Source claim and native store history.
No inference or old RAM execution is replayed.

The authenticated recovery command retains its request identity, actor, terminal observation
and successor declaration atomically before any create. It reuses the original store's exact
claim UID, initialization identity, capacity range and actual selected size. Fresh execution
binds under the same row-lock boundary as retirement. Concurrent or repeated commands cannot
retarget old Runtime Attempts or create another successor for the same predecessor.

The successor has a new Pod, native epoch and independently qualified worker profile.
Its read-only store inspector refuses missing, changed or still-leased backing. It never
initializes, repairs, reformats or resizes that store. Bootstrap and later consumer exports
use admission-scoped directories and exporter names; old import/export receipts stay unchanged.
Native storage admission does not allocate another fixed image on this path.
Completed predecessor transport archives have a separate, exact retirement contract in
[ADR 0032](0032-retire-export-archives-of-terminated-workers.md); native state is not a cache.

Source remains on its original claim and node. Opening a Project does not commission recovery.
Already admitted worker replacement is separate from the unused bootstrap recovery in
[ADR 0029](0029-worker-bootstrap-admission-recovery.md). This does not claim cross-node RAM restore,
automatic recovery of a missing unobserved Pod, or general reclamation of retained old-epoch data.

Confirmed Delete and private backing reclamation are separate outcomes. After
ordinary Stop settles execution and the original terminal Pod is observed, a
successor may continue an already retained backing-retirement request in that
same store. It verifies the original worker, claim, boot and Sandbox identities,
and dispatches metadata-only cleanup through the successor's own pinned
executable. Old Runtime Attempts, admissions and requests are never retargeted.
This is not general collection of old epochs or permission to delete an old Pause.

Reserve retirement retains each confirmed checkpoint and Resume-image receipt
before proceeding to backing cleanup. Those receipts are append-only and survive
Factory restart or worker replacement. A parent template can retire once every
child has confirmed native Delete, without waiting for the child's storage
reclamation; the native dependency checks remain authoritative. After replacement,
unconfirmed checkpoint outcomes stay pending. Neither worker termination nor an
absent process manufactures their completion.
