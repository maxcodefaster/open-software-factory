---
status: accepted
---

# Worker recovery, Stop settlement and storage retirement


This record holds the decisions formerly numbered 0028, 0029, 0031, 0032, 0035, 0036. Each section keeps its original wording.


## Settle a retained native Stop without restarting Project execution

OpenCode retains queued input after compute exits. A failed Dev Container can therefore prevent
Factory from confirming an already requested Stop, even when the exact Sandbox is gone. Factory
uses a one-shot native settlement Pod after positively proving the original execution has exited.
It preserves the Stop, Turn, Session, prompt, Workspace and Runtime Attempt identities.

The Pod freezes the published Factory runtime tools image selected by the current installation,
with its matching pinned OpenCode and client versions. It does not depend on the failed Dev
Container's consumer image being usable or cached. The original Runtime Attempt's artifact remains
unchanged. The Pod mounts only that Workspace's retained Git metadata at a separate native-store path.
The original location is an empty, read-only directory, so Project source, Git configuration and
hooks cannot become execution inputs. It receives no provider credentials, Factory capability or
ServiceAccount token. It observes settlement first; interruption and cancellation are limited to
the recorded native Session and input. Unrelated queued input prevents confirmation.

The existing immutable command journal records the declaration and one create attempt before
external creation, then the original Pod UID, native result and cleanup outcome. Lost output
observes the same Pod. A missing Pod after attempted creation does not authorize replacement.
Native success requires actual Pod termination and an exact result; source or identity changes
cannot turn a late result into confirmation of another Stop. The normal authenticated Stop
controller publishes confirmation through its existing compare-and-set boundary.

A corrected tools image or runner can receive a distinct recovery operation after positive
termination or non-execution proof for its predecessor. The immutable journal links those operations;
neither an unknown create outcome nor a missing Pod authorizes replacement. The original Stop,
native input, source and Runtime Attempt are never retargeted.

Recovery is serialized per Factory worker and periodically resumes saved Stop intent without
admitting another Agent Turn. Shutdown cancels and joins its observers; already admitted native
work remains observable after restart. An explicit read-only confirmation cannot create the Pod,
stop compute or dispatch native mutations. Failed or uncertain settlement preserves the barrier.

Restarting the complete Dev Container was rejected because broken Project setup would block Stop
again and rerun Project hooks. Direct SQLite edits or replacing retained state would bypass native
queue semantics and destroy the recovery evidence. Neither is an acceptable Stop implementation.

## Keep Source allocation separate from worker admission attempts

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
This check is not disk reclamation. For a new automatic profile it checks the declared minimum;
the pinned native worker selects the actual fixed capacity within the requested range under its
own store lease. Factory records that selected size as part of the immutable native identity.
Later host availability cannot reinterpret or resize it. Older exact-size profiles remain unchanged.

A fresh bootstrap successor may use the currently configured, independently qualified worker
profile on the same canonical Source node. The original profile and bootstrap outcome remain
retained on their original admission. This does not move Source, resume old RAM or qualify a new
image without native evidence.

## Recover an admitted worker without allocating another store

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
[ADR 0003](#retire-old-worker-export-transports-without-deleting-native-state); native state is not a cache.

Source remains on its original claim and node. Opening a Project does not commission recovery.
Already admitted worker replacement is separate from the unused bootstrap recovery in
[ADR 0003](#keep-source-allocation-separate-from-worker-admission-attempts). This does not claim cross-node RAM restore,
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

## Retire old worker export transports without deleting native state

A recovered worker keeps its predecessor's store. Its completed image-export tar files
are transport caches, not canonical Source, native bases or RAM snapshots. Keeping every
old transport alongside each successor's new export and temporary extraction consumes
host capacity even though the bounded native store was reused.

Before preparing execution on an admitted successor, Factory selects only admissions in
that trust domain and store with an immutable operator-recovery terminal observation.
The current worker and epoch are checked again. Bootstrap exports require their original
Pod/store/image marker and committed checksum; later consumer exports also require the
exact successful exporter receipt. Partial, foreign, active or changed exports stay retained.

Each archive retirement hashes the original file, records its directory/file identity and
immutable owner, and fsyncs intent before unlink. Completion and all original export/import
receipts stay on the retained store. Interrupted retirement continues the same inventory;
a replacement file is never removed. The current admission's export directories are excluded.
This cleanup can run before normal native write admission, so it can recover host headroom.

Only the old `rootfs.tar` transport is eligible. No Source, prepared Sandbox backing, native
base, checkpoint, Resume image, private store image or incomplete import is deleted here.
This does not qualify arbitrary old-epoch state for retirement or promise a specific free-space
delta from a file's size. Native capacity checks remain authoritative after cleanup.

## Retire a consumer transport after verifying its independent native import

A completed consumer export's tar file is transport, not Sandbox state. Factory may retire it
while its original worker remains active, only after the exact successful exporter receipt,
current worker/epoch, import receipt and completed source-extraction retirement agree. It
reverifies the already published independent native base before granting archive retirement.
Missing, partial, replaced or changed inputs do not grant deletion authority.

The existing archive journal retains owner, image, checksum and exact directory/file identity.
Its intent is durable before unlink and completion remains recoverable without replacing any
runtime identity. Later preparations accept an absent transport only with that exact completion
and native-import authority; fresh inputs still reverify the original native base and cannot
reconstruct missing backing from the retired archive.
After compaction, serving Factory versions must understand receipt-based reuse; an older tar-only
preparer cannot recreate retired transports by rollback.

The joined storage sweep performs this work automatically, and a known unattempted capacity
refusal can try the same cleanup before checking admission again. This adds a one-time native
verification and archive hash rather than retaining a multi-gigabyte duplicate per tool-image
update. It never removes Source, native bases, RAM images or private Docker backing. The separate
terminal-predecessor path in [ADR 0003](#retire-old-worker-export-transports-without-deleting-native-state)
retains its original authority and receipts.

## Admit fresh execution storage only after confirmed drain

Ordinary admitted-worker recovery keeps the exact store as defined in
[ADR 0003](#recover-an-admitted-worker-without-allocating-another-store).
An undersized store may instead require an explicit System Manager recovery
with `storage: "fresh"`. Observe the exact original terminal Pod, settle every
execution and confirm private backing cleanup across all admissions sharing
that store before retaining the new admission and its distinct claim intent.

The new worker selects its fixed capacity within the configured range on the
actual backing volume. Safe whole-byte quantities, claim headroom and native
capacity admission bound that range, rather than a universal 32 GiB ceiling.
The default fresh range is 8 through 64 GiB with a 128 GiB claim.

Keep the original store, admission, execution identities and history unchanged.
Canonical Source stays on its original claim, Namespace and node. There is no
resize, migration, automatic storage replacement or replay of old execution.
Unconfirmed reclamation requires ordinary retained-store recovery so cleanup
can continue there; logical Stop alone cannot authorize abandoning its backing.
