---
status: accepted
---

# Workspace file access independent of execution

Use a Factory-owned Workspace file service and narrow Theia adapters for files, search and change
events. This lets one developer backend access canonical checkouts on different storage nodes while
execution is stopped. It avoids a second synchronized checkout and a broad filesystem mount into
the developer backend. This is the concrete design for the independent editing decision in
[ADR 0001](0001-development-workspaces-and-staging.md), authorized for Slice 17. Acceptance of this
decision does not claim an implemented capability; the
[architecture reference](../README.md#verification-and-operating-limits) records implementation evidence.

## Storage and execution

Each Workspace has one durable source volume and one authoritative checkout initializer, with
persisted intent and incomplete-create recovery before either editing or compute uses the checkout.
A single digest-pinned Source artifact initializes the checkout and then serves files. Initialization
runs with bounded ownership capabilities; before opening the checkout for requests or listening,
the process permanently switches all threads to UID/GID 101000, clears supplementary groups and
capabilities, and forbids privilege escalation. Initialization evaluates no repository hooks or
Project code. Failure or cancellation never exposes partial source. This avoids a second container
startup without retaining a privileged serving process.

The file service mounts only the source parent and its own read-only assignment, not Docker graphs,
service data or execution assignments.
It remains available during active editing independently of the Envbox and Dev Container lifecycle.
Historical unused Workspaces do not each require an always-running file service.

After a brief stable selection, prepare only the authorized selected Project's personal source
alongside its developer IDE. Coalesce rapid selections to one running admission and the newest
pending Project. This preparation admits neither Apps nor Build. An explicit retry after a timeout
re-observes the same resource intent and access epoch, confirms exact resources and warms authenticated
file access before readiness. Stop and changed authority still fence the result.

The file service and assigned runtime mount the same source inodes on the same storage node.
The mounted filesystem provides ordinary local POSIX and file-watch semantics. Its durable backing
may be a supported replicated block volume; physical node-local disk is not a durability guarantee.
With RWO storage, service and runtime use the same namespace/claim and enforced placement.
Storage failover has one owner and reports unavailability rather than mounting two divergent copies.
The developer backend need not share that node.

Docker graphs, service volumes and heavy dependency/build caches remain Workspace-private and
outside the file-service mount. Overlaid dependency directories are not another authored checkout.
Project language services must use the actual execution environment and dependencies; source access
alone does not establish completion, refactoring or full language support.

## Theia and file operations

Keep upstream Theia unmodified. A Factory extension translates immutable Workspace-qualified
resource identities to scoped file-service operations. Root selection alone is not authorization.
Stock Theia search uses backend-local paths, so search needs an explicit adapter too. The service
can perform fixed, bounded source search, but exposes no arbitrary shell, executable hook or tunnel.

File reads, listings, writes, renames, deletions, search and subscriptions require current Developer
authority for that exact Workspace. Access has its own service identity and revocation epoch,
independent of a Sandbox Runtime Attempt. Revocation rejects further operations and closes streams.
The backend receives no installation-wide mount or reusable forge, model or Kubernetes credential.
Resolved paths and race-safe operations stay within the checkout; path-prefix checks alone cannot
prevent traversal or symlink escapes. Unix ownership must account for Sysbox UID mapping and the
actual Dev Container user rather than assuming UID 1000 means the same thing in sibling Pods.

Saves use observed file versions and atomic replacement where appropriate. Known stale saves retain
the human buffer for conflict resolution. An ETag check plus rename is not serializable editing
against arbitrary shell writes. Agent and commit writers require explicit coordination; there is
no claim of CRDT collaboration or a blanket guarantee against uncoordinated runtime writers.

The source service observes local file changes and forwards bounded events to the IDE. Runtime
watchers observe the same inodes, including IDE writes. Reconnect and event overflow trigger scoped
reconciliation rather than silently losing changes. Events are ephemeral, not Evidence or Zero data.
Workspace changes preserve original buffer URIs and per-Workspace editor state; no writable
`/current` symlink or forced save is used. PTY and Run routing remain tied to their exact runtime.

## Why this integration

Stock Theia file access and search are backend-local. An NFS/RWX mount does not automatically fix
cross-node watches: Linux inotify does not observe remote-client writes. Polling every repository
would add recurring I/O and still require Project watcher configuration. Co-locating every developer
and all their shared Tickets on one node would impose an unsuitable multi-Project constraint.
The narrow file/search/watch integration adds implementation work while keeping Project toolchain
I/O local and the developer backend independent. It must not grow into a remote-development platform.

Before implementation acceptance, prove actual source access with compute stopped, writes and Hot
Reload in both directions, stale-save behavior, safe switching, UID/mount correctness, revocation
and source-resource teardown. The exact CSI/storage choice and supported Theia adapter hooks need
a bounded correctness check. No startup or footprint improvement is claimed before that proof.

References: [Theia filesystem provider](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/filesystem/src/node/filesystem-backend-module.ts),
[Theia search](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/search-in-workspace/src/node/ripgrep-search-in-workspace-server.ts),
[Linux inotify](https://man7.org/linux/man-pages/man7/inotify.7.html),
[Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).
