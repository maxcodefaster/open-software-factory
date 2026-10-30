---
status: accepted
---

# Select aggregate worker resources before admission

The Factorybox Worker contains all Sandboxes in one Factory trust domain. Its
aggregate CPU and memory budget must not inherit the 3 CPU / 3 GiB native fixture
ceiling. This supersedes that aggregate ceiling in
[ADR 0021](0021-factorybox-worker-admission.md), not the existing qualification
fixtures or any retained worker declaration.

Before a fresh automatic admission, read the configured node's exact platform,
readiness and allocatable resources plus its assigned Pods. Select the node CPU
ceiling and reserve the remaining schedulable memory after Pod requests and an
explicit operator headroom. Account for init peaks, native sidecars, overhead,
terminating Pods and allocated resize reservations. Usage samples are not
scheduling reservations. An unavailable observation or exhausted budget refuses
selection without creating execution.

Retain the selected budget on the worker admission before freezing a Sandbox's
artifact intent or creating the worker. Concurrent commissioners use the same
retained winner. The worker's memory request equals its finite memory limit;
the smaller CPU request remains a scheduling reserve, not a dedicated-core
promise. Kubernetes remains responsible for scheduling against concurrent
allocations. The observation does not reserve the entire node or guarantee
capacity for arbitrary Project processes.

An application upgrade, reconnect or later node sample never resizes an
admitted worker. Profiles without a selected budget retain their original
3 CPU / 3 GiB declaration. A fresh larger budget requires a pinned Factorybox
binary that admits finite aggregate limits and native evidence for that
deployment. This decision does not authorize replacing an admitted worker,
replaying uncertain execution or claiming per-Sandbox resource isolation.
