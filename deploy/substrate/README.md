# Substrate native operator profile

This is the concrete Substrate **v1.0.0** operator path for Linux amd64
and arm64, using direct native containers with MEMORY preference and ROOTFS cold fallback.
Both architectures use
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

## Runtime responsibilities

Factory's control plane runs outside the Actor. It owns requirements, approvals,
execution intent, Source authority and the admitted Agent turn. Substrate owns the
Actor's placement, lifecycle, routing and snapshots; it is not the coding agent.

The supplied [OpenCode process](../../packages/runtime-kubernetes/src/agent-process.ts)
runs inside the Project's native Work container, as its development user. Its native
file and shell tools use that environment, alongside the Child Connector, terminals
and Project processes. Substrate starts the Project containers directly. The Parent
Connector owns Factory control and Source, not a nested Docker daemon.

The per-user Theia editor runs outside the Actor. It accesses the current canonical
checkout through authenticated Source routes, rather than owning another clone.
While compute runs, Source is served by the Actor's development-user subprocess.
First Start admits the initial saved checkout even if the IDE has never been opened.
Creating or allocating an Actor does not complete that first import.
After admission, the same native Actor remains canonical Source owner across
Pause and Resume. Routine halt does not export the checkout to another writer or delete the Actor.
The editor can retain its tree and unsaved buffers while paused; actual current-file access
may resume compute, independently of App health and without starting AI work.

OpenCode packages are installed during the tools-image build and exposed through the
native read-only tools image volume. The direct entrypoint uses that Connector and
the packaged tools; it does not run the removed RootlessKit/Docker bootstrap.
The ordinary private-container `parent` CLI, injection, deferred CLI hooks and
private-daemon cleanup paths are retired. Current tools/Actor packages do not
contain Docker/DinD, Compose, Dev Containers or the former producer executable.
Projects supply their immutable Work/service images. Native Work preparation is
the explicit command in the ActorTemplate, not a Factory image-build queue,
a fully initialized OpenCode process or authorization to reuse a Session.
Native `RUNNING`, Source availability, OpenCode readiness and
App health are distinct observations, not interchangeable readiness claims.

Earlier private-Docker MEMORY attempts stalled while restoring nested network state.
Those receipts do not qualify the direct-native replacement. MEMORY preference
does not promise RAM continuity: require the actual snapshot fidelity and restored
process evidence. ROOTFS fallback restarts processes and connections; neither a
preference nor a snapshot label proves successful restoration.

An earlier owned Linux arm64 infrastructure proof exercised the unchanged official
worker with this nightly and its then-current Factory Actor image: Docker 29.9.0
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

### Retained Workspace lifecycle

A **Workspace** is the retained development context. **Source** is its canonical saved checkout;
the independent initial checkout is only the first-import owner. After admission the Actor owns
that checkout for the Workspace. **Pause** means native synchronous durable Suspend, not disposal.
**Continue** means native Resume of the same Actor. **App restart** controls the declared process,
not the Source owner. Destructive removal and **Coding cancellation** are separate operations.

Factory does not freeze guest writers, copy Source, switch canonical owners or request an
additional Source checkpoint for ordinary Pause/Resume. Substrate owns the atomic native snapshot.
MEMORY continuation leaves the live checkout in place. ROOTFS cold entry verifies the Actor's
private initial-import identity and a current authenticated Source grant; it does not download the
initial seed again, overwrite dirty files or replay inference. Unknown outcomes remain unknown.

Current-file access may wake paused compute. Passive metadata/events and the retained editor tree
are not proof that current files are connected, and a cached tree must not be presented as a fresh
filesystem read. Source connection does not wait for the App or Work preparation to become healthy.
Current membership, collaboration, writer/CAS and shared-buffer protections remain required.
Ordinary halt refuses active or uncertain Coding input; file access must not resume admitted AI work.

Qualification is bound to the tested source, images and installation, as scoped below.
Earlier Source-handoff, final-Delete and replacement-Attempt receipts do not qualify
this retained-Workspace contract.

## Qualification scope

Current qualification consists of focused Linux arm64, same-node source-chart checkpoints
on the pinned official Substrate worker and gVisor profile, using native ActorTemplates
and direct Project containers. Each receipt applies only to its recorded source, images
and installation; separate checkpoints are not one comprehensive acceptance run.

- **Starter delivery:** A new Project on the retained Helm installation completed explicitly
  approved Coding, exact-commit native Verification, independent browser review and authorized
  Delivery through merge and healthy replacement Staging. Review media were inspected, and
  Staging signup, signout and login exercised the delivered change. Manual requirements and
  personal Source reads before Workspace compute admitted no inference. This journey did not
  requalify Source-before-App-health or MEMORY/ROOTFS restoration.
- **Retained Workspace:** Ordinary durable Pause retained the original Actor and complete
  canonical Source/writer identities while releasing its worker. Separate Starter and large
  Source-I/O measurements exercised explicit Resume and real current-file demand wake without
  Coding or new inference intent. Final passive checks found both original Actors suspended
  without workers and their canonical Source unchanged. No per-Pause Source export, owner
  transfer, Actor deletion or successor generation was used.
- **MEMORY checkpoint:** An open IDE retained its tree and unsaved buffers across independently
  observed durable MEMORY detach and Resume of the same Actor. Dirty, staged and untracked files,
  the RAM-only process nonce and Source writer epoch continued. Passive watch reconnection did
  not undo Pause; deliberate current-file access could wake compute without inference. Real
  compiler rejection, clean build/tests, personal Preview authentication and App restart were
  exercised. This is evidence for that observed continuation, not a general RAM guarantee.
- **Explicit ROOTFS checkpoint:** A separate owned Starter declared native ROOTFS before its
  first Start. Durable detach and cold continuation retained the Actor, dirty/staged/untracked
  Source and an image-backed file's hash/nanosecond mtime, while sandbox boot and process
  identities changed. Its compiler, build/tests and App health passed after cold wake, and the
  editor retained its unsaved buffer. The explicit ROOTFS case does not qualify automatic
  cross-runtime fallback. A snapshot label, reconnect or fast Resume alone cannot prove cold
  restoration or RAM continuity; an attached sandbox can resume in place.
- **Wiki:** The current Starter published pages at the delivered commit. A human edit saved
  without inference remained separate from the generated baseline and survived an explicitly
  requested update, reload and History inspection. The original failed generation remains
  failed; later success does not establish its cause or repeated reliability.
- **Large Source/I/O benchmark:** The actual Factory authored-source corpus contained 2,465
  files and 33,204,315 bytes. Authenticated Source reads, first Start, Pause, Resume and demand
  wake were measured; a real development-user command verified every file's bytes and
  Git checkout mode plus 97 deleted paths after continuation. The native I/O profile declared
  no App or preparation command. It does **not** qualify running or building the Factory App,
  arbitrary host filesystem metadata, browser first paint or concurrent interactive load.
  Images had already been used on that worker; these small same-node samples are neither
  cache-cold/different-node restore measurements nor p95/p99, SLA or RAM-continuity evidence.
- **IDE on the large corpus:** The actual editor displayed the tree and file contents on the
  reused per-user IDE backend. Two unsaved markers, including one typed while compute was
  independently suspended without a worker, survived native Resume. Saved file bytes remained
  unchanged, no inference was admitted, and a second open Workspace's existing draft stayed
  intact. Desktop and 900-pixel-wide screenshots were inspected. One warm explicit-open sample
  took 5.26 seconds to acknowledge Workspace selection, including Source wake; it is not a
  cold-IDE provisioning result or a first-paint SLA. This private-editing check does not
  establish multi-user shared-buffer convergence.
- **Shared IDE/MCP checkpoint:** An actual owner IDE and a separately authenticated Developer
  MCP client exchanged unsaved edits through the same shared document, with authenticated
  participant/cursor display. A real native shell write produced a preserved conflict; both
  versions were inspected in the editor comparison dialog before explicit resolution.
  The collaborator then saved the acknowledged edits after the owner's Project frontend
  closed. Revocation refused further read/edit/save calls in the already-connected guest
  MCP session. This is a mixed-client checkpoint, not simultaneous two-browser co-editing
  or a guest IDE's local-buffer retention test.
- **Native file transfers:** A deterministic 128-MiB binary completed raw HTTP upload,
  checksum-verified commit, ordinary native Pause and same-Actor demand wake, then full
  checksum-matching download. The 32-KiB MCP chunk tools also exchanged actual bytes.
  Missing authentication, a foreign Origin and an oversized HTTP chunk were refused
  without writing bytes. Partial release and checksum rejection left no published file;
  exact owned handles/files were cleaned up and compute paused. Transfer results retained
  compact metadata, not file content. This synthetic maximum-size boundary check is not
  application throughput, an SLA, node-loss recovery or RAM-continuity evidence.
- **Public Pause/Stop boundary:** An authenticated Workspace Stop request was refused
  without admitting a native lifecycle RPC; the retained Actor stayed suspended.
  Separately requested native Starter Staging reported primary-App health, then its
  normal isolated Stop deleted only that exact Actor, independently confirmed absent.
  All 14 observed canonical Source authority rows stayed unchanged. A saved Starter file
  remained byte/version-identical after Staging removal; its current-file read woke the
  same original Workspace Actor, which was then paused again. This does not expose or
  qualify a public Workspace-deletion/Source-export operation.
- **Coding observation loss:** An owned Project's active foreground shell was observed
  before temporarily suspending only its OpenCode server process. After about 420 seconds
  from the fault request, the admitted turn became uncertain and released its execution
  owner/expiry; the UI required attention without reporting success. Canonical Source,
  writer epoch, Actor binding, Runtime Attempt and native lifecycle RPC facts stayed
  unchanged, and the same Actor remained running. The server was explicitly restored,
  normal Coding Stop confirmed, and authenticated Workspace Pause retained the same
  Actor/Source without a worker. This is one same-node server-observation outage, not
  Connector loss, control-plane restart, node failure or proof of the controller's exact
  last successful observation time.

Local receipts, source/image/installation bindings and inspected media remain under
`.factory/test-results/`, outside the source distribution. Failures and interrupted checks
are not relabelled as passes by later successful runs. Deleted historical receipts are not
retained evidence. Private-Docker/Dev-Containers and Source-export-on-Pause/final-Delete narratives
do not qualify the current retained-Actor contract. Project OCI-image builds remain external
to Factory.

The [native lifecycle proofs](../../scripts/runtime/README.md#native-lifecycle-proofs)
describe separately owned adapter and Workspace lanes, including explicit ROOTFS cold witnesses.
Controlled Source admission, controller fixtures, offline profile checks, package checks and lane
declarations are not fresh live product receipts. Require actual restore observations rather than
snapshot preferences or labels; MEMORY preference and ROOTFS cold fallback remain distinct.

This scope is not full production or feature acceptance, a full amd64 product journey, a
source-development-launcher qualification, signed release acceptance, independent disaster restore,
cache-cold/different-node recovery or every queued-input Stop/manual-Continue case. It does not
establish comprehensive role/permission coverage or native private-image pull qualification.
The Starter journey needed an explicit Retry and ordinary Pauses for host capacity; it was
neither first-attempt success nor a no-wait flow. Actor-level native resource limits remain
the enforcement boundary.

## Native isolated-browser transport

The direct-ActorTemplate work uses Bun's built-in mTLS WebSocket client through
Substrate's ordinary Router ingress to Actor port 80. The fixed endpoint is
`/internal/factory-browser`. There is no forwarding subprocess, internal SDK,
Kubernetes exec, inner Docker or additional lifecycle controller. The client
does not create, explicitly resume, suspend, delete or retry Actors. Router
ingress can itself resume an Actor, so opening the transport is an execution
action, never an inventory read.

The trusted Browser owner supplies the Router `routerURL`, absolute `caFile`
and combined `credentialFile` projection paths, `atespace`, deterministic
`actorName: "browser-<Session UUID without hyphens>"`, expected `actorUID`,
frozen Session scope and browser-scoped capability. The client rereads trust
and credentials for each connection, verifies the fixed TLS server name
`atenet-router.ate-system.svc` and sends `ate-target-actor` on the Router request.
The Browser gateway checks its projected UID, Session, capability and pinned
protocol. Its first `browser-connected` frame must confirm the expected Actor
UID and Session before any operation is sent. Credentials do not appear in
argv, tool results or public diagnostics.

The Router addresses Actors by **name**, not immutable UID. The product owner
must still verify the original Actor/template binding before opening it, retain
permanent name tombstones, and use a trusted Browser endpoint that checks its
projected Actor UID. A returned header is not independent runtime attestation.
The Router client's allowlisted SPIFFE identity is installation authority and
must not be mounted in any Project or Browser Actor.

Frames are bounded JSON. Connection loss and cancellation end the original
transport without replaying a tool call. Each operation requires the owner's
current authority check at the actual send. App HTTP and read-only Source
inspection callbacks retain their frozen scope and declared App destination.
App WebSocket upgrades are implemented through the existing Child transport,
relaying bounded text and binary frames, including empty payloads. Opening and
each Browser-to-App data send recheck current owner authority and the original
Actor UID, Runtime Attempt/generation, Child connection and declared App target.
Cancellation, Stop, suspension or changed bindings end the original stream
without reconnecting or replaying it. Isolated App credentials use the dedicated
`AppAuthorization` field (`appAuthorization` on the wire), bounded to 16 KiB.
The Child rejects invalid values and use on non-App channels before dialing or
attaching other capabilities. These credentials remain separate from generic
headers and Factory/Parent/Child/Agent credentials; public Runtime WebSockets
do not populate that App-only field.

The isolated transport lane is component qualification: its App relay and Source
observations use controlled fixtures. The focused live Starter independent-review checkpoint
is scoped [above](#qualification-scope); it does not establish comprehensive per-send authority,
credential-rotation or permission coverage. Component checks and removed private-Docker browser
receipts do not extend that live scope.

## Commission the Factory Router identity

Router admission is **external operator configuration**, separate from Factory's native
Owner/Editor API grants and the `ate.dev/api-access=true` Namespace label. The pinned
v1.0.0 [Router manifest](https://github.com/agent-substrate/substrate/blob/b34fbee742906494b5eb4f1f36987176bf8770a4/manifests/ate-install/atenet-router.yaml)
leaves its client allowlist unset. The official
[installer overlay](https://github.com/agent-substrate/substrate/blob/b34fbee742906494b5eb4f1f36987176bf8770a4/cmd/ate-setup/internal/steps/overlay.go)
sets the `atenet-router` container's `--ingress-allowed-spiffe-ids` from the installer's
same-named option, or `ATE_INGRESS_ALLOWED_SPIFFE_IDS` when that option is absent.
The [native flag owner](https://github.com/agent-substrate/substrate/blob/b34fbee742906494b5eb4f1f36987176bf8770a4/cmd/atenet/internal/router/cmd.go)
accepts comma-separated or repeated values; repeated flags append. The Envoy
[validation context](https://github.com/agent-substrate/substrate/blob/b34fbee742906494b5eb4f1f36987176bf8770a4/cmd/atenet/internal/router/xds.go)
requires a Pod Identity CA client certificate and an **exact URI SAN** match. An admitted
client can reach any Actor through this Router, not just one Project. Admit only the
trusted Factory control-plane identity, never an Actor, editor or Project ServiceAccount.

For a Router currently allowing only
`spiffe://cluster.local/ns/ate-system/sa/atenet-client`, the missing entry for Helm release
`factory` in Namespace `factory` is exactly `spiffe://cluster.local/ns/factory/sa/factory`.
Other installations must use their actual Namespace and rendered `serviceAccountName`.
The chart truncates the release name to 40 characters and removes a trailing hyphen;
neither the release string nor a clean-room Namespace guess is sufficient.
The API Editor principal for that same example is
`user:system:serviceaccount:factory:factory`; it is not the Router's certificate identity.
Do not borrow, copy or mint an `atenet-client` credential to stand in for Factory.

The Factory container mounts the whole read-only `substrate-control` projected volume:

| Purpose | Native projection | Factory path |
| --- | --- | --- |
| Router client identity, including private key | `podCertificate`, signer `podidentity.podcert.ate.dev/identity`, `ECDSAP256` | `/run/factory/substrate-control/credential-bundle.pem` |
| Router/API serving trust | live `ClusterTrustBundle`, signer `servicedns.podcert.ate.dev/identity`, label `podcert.ate.dev/canarying=live` | `/run/factory/substrate-control/ca.pem` |
| API Editor authentication, not Router mTLS | 600-second ServiceAccount token, audience `api.ate-system.svc` | `/run/factory/substrate-control/token` |

Kubelet owns projection rotation. The Router client rereads CA and credential files on
every connection and verifies `atenet-router.ate-system.svc`; do not freeze either with
`subPath`, copied files, image layers or Secret substitutes. Router-side client trust remains
the native live `podidentity` ClusterTrustBundle. No CA key, Factory client bundle, Owner
token or Factory ServiceAccount belongs in a Project or Browser Actor. Actor egress public
trust is separate. This commissioning changes no trust root, wildcard, TLS verification,
WorkerPool, egress policy or Actor template.

### Observe and prepare an append-only plan

Run from the Factory root. Select explicit `KUBECONFIG`, `CONTEXT`, `NAMESPACE`, `RELEASE`,
the installation's private `FACTORY_VALUES` file and a **new private** `OUT` directory.
The following only renders local files and reads the selected Router; it makes no cluster
changes. Render with the same chart/values as the intended installation. For an existing
installation, independently confirm its actual Factory Pod Namespace/ServiceAccount and
Deployment match this render before approving the plan.

```sh
(
  set -euC
  umask 077
  mise exec -- helm template "$RELEASE" ./deploy/helm/factory --namespace "$NAMESPACE" \
    --values "$FACTORY_VALUES" --show-only templates/factory.yaml > "$OUT/factory-rendered.yaml"
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
    get deployment atenet-router -o json > "$OUT/router-before.json"
)
SERVICE_ACCOUNT="$(mise exec -- bun --no-env-file --eval '
  import { parseAllDocuments } from "yaml";
  const apps = parseAllDocuments(await Bun.file(process.argv[1]).text())
    .map(d => { if (d.errors.length) throw d.errors[0]; return d.toJSON(); })
    .filter(d => d?.kind === "Deployment");
  if (apps.length !== 1) throw new Error("Expected one rendered Factory Deployment");
  const account = apps[0].spec.template.spec.serviceAccountName;
  if (!account) throw new Error("Missing rendered Factory ServiceAccount");
  console.log(account);
' "$OUT/factory-rendered.yaml")"
router_plan() {
  mise exec -- bun --no-env-file --eval '
    import { planSubstrateRouterAdmission } from "./scripts/runtime/substrate-profile";
    console.log(JSON.stringify(planSubstrateRouterAdmission(
      await Bun.file(process.argv[1]).json(), process.argv[2], process.argv[3]), null, 2));
  ' "$1" "$NAMESPACE" "$SERVICE_ACCOUNT"
}
(set -euC; umask 077; router_plan "$OUT/router-before.json" > "$OUT/router-admission-plan.json")
```

Review `spiffeID`, **all** `allowedSPIFFEIDs` and `patch` in the plan against the selected
installation. `planSubstrateRouterAdmission` is an offline bounded helper, not a Factory
endpoint or automatic installer. It accepts the pinned Envoy layout and literal native Pod
identities only; unfamiliar identities/layouts require operator review. It preserves all existing
arguments and clients, appending one repeated native flag only when that exact identity is
missing. Missing UID/resourceVersion, malformed identities, wildcards or changed expected
CA/serving-certificate flags refuse a plan. It does not certify the whole deployment or live TLS.

### Operator apply and live validation

Only the selected installation's operator performs this step, with new admission withheld
and in-flight Router traffic accounted for. The patch causes the ordinary Router rollout,
which can interrupt connections. Do not rerun the full native installer just to change a
retained Router's admission. If `patch` is empty, skip mutation and continue with validation.
Otherwise extract and deliberately apply the reviewed patch:

```sh
(
  set -euC
  umask 077
  mise exec -- bun --no-env-file --eval '
    import { writeFile } from "node:fs/promises";
    const { patch } = await Bun.file(process.argv[1]).json();
    if (!patch.length) throw new Error("Already listed; skip mutation and validate");
    await writeFile(process.argv[2], JSON.stringify(patch), { flag: "wx", mode: 0o600 });
  ' "$OUT/router-admission-plan.json" "$OUT/router-admission-patch.json"
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
    patch deployment atenet-router --type=json --patch-file "$OUT/router-admission-patch.json"
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
    rollout status deployment/atenet-router --timeout=240s
  mise exec -- kubectl --kubeconfig "$KUBECONFIG" --context "$CONTEXT" -n ate-system \
    get deployment atenet-router -o json > "$OUT/router-after.json"
  router_plan "$OUT/router-after.json" > "$OUT/router-admission-after.json"
)
```

The JSON Patch tests the observed Deployment UID, resourceVersion, named container and full
argv before appending. A concurrent change/replacement refuses the update. A lost reply is
**unknown**: inspect the same original Deployment and rollout before any new plan; never
blindly retry, force replacement or adopt another UID. Compare `router-after.json` with
`router-before.json` and require the original Deployment UID. Require the after-plan's `patch` to
be empty and its existing identity list to equal the original list plus this one exact
Factory identity (unchanged if it was already listed). That is a configuration check,
not installed acceptance.

Persist the complete preserved list in the operator's official `ate-setup` configuration
before its next regeneration. With only the previously described client and default Factory
installation, the full installer setting is:

```text
--ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-system/sa/atenet-client,spiffe://cluster.local/ns/factory/sa/factory
```

Retain every other actually configured client too. Never replace the list with Factory alone,
change native trust, add a namespace prefix/wildcard or grant an Actor this authority.
After every native installer regeneration, reobserve and replan admission as well as rechecking
the existing egress/probe overlays.

The remaining live gate belongs to the deployment owner: from the **actual trusted Factory
Pod**, use its normal projected files and native Router client against an explicitly authorized,
UID-verified Browser Actor. Require the expected Actor UID/Session handshake and a scoped
operation, normal TLS hostname verification, and denial for an unlisted identity. Reconnect
after native certificate/trust rotation to qualify rotation; never export the private bundle
into a probe Pod or evidence. Router ingress may resume its target, so this is not a read-only
inventory check. Record tested source/image, installation/Pod/Router UIDs, exact identity and
outcomes without secrets. Neither an empty plan, `helm test`, Pod readiness nor local unit checks
prove that live gate or the complete Browser-QA journey.

## Fresh Factory Workspace provisioning

The normal Factory image now embeds `/usr/local/bin/factory-substrate-control`,
built with the pinned Go toolchain and the unchanged official v1.0.0 module.
No operator-copied bridge binary is needed. The authenticated
`startPersonalWorkspace` command can create a **fresh** personal Workspace and
provision its deterministic Atespace, editor grant, immutable ActorTemplate and
Actor. Configuration
is explicit and installation-scoped through `FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION`;
all Projects use that selected native configuration. Each Workspace, Verification,
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

The pinned native wakeup client has a 250ms deadline for each HTTP request.
Factory's direct Parent serves `/readyz` from its current control and Source readiness.
It does not shell out to a cold-mode CLI, poll Docker or expose the removed Python
bootstrap probe. Native `RUNNING` does not mean OpenCode or an App is ready.
The standalone operator profile does not invent an application readiness endpoint:
its supplied command must be valid in the selected image. Production Factory templates
retain their own explicit control and Project probes.
The earlier native ARM Workspace lane verified authenticated Source reads before a
deliberately held Dev Container setup hook, followed by real Parent/Child readiness,
ROOTFS Pause/Resume and running/paused final Stop with independent Source. This
small Node fixture does not qualify Starter, browser interaction or first LLM-tool
latency; the historical product receipts above do not establish those new timings.

The native worker still owns the overall wakeup deadline. Fixed Source lease,
download and materialization timings are ephemeral
diagnostics, not readiness or successful restoration evidence.
Parent tool-injection timings separate fixed probes, payload copies, executable
staging, permissions and Child launch. Per-tool and shared executable timings can
nest and must not be added together. The total ends at Child launch, before Child
health or model readiness; new phases require rebuilt `runtime-host` and derived
`substrate-runtime` artifacts.

Connector transport reads Ping/Pong frames after its first startup message, including
while native Project preparation runs. One socket reader keeps complete
application frames in receive order in a bounded eight-frame queue; a full queue applies
backpressure. Receiving a frame does not dispatch an operation, repeat startup work
or announce App readiness. The existing application loop still owns execution, and
closing the connection releases a reader blocked on that queue. Ten-second pings and
their replies keep the transport observed while preparation runs; no private proxy
is required. TLS, protocol, attempt/Actor authentication and the normal 90-second
read deadline are unchanged.

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

### Project images and native preparation

The approved `.factory/actor-template.json` supplies exact immutable Work and service
images. Build and publish those images through the Project's normal OCI-image workflow;
Factory does not build arbitrary Dockerfiles, install Dev Container Features, translate
Compose or publish a cached development image. The shipped Starter already supplies its
release's prepared Work and PostgreSQL images. Imported Projects must establish real
image digests before execution; an AI-proposed recipe or invented digest is not a built image.

The Project declaration optionally accepts the native-shaped
`"snapshotConfig": {"preferredFidelity": "SNAPSHOT_FIDELITY_ROOTFS"}`. The only other
supported value is `"SNAPSHOT_FIDELITY_MEMORY"`, which remains the default when
`snapshotConfig` is omitted. This strict object accepts only `preferredFidelity`;
VOLUMES, `storageLocation`, golden snapshot configuration and unknown fields are rejected.
Factory always renders golden snapshots explicitly disabled.

This setting selects the preference for a newly admitted immutable ActorTemplate, not a
per-Pause switch. An existing Actor retains its original template; editing the Project
declaration does not mutate a retained binding. To exercise a full Starter ROOTFS cold flow
from first Start, declare ROOTFS before creating that Project's first Actor. A preference or
snapshot label alone proves neither fallback nor successful restoration. This setting offers
no performance or RAM-continuity guarantee and does not qualify a Starter or native lifecycle flow.

Substrate's node-side `atelet` pulls these images before the Project process exists.
Private image access must therefore be commissioned by the operator through the pinned
upstream `--image-credential-provider-config` and `--image-credential-provider-bin-dir`
contract, with the corresponding registry trust. Factory supplies no custom credential provider
or per-Project registry UI. Private images remain unavailable until that operator prerequisite
is met: missing pull authority, registry trust or image content surfaces as a native pull/start
failure, not successful setup, an anonymous fallback or substitution of a public image.
Do not copy credentials into ActorTemplate JSON or add a Factory image proxy to conceal an
unconfigured native pull. Qualify private access against the exact admitted native image and
original Actor binding; saving Project settings or passing a registry-credential fixture is
not proof that the native worker can pull it.

The Work container's optional command/args performs explicit repository preparation after
the canonical Source checkpoint is admitted. Factory waits for its actual successful result
before Project execution. A failure remains a failure, not a skipped image job or a claim that
the App is healthy. Native cold continuation can run preparation again, so commands must
tolerate it. Services use their explicit native entrypoints and separate durable directories.

Project Environment settings accept only
`{variables:[{name,value?,runtime,verification}]}`. Runtime grants support application variables
and private-package tokens inside Project processes, including explicit Work preparation.
Verification receives only variables explicitly opted in with `verification: true`; Runtime
access alone does not grant Verification access. There is no build-time flag or registry bundle.
Image-build credentials belong to the Project's external OCI workflow, not Factory Environment.

Saving Environment settings persists the exact secret revision. It does not enqueue a build,
publish an image, start inference or qualify the next native start. Settings and signed source
events have no image-producer side effect. Setup reports approved configuration, Environment
settings and actual Main Preview independently; it has no synthetic image-preparation steps.
The image-result endpoint, global producer scheduler, producer grants and producer-only
Greenfield tables are removed rather than retained as compatibility paths.

Registry authentication, public certificate trust, explicit egress and immutable native
provisioning checks remain required. Adding an admitted download host affects fresh owners;
retained owners keep their original exact policy. Removing an original admission or changing
trust/placement fails closed rather than rebinding a retained Actor. Release publication
remains its separately authorized exact-job workflow, not a replacement development-image builder.

### Model and browser callbacks

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

Internal final Workspace cleanup, not the public Workspace halt action, keeps the
existing Workspace lock throughout complete Source export,
confirmed independent Source handoff and UID-bound Delete. It records final Stop intent before
exporting and never captures a new ROOTFS merely to delete that Actor. Missing independent Source
blocks Delete. Lost replies retain the original intent until the same Actor is independently
absent; concurrent Start cannot wake it. Startup recovery and the bounded Stop-cleanup sweep
continue that recorded operation without new compute, hooks or input.
Public Workspace halt uses Pause; `stopRuntimeAttempt` refuses Workspace-bound Attempts
and is reserved for isolated execution. There is no public Workspace-delete command.
During startup, the authenticated Source drain cancels and joins preparation instead of
waiting behind a blocked Dev Container command. The same queued checkpoint request then
reaches the retained Source owner; cancellation alone is not a drain acknowledgement.

An explicit Workspace Start after confirmed Stop selects the next generation only after
re-observing the original Actor's absence and independent Source. Every generation keeps its own
Atespace, grant, template, Actor binding and creation attribution. New compute consumes the latest
confirmed service-owned Source export, including saved offline edits, without reusing an old runtime
identity. The version-2 restore GET freezes and confirms the service's complete export only when
the exact admitted Actor requests it. Frozen service-owned Source stays readable; saves refuse
without discarding editor buffers. A dedicated Source lock keeps these operations independent of
the long-running native Resume lock.
The authenticated response identifies both the recipient and the checkpoint's actual producer.
After verifying and materializing the bundle and rechecking the complete lease, the Connector
POSTs that exact checkpoint and planned owner epoch. Factory stops the old service and commits
the Actor's writer grant before acknowledging it. Only that ACK permits the cold bootstrap marker,
Docker or Stop-only execution. The ACK supplies the current Change writing role, including on an
identical retry; the marker does not reuse an earlier GET's role.
Lost ACKs may confirm the identical receipt; GET never replays an
import over an already-granted Actor's tree.
Final Stop before this v2 grant keeps the same independent saved checkout, including when a
download was interrupted. Stop after the grant still requires the original Actor's confirmed
export; an absent Parent is never proof that no writes happened.
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

An explicit first Start can add the exact confirmed missing setup files to a Source checkout
opened before configuration approval. This uses the existing Workspace lock and Source writer
fence, a confirmation for that seed's exact Project and base commit, and create-only file writes.
Different local bytes or unsaved shared configuration block Start without overwriting them.
Interrupted copies observe identical confirmed files and add only what remains missing.
The immutable initialization revision, original seed and Git history do not change. Provisioning
freezes the System Contract read from current canonical Source, including on a later Start after
Stop; it does not read an absent contract from that older initialization commit or replay setup
over a previously running Workspace.

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
The private filesystem recreates the Session's recorded container directory empty, including
standard and custom Dev Container folders. It never mounts that directory's Project checkout.
Fixed tool and retained-metadata paths cannot be selected as the empty Session directory.
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

The pinned host runner keeps its scratch workspace under `/tmp/factory-actions`; that is
not the prepared checkout. For Verification and publication, Factory supplies
`FACTORY_CHECKOUT_ROOT` from the Work process's actual cwd after native path remapping.
Source-based `run` steps use the standard
`working-directory: ${{ env.FACTORY_CHECKOUT_ROOT }}` field. Keep commands relative;
monorepo checks may append an established relative subdirectory to that field.
Generated Verification workflows set it on each step; the assigned-commit check stays at
the checkout root. Only `run` steps are supported:
do not add `uses`/checkout steps. Factory neither overrides authored step directories
with a wrapper nor copies or links the checkout into runner scratch space.

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
new pins only for fresh owners. An omitted installation selection now freezes explicit
1,500m CPU / 3,072 MiB limits before creating a new owner; these are finite defaults, not a
claim that every Project fits. Existing
Workspaces keep their saved image, template and provisioning intent for observation,
Stop and continuation. The update never replaces an Actor or reinterprets its
snapshot. Changes to trust, scope, placement or egress still fail closed against
retained intent; this is not a runtime migration or automatic qualification.
Resource admission charges the exact selected native limits against existing
Factory/Project allowances; old native bindings retain their original 1500m CPU /
1024 MiB limits and accounting. Those old smoke limits did not fit the real Starter
dependency hook, which Substrate killed for exceeding memory. No failed Actor is
resized or restarted to hide that outcome. WorkerPool capacity admission still applies.

Native image acquisition and container startup belong to Substrate. Factory does not retain
the previous private-Docker download workers, prepared-image lookup deadline or CLI hook path.
Exact image identities are validated before template admission; runtime preparation and App
health still need their own observed results. Earlier private-image acquisition timings are
not performance evidence for direct native startup.

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
the immutable `FACTORY_RUNTIME_HOST_IMAGE` digest from `deploy/runtime-host/Dockerfile`.
It starts `factory-runtime-connector native-parent` directly and checks the shipped
Connector and Git executables. There is no rootless bootstrap image input or
`native-bootstrap-mode` command. Project containers use their separately admitted
immutable images, not a private Docker engine. Normal installation checks that
`workloadImage` matches the exact `substrate-runtime` artifact.
`scripts/runtime/substrate-image-proof.sh` checks only the networkless image
packages and explicitly reports no native lifecycle proof. Its successful result
does not qualify gVisor, Source handoff or the full Ticket journey.

### Historical private-container storage and Source qualification

This entire subsection records an older private-Docker and Source-handoff design
and its scoped receipts. It is not the current retained-Workspace contract or an
entrypoint supported by current native templates; do not implement its Pause/Stop
ownership transfer as a compatibility path. The current contract is
[retained Workspace lifecycle](#retained-workspace-lifecycle).

The removed dependency-layer builder, Dev Container Features, Docker build proxy and
deferred CLI hooks are not native image-preparation options. Current Projects supply
immutable OCI images and explicit Work commands as described
[above](#project-images-and-native-preparation); the storage receipt below does not qualify them.

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
This historical same-node cold-restart proof does not qualify different-node recovery,
the current toolchain or retained cutover.

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

For resumable Pause, only an independently observed completed durable ROOTFS snapshot permits Source
ownership to move to the independent service on Factory's retained state claim. Final Stop instead
requires its persisted cleanup-only intent and the same completely confirmed frozen Source export.
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
Stop is not reported as successful until the original Actor's absence is confirmed. Live ARM coverage
is listed above. Pause preserves private Docker data in the Actor's ROOTFS; an explicit Stop removes
that Actor and its compute state only after Source has an independent owner. Final Stop does not
create another native snapshot. Its intent cannot be cleared or converted back into execution.
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
default still rounds timestamps. The other packet/raw/SUID flags remain the pinned
worker configuration from earlier rootless qualification; removing that bootstrap
does not silently change the worker flags or claim a newly qualified sandbox profile.

Fresh Actors/snapshots must use `nightly-20261109-975fb172241c`. ROOTFS means
restarting processes, PTYs, connections and in-memory state, not MEMORY continuity.
`preferredFidelity` is only a request. Before releasing source-node data, the
Factory adapter must explicitly call SuspendActor with
`options.mode=DURABILITY_MODE_SYNCHRONOUS` (**1**, not the asynchronous default),
then verify the actual snapshot UUID/generation, ActorUID, ActorTemplateUID,
sandbox runtime/version and actual fidelity **MEMORY (3) or ROOTFS (2), never
VOLUMES (1)**, with
`durableSnapshot.state=COMPLETED`. `SUSPENDED`, a successful RPC or a local snapshot
alone is insufficient, including an already-suspended Actor returned by a sync call.
Factory's runtime adapter owns those lifecycle calls; this operator profile pins the native
binaries and installation configuration.

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
```

The asset command verifies SHA256 **and** SHA512 before saving the official
archive, checks its extracted runsc, and checks the official Linux release CLI for
that architecture. The saved CLI is a Linux worker-host tool, not a macOS binary.
The installer built below uses the operator host's own Go target. Files
are created exclusively; an identical existing file is reusable, a different one
is never overwritten. SandboxConfig uses the same content-checked official
`gs://gvisor/...` URL through native asset synchronization; the downloaded copy is
an operator verification artifact, not a custom distribution server.

The profile renderer starts the exact supplied command in the immutable workload
image. It adds no shell, RootlessKit namespace, daemon, SUID capability, persistent
Docker graph, private proxy or fabricated wakeup probe. It drops all capabilities
and projects native egress/system public roots, selected by normal TLS environment
variables. Destinations still require native EgressPolicy admission; TLS verification
must remain enabled. This operator smoke template is not the Factory Project-template
renderer and does not initialize Source, prepare Project images or run an Agent.
The removed rootless bootstrap is not a compatibility option.

Build and publish the selected tools/Project images separately and supply their immutable
digests. Profile rendering does not build or publish those images, and Factory has no automatic
Project-image producer. A previous native acceptance receipt does not qualify refreshed Node,
OpenCode, IDE, browser or Go artifacts.

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
  "workloadImage": "registry.example/workload@sha256:<64 lowercase hex>",
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

Also apply [`tracing-resources-patch.yaml`](tracing-resources-patch.yaml) to the owned
`otel-system/jaeger` Deployment using the same observed-object procedure. The upstream
in-memory tracing fixture otherwise has no memory limit: accumulated traces consumed
about 4 GiB and contributed to control-plane and Factory timeouts on the shared VM.
This patch reserves 128 MiB, caps tracing at 512 MiB and gives Go a 384 MiB memory target.
Only ephemeral diagnostic traces may be lost on restart; Factory history, Source and
Actor limits are unchanged. Do not run another completed test cluster alongside a
retained demo without budgeting both clusters' actual host usage.

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
