---
status: accepted
---

# Retire old worker export transports without deleting native state

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
