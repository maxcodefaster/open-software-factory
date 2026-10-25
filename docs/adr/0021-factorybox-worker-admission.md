---
status: accepted
---

# Admit Factorybox workers before changing Workspace execution

Add a concrete operator command for Factorybox's bounded worker contract. Reuse ordinary
Kubernetes objects and the current installation connection. Keep Factory as the sole product
control plane and preserve its existing execution-reserve coordination.

One worker and complete persistent store belong to one customer or trust domain. The worker runs
as PID 1 with a 3 CPU / 3 GiB ceiling. Native HTTP readiness avoids exec tasks during initial
cgroup delegation. Every administrative mutation verifies recorded Kubernetes resource UIDs and
pins the live store/epoch inside the runtime CLI. Persist exact intent before the first external
command. An uncertain operation cannot create a replacement identity or silently retry.

The command is an explicit admission lane for private OCI bundles, not another generic runtime
provider. It adds no product setting, routing fallback, database, CRD, controller or pool. Existing
Envbox Sandboxes, Source and Connector behavior remain selected by the product.

The blocking product boundary is canonical source. [ADR 0009](0009-independent-workspace-file-access.md)
requires the file service and compute to mount the same inodes while editing remains available
with execution stopped. Factorybox currently requires its own bounded storage and refuses
external bind mounts. A copied checkout would break file/watch semantics. Restoring an old full
filesystem snapshot over source edited during Pause would discard accepted edits.

Do not bypass either contract to make the image appear integrated. Before routing Workspace
Start or idle Stop through Factorybox, establish and natively prove the exact shared-source
capture/restore behavior, including atomic editor replacement and relevant open file handles.
Continue to use current PostgreSQL Runtime Attempt and reserve ownership when that path is
implemented. New platform profiles require native qualification; a different cloud provider,
portable manifest or persistent volume does not establish cross-node RAM restore.

The [operator command](../../deploy/factorybox/README.md) is implemented and has targeted contract
tests. Its native transport proof uses real Factorybox operations with fixture Kubernetes
observations. A real target-cluster run and shared-source product acceptance remain separate
requirements. No production or Kubernetes qualification follows from this decision.
