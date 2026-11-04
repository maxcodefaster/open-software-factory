# Operating Factory

Installing, sizing and recovering a Factory installation and its Factorybox worker.
The chart's own instructions are in [deploy/helm/factory](../../deploy/helm/factory/README.md).

## Installation and worker admission

Select `registryCASecret` before admitting the installation's first Factorybox worker and keep
that CA bundle unchanged for the retained worker. This configures its private Sandbox registry
trust; it does not configure Kubernetes node image pulls. Node image-pull trust is an operator
prerequisite. Publishing new digest-pinned runtime tools does not itself require changing this
setting, and Factory refuses to overwrite a retained worker's shared trust declaration.
The Dev Containers CLI receives that admitted Factory Registry CA alongside any
Project Registry certificates. Empty Project settings do not discard the installation
trust or disable TLS verification.

The development Helm chart lives in [deploy/helm/factory](../../deploy/helm/factory/README.md).
Install it directly from this repository; a public chart repository and release publication are
not required during development. Kubernetes is provided by the operator. Factory does not
install a VM or cluster, require OrbStack, or manage the node's Docker daemon.
Local tools and the Factory image pin `kubectl` 1.35.6. Use a Kubernetes API server
within one minor version, 1.34 through 1.36, as required by the upstream version-skew policy.
Use the repository-pinned Helm 4.2.2 for installation and upgrades. Helm 4.2.0 and 4.2.1
can wait indefinitely for deletion of a missing pre-upgrade hook, including Factory's
maintenance Job. The [upstream fix](https://github.com/helm/helm/issues/32231) is included in
4.2.2; skipping hooks would bypass Factory's work-settlement guard rather than fix the wait.

The chart and owned Forgejo fixtures pin 17.0.0 by image digest. Its native job/step/log API
supplies Verification diagnostics. Upgrading an existing Forgejo is an explicit operator action:
back up its database, repositories, configuration and secrets, review the upstream 16/17 breaking
changes, and verify the upgrade before normal work resumes. Changing the repository pin or running
an owned proof never upgrades a retained installation.

The chart runs Factory, PostgreSQL, Forgejo, Zero, encrypted OpenBao and one private Garage
object store in Kubernetes. It creates the file bucket, credentials and persistent volume
automatically; no separate S3 provisioning is required. Internal
callbacks use Services and the application uses its ServiceAccount, without a personal kubeconfig
or a mounted host Docker socket. Factorybox execution requires an admitted Linux node/kernel
profile, permission for privileged outer Pods and usable persistent storage. Supply the exact
private worker image and executable hash in the chart's `factorybox` values.

PostgreSQL checks idle TCP connections after 30 seconds, with three ten-second probes and a
60-second unacknowledged-data bound. This detects lost control-plane Pods so their session
advisory locks do not wait for node TCP defaults that can retain them for hours. Healthy idle
connections have no session expiry; a long Sandbox operation is not cancelled merely because it issues no SQL.
Active queries check for a kernel-reported disconnect every second. Database connection loss
does not authorize replaying external work; retained intents and native operation locks still
govern reconciliation.

Fresh chart installations select the aggregate worker budget from the configured node before
first admission. Factory checks its platform and readiness, uses its allocatable CPU ceiling
and subtracts other Pods' memory reservations plus `factorybox.memoryHeadroomMiB`, 2048 MiB
by default. The worker reserves that selected memory and uses it as its finite ceiling.
Init peaks, sidecars, Pod overhead and terminating or resizing allocations remain charged.
This is scheduling capacity, not a sample of free memory.
`factorybox.cpuRequestMilli` selects the smaller CPU scheduling reserve, 100 millicores by default.
The pinned Factorybox binary must admit finite aggregate budgets; the native qualification
fixtures still retain their 3 CPU / 3 GiB ceiling. Existing workers retain their exact admitted
profile, including the original 3 GiB aggregate limit. Changing defaults never resizes or replaces
them. See [worker resource admission](../../docs/adr/0002-factorybox-worker-and-execution.md#select-aggregate-worker-resources-before-admission).
Operator values can independently size `postgres.resources`, `forgejo.resources`,
`openbao.resources`, `zero.resources` and `objectStorage.resources`; their defaults are unchanged.
CPU requests are reservations, not instantaneous usage. Keep headroom for startup, storage checks,
runtime helpers and future Source/IDE allocation without bypassing admission.

There is one active worker admission per Factory. A fresh commissioned Start can recover a failed
initial setup only after the exact original terminal Pod is observed, no native worker identity
was recorded and all previous execution is settled. The new admission has its own Pod and private
store; canonical Source, old Pods, stores and Runtime Attempts retain their original identities.
Opening a Project or reconnecting does not replace a worker. Recovery of an already admitted
worker requires an explicit System Manager command after its exact original Pod has terminated
and prior execution has settled. By default the successor reuses the original private store and Source claim;
it has a new Pod and native epoch, without replaying Agent work. See
[admitted worker recovery](../../docs/adr/0003-worker-recovery-and-storage-retirement.md#recover-an-admitted-worker-without-allocating-another-store)
and [bootstrap admission recovery](../../docs/adr/0003-worker-recovery-and-storage-retirement.md#keep-source-allocation-separate-from-worker-admission-attempts).
An explicit `storage: "fresh"` recovery can admit a distinct store with the configured capacity
only after private backing cleanup is confirmed across every admission sharing the old claim.
The old store and execution history remain unchanged, and canonical Source keeps its exact claim,
Namespace and node. This does not resize or migrate a retained store. See
[fresh execution storage](../../docs/adr/0003-worker-recovery-and-storage-retirement.md#admit-fresh-execution-storage-only-after-confirmed-drain).
The successor can finish an exact private-backing retirement whose native Delete
and preceding checkpoint retirements were already confirmed. Factory retains each
reserve retirement receipt as it arrives, instead of losing completed steps when
the final cleanup fails. Its storage sweep uses the successor's pinned executable
against the original controller in the same store. It preserves old execution
identities and never starts old processes. Missing checkpoint receipts remain
pending; stopped compute is not a claim that all retained storage was reclaimed.
Before preparing a successor's Sandbox, Factory retires completed image-export transports
owned by positively terminated predecessor admissions. It keeps their receipts and checks
exact archive identity; active, partial and changed payloads are not deletion authority.
This does not prune native bases, snapshots, Source or the bounded store.
The current worker also retires a completed consumer transport after reverifying its independent
native import. Later preparations reuse that verified base without the tar file. The storage
sweep performs this automatically; Source, snapshots and native backing remain retained.
See [consumer transport retirement](../../docs/adr/0003-worker-recovery-and-storage-retirement.md#retire-a-consumer-transport-after-verifying-its-independent-native-import).
Fresh admissions check actual backing-filesystem availability before native allocation. The chart
defaults to an 8 GiB minimum, 64 GiB maximum and 128 GiB claim. Larger safe whole-GiB budgets
are accepted when the claim covers the maximum plus 17 GiB. The pinned worker selects a fixed
size in that range on the actual volume while preserving its native host floor and operating
write reserve. Factory records the
selected size in its immutable native identity. The worker must support `bounded-min-bytes` and pass
its native qualification. Insufficient space fails explicitly rather than waiting indefinitely.
This does not resize a retained worker or reclaim unrelated node data.

Before dispatching a fresh Sandbox Start or Fork, Factory observes the original worker's native
write-admission decision. A known disk refusal leaves the mutation unattempted, so Stop can release
its prepared inputs without inventing a native Delete receipt. The native runtime still checks
again at dispatch; an uncertain result after dispatch remains retained and is never replayed.
Preparation checks that same decision before exporting a consumer image and again before dispatching
extraction or private mounts. A refused check keeps preparation unattempted and can continue when
capacity returns. If dispatched preparation has no completion receipt, reconciliation preserves its
original failure diagnostic rather than replacing it with a generic pending message.
Verified pre-dispatch capacity waiting does not consume the Sandbox's native startup window.
When capacity returns, the same admitted request receives its full bounded lifecycle window.
Unknown outcomes retain their existing deadline and cannot use this admission-wait path.
A confirmed native Start with its Parent connected remains preparing while Project setup hooks
finish. Expiry of the native startup observation window does not report those hooks as failed.
Connector readiness, actual setup errors and exact-identity transport recovery still own the outcome.
Cold Project pool templates use their original preparation lease, fifteen minutes by default,
for image import, dependency hooks and checkpoint quiescence. Native Fork preparation retains its
420-second window. A newly commissioned healthy Staging permits one fresh preparation after a
failed template; unchanged observation never cold-retries it. Already-ready templates remain reusable.
Clean preparation retains the primary's installed user-home tools in a private, exact-image
cache before Apps or Runtime grants are activated. A same-source Fork that needs fresh Runtime
values can create a new compliant Dev Container from those files instead of downloading its
tools again. Required hooks still run once, and changed build or registry grants cannot reuse
that cache. It stays in the Sandbox's private daemon and is never published.
Idle Pause checks that same capacity decision before revoking live transports or dispatching capture.
A known pre-dispatch refusal keeps the Sandbox usable and the same snapshot intent unattempted;
the existing idle grace permits another admission check. A dispatched or unknown Pause remains fenced.

Choose an available development application image containing the exact runtime artifact bundle,
then supply the browser-facing Factory and Forgejo origins. See the chart's
[installation and maintenance instructions](../../deploy/helm/factory/README.md) for local access,
Ingress, credentials and retained data. Development images may be built locally; the installed
application does not build its own tools or require a source checkout on the operator's machine.

The image workflow publishes only when a GitHub release is published, never on branch pushes or
pull requests. A release tag such as `v0.1.0` must point to a commit contained in `main`.
The shared verification workflow runs the standard checks, PostgreSQL/controller tests and
owned UI journeys natively on AMD64 and ARM64 for `main` and its pull requests. Release publication
must pass those same checks on its exact tagged source before any image build or push.
Native AMD64 and ARM64 jobs build the runtime roles and Factory, then publish their combined
manifests. Existing versioned architecture images are not overwritten. Publishing Factory does
not admit a Factorybox worker or activate an installation.
Before pushing each native runtime-host image, an offline Compose proof builds a configured
Dockerfile outside its context and checks that raw Bake still refuses the same ungranted file.
It uses no Project source, credentials or host Docker socket.
`mise exec -- bash scripts/runtime/project-compose-prebuild-proof.sh RUNTIME_IMAGE NODE_IMAGE REGISTRY_IMAGE`
separately checks native Compose image preparation, exact replay and a writable consumer with
required Project/Feature hooks. Pass immutable native image references. It runs offline against a private Docker daemon.

For local browser access, install with `deploy/helm/factory/values.local.yaml` and your
cluster-reachable application image. Then run:

```sh
mise exec -- bun run factory:connect
```

This one foreground command reads the installed addresses and manages all three native Kubernetes
connections. It reconnects after a forwarding process exits, including Pod replacement, without
restarting Factory or replaying work. Use `--namespace`, `--release` and `--context` for a different
installation. Ctrl+C closes only its own local connections. No hosts-file edits, external wildcard
DNS or browser resolver flags are needed in Chromium-based browsers for the isolated
`*.runtime.localhost` IDE and App addresses. This is local development access, not a public Ingress
or an installer for Kubernetes.

Each declared App has its own isolated origin. Root-relative pages, framework APIs, assets and
WebSockets stay with that App instead of entering Factory's document or command handlers.
Declared App processes receive `FACTORY_APP_ORIGINS`, a JSON object from their declared ports
to the published origins of that exact Runtime Attempt. Projects can use those addresses for
browser-facing configuration while keeping backend and health connections local. The addresses
contain no credentials and grant no cross-App access or relaxed authentication. New artifact
intent freezes the public Factory origin; existing Attempts and clean prepared templates are
not rewritten. See [published App addresses](../../docs/adr/0001-workspaces-source-and-app-access.md#bind-published-app-addresses-to-their-runtime-attempt).
The Connector preserves the browser-visible App Host for HTTP and WebSocket requests while
dialing only the admitted internal target. Factory reconstructs proxy authority after discarding
client-supplied forwarding headers; same-origin authentication does not need a relaxed origin check.
Preview grants bind the exact Runtime Attempt and App channel. Their host-only cookies cover that
App's origin; Factory credentials are not forwarded, and App cookies cannot escape to another App.


## Runtime host

The runtime host builds Docker Compose from the verified upstream source archive pinned in
`upstream.json`. It includes the configured-input grants needed for Dev Containers' temporary
Dockerfiles while keeping Bake's filesystem checks enabled. This is an upstream development

## Local source installation

The local listener defaults to `0.0.0.0` so OrbStack-hosted runtimes can call Factory.
Set `FACTORY_HOST` explicitly to narrow that listener, noting that loopback-only access may prevent
runtime callbacks. `FACTORY_ADMIN_EMAIL` and `FACTORY_ADMIN_PASSWORD` are honored for bootstrap and
Forge setup. Set a private password before first startup if the listener is reachable by others.
Bootstrap never resets an existing account's password; later starts must use that account's
current credentials for Forge setup.
Disposable installations keep their own generated administrator identity and private password
instead of inheriting the normal installation's administrator overrides.

Startup provisions the local database, Forgejo, planning cache and encrypted OpenBao, reuses a
complete set of pinned runtime artifacts after checking their remote manifests or publishes them
once, applies migrations and builds Factory. Missing artifacts fail before replacing a running
Factory server; a valid digest file alone is not readiness. Cold artifact builds
and Sandbox preparation can take several minutes. Installation data and exact artifact references
live under the ignored `.factory/` directory.

Before replacing the running server or announcing readiness, startup checks the default Kubernetes
storage class with a fresh 8 GiB RWO claim. The pinned source image must write and read a marker as
the source-service UID, then its Pod, claim, backing volume and Namespace must be removed.
This checks usable storage, not just a reachable cluster or an existing volume. A failed check
keeps its own recorded identity for the next startup; it never resets Project storage.
`storage-readiness-diagnostic.json` in the installation state records compact claim, Pod and
provisioning-helper states, including observed exit codes when available. The last failed check
also remains in `storage-readiness-failure.json`, even after a successful retry. Neither file
contains raw logs, environment values or credentials. The explicit native proof is
`FACTORY_RUN_STORAGE_READINESS_PROOF=1 mise exec -- bun run test:live storage-readiness.live`.

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
Published defaults also supersede disposable-installation bootstrap pins, never an existing
Runtime Attempt's recorded image.
It starts stopped PostgreSQL and Forgejo services and waits for their health checks before running
migrations or replacing the server. A dependency failure leaves the existing server untouched.
It reuses the existing frontend bundle. After changing UI source, run `factory:up` again to rebuild
that bundle and restart the same installation without resetting its data.
Use [runtime artifact instructions](../../deploy/runtime-host/README.md) when changing runtime images.

### Run the existing installation's server on Linux

On macOS 27 with OrbStack 2.2.3, long-lived Pod connections through the Mac host alias can lose
responses. Keep Factory's server on the Linux side and use the Linux node's reachable IPv4 address
for runtime callbacks. This changes only the server process, not the installation, database,
Workspace storage, model settings or registered Forge identity.
Source initialization and runtime assignments share the same repository-transport check. Local
HTTP endpoints may use private or loopback IP literals as well as the local host aliases. Public
HTTP endpoints, credentials in URLs and executable clone protocols remain rejected.

After the initial artifact publication, build the application image and inspect the node address:

```sh
FACTORY_IMAGE=open-software-factory:local mise exec -- bun run factory:image
mise exec -- kubectl --context orbstack get node orbstack -o wide
```

Use the actual `INTERNAL-IP` from that output, rather than copying this example address:

```sh
FACTORY_SERVER_IMAGE=open-software-factory:local FACTORY_RUNTIME_HOST=192.168.139.2 mise exec -- bun run factory:restart
```

The native launcher still owns startup and Stop. It records the exact image/container identity
before creation, keeps credentials out of command arguments and reuses the selected image and
runtime host on later restarts. It mounts the configured OpenBao token and CA files read-only,
including a local CA stored outside installation state. Neither a static neighbour entry nor a
network repair loop is needed. For the Linux server, the launcher also binds the existing local
Forgejo port on that exact private node address so Sandbox Git operations can reach it. The
loopback binding and browser-facing Forgejo identity stay unchanged; PostgreSQL and Zero remain
loopback-only. Rebuild the image and explicitly select it to adopt source or UI changes. Setting
`FACTORY_SERVER_IMAGE=native` explicitly returns to a host process.

Compose supplies only the source-development data services. It is not another Factory installation
method. The application image starts the Kubernetes bootstrap and contains neither a Docker CLI
nor a workstation certificate generator. Install that image with the
[repository Helm chart](../../deploy/helm/factory/README.md).

