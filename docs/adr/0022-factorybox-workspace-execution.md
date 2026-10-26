---
status: accepted
---

# Run Workspace execution in Factorybox with shared canonical source

Replace Envbox execution with an admitted, pinned Factorybox worker. Factory remains the sole
control plane. Keep the existing Runtime Attempt, Connector credentials and PostgreSQL reserve
ownership. One worker initially belongs to one Workspace or isolated execution slot; it must
never pool live customer processes across trust domains.

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

An explicit Stop can retire a missing, terminal or restarted original worker after exact Namespace
and Pod UID checks. This records no invented native Delete receipt. It still removes only the
owned execution Pod and private store, preserving canonical Source. An unavailable Kubernetes read
or a replacement UID retains Stop for observation. Healthy Stop confirms native Delete and releases
the exact caller-owned mount pair before worker shutdown. Incomplete preparation with unconfirmed
mount ownership remains available for inspection instead of being force-unmounted.

Native runtime evidence on one Linux profile establishes only that profile. Before installation,
admit the actual cluster's node, kernel, CNI and storage with the pinned worker. A provider-neutral
manifest does not prove support for every Kubernetes cluster, cross-node RAM migration or recovery
after worker restart. The product replacement requires its own native Connector and lifecycle
acceptance in addition to the runtime contract proofs described in
[ADR 0021](0021-factorybox-worker-admission.md).
