---
status: accepted
---

# Retire a consumer transport after verifying its independent native import

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
terminal-predecessor path in [ADR 0032](0032-retire-export-archives-of-terminated-workers.md)
retains its original authority and receipts.
