# Substrate ROOTFS operator profile

This is the concrete amd64 Substrate **v1.0.0** operator/bootstrap path for the
accepted **ROOTFS cold restart** contract. It does not change the existing Factory
deployment, default runtime, retained data or Factorybox repository. No runtime
fork, provider framework or new controller is used. The concrete Factory Workspace,
Connector and Source path is described below. Coding, Verification/Delivery,
archive/manual-Continue and retained cutover still need product integration and proof. The Factory
[gRPC/Connector adapter slice](../../services/substrate-control/README.md) is
available without changing these profile pins or the retained runtime default.
Fresh isolated publication and Staging starts in an explicitly native Project
fail closed until their native owners are enabled; they never fall back to creating legacy capacity.
Existing retained Attempts keep their original observation paths.

## Fresh Factory Workspace provisioning

The normal Factory image now embeds `/usr/local/bin/factory-substrate-control`,
built with the pinned Go toolchain and the unchanged official v1.0.0 module.
No operator-copied bridge binary is needed. The authenticated
`startPersonalWorkspace` command can create a **fresh** personal Workspace and
provision its deterministic Atespace, editor grant, immutable ActorTemplate and
Actor. The default runtime and existing Workspaces are unchanged. Configuration
is explicit and Project-scoped through `FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION`;
the earlier `FACTORY_SUBSTRATE_OWNED_CONFIGURATION` prepared-binding proof remains
separate and cannot be configured at the same time.

Fresh Ticket provisioning now routes through the existing `startPersisted`
owner, with additive migration 0022. It retains the real Ticket/Change identity,
approved branch, existing compute admission and original native provisioning
intent. A commissioned Contributor uses the saved Agent turn and its live
authority/lease, not a personal Owner or Developer impersonation. Human execution
still requires the current Developer writer. The native bootstrap uses the same
`agentConfiguration` and pinned OpenCode process settings as the existing runtime.
This is integration in progress, not a qualified Coding, QA or Delivery journey.
The shipped-template interview, human approvals and live model proof remain
separate acceptance gates; controller fixtures do not satisfy them.
Native Project prebuilds now enter the existing preparation queue with additive
migration 0027. Each producer retains its exact revision, Environment version,
private checkout, native create outcomes and publication repository; it allocates
no Workspace, canonical Source writer or legacy worker. Set `prebuildRegistry` to
an explicitly admitted TLS registry hostname on port 443 (the Connector's port
must also be 443). Credentials and any registry CA come only from that frozen
Project Environment, never the Factory/Forge administrator. Missing publication
configuration or a missing committed Project Environment registry credential fails
closed before provisioning. Lost replies observe the same
names, and a published result releases the producer only after exact-UID Delete
is confirmed. Registry/image selection changes do not rewrite retained owners.
Migration 0028 keeps isolated generations local to each Verification or preparation
owner, without a shared Project counter.
These are controller regressions, not live native prebuild qualification. Runtime-only
Compose service environments are omitted from the private producer snapshot without
resolving their values; consumers retain the original files and fresh Runtime grants.
Image/build/file-selection interpolation remains refused. The Connector component lane
checks a real pinned CLI build, completed-result reuse and a cache-independent consumer;
the shipped Starter still needs actual Substrate producer qualification. Unsupported
recipes keep normal startup available without exporting Runtime secrets. A dispatched
build with no positively observed original image is retained as uncertain, never rerun.
Native producers use only the verified Actor-private Docker socket and proxy.
Image-only Compose primaries reuse the bundled networkless HTTPS/CA preparation
before Features build. Public transport is hashed into the recipe; local image and
Actor identities stay private and are not needed to match a cached artifact.

Native model and browser callbacks use the exact Connector HTTPS origin, with
their existing attempt-scoped tokens. Legacy internal-host URL settings do not
redirect these capabilities outside the pinned native TLS/egress boundary.

Fresh native Verification now enters the existing `startVerification` owner with
additive migration 0023. It provisions an independent exact-commit checkout and
the pinned one-job runner bound to that Forgejo job, using the admitted public
Forge HTTPS origin and existing Verification environment filtering. It allocates
no Workspace, canonical Source writer or synthetic worker, and reuses the same
Substrate Actor lifecycle and UID-bound cleanup. Lost create replies retain their
original intent and are observed rather than repeated. Additive migration 0024
retains each provisioning generation when the existing explicit queued-bootstrap
retry decision has confirmed exact predecessor cleanup; a lost or still-live
outcome cannot select a successor. These are controller regressions, not real
native CI qualification. Live prebuild, Staging, publication and the
shipped-template journey remain open.
Ticket bootstrap repository reads recheck the current commissioned writer and live
execution lease. Isolated Verification reads use their exact-job provisioning grant,
not a personal Developer Workspace grant, and reject a retargeted repository or
an execution that has already become ready or retired. Neither read starts inference.

Native commit and merge operations write Source as the development UID, not the
privileged Parent. Credential-bearing fetch and push run only in a new
Parent-private bare Git repository. Exact-commit object packs cross pipes between
that repository and development-owned Source; Project config, hooks, attributes
and filters never receive the remote credentials or privileged execution identity.
The existing exact-parent recovery, expected remote HEAD and observed push result
checks remain in force. Failed trust or authentication does not authorize a merge,
and observing an already-pushed exact commit does not push it again. The owned
Linux Connector lane checks this with real HTTPS Git, development-user filters,
negative CA/credential cases and complete Source export. This does not substitute
for the native image qualification or the live human-approved Ticket journey.

The configuration shape is defined in
[`substrate-workspaces.ts`](../../apps/factory/src/runtime/substrate-workspaces.ts).
Set `deployment: fresh-workspaces`, the exact database name and Project UUID,
`profile: nightly-20261109-975fb172241c`, the **actually observed** native runtime
version, a digest-pinned `workloadImage`, an exact WSS `connectorURL` and an
absolute `factoryCAFile`. `workerSelector` must contain the profile label and a
unique `factory.dev/deployment` label already on the owned WorkerPool. That is
installation provisioning, not a per-Workspace relabeling fixture. `egressHosts`
contains only explicitly allowed additional TLS destinations on the Connector's
port (normally 443), for example the chosen image registry and its authentication
and blob origins. No host Docker socket, Kubernetes credentials or global native
credentials are projected into an Actor.
Updating `workloadImage` or optional `resources` (`cpuMilli`, `memoryMiB`) selects
new pins only for fresh owners. Existing
Workspaces keep their saved image, template and provisioning intent for observation,
Stop and continuation. The update never replaces an Actor or reinterprets its
snapshot. Changes to trust, scope, placement or egress still fail closed against
retained intent; this is not a runtime migration or automatic qualification.
Resource admission charges the exact selected native limits against existing
Factory/Project allowances; old native bindings retain their original 1500m CPU /
1024 MiB limits and accounting. Those old smoke limits did not fit the real Starter
dependency hook, which Substrate killed for exceeding memory. No failed Actor is
resized or restarted to hide that outcome. WorkerPool capacity admission still applies.

For `fresh-workspaces`, installation capacity admission observes the one original
WorkerPool selected by those installation labels and its exact pinned SandboxConfig.
It uses the original pinned worker image for distinct, deterministic pools on joined,
Ready, schedulable Linux amd64 nodes. Node taints, pressure, Pod requests and allocated
resize reservations remain admission barriers. No node opt-in label or approval is
needed. Each new pool requests its full finite budget after the existing 2048 MiB
memory headroom and 250m CPU headroom for independent access services; original
pools are not resized, patched, deleted or replaced.
Additive migration 0025 retains the selected node/boot, original pool/profile,
budget, creation intent and returned pool UID. Missing, rejected, changed or
uncertain creates never authorize another create. These capacity changes still
need controller, chart and native joined-node qualification before claiming that
the shipped-template journey or different-node recovery has passed.
Git uses `FACTORY_FORGEJO_PUBLIC_URL`, which must be HTTPS on that same port with
its hostname admitted by `egressHosts` (or equal to the Connector hostname).
Native fetch/push never use legacy internal HTTP addresses or follow redirects.
For a new Project created through Factory setup, begin and save the normal setup
draft first, then include its exact `setupID` alongside the reserved `projectID`
in this configuration before Create. Only that authenticated draft receives the
native Project identity. The repository intent persists it before Forge creation;
restarts observe that intent without reallocating it. Another draft stays outside
the reservation, and retained Projects or previously admitted intents cannot be
retargeted. Native Git still uses the admitted public Forge origin, independently
of its private API transport. No Project rows, approvals or runtime resources need
fixture insertion.
Build and Delivery recheck the destination at the actual Parent dispatch fence.
After a turn completes, only an already saved integration with its exact submitted
parent and current Delivery queue may reopen that same confirmed Actor without a
Coding lease. Stop, revoked access, newer requirements and retired intent still block it;
this grant never authorizes inference or creates a replacement Actor.

`connection` and `provisioner` both use `bridge`, `endpoint`, `serverName`,
`caFile` and `tokenFile`; the serving name remains `api.ate-system.svc`.
**Substrate v1.0.0 requires global Owner for CreateAtespace.** Supply that separately
rotated, short-lived credential only to `provisioner`. `connection` is the Factory
application's audience-bound Editor identity. `editorPrincipal` is its exact
`user:system:serviceaccount:NAMESPACE:SERVICEACCOUNT`. Factory creates only that
Atespace's single Editor binding. The bridge exposes no global AccessPolicy update
or native delete/provisioning administration beyond this concrete path. Holding
the provisioner credential still makes the trusted Factory control plane a native
global Owner; the process allowlist is not a security sandbox for that credential.

The normal chart supports `substrate.workspaceConfigurationSecret` (keys
`configuration.json` and `factory-ca.pem`) and `substrate.provisionerTokenSecret`
(key `token`). Connections in that JSON normally use:

- bridge `/usr/local/bin/factory-substrate-control`;
- editor CA/token `/run/factory/substrate-control/{ca.pem,token}`;
- provisioner CA at that same CA path, token `/run/factory/substrate-provisioner/token`;
- Factory CA `/run/factory/substrate-configuration/factory-ca.pem`.

The chart projects the Editor token with API audience and 600-second lifetime and
the live serving CA. The separately privileged provisioner Secret must be rotated
by the installation's credential owner **before expiry**; Factory reopens it per
RPC and never mints a long-lived token or installs a grant-renewal controller.
After the original Atespace/grant is confirmed, continuation revalidates it through
the scoped Editor connection, not the global provisioner credential. Missing or
changed grants still fail closed; this does not authorize another Create.
Do not grant native global Owner to the application Editor ServiceAccount. Native
capacity adds Kubernetes WorkerPool `get/list/create` and SandboxConfig `get`, not
pool patch/delete, RBAC administration or Actor credentials. No fsGroup is added.
An Ingress must allow the normal WSS and
read-only Git bootstrap routes while preserving serving TLS/SNI/SAN.

Build the Actor image with [`Runtime.Dockerfile`](Runtime.Dockerfile), supplying
immutable `FACTORY_RUNTIME_HOST_IMAGE` and `FACTORY_SUBSTRATE_BOOTSTRAP_IMAGE`
digests. The former is the normal Factory runtime bundle, built from
`deploy/runtime-host/Dockerfile`; the latter is the qualified rootless bootstrap
above. This intentionally replaces its old Docker 29.0.0 engine with Factory's
**29.9.0** binaries and retains Compose **5.7.0-dev.1e1c577**, Node **24.21.0**,
Dev Containers CLI **0.89.0**, Connector and the packaged OpenCode **2.0.27** tools.
The image build checks executable versions. It does not substitute newer packages
or qualify every Dev Container feature or Coding/Verification workflow.
For image-only native primaries, the Connector prepares a private, networkless
dependency layer before Features run. It supplements the image's public trust,
keeps those roots through `ca-certificates` installation, and changes APT repository
schemes to HTTPS without changing hosts, paths or signature settings. The original
image identity, required Features, lifecycle hooks, Source and Compose data remain
authoritative. Docker build proxies and lifecycle environment use the Actor-private
proxy; no Parent credentials or additional egress ports enter the layer. Lost build
outcomes are observed under their original creation intent, never blindly rebuilt.
Required Features consume its owned local tag rather than a bare image ID, which
BuildKit would interpret as a registry repository. Factory verifies that tag's exact
image ID and ownership again before startup; Source cannot supply this bypass.
Native startup defers user lifecycle commands with the pinned CLI's
`--skip-post-create`, inspects the exact primary and its one private bridge, then
uses `run-user-commands` once with that bridge's observed proxy gateway. Child
transport uses the same observation; Compose never inherits another bridge's
unreachable default address. Missing, changed or ambiguous networks fail closed.
This path still requires rebuilt-image and shipped-template native qualification;
the earlier Alpine Workspace proof does not qualify it.
The Factory-specific child bootstrap lets Docker 29.9 manage its own matching
containerd. The Docker bundle supplies shim **2.4.1** but omits the standalone
daemon. The image therefore intentionally replaces the bootstrap's **2.1.5** daemon
with the official **2.4.1 static** binary (no injected glibc compatibility layer), exact release/revision/checksum in
[`runtime-pins.json`](runtime-pins.json). It never combines the new shim API with
the older daemon. The standalone qualified Docker 29.0 profile and its child script stay
unchanged; only the explicitly new Factory image selects `runtime-child.sh`.
The pinned gVisor virtual kernel has **no nested cgroup-namespace feature**.
The inner daemon therefore uses its Actor-private virtual cgroups (`host` in
Docker's inner terminology), never the node's cgroup hierarchy. The Connector
accepts that one resolved field only with an unexported assignment fact set by
`native-parent` after the exact private RootlessKit UID/GID checks, matching
projected Actor UID and actual absence of `/proc/self/ns/cgroup`. The Parent has
authenticated that Actor-bound capability before container inspection. A Project
JSON field or environment variable alone cannot enable it. Factorybox still
rejects host cgroup namespaces, and every other container/mount/capability fence
remains unchanged. There is **no qualified per-inner-container cgroup/resource
enforcement** in this profile; Actor-level native limits remain the boundary.

Factory persists provisioning intent and external dispatch/outcomes before each
Create in additive migration 0020, using the existing Workspace lock. There is no
second runtime state machine. Lost replies observe only those names; preexisting,
rejected, recreated or changed resources are never adopted or recreated. Native
Start retains the existing admission, personal Owner, Developer and immutable
Actor/UID/runtime/ROOTFS guards. Environment selection and the actual Project
System Contract remain pinned; native RUNNING alone is never App/Connector ready.

The owned native Factory lane proves initial checkout, Parent/Child, App and
Terminal readiness, synchronous durable ROOTFS suspend and renewed workflow
readiness with fresh authenticated Connector connections and dirty-Source readback.
ROOTFS cold restart can retain the private build-secret symlink while replacing
`/dev/shm`. Under the existing exclusive lock, the Connector removes only its owned,
exactly bounded orphaned pointer and rematerializes the authenticated environment
in fresh memory. Existing targets still require a private, owned directory; foreign
or malformed pointers remain refused. Workspace and private Docker data are not
reset. This is the pinned same-node cold-restart proof, not different-node recovery,
complete toolchain qualification or retained cutover.

Initial Source uses the existing atomic checkout initializer inside the Actor's
durable directory, assigning development UID 1000 inside the existing private
RootlessKit namespace rather than applying the Sysbox host mapping. Its root maps
only to the unprivileged Actor UID 1000; host/Actor root is refused by the initializer.
The real Parent starts the declared Dev Container and injects the real Child;
both use the restricted proxy and copied trust bundle. The initializer never
resets an existing checkout, including dirty Source. For an active initialized native
Workspace, the normal Source/editor protocol routes CRUD, search and watch over
its authenticated **Parent** connection to that exact checkout. No shared Project
tree, second active writer or App port is involved. Parent explicitly advertises this protocol; older images remain
unavailable rather than reporting false Source readiness. The reused Go Source
service runs as development UID/GID 1000 in the verified private namespace, with
no-new-privileges and a separate random service-only capability. Its inherited
listener is in the Parent's owned 0700 directory, not on a network port. It never
receives Parent/Child/native credentials or Project environment secrets. Editor
atomic saves therefore remain writable by the Dev Container's development user.

Each forwarded request rechecks current personal Owner/Developer authority under
the existing Workspace lifecycle lock, the current Attempt/generation and live
Source owner and Parent protocol. Personal writes use the current monotonic writer epoch plus the existing file CAS;
path/symlink/hardlink protections stay in the existing Source service. The Hub
accepts responses only from the exact selected socket, and disconnect/revocation
cancels its watches. A new Parent reconnect must advertise Source again. Source
access never creates or wakes compute and never creates legacy Source/worker
rows for this Project. First initialization still requires the explicit normal
Workspace Start.

Ticket Source keeps Change human/Agent epochs separate from the storage-owner
checkpoint epoch. The current Change role is restored before Docker, and both
Actor-hosted and sleeping Source receive the existing handoff fence. A delayed
writable role grant cannot reopen a checkpoint-frozen owner. Editor access does
not create legacy Source or start Ticket compute. These role changes follow the
recorded personal-Workspace native proof and require a rebuilt runtime/native
qualification before extending that proof's scope.
An Agent role leaves human Source mutations observation-only. These checks do not
replace turn admission or authorize inference on reads or saves.
The runtime API reports `confirmed-same-node` only for the service-owned Source
and an independently observed durable ROOTFS matching the recorded UUID and
generation. A pending or different snapshot does not inherit that confirmation;
this is not evidence that queued OpenCode inputs have been settled.

Pause freezes Source writes under that same Workspace lock, drains Parent Git and
browser operations and stops the Actor's private Docker containers without deleting
their filesystems or volumes. Complete Source archives, including Git metadata and
ignored/private files, are written as immutable checksummed chunks and a manifest in
Factory's existing private object bucket. Unsupported ownership, privileged modes,
external links or metadata fail closed; retained files are not normalized or discarded.
The normal native checkout refresh runs Git as the development user so it does not
replace that user's metadata with root-owned files.
An idle claim blocks interactive work, not the Source drain and internal
checkpoint/chunk traffic needed to finish that already-fenced pause. A saved frozen
personal pause can recover its original Parent connection without admitting a Child
or replaying lifecycle work.

Only an independently observed completed durable ROOTFS snapshot permits Source
ownership to move to the independent service on Factory's retained state claim.
The Source tree and its confirmation marker publish together. Sleeping CRUD,
search and watch use that tree without calling ResumeActor. Concurrent startup,
file writes and ownership transfer use the existing Workspace lock and writer epochs.
Malformed confirmation or an unknown preexisting tree is refused without overwriting it.

Resume freezes and confirms the latest service-owned generation, stops that writer
and transfers ownership back. The cold entrypoint imports the authenticated latest
generation **before Docker starts**, so retained containers, watchers and agents cannot
start against the older tree. Private Docker data remains in native ROOTFS, outside
the Source archive. Neither file access nor restoration replays a model command.
Transient checkpoint-read failures retry only the same authenticated read under native
wakeup supervision and caller cancellation. Invalid serving identity, grants, epochs,
checksums and archive bounds still fail closed. Rebuilt-image qualification remains required.
Archive file reads use bounded read-only mappings. The pinned native runtime
accepts `O_NOATIME` but still changes access time on ordinary reads; mappings avoid
that mutation without changing the runtime or repairing Source timestamps. A
foreign truncate fails the archive instead of crashing the Source service.
Directory enumeration also ignores that flag. Native Parent therefore supplies
the Source service an archive-only descriptor for the same checkout inode through
a private read-only, noatime, nosuid, nodev and noexec bind alias in the existing
RootlessKit namespace. It changes neither canonical Source's mount nor normal
development-UID CRUD. The service receives no mount capability; archive traversal
stays beneath that pinned descriptor and needs no timestamp repair.
An interrupted native pause can re-enter Substrate's own workflow only after a
positive completed-durable observation of the exact persisted snapshot. A pending
snapshot alone never authorizes another Suspend RPC. An already completed durable
pause is observed without another dispatch. Pending/local-only snapshots never
authorize Source release.

This is a **same-node personal Workspace** proof, not different-node recovery, complete
toolchain qualification, Coding/Delivery, retained migration or zero-RPO evidence.
Its native receipt records `sourceHandoff: confirmed-same-node`, `coldRestart: true`,
`portable: false` and `fullFactoryE2E: false`. No replacement Attempt is enabled.
For `fresh-workspaces`, Stop still performs native synchronous Suspend and
returns the actual **paused** state, retaining the Actor and verified ROOTFS.
It does not delete dirty Source. Destructive Actor Delete is limited to the
explicitly disposable `owned-test` database proof; a Source handoff alone does not
authorize discarding retained private Docker data. No retained cutover is implied.
An initial personal bootstrap without its current Source checkpoint service cannot
dispatch a new native pause: an unavailable Parent does not prove that the workload
is still checkpointable. An original already-completed durable pause can still be
reconciled without another Suspend. Source then stays with that Actor; sleeping
editing is unavailable and handoff remains `pending`. Start/Resume stay blocked
until the bootstrap outcome is reconciled, so uncertain Features or hooks are not
replayed. This reconciliation does not settle Ticket or Coding inputs.
An exited workload is not proof that ROOTFS can still be checkpointed: a native
checkpoint failure can leave CRASHED with a PENDING snapshot. Factory records that
as failure, never as retained durability, and does not revert or recreate it.
New retained native bootstraps keep their existing Parent/Source service alive
after a startup failure, accepting Source checkpoint operations only. No hooks,
Git mutations, browser operations or inference are restarted. The recorded startup
failure survives Pause and still blocks implicit continuation after Source handoff.
The Hub keeps that advertised Source/checkpoint protocol available after failure
without marking App/Child readiness or allowing other Parent operations. Native CLI
calls use the saved private `COMPOSE_PROJECT_NAME`, rather than the checkout path's
derived name or a Project environment override.
Before a native CLI call, Factory reserves a missing Feature lockfile as development
UID/GID 1000. The pinned CLI writes that inode with its normal generation and
verification behavior. Reservation never truncates, replaces or chowns an existing
lockfile; unsupported retained ownership fails closed before CLI dispatch. This prevents a
fresh Parent from creating root-owned Source metadata; it does not repair or qualify
recovery of an earlier root-owned lockfile.
For an already-fenced retained checkout, the operator-only `native-source-preserve`
command can make a separate private recovery archive and prove its complete round
trip. It requires the exact Actor UID projection and existing private RootlessKit
root mapping, the caller's existing Workspace lock and confirmed writer drain.
Only the observed root:root 0644 regular CLI lockfile is additionally supported;
its ownership is preserved, not repaired. This version-2 recovery archive is not
accepted by normal version-1 Source materialization or published as a generation.
The command runs no Project processes or native lifecycle action, and neither its
archive nor its recovery-copy proof authorizes Suspend or claims ROOTFS durability.
If the earlier ordinary-read archive positively completed, explicit
`native-source-preserve-reconcile` requires its exact checksum and retained
recovery marker before making one separately named noatime-view copy. The first
archive is kept, uncertain exports are not repeated, and the original Source
fence remains unchanged. The command also re-exports Source to prove that all
archived metadata and bytes stayed unchanged during preservation.
Additive migration 0026 lets the existing frozen Source owner retain the exact
verified private archive reference through a bounded Parent-capability endpoint.
Only a failed initial personal bootstrap is eligible, with current Developer
authority rechecked after object readback. The reference stays immutable and does
not create an editor generation. Pause rechecks its complete manifest/chunks and
the live original Source Parent before requesting synchronous native ROOTFS.
Afterward Source remains Actor-owned and fenced, handoff stays `pending`, and
failed-bootstrap continuation stays blocked. This is retention, not sleeping
editing, Coding-input settlement or qualification of the Starter journey.
Failed retained bootstrap cleanup does not remove inner containers or their private
writable layers; the normal Source drain stops them before native checkpointing.
The normal Factory image packages the Source executable alongside the gRPC bridge;
an installed-image upgrade still needs its own backup, rehearsal and product proof.

Ticket writer transfer accepts this retained pause as a compute fence only when
the existing runtime observation independently confirms the matching durable
ROOTFS and service-owned Source (`confirmed-same-node`). A generic `paused` row,
pending Source checkpoint or running Actor cannot grant editing. Recovery can
continue only the already saved takeover or admitted Agent turn; it does not
commission new work. Agent Stop remains a separate prerequisite: pausing compute
does not cancel queued OpenCode inputs or clear `stop_pending`. A paused Ticket
with an unsettled assigned input remains blocked until its native input outcome
can be positively confirmed. The cold queue/archive lane uses the actual pinned
OpenCode server with a controlled provider; it is not the live template journey
or authenticated manual Continue acceptance.

The explicit owned native lane is:

```sh
mise exec -- bun run test:native substrate-workspaces.native
```

It requires `FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE`, not a retained default
cluster. Its installation infrastructure, confirmed Project repository and users
are owned fixtures; Workspace/Atespace/grant/template/checkout/Dev Container and
Connector activation are product commands, not fixture-created runtime objects.
It also checks real Source API/editor saves against PTY reads/writes, watch of an
atomic save, live App readback, development ownership, unauthorized/path negatives
and Source reconnection after cold restart. It also checks sleeping edits/search/watch
without waking the Actor, latest-edit restoration, private-file isolation between two
Workspaces, retained private Docker/volume state and a non-repeated Create hook.
It remains an owned Source fixture, not the shipped-template user journey,
different-node recovery or full Factory Delivery proof.

## Pins and contract

[pins.json](pins.json) retains the official Substrate commit/release/worker and
CLI checksum, official gVisor nightly commit/archive SHA256/**published SHA512**/
runsc checksum, and qualified Envoy binary/module identity. The nightly is an
explicitly accepted unreleased dependency, not `v7` or a production-supported
tag. Never overwrite an existing compatibility name with another binary.

[internal_flags.json](internal_flags.json) is copied into the unchanged release
worker. **`--tar-timestamp-resolution=nanoseconds` is required**: this nightly's
default still rounds timestamps. The other packet/raw/SUID flags are the retained
rootless bootstrap configuration, not security-policy source modifications.

Fresh Actors/snapshots must use `nightly-20261109-975fb172241c`. ROOTFS means
restarting processes, PTYs, connections and in-memory state, not MEMORY continuity.
`preferredFidelity` is only a request. Before releasing source-node data, the later
Factory adapter must explicitly call SuspendActor with
`options.mode=DURABILITY_MODE_SYNCHRONOUS` (**1**, not the asynchronous default),
then verify the actual snapshot UUID/generation, ActorUID, ActorTemplateUID,
sandbox runtime/version and **fidelity ROOTFS (2, never VOLUMES=1)**, with
`durableSnapshot.state=COMPLETED`. `SUSPENDED`, a successful RPC or a local snapshot
alone is insufficient, including an already-suspended Actor returned by a sync call.
This profile does not implement that later lifecycle adapter.

## Prepare and build

Run from the Factory repository root with `mise exec --`. Prerequisites: Linux
amd64, Docker build/push, Git, Go, GNU tar with zstd, kubectl and a separately owned
Kubernetes context. Use a **new output directory**, not a retained installation.
Obtain a clean Substrate checkout at commit
`b34fbee742906494b5eb4f1f36987176bf8770a4` (`v1.0.0`). Set `SUBSTRATE`, `OUT`,
`KUBECONFIG`, `CONTEXT` and your own pushable `REGISTRY`; no implicit current
Kubernetes context is used by the profile commands.

```sh
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts assets "$OUT"
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts verify-assets "$OUT/gvisor.tar.zstd"
docker build --platform linux/amd64 -f deploy/substrate/Worker.Dockerfile -t "$REGISTRY/worker:rootfs-ns" .
docker push "$REGISTRY/worker:rootfs-ns"
docker build --platform linux/amd64 -f deploy/substrate/rootless/Dockerfile -t "$REGISTRY/rootless:bootstrap" .
docker push "$REGISTRY/rootless:bootstrap"
```

The asset command verifies SHA256 **and** SHA512 before saving the official
archive, checks its extracted runsc, and checks the official release CLI. Files
are created exclusively; an identical existing file is reusable, a different one
is never overwritten. SandboxConfig uses the same content-checked official
`gs://gvisor/...` URL through native asset synchronization; the downloaded copy is
an operator verification artifact, not a custom distribution server.

The rootless image is a **bootstrap**, not the qualified Factory toolchain.
Its immutable Docker 29.0.0 rootless base is the retained probe base. Alpine
packages are resolved by APK at build time (not claimed bit-reproducible); retain
the built image digest and package inventory, and requalify any changed packages.
The Dockerfile checks the selected Docker/Tinyproxy versions. It supplies legacy
iptables, SUID newuidmap/newgidmap (file capabilities removed, as required by the
retained gVisor bootstrap), RootlessKit/slirp namespaces, Tinyproxy, normal HTTP(S)
proxy/CA
environment, a private containerd with bounded readiness, vfs Docker storage,
transient process cleanup and a real `/readyz` wakeupProbe. Cleanup never removes
the persistent Docker graph/database. No host socket or host cgroup mount is
included. Only SETUID/SETGID are added by the native ActorTemplate.

The explicit workload command starts only after Docker readiness; `/readyz`
checks the current daemon and workload process, not an old saved marker. This is
runtime-bootstrap readiness, **not application/Connector protocol readiness**.
An application-specific readiness gate belongs to its later adapter. No Source
initializer or saved agent command queue is replayed. HTTP(S) in inner containers
needs the normal proxy variables and projected CA passed into those containers
too; use `http://172.17.0.1:8888` from the default Docker bridge, not its own
loopback. Explicitly mount/copy the Actor's trust bundle into inner builds and
containers, keep strict certificate checks enabled, and allow only intended
destinations through native EgressPolicy. Never replace public roots with a
diagnostic CA. Arbitrary transparent TCP/UDP/IPv6, per-inner-container resource
enforcement and all Dev Container features are not qualified.

Factory currently pins Docker **29.9.0**, Compose **5.7.0-dev.1e1c577**, Dev
Containers CLI **0.89.0**, Node **24.21.0** and OpenCode **2.0.27** in
[the RuntimeHost Dockerfile](../runtime-host/Dockerfile). The prior probe's
Docker29.0/Compose2.40.3/CLI0.90 results do **not** qualify these Factory tools.

## Render, install and apply

Create `$OUT/input.json` with the actual **pushed immutable image digests**, a
unique owned namespace/pool/template, a suitable joined amd64 node hostname and
an explicit workload argv. Example shape (replace angle-bracket values):

```json
{
  "namespace": "factory-profile-proof",
  "pool": "factory-profile-worker",
  "node": "joined-worker-hostname",
  "workerImage": "registry.example/worker@sha256:<64 lowercase hex>",
  "workloadImage": "registry.example/rootless@sha256:<64 lowercase hex>",
  "template": "factory-profile-workload",
  "command": ["sleep", "infinity"]
}
```

```sh
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts render "$OUT/input.json" "$OUT/rendered"
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts check-upstream "$SUBSTRATE" "$OUT/rendered"
mise exec -- go -C "$SUBSTRATE" build -mod=vendor -trimpath -o "$OUT/ate-setup" ./cmd/ate-setup
(cd "$SUBSTRATE" && "$OUT/ate-setup" --no-dev-env --context "$CONTEXT" --kubeconfig "$KUBECONFIG" --record-dir "$OUT/install-records" --rollout-timeout 240s --image-repo ghcr.io/agent-substrate/substrate --image-tag v1.0.0 deploy ate-system --sandbox-classes=gvisor --setup-csi=none)
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts apply-egress "$SUBSTRATE" "$KUBECONFIG" "$CONTEXT" 18195
kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" apply -f "$OUT/rendered/sandboxConfig.json"
```

`check-upstream` requires the exact clean pinned checkout, transforms its actual
full egress ConfigMap twice, and strictly decodes the rendered manifests with
upstream Go SandboxConfig/WorkerPool and protobuf ActorTemplate types. It is an
offline wire-schema check, **not** API admission/CEL or an installed cluster test.
Run before compiling the installer from that checkout. Do not silently use newer
installer images, Envoy binaries or a differently compiled policy module.

The installer command is ordinary upstream installation, **not executed against
retained resources by tests**. For kind, use upstream's explicit `--kind
--kind-cluster-name ...` options. Configure durable S3 storage with the existing
native objectstore plugin before accepting Actors; installer test storage is not
a Factory backup/HA contract. A local kind registry must also have the native
`kind-registry` Docker-network alias, matching the installer's localhost-registry
replacement. Configure normal native Atespace grants and
EgressPolicy separately; this profile does not grant bootstrap/global credentials
to Actors or Factory users.

Create the separately owned Kubernetes namespace, then apply `workerPool.json`
with explicit kubeconfig/context. Wait for the generated Deployment to exist
(`kubectl ... wait --for=create deployment/POOL -n NAMESPACE --timeout=90s`) before
waiting for its rollout: WorkerPool reconciliation is asynchronous. It has fixed
replicas=1, finite worker budgets,
hostname placement and an explicit SandboxConfig reference; it does not change
the installation's class default. Await native deployment/worker readiness and
the synchronized runtime asset identity before creating Actors; a ready Pod alone
is not asset-sync proof. After allocation, verify the **actual assignment runtime
version/runsc checksum/worker checksum/flags** before accepting work. Create the native
Atespace and ActorTemplate via the release CLI's normal `create atespace` and
`create actor-template -f "$OUT/rendered/actorTemplate.json"` path, then use native Actor
create/resume/suspend. Record returned UIDs/versions; all later mutation/cleanup
must use their native preconditions, never name-only deletion. The profile commands
perform no Actor creation/cleanup, retained migration or default-provider switch.

## Regeneration-safe TLS overlay

The pinned Envoy **1.39.5** mitigation is `UpstreamTlsContext.max_session_keys: 0`
as a **sibling** of `common_tls_context`, on exactly `egress_forward_proxy` and
`egress_forward_proxy_grpc`. It disables upstream TLS **session resumption**, not
HTTP connection pooling, policy, public CA roots, auto-SNI or SAN validation.
The qualified fixture also needed exactly seven `dns_lookup_family: V4_ONLY`
edits; this is an explicit IPv4 profile, not a transparent dual-stack claim.

`apply-egress` reads the real `ate-system/atenet-egress` ConfigMap, rejects any
bootstrap drift outside those nine allowed scalar changes against the full
pinned upstream configuration, verifies unchanged SDS projections, and preserves
the object's UID/resourceVersion and every other key. Missing/extra/duplicate
TLS clusters, malformed/duplicate YAML, misplaced settings, altered roots,
validation, pooling or policy fail closed. Replacement uses the observed native
resourceVersion, and deployment restart uses UID/resourceVersion preconditions.
Even an already-applied overlay triggers rollout/live verification, since
ConfigMap contents alone do not prove the running Envoy configuration.

It then port-forwards loopback-only Envoy admin for **each Ready egress Pod**,
checks the pinned live version and only `config_dump?resource=static_clusters`
(not secret dumps), and verifies both active TLS contexts, SNI/SAN, HTTP pooling
options and cluster IPv4 DNS. The temporary forward is closed on success/failure.
It never exposes admin on a public interface. If the check fails, the command
fails; it does not quietly substitute an Envoy/module ABI.

After **every installer/upgrade regeneration**, withhold new workload traffic,
run `apply-egress` again and require success **before accepting traffic**. The
caller/operator owns that maintenance/acceptance gate; this script does not add a
controller or claim to quiesce existing Actors. Recheck independently with:

```sh
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts verify-egress "$SUBSTRATE" "$KUBECONFIG" "$CONTEXT" 18195
```

For offline inspection, `overlay-egress SOURCE INPUT_CONFIGMAP_JSON OUTPUT_JSON`
performs the same semantic transformation without any Kubernetes access.
Envoy 1.40.2 includes the upstream fix, but its binary/policy-module combination
has not been qualified; this profile deliberately does not swap it in.

## Focused checks

```sh
mise exec -- bun --no-env-file test scripts/runtime/substrate-profile.test.ts
mise exec -- bun run check:docs
```

Tests cover supported/rejected inputs, immutable pins/required runsc flags,
actual CLI output/repeated rendering/protected outputs, operator command order
and native preconditions, idempotency, installer-regenerated config, missing/
duplicate/wrong TLS clusters, drift and active-cluster validation. Mocked
Kubernetes command tests and upstream wire decoding are not installed live proof.
The earlier retained 61-check different-node/Garage ROOTFS fixture remains scoped
platform evidence, not Factory integration, MEMORY, Vite/browser HMR, HA or a RAM
savings comparison. A new complete platform survey is intentionally unnecessary.
