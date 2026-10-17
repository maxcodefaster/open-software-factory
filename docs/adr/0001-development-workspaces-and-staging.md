---
status: accepted
---

# Independent editing, durable Workspaces and prepared compute

Factory separates the Developer IDE, durable Development Workspace and replaceable execution
Sandbox. One warm Theia backend per active developer is the target, rather than one backend per
open Ticket. Editing must not wait for Envbox, the Dev Container, Apps, OpenCode or browser tools.
The [architecture reference](../README.md#verification-and-operating-limits) records verification
and operating limits separately from this decision.

## Workspace and editor ownership

One developer may have one Personal Development Workspace per Project. One active Ticket Change
has one shared Ticket Workspace. Each has one canonical checkout, not synchronized editor and
agent copies. A Ticket with an active Change selects its shared Workspace; otherwise the IDE
selects the developer's personal Workspace. That fallback creates neither a Change nor Ticket Build
authority. Personal work does not grant writes to the protected default branch.

Selecting a Project may prepare the developer's IDE and required files without starting Apps or
Build. Product Contributors do not need IDE preparation. During active use, source editing and
saving are immediately available; switching prepared Workspaces targets less than three seconds.
That is a product target, not a measured guarantee. Initial checkout preparation and return after
prolonged inactivity may be explicitly cold.

Switching or minimizing retains per-Workspace open files and unsaved buffers. A file keeps its
Workspace-qualified identity; no mutable current-directory alias may redirect a later save.
Terminal sessions, Agents and processes keep their original Workspace and Runtime Attempt.
The concrete file-access design is accepted in [ADR 0009](0009-independent-workspace-file-access.md).

## Execution and reserve

Each Development Workspace has at most one assigned running Sandbox. Every new start has an
immutable Runtime Attempt; retries of the same intended create retain its identity. Factory
persists intent before external creates and assignments. A running Agent does not stop merely
because its editor, Ticket or Preview is hidden.

Every Sandbox uses pinned Envbox, its unprivileged Sysbox workspace and private Docker daemon,
the exact Dev Containers CLI, and the Factory Runtime Connector. This supports Docker-in-Docker
without exposing the node Docker socket to Project code. The outer privileged Envbox wrapper is
trusted infrastructure; Sysbox shares the host kernel and is not separate-kernel VM isolation.
This decision targets authorized Enterprise development, not a public hostile-code service.

Factory maintains a small reserve of clean, unassigned, prepared execution slots. It replenishes
after reservation rather than waiting for the reserve to become empty. A configured minimum-ready
target is constrained by maximum slots, creation concurrency, idle expiry and total compute budget.
Ready and in-flight creations count toward reconciliation so a burst or failed start cannot create
an unbounded replacement loop. Exhaustion leaves the editor usable and compute honestly preparing.

A slot contains approved base tools and images, not repository data, Project hooks or user secrets.
Reservation and one-time assignment are durable, deterministic and recoverable; fresh capabilities
are issued only after assignment. Used slots never return to the unassigned reserve. Their data
remain under their owner or their disposable compute is destroyed. Envbox waiting and Connector
activation are Factory-owned behavior, not a rewritten admitted Runtime Attempt.

A prebooted Pod cannot acquire a different PVC by changing its assignment. Fully prepared slots
therefore serve fresh Staging and Verification runtimes with their own clean storage.
Existing stopped Workspaces retain their storage identity and use normal preparation or their own
retained compute. Broader reserve reuse requires a separately proven storage-attachment design.

## Preparation and resource use

Discover the current Dev Container image inputs through the exact upstream CLI, acquire the selected
pinned digests with bounded concurrency in the Workspace-private daemon, then re-read the complete
merged configuration before starting. The CLI can reuse confirmed local image metadata. Never cache
mutable configuration guards or skip required hooks and resolved-container checks to reduce startup.
The merged image set must match the acquired repository/digest identities. A concurrent change fails
preparation explicitly; a new start discovers its current inputs instead of adopting an unacquired image.

Prebuild stable toolchains and Dev Container Features, and prepare dependencies against exact
configuration, image, lockfile and architecture inputs. Required lifecycle hooks and boundary checks
remain valid; a prebuilt image is still a normal writable development environment. Fresh Verification
may use immutable artifacts, never a development worktree, mutable dependency tree or cached verdict.

Project registration and signed default-branch push events admit separate Development and
Main-Preview image-preparation jobs. One producer runs at a time, including its teardown. Persist
deterministic intent first, coalesce superseded inputs and expire interrupted producers after twelve
minutes. A confirmed image is reusable only for its exact commit, recipe, resolved image/Feature
inputs, native platform and environment version. Normal image tags and JSONC remain repository-owned;
resolve and freeze only an isolated build snapshot. The consumer uses a temporary image configuration
and upstream image metadata so Feature lifecycle hooks still run. Dirty source, changed inputs,
unsupported recipes or failed preparation use normal compliant startup. Compose runs through the
existing bounded runtime path; automatic Compose image production is not supported.

Use OpenBao KV v2 for encrypted Project values. PostgreSQL owns masked manifests, versions and
deterministic write intent/outcome, never values. Project managers replace protected values; developers
read configuration status. Development and Main-Preview are independent, and Verification receives
only explicitly granted values and registry access. Scoped, memory-backed runtime credentials preserve
the admitted version through later settings changes. Image-build secrets require repository-owned
BuildKit secret mounts rather than build arguments. Authorized Project code and its coding Agent can
read their runtime variables; UI masking is not code isolation. New settings apply to subsequent starts
and builds, without stopping current work. Main-Preview remains a Dev Container, not a release artifact.

Keep registry access close to execution and prepare each actual image-cache tier: node/Kubelet,
Envbox Docker, and private Workspace Docker. Do not share a live Docker graph directory between
Workspaces. Separate durable source and approved data from bounded, disposable image and build caches.
Theia belongs in the Developer IDE image; other tools are exact, role-specific artifacts rather than
an all-tools payload copied into every runtime.

Prepare only used Workspaces. Start optional browser tools and processes when needed, without making
editor or PTY readiness wait for unrelated services. Preserve genuine Dev Container hook dependencies.
Allow bounded CPU bursts, retain active work, and shut down idle compute. Process views consume
bounded events instead of repeatedly fetching and rebuilding unchanged state. RAM snapshots,
live migration, generic runtime providers and a second control plane are not part of this design.

## Staging and retained work

Each Project has one independently reconciled Staging Preview at the exact promoted revision,
without a Developer IDE or Change Agent. Declared development App previews remain bound to their
own Workspace. Promotion replaces only healthy Staging revisions.

Checkout and approved data survive compute Stop and Trash. Restore does not restart implementation.
Data removal is explicit and must account for file-access resources as well as execution resources;
ordinary compute shutdown must not delete the files or their access service.

A connector transport timeout withdraws readiness, not ownership. Factory observes the recorded
Pod UID before treating reconnect delay as runtime failure. A live owned Pod or an unavailable
Kubernetes observation retains its capabilities and remains reconnecting. Repeated observations
detect missing, terminal or changed resources without adopting a replacement UID. Explicit Stop
and confirmed runtime failure still fence capabilities and clean up only owned resources.
