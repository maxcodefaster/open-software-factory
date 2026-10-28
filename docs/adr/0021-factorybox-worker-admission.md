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

CPU scheduling requests are distinct from that qualified ceiling. Fresh product workers
reserve 100 millicores by default and can use spare node CPU up to the existing three-core
limit. Kubernetes schedules against the reserve and shares available CPU dynamically; the
reserve does not promise three dedicated cores or change the memory ceiling. The operator
can select a whole-millicore reserve between 10 and 3000 before first admission. Product init
containers request no more CPU than that reserve, so a completed image exporter does not
silently retain a larger scheduling floor.

The selected reserve is part of the immutable profile. Existing worker profiles without
that field retain their original full reservation and exact declarations; an upgrade never
changes their QoS class, resource UIDs, store or epoch. New execution and reserve preparation
on an existing worker use its retained profile rather than new installation defaults.
Lower requests require native target-cluster acceptance under the resulting QoS class.
Unit tests and spare CPU observations alone do not qualify checkpoint/restore behavior.

The command is an explicit admission lane for private OCI bundles, not another generic runtime
provider. Workspace execution and the execution reserve now use the same admitted worker contract,
with Factory-owned consumer preparation and lifecycle intent. The product integration and its
canonical Source boundary are defined in [ADR 0022](0022-factorybox-workspace-execution.md).

The product boundary is canonical source. [ADR 0009](0009-independent-workspace-file-access.md)
requires the file service and compute to mount the same inodes while editing remains available
with execution stopped. Factorybox keeps private runtime state in bounded storage and admits only
the exact declared shared Source mount. A copied checkout would break file/watch semantics.
Restoring an old full filesystem snapshot over source edited during Pause would discard accepted edits.

Do not bypass either contract to make the image appear integrated. Routing Workspace Start or
idle Pause through Factorybox requires native proof of the exact shared-source capture/restore
behavior, including atomic editor replacement and relevant open file handles. PostgreSQL retains
Runtime Attempt and reserve ownership. New platform profiles require native qualification; a
different cloud provider, portable manifest or persistent volume does not establish cross-node RAM restore.

The [operator command](../../deploy/factorybox/README.md) is implemented and has targeted contract
tests. Its native transport proof uses real Factorybox operations with fixture Kubernetes
observations. Each admitted profile also requires a real target-cluster run and shared-source
product acceptance. No production or Kubernetes qualification follows from this decision alone.
