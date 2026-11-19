# Substrate ROOTFS operator profile

This is the concrete Substrate **v1.0.0** operator/bootstrap path for Linux amd64
and arm64 and the accepted **ROOTFS cold restart** contract. Both architectures use
the unchanged official worker and separately pinned official gVisor/CLI binaries.
ARM artifact verification is not a native lifecycle or complete product proof.
Factory's runtime controller now requires
this native installation configuration and has no Factorybox execution fallback. The
chart requires native configuration and has a read-only native preflight. No runtime
fork, provider framework or new controller is used. The concrete Factory Workspace,
Connector and Source path is described below; live product coverage and its limits are
listed in [qualification scope](#qualification-scope). The Factory
[gRPC/Connector adapter slice](../../services/substrate-control/README.md) is
available without changing these profile pins or the retained runtime default.
Fresh Staging, promotion replacement and publication use the existing product owners and
the shared native Actor adapter. They never fall back to creating legacy capacity.
Native Attempts keep their original immutable observation bindings.

An owned Linux arm64 infrastructure proof has exercised the unchanged official
worker with this nightly and the current Factory Actor image: Docker 29.9.0
created and ran an inner container, allowed HTTPS kept certificate verification,
and an unadmitted hostname received native DNS `NXDOMAIN`. Synchronous ROOTFS
Suspend returned a durable COMPLETED snapshot. A separate Get confirmed its
Actor/template/runtime identity before Resume. Cold restart preserved the private
Docker image and volume content, plus a marker outside durable-dir storage with
its nanosecond mtime; a new boot identifier confirmed new processes. Final Delete
used the original Actor UID and current version and was independently observed.
That workload used no Factory Source, Project, Connector grant or inference.
It does not qualify Dev Container hooks, normal Workspace Source handoff, the
Starter, browser journeys or the full human-approved Ticket/Delivery path.

Fresh databases use one native Greenfield baseline, with no Factorybox worker,
execution-slot, old Source or runtime-artifact tables. The initializer records the exact
SQL fingerprint and serializes concurrent startup. Repeated startup with the same
fingerprint preserves accounts, Source ownership, runtime identities and approvals.
Unknown historical schemas or a different fingerprint are refused without modifying
their data. This is not a database upgrade or Factorybox data-transfer path.

## Qualification scope

The Greenfield source-chart product path has been exercised on Linux arm64 with the
unchanged pinned official worker, gVisor profile and original WorkerPool budget. This is
not a published Factory release or a claim that every operator environment is qualified.
The same fresh Helm installation covers:

- Two ordinary Projects, the shipped Starter's signup/login/signout flow and healthy
  Staging Apps, without Factorybox configuration or a retained-installation conversion.
- Saved requirements, explicit Implement approval, real OpenCode implementation,
  exact-commit native Verification, independent review and deliberate Delivery through
  merge and healthy replacement Staging. Infrastructure changes still require human approval.
- Independent Source reads and saved edits without waking compute, ROOTFS cold restart,
  explicit Stop with UID-confirmed Delete and a new immutable generation retaining saved source.
  IDE and real UID-1000 ARM terminal use, OAuth MCP and shared Source editing have live coverage.
- Native build-only prebuild publication for both Project Environments, including mixed
  private-registry credentials and certificate-only registry trust, followed by confirmed
  producer cleanup. Runtime-interpolated Compose recipes remain unsupported for prebuilds;
  that explicit skip retains normal Dev Container startup.
- Source-only release publication and a native attested one-job artifact publication after
  the normal approval/Verification/review/Delivery path. Actual downloaded artifact bytes
  and SHA-256 match the recorded release; temporary access and compute are revoked afterward.

A separate fresh Linux arm64 installation also covers Stop-only cold settlement of a
previously completed Coding input after normal idle Pause. The same original Actor produced
an exact joined worker result, a new completed durable ROOTFS and independent writable Source.
A deliberate follow-up continued Coding. An ordinary Starter change on that installation
passed generated exact-commit Verification, independent browser review, explicit Delivery
approval and replacement Staging, including a real Staging signup and logout. Historical
failed Stops and paused inputs with running or queued work are not qualified.

Local qualification receipts and inspected media copies stay under
`.factory/test-results/substrate-only/` and `.factory/test-results/product-acceptance/`,
not in the source distribution. Factory retains
its normal approvals, exact-commit results and review media in the installation.
Failed or interrupted receipts remain failed; later explicit fixture runs do not relabel them.
Controller, package and ordinary Docker checks retain their narrower meaning below.

This scope does not qualify a full amd64 product journey, the source-development launcher,
different-node recovery, independent disaster restore or every offline queued-input
Stop/manual-Continue case. ROOTFS cold restart is the contract, not warm memory continuity.
Actor-level limits remain the enforcement boundary, not per-inner-container cgroups.

## Fresh Factory Workspace provisioning

The normal Factory image now embeds `/usr/local/bin/factory-substrate-control`,
built with the pinned Go toolchain and the unchanged official v1.0.0 module.
No operator-copied bridge binary is needed. The authenticated
`startPersonalWorkspace` command can create a **fresh** personal Workspace and
provision its deterministic Atespace, editor grant, immutable ActorTemplate and
Actor. Configuration
is explicit and installation-scoped through `FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION`;
all Projects use that selected native configuration. Each Workspace, Verification, prebuild,
Staging and publication
retains its own Project identity with the installation pins before provisioning.
The owned adapter proof calls the native adapter directly; it is not a separate
production runtime configuration or a compatibility constructor.

The official API NetworkPolicy admits external control-plane Pods only from namespaces
labelled `ate.dev/api-access=true`, excluding native WorkerPool Pods. Label the trusted
Factory installation Namespace before its first native call. Do not put this label on
Project execution or editor namespaces. The label enables network reachability only;
verified serving TLS and the separate native Owner/Editor credentials remain mandatory.
The clean-room command sets this label on its new, exactly owned Factory Namespace.
The read-only Helm preflight refuses a missing or disabled label without modifying policy.

The pinned native wakeup client has a 250ms deadline for each HTTP request. The
Actor's wakeup server therefore runs its real Docker or Stop-mode check serially
on demand outside the HTTP handler. It starts unready, expires a successful check after one
second, and rechecks the current process IDs on every request. Checks stop when
the native worker no longer requests readiness. Slow or stuck CLI
reads cannot block the HTTP response or keep an old success alive. Native wakeup
deadlines and the later Connector, Source and App readiness checks are unchanged.

The private cold-mode watcher allows the pinned worker's five-minute wakeup window,
including verified Source import before Docker starts. It no longer cuts that import
off at the ordinary Docker check's 150-second limit. The worker still owns the overall
wakeup deadline. Fixed Source lease, download and materialization timings are ephemeral
diagnostics, not readiness or successful restoration evidence.
Parent tool-injection timings separate fixed probes, payload copies, executable
staging, permissions and Child launch. Per-tool and shared executable timings can
nest and must not be added together. The total ends at Child launch, before Child
health or model readiness; new phases require rebuilt `runtime-host` and derived
`substrate-runtime` artifacts.

Connector transport reads Ping/Pong frames after its first startup message, including
while Parent prepares images, Features and hooks. One socket reader keeps complete
application frames in receive order in a bounded eight-frame queue; a full queue applies
backpressure. Receiving a frame does not dispatch an operation, repeat startup work
or announce App readiness. The existing application loop still owns execution, and
closing the connection releases a reader blocked on that queue. Ten-second pings leave
headroom inside the private proxy's unchanged 30-second idle timeout. TLS, protocol,
attempt/Actor authentication and the normal 90-second read deadline are unchanged.
Prebuild reconnect publishes the replacement transport together with its startup
reports, so a concurrently completed producer reports through that same connection
without another build or publication.

The Parent's authenticated Environment GET retries transient DNS, CONNECT and
gateway failures inside its original fifteen-second read budget. Every read keeps
the same Attempt, generation, token, endpoint and pinned Environment version.
Cancellation, egress NXDOMAIN, access denial, failed certificate validation,
redirects and invalid responses never authorize another destination or a bootstrap
restart. This does not retry Actor lifecycle operations or Project hooks.

Fresh Ticket provisioning now routes through the existing `startPersisted`
owner and the native Greenfield baseline. It retains the real Ticket/Change identity,
approved branch, existing compute admission and original native provisioning
intent. A commissioned Contributor uses the saved Agent turn and its live
authority/lease, not a personal Owner or Developer impersonation. Human execution
still requires the current Developer writer. The native bootstrap uses the same
`agentConfiguration` and pinned OpenCode process settings as the existing runtime.
Controller fixtures alone do not qualify Coding, QA or Delivery. The live ARM
journey is listed in the qualification scope; reading or saving requirements never
implicitly starts an AI Interview.
Native Project prebuilds now enter the existing preparation queue. Each producer
retains its exact revision, Environment version,
private checkout, native create outcomes and publication repository; it allocates
no Workspace, canonical Source writer or legacy worker. Set `prebuildRegistry` to
an explicitly admitted TLS registry hostname on port 443 (the Connector's port
must also be 443). Credentials and any registry CA come only from that frozen
Project Environment, never the Factory/Forge administrator. Missing publication
configuration or a missing committed Project Environment registry publication grant fails
closed before provisioning. Registry credentials grant image pulls by default, not pushes.
A Project manager must explicitly enable **Allow publishing prepared images for this Project**
and save that Environment revision before a new producer can publish. Use a push-capable token
limited to the Project's prepared-image repository. Verification access remains a separate choice.
Without that grant, Factory records the preparation as skipped and keeps normal Dev Container
startup available; it creates no native producer resources.
The publication decision stays in Factory; the Connector receives only its selected registry
credentials, not that control-plane permission. Lost replies observe the same
names, and a published result releases the producer only after exact-UID Delete
is confirmed. Registry/image selection changes do not rewrite retained owners.
Native prebuild recipe checks run Git against canonical Source as development UID 1000;
their temporary build checkout stays private. Consumer image inspection uses the same
Actor-private Docker connection as acquisition, and still checks the exact input label and platform.
A successful prepared-image consumer records its immutable image/input and public configuration
fingerprint in the existing private Parent state. Same-Actor cold startup checks that original
Attempt, generation, primary container, image metadata and configuration before recreating its
temporary CLI override. Ordinary offline application edits do not turn continuation into a new
cache-compatibility decision. Missing ownership, a changed configuration or an unavailable original
image fails without silently selecting another image or rebuilding the container. Runtime grants
and generated overrides are not saved in that state. Real-CLI component checks remain separate
from the native Workspace lifecycle proof.
The Connector has no reserve, template-fork activation, prepared Child or private
primary-container capture mode. Parent authenticates the current Runtime environment,
selects the confirmed prebuild or native dependencies and starts the assigned Child.
Registry-digest prebuilds and same-Actor continuation remain separate from the removed
captured-process path. Source initialization and service subprocesses use development
UID 1000, without the former shifted host UID.
The baseline keeps isolated generations local to each Verification or preparation
owner, without a shared Project counter.
Controller regressions are separate from live native prebuild qualification. Runtime-only
Compose service environments are omitted from the private producer snapshot without
resolving their values; consumers retain the original files and fresh Runtime grants.
Image/build/file-selection interpolation remains refused. The Connector component lane
checks a real pinned CLI build, completed-result reuse and a cache-independent consumer;
the shipped Starter's runtime-interpolated Compose recipe deliberately skips preparation. Unsupported
recipes keep normal startup available without exporting Runtime secrets. A dispatched
build with no positively observed original image is retained as uncertain, never rerun.
Native producers use only the verified Actor-private Docker socket and proxy.
Image-only Compose primaries reuse the bundled networkless HTTPS/CA preparation
before Features build. Public transport is hashed into the recipe; local image and
Actor identities stay private and are not needed to match a cached artifact.
Native prebuilds hash and embed a canonical public certificate set. PEM ordering,
whitespace and duplicates cannot separate otherwise identical producer/consumer inputs.
Different certificates or transport code still produce a different identity. Existing
results are not rewritten to match the new transport contract. Native producer coverage is
listed above; component consumer checks do not broaden that coverage.

Native model and browser callbacks use the exact Connector HTTPS origin, with
their existing attempt-scoped tokens. Legacy internal-host URL settings do not
redirect these capabilities outside the pinned native TLS/egress boundary.
App processes also receive `FACTORY_APP_ORIGINS` from that pinned TLS origin.
Factory freezes these values with the Actor template; changing the browser base
URL cannot change a retained Workspace's startup inputs.

Native Staging records a pinned Preview revision before provisioning. It runs only the declared
Apps with the frozen `main-preview` Environment, without a development Workspace or Source writer.
An explicitly stopped initial Staging can select its next generation only after the original
Actor's UID-bound Delete is independently confirmed. A lost Create or unconfirmed cleanup retains
the original generation and names.
Native promotion replacement additionally requires the existing current promotion, successful
exact-commit merge, Delivery approval, Verification and independent review. Substrate RUNNING is
not Connector/App readiness. The normal Delivery owner switches the Preview only after readiness,
then removes the original runtime through the same native Delete path.
Native publication uses the existing latest release attempt and its original one-job Forgejo
runner. Git, registry and release-credential traffic use admitted HTTPS destinations. Publication
receives an empty Project Environment and no canonical Source grant. Runner tokens and bootstrap
capabilities remain outside the public Staging declaration and compact provisioning intent.
These paths use the Greenfield baseline's `substrate_isolated` provisioning facts. Their controller
tests prove authority, original creates, scope, readiness gating and cleanup against controlled
native responses, not live runtime or human-approved release qualification.

Workspace Stop now keeps the existing Workspace lock throughout synchronous Suspend,
confirmed independent Source handoff and UID-bound Delete. A durable ROOTFS without a usable
independent checkout cannot authorize deletion. Lost Delete replies retain the original intent
until the same Actor is independently absent; concurrent Start cannot wake it.

An explicit Workspace Start after confirmed Stop selects the next generation only after
re-observing the original Actor's absence and independent Source. Every generation keeps its own
Atespace, grant, template, Actor binding and creation attribution. New compute consumes the latest
confirmed service-owned Source export, including saved offline edits, without reusing an old runtime
identity. Source transfer freezes the service, confirms its complete export and stops its process
before assigning the new writer. The authenticated restore response identifies both the new Actor
and the checkpoint's original producer; the Connector rechecks the complete lease before publishing.
Ticket Start rechecks pending Agent Stop under the existing Change lock. Source durability cannot
authorize replay of unsettled OpenCode input.

A stopped, unbound first Coding input may prepare a new commissioned writer while its
original initial Actor is still RESUMING and its Source Parent is unavailable. This requires
the exact live approval/lease, complete no-input history, no previous human writer or Session,
initial Source ownership and authenticated role-restore capability. It defers initialization
of the read-only Source API role, not an old-writer teardown or proof that hooks stopped.
The native owner checks that capability against the original template's live UID, version
and full specification hash; Factory's metadata-only cache is not a copy of its bootstrap secrets.
Before any new input enters dispatch, the running Source must acknowledge the current Change
writer epoch as read-only. Missing, rejected or lost acknowledgements refuse dispatch; an old
restore marker or transport reconnect is not confirmation of the current role.

The Source controller has no Factorybox allocation, Kubernetes Source creation or legacy Git
bootstrap route. Source materialization uses the separate coordination connection, not the
application query pool. Native controller and Connector tests cover these boundaries;
the live ARM Workspace and shipped-template coverage is listed above.

The application no longer has a Factorybox executor, prepared execution reserve or worker-recovery
path. Idle compute records Pause under the Workspace lock and never applies the removed Factorybox
pause-count limit or an implicit Stop. Shutdown tracks the actual native Actor operations without
a second worker dispatch scheduler.

Compute allowance reads the immutable Substrate resource intent. An unconfirmed failure does not
release that allowance; a recorded native crash with no worker assignment or confirmed Delete does.
Current consumption remains unavailable until an Actor-specific measurement exists. Factory
does not substitute a shared Worker's Pod totals or display missing measurements as zero.
Before native Stop revokes the live Connector or captures ROOTFS, Factory drains
admitted Coding turns' durable usage logs, including child Sessions and late
auxiliary consumption. A missing connection or failed replay records unknown
coverage before Delete and preserves any consumption already observed. Replaying
the same native events or repeating Stop does not add another charge.

The old Kubernetes-only offline OpenCode Stop runner has also been removed. A confirmed or reused
Session whose queued input cannot be observed still keeps Stop pending. Source durability and Actor
deletion alone do not confirm input cancellation. Live ARM coverage of paused-input settlement
and subsequent explicit Coding is limited to the previously completed input described above;
it does not establish recovery of running or queued inputs.

The Actor tool bundle includes `input-stop.mjs`, a fixed metadata executor rather
than a runtime controller. It opens only the private native Session database,
uses the pinned SDK/server at an empty Session location, receives no Factory or
provider configuration, and confirms engine exit before returning a result.
It refuses a changed model/version, linked database sidecars and any unrelated
root Inbox work. Networkless, read-only-container checks cover queued descendants,
a previously running input, retained Source and the negative cases.
The Connector's fixed `native-input-stop-worker` child runs as UID 1000 in private
Linux process, mount and network namespaces. Its private root contains the exact
packaged SDK/server, Bun, their libraries and libc-detection tools, Git metadata,
temporary storage and loopback. It contains no Project checkout, Docker socket,
Connector state or inherited Factory/provider environment. The trusted caller joins
namespace PID 1 before accepting the exact bounded result, including after
cancellation or detached children. Explicit local Linux checks exercise this
boundary and the packaged SDK; they do not qualify the amd64 gVisor Actor profile.
Fresh Workspace templates declare the exact Stop-only bootstrap capability.
Factory records the pending input, original Actor and durable checkpoint before
its one Stop-only Resume. It exports the latest offline Source before transfer.
The cold bootstrap discards its previous transient mode receipt, restores Source,
and selects the authenticated Stop branch before Docker, Dev Containers or Project
hooks. Its Source-only Parent accepts the bound result and checkpoint/chunk export,
not Project commands or ordinary file access. A lost worker acknowledgement permits
read-only SDK observation, never replay of the interruption.
Factory keeps Stop pending until the joined SDK result confirms settlement and a
new durable ROOTFS plus independent Source handoff are confirmed. An unconfirmed
joined result can preserve Source without claiming cancellation. Missing bootstrap
capability refuses wakeup; it never falls back to ordinary Resume or creates an
Actor to rescue an already deleted fixture. These paths have controlled coordination
and local Linux checks; the complete amd64 gVisor Stop/Continue journey remains a
live qualification gate.

For connected Coding, Compute Stop first uses the existing Agent Stop owner.
It confirms the root input and the complete native child-Session tree before
Source drain, ROOTFS capture or Delete. Ordered interruption also cancels queued
work in verified descendants; an unrelated root Inbox entry is retained and keeps
Stop unconfirmed. A final answer cannot become a completed Build while that tree
has running or queued work. The native adapter rechecks the product barrier under
its lifecycle lock. Only a fenced, never-confirmed fresh bootstrap may use the
existing no-submitted-input exception. Paused/deleted compute does not supply a
missing cancellation proof. Pinned OpenCode-process checks and controlled native
RPC checks cover this order; they are not the complete Substrate live proof.

Fresh native Verification now enters the existing `startVerification` owner.
It provisions an independent exact-commit checkout and
the pinned one-job runner bound to that Forgejo job, using the admitted public
Forge HTTPS origin and existing Verification environment filtering. It allocates
no Workspace, canonical Source writer or synthetic worker, and reuses the same
Substrate Actor lifecycle and UID-bound cleanup. Lost create replies retain their
original intent and are observed rather than repeated. The baseline retains each
provisioning generation when the existing explicit queued-bootstrap
retry decision has confirmed exact predecessor cleanup; a lost or still-live
outcome cannot select a successor. Controller regressions remain separate from real
native CI qualification; the live ARM coverage is listed above.

An initial Verification refused native worker capacity waits on the same Actor.
The existing owner may re-enter official Resume only while the original UID and
dispatch version are unchanged, with no assignment, checkpoint, snapshot or canonical Source.
It rechecks the current submitted commit, exact job, permissions and Stop before
dispatch, without clearing the original lifecycle facts or creating another Actor.
The capacity hint clears only after validated native progress. A suspended state
alone never authorizes continuation of an already-started or superseded execution.

Workspace startup and checkpoint Resume also retain confirmed capacity refusals.
A deliberate Start or compute demand may continue only the same unassigned Actor,
at its original dispatch version and exact durable checkpoint, under current writer
authority. Canonical Source must still belong to that Actor; continuation does not
repeat its handoff. The capacity marker permits one continuation and is consumed
before the RPC. Another confirmed capacity refusal can restore it, but a lost reply
cannot. Unknown suspended startup refuses commands without dispatching them.
These checks do not clear historical unknown outcomes or replace native identities.

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
and observing an already-pushed exact commit does not push it again.
Coding, integration and shared Workspace submissions use only the native binding's
admitted Forge HTTPS destination. There is no internal-host or `file://` execution fallback.
Shared submissions persist their exact HTTPS repository before the first commit request,
and retain that destination after a lost response or a later Project edit. The Parent
dispatch fence rechecks the destination, current Project access, Workspace Stop,
Agent Stop and native Delete intent. Confirmed original pushes are observed without replay.
The owned
Linux Connector lane checks this with real HTTPS Git, development-user filters,
negative CA/credential cases and complete Source export. This does not substitute
for the native image qualification or the live human-approved Ticket journey.

The configuration shape is defined in
[`substrate-workspaces.ts`](../../apps/factory/src/runtime/substrate-workspaces.ts).
Set `deployment: fresh-workspaces` and the exact database name,
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

Project Registry image acquisition has one ten-minute deadline for cold downloads and
private image extraction. Both download workers and all transport retries share that
window; a shorter caller deadline still applies. Cancellation joins the clients, and
exact image digests must be confirmed before Dev Container hooks can run.
Prebuild metadata and recipe matching have a separate thirty-second read window. Once those
match, acquiring the exact prepared image uses the same ten-minute cold image budget, not the
spent read window. The original caller's shorter deadline and cancellation still apply, and
the consumer rechecks the saved checkout before selecting the downloaded image.

For `fresh-workspaces`, installation capacity admission observes the one original
WorkerPool selected by those installation labels and its exact pinned SandboxConfig.
It uses the original pinned worker image for distinct, deterministic pools on joined,
Ready, schedulable Linux nodes matching the architecture in the installation's
observed immutable runtime. Node taints, pressure, Pod requests and allocated
resize reservations remain admission barriers. No node opt-in label or approval is
needed. Each new pool requests its full finite budget after the existing 2048 MiB
memory headroom and 250m CPU headroom for independent access services; original
pools are not resized, patched, deleted or replaced.
The native baseline retains the selected node/boot/architecture, original pool/profile,
budget, creation intent and returned pool UID. Missing, rejected, changed or
uncertain creates never authorize another create. The original node-pinned pool
has its own immutable installation observation binding its UID, worker image,
profile and the same Ready node/boot. It must report a Ready replica and reserve
its full finite CPU/memory limits. It counts even when no additional pool fits;
confirming a second pool is not a prerequisite. This reads existing budgets without
resizing a worker or promising a free Actor slot; Substrate still owns actual placement.
These capacity changes still
need controller, chart and native joined-node qualification before claiming that
the shipped-template journey or different-node recovery has passed.
Git uses `FACTORY_FORGEJO_PUBLIC_URL`, which must be HTTPS on that same port with
its hostname admitted by `egressHosts` (or equal to the Connector hostname).
Native fetch/push never use legacy internal HTTP addresses or follow redirects.
New Projects use normal authenticated Factory setup. The repository intent persists each
new Project identity before Forge creation; restarts observe that intent without reallocating it.
Installation configuration accepts neither `projectID` nor `setupID`, and cannot reserve or
retarget a setup draft. Each runtime owner freezes its actual Project identity separately.
Native Git still uses the admitted public Forge origin, independently of its private API
transport. No Project rows, approvals or runtime resources need fixture insertion.
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
The distribution workflow builds this Actor image natively on amd64 and arm64 after
the same-commit tools and same-architecture rootless bootstrap have been published
by digest. Each package proof refuses an emulated host/image mismatch. It signs the
combined image and includes it as the required `substrate-runtime` artifact in both
control-plane image architectures and the chart catalog. Normal installation
checks that `workloadImage` matches this exact reference. Existing native owners
keep their immutable original image and template.
`scripts/runtime/substrate-image-proof.sh` checks only the networkless image
packages and explicitly reports no native lifecycle proof. Its successful result
does not qualify gVisor, Source handoff, private Docker or the full Ticket journey.

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
The earlier Alpine Workspace proof alone does not qualify this path. The current
ARM Starter coverage uses the rebuilt image and is listed above.
The Factory-specific child bootstrap lets Docker 29.9 manage its own matching
containerd. The Docker bundle supplies shim **2.4.1** but omits the standalone
daemon. The image therefore intentionally replaces the bootstrap's **2.1.5** daemon
with the official **2.4.1 static** binary (no injected glibc compatibility layer), exact release/revision/checksum in
[`runtime-pins.json`](runtime-pins.json). It never combines the new shim API with
the older daemon. The standalone qualified Docker 29.0 profile and its child script stay
unchanged; only the explicitly new Factory image selects `runtime-child.sh`.
Fresh Factory images use Docker's `overlay2` graph at
`/home/rootless/persist/docker/graph` in the native durable directory. A separate
root-owned 0700 parent blocks development-UID access even though Docker sets its
own data root to 0710. Source remains the separate `project` tree; its archives
and cold imports never include or replace Docker storage. Bootstrap refuses
symlinks, non-directories, foreign ownership or changed private-parent permissions
without repairing them. The Stop-only branch runs before storage creation.
No existing graph is converted, and old Actors keep their immutable image.

An owned arm64 storage proof loaded the exact shipped Node and PostgreSQL images
into an empty Overlay graph within the existing ten-minute acquisition window,
then ran both images. After synchronous durable ROOTFS Suspend and independent
snapshot verification, Resume started new processes with the same image IDs,
container IDs, Node writable-layer and volume markers, PostgreSQL volume contents
and nanosecond rootfs marker. Initialization was not replayed, and development UID
1000 could not open the private graph. Original-UID/version Delete was independently
confirmed. This proves storage on that pinned same-node ARM profile, not the
complete Starter, Source/IDE, prebuild, Verification or approved Delivery journey.

The pinned gVisor virtual kernel has **no nested cgroup-namespace feature**.
The inner daemon therefore uses its Actor-private virtual cgroups (`host` in
Docker's inner terminology), never the node's cgroup hierarchy. The Connector
accepts that one resolved field only with an unexported assignment fact set by
`native-parent` after the exact private RootlessKit UID/GID checks, matching
projected Actor UID and actual absence of `/proc/self/ns/cgroup`. Browser and App-proxy
containers use the same authenticated exception; their network, mounts and capability checks
remain unchanged. The Parent has
authenticated that Actor-bound capability before container inspection. A Project
JSON field or environment variable alone cannot enable it. Every other container,
mount and capability fence remains unchanged. Compose admission checks resolved
top-level volume definitions before image preparation or `devcontainer up`.
Named volumes may use only the default or explicit `local` driver, with no
nonempty `driver_opts` and no external volumes. Ordinary Compose-managed local
data volumes, including PostgreSQL data, remain supported; a service mount's
`type: volume` alone does not establish confinement.
There is **no qualified per-inner-container cgroup/resource
enforcement** in this profile; Actor-level native limits remain the boundary.

Factory persists provisioning intent and external dispatch/outcomes before each
Create in the native baseline, using the existing Workspace lock. There is no
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
checksums and archive bounds still fail closed. Image package checks alone do not
qualify this Source restoration.
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
Factory records immutable Resume/Suspend intent and dispatch facts for the original
Actor and its preceding confirmed ROOTFS UUID. A lost reply while Get still shows the
preceding native state does not authorize another dispatch. A recorded `SUSPENDING`
Actor may continue the [pinned official Suspend workflow](https://github.com/agent-substrate/substrate/blob/b34fbee742906494b5eb4f1f36987176bf8770a4/cmd/ateapi/internal/controlapi/workflow_suspend.go),
which reuses its persisted snapshot rather than taking a new one. Factory requires
the original dispatched Actor, matching template/runtime, exact next snapshot generation
and storage identity, and its retained Source fence. The first dispatch facts remain
immutable; a `PENDING` capture permits only that native continuation, never Source handoff
or Resume. Normal Factory startup recovery uses the same guarded continuation for a
recorded pausing Attempt, without starting inference or resuming compute.
A recorded `RESUMING` allocation can re-enter the pinned official Resume workflow
under its native lease. Factory requires the original unresolved Resume dispatch,
Actor/template/runtime, current execution authority and unchanged preceding ROOTFS
checkpoint, or no snapshot for an initial start. Stop, superseded generations and
revoked or expired execution authority refuse continuation. The existing dispatch
facts stay immutable; Source is not transferred again and no Create, hook or prompt
is dispatched by this continuation. The independent final `RUNNING` observation
must preserve that same checkpoint identity before Factory records completion.
Startup recovery uses those guards and skips expected authority fences without
preventing recovery of other Workspaces. This has controlled controller coverage;
an interrupted native product start still needs its separate live proof.
A positive `SUSPENDED` observation of the exact completed durable snapshot
can finish Source handoff. Only that confirmed checkpoint permits the next deliberate
Resume. Reading an already RUNNING allocation does not dispatch Resume or reset READY;
an unresolved Pause does not reopen Connector authority. Pending/local-only snapshots
never authorize Source release. These dispatch guards have controlled PostgreSQL and
controller coverage, not a complete native product proof.

This is a **same-node personal Workspace** proof, not different-node recovery, complete
toolchain qualification, Coding/Delivery, retained migration or zero-RPO evidence.
Its native receipt records `sourceHandoff: confirmed-same-node`, `coldRestart: true`,
`portable: false` and `fullFactoryE2E: false`. That earlier receipt did not qualify
a replacement Attempt. The current Workspace controller requires independent Source
before UID-bound Delete and supports an explicit next generation after confirmed cleanup.
Stop is not reported as successful when only Pause completed. Live ARM coverage
is listed above. Pause preserves
private Docker data in the Actor's ROOTFS; an explicit Stop removes that Actor and its
compute state only after Source has an independent owner.
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
Before a native CLI call, Factory checks retained Feature lockfile ownership. It reads
the resolved configuration through the pinned CLI and reserves a missing lockfile as
development UID/GID 1000 only when Features need one. The final `up` call checks its
current effective configuration too. Featureless recipes do not acquire an empty
lockfile. The CLI keeps its normal generation and verification behavior.
Reservation never truncates, replaces or chowns an existing
lockfile; unsupported retained ownership fails closed before CLI dispatch. This prevents a
fresh Parent from creating root-owned Source metadata. Source export and
materialization accept only the development UID/GID 1000, including CLI lockfiles.
Unsupported metadata fails without changing its owner or weakening the checkpoint
contract. There is no operator rescue endpoint, version-2 recovery archive or
disposable-fixture adoption path. Existing Source and its original Actor remain
retained until normal complete Source handoff can be confirmed.
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

[pins.json](pins.json) retains the official Substrate commit/release/worker index,
architecture-specific Worker/CLI checksums and official gVisor nightly
commit/archive SHA256/**published SHA512**/runsc checksums. Its Envoy binary/module
checksums are the earlier amd64 qualification, not ARM qualification. The nightly is an
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
arm64 or amd64 matching the selected worker architecture, Docker build/push, Git, Go,
GNU tar with zstd, kubectl and a separately owned
Kubernetes context. Use a **new output directory**, not a retained installation.
Obtain a clean Substrate checkout at commit
`b34fbee742906494b5eb4f1f36987176bf8770a4` (`v1.0.0`). Set `SUBSTRATE`, `OUT`,
`KUBECONFIG`, `CONTEXT` and your own pushable `REGISTRY`; no implicit current
Kubernetes context is used by the profile commands.

```sh
# Set ARCH explicitly to arm64 or amd64. Do not mix the output directories.
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts assets "$OUT" "$ARCH"
mise exec -- bun --no-env-file scripts/runtime/substrate-profile-command.ts verify-assets "$OUT/gvisor.tar.zstd" "$ARCH"
docker build --platform "linux/$ARCH" -f deploy/substrate/Worker.Dockerfile -t "$REGISTRY/worker:rootfs-ns" .
docker push "$REGISTRY/worker:rootfs-ns"
docker build --platform "linux/$ARCH" -f deploy/substrate/rootless/Dockerfile -t "$REGISTRY/rootless:bootstrap" .
docker push "$REGISTRY/rootless:bootstrap"
```

The asset command verifies SHA256 **and** SHA512 before saving the official
archive, checks its extracted runsc, and checks the official Linux release CLI for
that architecture. The saved CLI is a Linux worker-host tool, not a macOS binary.
The installer built below uses the operator host's own Go target. Files
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
unique owned namespace/pool/template, a suitable joined node of the selected
architecture and
an explicit workload argv. Example shape (replace angle-bracket values):

```json
{
  "architecture": "arm64",
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

Match Kubernetes capacity to the host's enforced CPU and memory budget, including
any outer container or VM limit. Qualify the native control plane while cold images
are being downloaded and unpacked, not only while workers are idle.
Kind can report the VM's memory instead of its node container's smaller enforced limit.
Before admitting Actors, compare Node allocatable resources with both limits. Configure
the new cluster's Kubelet reservations so allocatable memory fits the enforced node budget,
then independently verify Node readiness and the resulting allocatable value. Do not
resize a retained WorkerPool to compensate for overstated Node capacity.
Reserve native API scheduling capacity before Factory's WorkerPool admission.
The small shared-node profile uses
[`api-resources-patch.yaml`](api-resources-patch.yaml): each of the two API replicas
requests 50m CPU and 128 MiB memory, without introducing new limits. Count the
combined 100m CPU and 256 MiB in node reservations; do not resize a retained WorkerPool
to make room. These are scheduling requests, not a claim that every installation
fits that minimum. Qualify the actual recipe and control-plane load.
Apply it with the observed-object procedure below, selecting Deployment
`ate-api-server` and `api-resources-patch.yaml` instead of the router pair.

For the owned eight-core shared-node profile, also apply
[`egress-resources-patch.yaml`](egress-resources-patch.yaml) to Deployment
`atenet-egress` and [`postgres-resources-patch.yaml`](postgres-resources-patch.yaml)
to StatefulSet `postgres` through that same observed-object procedure.
The egress certificate sidecar requests 100m CPU and 128 MiB; PostgreSQL requests
100m CPU and retains its existing memory request. Images, limits, TLS, probes and
WorkerPool budgets remain unchanged. These are scheduling reservations, not measured
consumption or a universal minimum. Reverify live egress after the rollout and qualify
the complete Project recipe under cold load before accepting this profile.

This shared-node profile keeps the official native API and PostgreSQL health endpoints
and probe periods, with a five-second readiness timeout and a ten-second liveness
timeout with six consecutive failures before restart. Apply those probe settings through
the operator's native deployment configuration before admitting Actors, and retain them
when regenerating upstream manifests. Do not disable the checks, resize an existing
WorkerPool or reinterpret an Actor's saved limits to obtain readiness.

Apply the same shared-node tolerance to the official `atelet` DaemonSet with
[`atelet-health-patch.yaml`](atelet-health-patch.yaml). It keeps `/readyz` and
`/healthz`, their named `health` port and their original periods. Readiness allows
five seconds; liveness allows ten seconds and six consecutive failures. It changes
no image, resource request, worker identity, TLS setting or Actor lifecycle budget.
The upstream one-second probes have caused kubelet to restart `atelet` during a
native ROOTFS checkpoint on the owned shared-node fixture. A draining daemon can
still report checkpoint work before its RPC returns `Canceled`; neither its logs
nor a completed Source export establish successful native Suspend.

Use the observed-object procedure below with `get daemonset atelet`, this patch
and `rollout status daemonset/atelet`. Withhold new workload admission and account
for in-flight native calls before rolling the daemon. The patch prevents neither
all host stalls nor every daemon failure, and it does not repair an Actor already
left `SUSPENDING`. Preserve that Actor and its Source fence. A probe configuration
change alone does not confirm its checkpoint or permit Source release. Factory can
continue only its matching persisted native Suspend as described above; do not clear
its dispatch facts, edit native metadata or substitute another Actor. Live checkpoint
qualification is still required after applying the operator configuration.

The pinned router also needs
[`router-health-patch.yaml`](router-health-patch.yaml) before admitting traffic.
Its Go process deliberately drains Envoy during shutdown. A container-only restart
can otherwise leave the still-running Envoy permanently `DRAINING`, with `/ready`
returning 503. The patch gives initial xDS setup up to three minutes, then lets
Kubernetes restart an unready Envoy after six failed ten-second liveness periods.
Both probes use the existing allowlisted `envoy-metrics` listener. The unauthenticated
admin interface stays loopback-only; no serving checks, TLS, routes or runtime pins
are removed or changed.

Apply this to the intentionally selected official installation while workload
admission is withheld. Use new private output files. The observed UID and
resourceVersion remain in the replacement, so a concurrent change or recreated
Deployment refuses the update rather than being adopted:

```sh
(
  set -euC
  umask 077
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
    get deployment atenet-router -o json > "$OUT/router-before.json"
  mise exec -- kubectl patch --local --type=strategic -f "$OUT/router-before.json" \
    --patch-file deploy/substrate/router-health-patch.yaml -o json > "$OUT/router-health.json"
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" \
    replace -f "$OUT/router-health.json"
)
mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
  rollout status deployment/atenet-router --timeout=240s
```

Inspect a refused or interrupted update before continuing; do not force replacement.
Retain this probe patch after upstream installer regeneration. A healthy router
does not by itself qualify native DNS/egress under image acquisition or a complete
Factory product journey.

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
