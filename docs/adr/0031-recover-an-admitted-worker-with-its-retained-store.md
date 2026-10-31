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
automatic recovery of a missing unobserved Pod, or reclamation of retained old-epoch data.
