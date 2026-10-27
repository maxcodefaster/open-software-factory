---
status: accepted
---

# Run Workspace execution in Factorybox with shared canonical source

Replace Envbox execution with an admitted, pinned Factorybox worker. Factory remains the sole
control plane. Keep the existing Runtime Attempt, Connector credentials and PostgreSQL reserve
ownership. One worker and its private store belong to one Factory trust domain. Independent
Sandboxes share that worker, never another Sandbox's writable overlay, Source directory or
credentials. Different customer trust domains require separate workers.

Allocate the Factory worker identity lazily, so independently initialized installations never
inherit the same identity from a database template. Workspace file access can allocate its
Namespace and canonical Source claim without starting compute. The first execution pins the
worker profile and consumer image. All roles on that worker use those exact pins. Namespace,
Source claim, private store and original Pod UIDs remain immutable once observed.

Shared resource creation is serialized and admitted before its external effect. A lost create
response can be reconciled through the surviving original objects. A surviving Pod cannot
authorize recreation of missing storage or trust inputs. Missing or replacement worker UIDs
refuse new execution instead of silently starting a second worker.

The immutable worker profile pins `arm64` or `amd64` explicitly, independent of the Factory server's
architecture. The same command and admission protocol serves both. Image, executable, node and
kernel qualification remain architecture-specific; the adapter accepting a profile does not qualify
a runtime build. RAM restore never crosses architectures. Each architecture requires the exact
standalone Factorybox native qualification gates before production admission.

The Source service and Sandbox bind the same canonical Project directory, following
[ADR 0009](0009-independent-workspace-file-access.md). Private runtime files and Docker storage
belong to the worker's bounded filesystem. Source stays available during Pause and is excluded
from private snapshots. The worker retains open descriptions so atomic saves, renamed working
directories and queued watches survive same-worker Resume. A stopped worker cannot recover those
descriptions; worker loss requires an explicit fresh execution decision from retained source.

Prepare the exact consumer runtime image before starting its Sandbox. A Kubernetes init container
exports its own filesystem without Project source or credentials. After native HTTP readiness,
Factory verifies Pod, claim, node and live epoch before preparing a private OCI bundle and starting
the Connector. Copy credentials and Pod DNS into private runtime files. Never mount the host's
Docker socket or copy the canonical checkout into a snapshot.

When the kernel exposes MPTCP, the OCI recipe disables it only in the new Sandbox network
namespace. Go 1.27 otherwise creates MPTCP listeners by default, which the checkpoint contract
refuses. Ordinary TCP remains available. This does not change a host sysctl or add MPTCP support
to CRIU.

The Sandbox OCI seccomp profile returns `EPERM` for `io_uring_setup`, `io_uring_enter`
and `io_uring_register`, matching the standalone native consumer profile. CRIU cannot save those
live kernel objects. The inherited filter keeps Node/libuv and other consumers on their supported
I/O fallback without changing host sysctls. The preparer selects the admitted worker's native
ARM64 or AMD64 seccomp architecture and refuses an unexpected upstream profile instead of
overwriting its restrictions. This is not a claim that Factorybox supports checkpointing io_uring.
The filter applies to fresh preparation. Retained OCI inputs and snapshots stay immutable;
upgrading Factory does not patch an existing execution during Resume.

Start `dockerd` directly inside Sysbox. The generic DinD entrypoint makes system mounts shared,
which creates unsupported nested proc mount propagation when restoring a Dev Container. Sysbox
already prepares those system mounts; the consumer must preserve their private propagation.

New canonical Source claims and their Source Pods use the admitted worker node so RWO storage can
be shared with execution. An existing retained Source keeps its observed node and claim identity;
a conflicting worker profile is refused before creation rather than moving the checkout.

Persist lifecycle intent before external effects. Pause retains the Runtime Attempt generation and
blocks work while its Connector transports disconnect. Resume reauthorizes the same credentials
only for that exact worker epoch. Unknown operation outcomes retain ownership and are observed;
they cannot authorize a new Pod, Sandbox or model request. Explicit Stop still removes execution.
Reserve slots continue to use the existing PostgreSQL controller and locks.

Sandbox identities are independent of worker identities. Preparation protocol 3
retains a private input directory and OCI configuration for each immutable
Sandbox ID; a reserve assignment keeps its original slot Sandbox ID. Sandboxes
reuse the worker's verified common image import, not another Sandbox's writable
overlay or credentials. Releasing an unused input cannot authorize deletion or
unmounts for another running Sandbox.

Preparation protocol 3 delivers only that Sandbox's bounded assignment through the
authenticated provisioning command. The worker Pod has no ambient assignment Secret
mount. A reserve seed receives no Parent or Child credentials; activation delivers
those only after its original Sandbox has resumed. Private assignment files do not
enter Factory's retained preparation request.

All Workspaces use the Factory's canonical Source claim. Canonical Source uses
`workspaces/<full-workspace-id>/home` within that claim. That
directory is generated and retained with the Source intent, including across access
epochs. The Source Pod mounts only that directory; the worker resolves the selected
Workspace beneath its source root without following symlink ancestors. Preparation
records the Source directory's device and inode for replay and refuses a replaced
root when preparation is observed again. Existing claims and mismatched layouts are never
retargeted by recovery. The Greenfield baseline has no migration of an old layout.
Source service, Pod and Secret names include the full Workspace ID and access epoch.
The Greenfield Source intent retains their generated key; a database without that
layout cannot derive new names for older recorded UIDs.
Stopping one Source epoch closes only its own connections, not every connection in
its Namespace. Resource names do not depend on a dedicated Namespace for uniqueness;
Factory verifies Namespace ownership and placement separately.

A never-used reserve becomes ready only after native Pause confirms its exact
standby snapshot, zero Sandbox anonymous RAM and no resident snapshot pages.
Assignment resumes that same Sandbox before delivering its role and credentials.
Persist each Pause/Resume attempt before the external command. A lost response
can settle through the original native record but cannot commission another
mutation or a cold replacement. This is a paused prepared reserve, not a claim
that cold preparation forms a Staging-derived preforked pool.

An explicit Stop can retire execution on a missing, terminal or restarted original worker after exact Namespace
and Pod UID checks. This records no invented native Delete receipt. It still removes only that
Sandbox's private assignment and inputs. It never deletes or relabels the shared worker Pod,
Namespace, private store or canonical Source claim. An unavailable Kubernetes read or a replacement
UID retains Stop for observation. Healthy Stop confirms native Delete and releases the exact
caller-owned mount pair. An assigned reserve retains its original slot owner through activation
and cleanup. Incomplete preparation with unconfirmed
mount ownership remains available for inspection instead of being force-unmounted.

Kubernetes volume initialization is limited to a new empty root-owned store and its exact
Pod/store identity. Existing backing is never repaired by changing permissions. Admission
pins the node-reported and worker kernel boot IDs independently, alongside original object
UIDs and the native epoch. It refuses a later change to either boot observation; it does not
assume those two independently supplied strings are identical.

Factory queues obsolete checkpoints and superseded private Resume images from confirmed native Runtime Attempt observations,
including inherited standby history. Each retirement retains its exact Sandbox ID,
snapshot, native owner, checkpoint hash and worker epoch before the external command.
A periodic sweep runs outside the Resume response path; healthy Stop drains its queued
retirements before confirming the Runtime Attempt's removal. A current unresumed
Pause is not eligible. Current Resume images remain protected until a later complete Pause
or confirmed Delete. Native recovery selections, shared bases and live dependencies
remain independent deletion guards.

Checkpoint retirement can continue the same native deletion inventory after interruption
or lost output. This explicit native continuation contract does not allow replaying an
uncertain Start, Pause or Resume. Factory retains the completed retirement receipt and
before/after filesystem availability, without treating concurrent filesystem counters as
the byte size of one Sandbox.

Releasing private input mounts is not disk reclamation. After confirmed native Delete,
Factory retains a separate private-backing retirement intent containing the original Sandbox
owner and Start input hash. It releases the exact caller-owned mount pair, then asks Factorybox
to retire its original private payload inventory. Lost output continues that same inventory.
Only a completed native receipt permits marking the Runtime Attempt's inputs released.
Original directory identities, registered bases, live peers, foreign mounts and unexpected
entries remain deletion guards. The shared worker and canonical Source claim are never deleted
to reclaim one Sandbox. Incomplete preparation and unresolved native outcomes remain retained
for inspection.

Unassigned slots retain their own immutable retirement plan and compact completion on the
execution slot, because they have no Runtime Attempt. Confirmed native Delete makes their
unused Pause eligible for checkpoint retirement, followed by exact input mount release and
private backing retirement. A lost retirement reply keeps the assignment Secret and slot
pending; reconciliation continues the same native inventories without repeating Delete.
The same rule applies when an assigned slot's original native owner is cleaned up.

Native runtime evidence on one Linux profile establishes only that profile. Before installation,
admit the actual cluster's node, kernel, CNI and storage with the pinned worker. A provider-neutral
manifest does not prove support for every Kubernetes cluster, cross-node RAM migration or recovery
after worker restart. The product replacement requires its own native Connector and lifecycle
acceptance in addition to the runtime contract proofs described in
[ADR 0021](0021-factorybox-worker-admission.md).
