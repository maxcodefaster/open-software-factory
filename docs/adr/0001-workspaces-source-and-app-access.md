---
status: accepted
---

# Workspaces, source and App access


This record holds the decisions formerly numbered 0001, 0009, 0033, 0034, 0037. Each section keeps its original wording.


## Independent editing, durable Workspaces and prepared compute

Factory separates the Developer IDE, durable Development Workspace and replaceable execution
Sandbox. One warm Theia backend per active developer is the target, rather than one backend per
open Ticket. Editing must not wait for Factorybox, the Dev Container, Apps, OpenCode or browser tools.
The [architecture reference](../README.md#verification-and-operating-limits) records verification
and operating limits separately from this decision.

### Workspace and editor ownership

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
The concrete file-access design is accepted in [ADR 0001](#workspace-file-access-independent-of-execution).

### Execution and reserve

Each Development Workspace has at most one assigned running Sandbox. Every new start has an
immutable Runtime Attempt; retries of the same intended create retain its identity. Factory
persists intent before external creates and assignments. A running Agent does not stop merely
because its editor, Ticket or Preview is hidden.

Every Sandbox uses an admitted, pinned Factorybox worker with Sysbox and a private Docker daemon,
the exact Dev Containers CLI, and the Factory Runtime Connector. This supports Docker-in-Docker
without exposing the node Docker socket to Project code. The privileged shared worker is
trusted infrastructure; Sysbox shares the host kernel and is not separate-kernel VM isolation.
This decision targets authorized Enterprise development, not a public hostile-code service.
The concrete worker, canonical Source and same-worker Pause/Resume boundary is defined in
[ADR 0002](0002-factorybox-worker-and-execution.md#run-workspace-execution-in-factorybox-with-shared-canonical-source).

Factory maintains a small reserve of clean, unassigned, prepared execution slots. It replenishes
after reservation rather than waiting for the reserve to become empty. A configured minimum-ready
target is constrained by maximum slots, creation concurrency and total compute budget.
Project-bound paused Forks retain their current recipe rather than cycling on an idle timer,
as specified in [ADR 0002](0002-factorybox-worker-and-execution.md#run-workspace-execution-in-factorybox-with-shared-canonical-source).
Ready and in-flight creations count toward reconciliation so a burst or failed start cannot create
an unbounded replacement loop. Exhaustion leaves the editor usable and compute honestly preparing.

A slot contains approved base tools and images, not repository data, Project hooks or user secrets.
Reservation and one-time assignment are durable, deterministic and recoverable; fresh capabilities
are issued only after assignment. Used slots never return to the unassigned reserve. Their data
remain under their owner or their disposable compute is destroyed. Standby waiting and Connector
activation are Factory-owned behavior, not a rewritten admitted Runtime Attempt.

An unused Sandbox cannot adopt another Workspace's canonical Source under live file descriptions.
Prepared slots therefore serve fresh Staging and Verification runtimes with their own clean
private storage. Existing Workspaces retain their canonical Source identity and use normal
preparation or resume their own retained compute. Used slots never return to the reserve.

### Preparation and resource use

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
Main-Preview image-preparation jobs. One live producer runs at a time, through confirmed native
Delete or complete Stop. Outstanding private backing cleanup keeps its storage ownership and failure;
it does not hold the global producer queue after that exact Sandbox's native Delete is confirmed.
Persist deterministic intent first, coalesce superseded inputs and expire interrupted producers after twelve
minutes. Worker readiness is infrastructure admission, not a running image producer. Prebuild
Attempts use the same observed native Sandbox Start as other roles; the preparation coordinator
separately owns job expiry and teardown. A confirmed image is reusable only for its exact commit,
recipe, resolved image/Feature inputs and native platform. Builds with protected build
variables or Project registry grants also bind the exact environment version; runtime-only
values do not invalidate a credential-free image. Normal image tags
and JSONC remain repository-owned;
resolve and freeze only an isolated build snapshot. The consumer uses a temporary image configuration
and upstream image metadata so Feature lifecycle hooks still run. Dirty source, changed inputs,
unsupported recipes or failed preparation use normal compliant startup. Compose preparation builds
the selected primary service with the unchanged CLI on the admitted native platform. Resolve its
committed Compose files and immutable image/Dockerfile inputs without producer-environment or
external-file dependencies. The consumer keeps the original service files and lifecycle hooks,
adding only a primary-image override that removes its redundant build. This caches the toolchain
image; it is not evidence that dependency hooks ran or that a paused Project Fork is available.

Use OpenBao KV v2 for encrypted Project values. PostgreSQL owns masked manifests, versions and
deterministic write intent/outcome, never values. Project managers replace protected values; developers
read configuration status. Development and Main-Preview are independent, and Verification receives
only explicitly granted values and registry access. Scoped, memory-backed runtime credentials preserve
the admitted version through later settings changes. Image-build secrets require repository-owned
BuildKit secret mounts rather than build arguments. Authorized Project code and its coding Agent can
read their runtime variables; UI masking is not code isolation. New settings apply to subsequent starts
and builds, without stopping current work. Main-Preview remains a Dev Container, not a release artifact.

Keep registry access close to execution and prepare each actual image-cache tier: node/Kubelet,
the Factorybox worker's immutable base import, and private Workspace Docker.
Do not share a live Docker graph directory between
Workspaces. Separate durable source and approved data from bounded, disposable image and build caches.
Theia belongs in the Developer IDE image; other tools are exact, role-specific artifacts rather than
an all-tools payload copied into every runtime.

Prepare only used Workspaces. Start optional browser tools and processes when needed, without making
editor or PTY readiness wait for unrelated services. Preserve genuine Dev Container hook dependencies.
Allow bounded CPU bursts, retain active work, and shut down idle compute. Process views consume
bounded events instead of repeatedly fetching and rebuilding unchanged state. Same-worker RAM
Pause/Resume follows ADR 0002. [ADR 0001](#release-idle-submitted-ticket-execution-instead-of-checkpointing-it)
releases submitted, settled Ticket execution through idle Stop instead of another RAM checkpoint.
Live migration, generic runtime providers and a second control plane
are not part of this design.

### Staging and retained work

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

## Workspace file access independent of execution

Use a Factory-owned Workspace file service and narrow Theia adapters for files, search and change
events. This lets one developer backend access canonical checkouts on different storage nodes while
execution is stopped. It avoids a second synchronized checkout and a broad filesystem mount into
the developer backend. This is the concrete design for the independent editing decision in
[ADR 0001](#independent-editing-durable-workspaces-and-prepared-compute), authorized for Slice 17. Acceptance of this
decision does not claim an implemented capability; the
[architecture reference](../README.md#verification-and-operating-limits) records implementation evidence.

### Storage and execution

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
It remains available during active editing independently of the Factorybox Sandbox and Dev Container lifecycle.
Historical unused Workspaces do not each require an always-running file service.

After a brief stable selection, prepare only the authorized selected Project's personal source
alongside its developer IDE. Coalesce rapid selections to one running admission and the newest
pending Project. This preparation admits neither Apps nor Build. An explicit retry after a timeout
re-observes the same resource intent and access epoch, confirms exact resources and warms authenticated
file access before readiness. Stop and changed authority still fence the result.

Failed file access has an explicit Restart action. It confirms Stop before preparing the next
source-access epoch on the same retained Workspace storage. It does not restart the developer IDE
or Apps, discard browser buffers, or change execution Runtime Attempts. Cancellation or an
unconfirmed Stop cannot proceed to a new source-access start. An ordinary connection retry only
re-observes the recorded source intent.

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

### Theia and file operations

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

### Project language tools

Keep the independent editor small with a fixed TypeScript/JavaScript and Python language preset,
rather than a general VS Code plugin host. Start tools is an explicit execution action, separate
from opening source. It may prepare the actual Dev Container and requires the current Change
Writer. The Connector starts unchanged pinned language servers on demand in that container.
TypeScript uses Project dependencies, and Pyright reads the actual Python environment and Project
configuration. Neither editor-local tools nor a second synchronized checkout stand in for them.

Use the existing authenticated runtime WebSocket transport, bound to the exact Workspace and
Runtime Attempt. Language requests cannot select executables, roots, plugins or commands and
cannot apply edits. Stop, lost authority and disconnect close the processes. Reconnect creates
a new language connection, reopens retained buffers and does not replay old requests.
Dependencies in runtime-only mounts or outside source use read-only, session-reported document
identities containing the original Runtime Attempt. Their bounded reads use that same connection,
not unrestricted file access on the Theia backend. Project source retains its normal canonical URI.
This preset is deliberately smaller than full IDE plugin compatibility.

### Why this integration

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

## Release idle submitted Ticket execution instead of checkpointing it

After the existing idle period, Factory stops a Ticket's submitted, settled Agent execution
through its normal retained Stop path. It keeps canonical Source, native Sessions, the completed
Turn, commit, approvals and results. A later commissioned operation gets fresh execution without
replaying that completed Turn.

The settled Session must target the Ticket's current Runtime Attempt, have a completed active
Turn and a successful commit for that Change. Human writing, pending or uncertain work and
unfinished Git operations cannot qualify. The same genuine-use, open-terminal, in-flight-operation and observation guards used for
idle Pause still apply. Intent is persisted under the existing Project and Change locks before
external cleanup. Reading or opening an observation-only view does not restart the released compute.

Personal Workspaces and unsubmitted work retain idle RAM Pause/Resume. Checkpointing submitted
Agent execution instead would preserve an unnecessary private Docker tree and RAM image on the
bounded store while Verification needs its own fresh environment. This decision does not resize
an admitted store, retire an earlier worker epoch, remove Source or guarantee unlimited capacity.

### Known failed Agent execution

The same idle release applies to a known failed Agent Turn whose failed Session and admitted intent
both identify the Ticket's exact current Runtime Attempt and native Session. Explicit retry already
fences and stops that execution before granting a new writer. Checkpointing it first adds storage and
capture failure without providing a supported retry path.

Normal Stop retains unsubmitted Source, the failed Turn and native Session; it starts no retry.
Human writers, another or unknown execution, active or uncertain work and unfinished Git operations
do not qualify. The same terminal, genuine-use and in-flight-operation guards remain mandatory.

### Release before fresh Verification

Fresh Verification also releases its exact submitted Agent execution before admitting another
Sandbox. Waiting for the idle grace would overlap two private Docker trees for one finished
implementation and can exhaust the bounded store during dependency installation. Use normal Stop
and wait for its positive cleanup result; a lost response or failed cleanup cannot admit the
replacement or repeat the Stop dispatch. Existing Verification execution is left unchanged.
Continuing a queued bootstrap may release its completed Coding predecessor, but keeps the same
Verification Runtime Attempt. A running Verification is not interrupted. A failed or stopped
Attempt remains retained until an explicit bootstrap retry, never replaced by periodic reconciliation.

The submitted commit must be the Verification candidate. The completed Session or that commit's
successful integration must identify the Ticket's current execution. Integration does not retarget
the retained native Session. Unfinished work, human writing and unrelated executions never qualify
for this automatic release. Current terminal observations and in-flight-operation guards still
apply, without an additional idle grace at this phase boundary. Source, writer authority, native
Sessions, approvals and results remain retained. Independently commissioned work keeps its existing
admission rules; this is not a global Sandbox-count limit or an allocation guarantee.

## Pin new Ticket execution to the submitted source

A fresh Ticket Runtime Attempt uses the latest successfully submitted Change commit for its
configuration and declared Apps, or the approved base before the first submission. The Workspace
keeps its original Source seed and canonical checkout. Reusing the seed for execution would launch
old App commands while independent Review inspects a newer candidate.

The database admits only that exact Change/project revision at create time. Existing Runtime
Attempts remain immutable, including capacity-waiting intents; recovery uses their recorded
revision. A new submission during configuration resolution aborts admission before external
creation rather than silently retargeting it. This does not reset Source, restart a completed Turn
or make a running App automatically adopt changed launch configuration.

## Bind published App addresses to their Runtime Attempt

An application cannot derive its browser address from an internal Dev Container port.
Freeze the public Factory origin with new runtime artifact intent, then provide declared
App processes with `FACTORY_APP_ORIGINS`, a JSON object mapping their declared ports to the
isolated origins of that exact Attempt. Use the existing process-environment contract,
without an additional Connector protocol or Project-specific Factory adapter.

These are public addresses, not access grants. Factory credentials, proxy trust, Project
authorization and App authentication remain separate. Existing intents without this
declaration keep their exact assignments; recovery never fills the value retrospectively.
Prepared templates exclude Attempt-specific address metadata, and assignment supplies it
for the consumer. Internal health and service connections still use their declared local
targets.

Top-level App links without a runtime cookie return through Factory's existing session-
and Project-authorized access issuer, preserving the exact App path and query. The issuer
still decides access and creates the one-use grant. API calls, embedded frames and invalid
grant redemptions remain denied; App cookies are never shared across isolated origins.
