# Factory with official Substrate

This chart installs the Factory control plane on an existing Kubernetes cluster. Factory uses
only the pinned official Substrate runtime. It does not install a cluster, an Ingress controller
or a private runtime fork. Use the checkout chart and explicitly qualified immutable images.
The [native profile's qualification scope](../../substrate/README.md#qualification-scope) separates
the live ARM product path from packaging, source-launcher and other architecture checks.

## Prerequisites

- Linux control-plane nodes, arm64 or amd64. Execution workers must match the selected
  Linux arm64 or amd64 identity for the pinned
  gVisor ROOTFS profile. Install the official Substrate API, durable native object storage and the
  exact SandboxConfig/WorkerPool described in [the native profile](../../substrate/README.md).
- Native API serving trust through the live `servicedns.podcert.ate.dev/identity` ClusterTrustBundle.
  The cluster must support that projection and the application's 600-second audience-bound token.
- A dynamic RWO StorageClass with POSIX permissions and ordinary atomic file operations. Set
  `storageClass` explicitly if the cluster has no suitable default. Bootstrap performs an exactly
  owned write/read check as UID 1000; it does not assume a worker's old host UID mapping.
- A digest-pinned Factory image containing the bridge, Source service and exact artifact bundle,
  and a digest-pinned native Actor image selected in the installation configuration. Publish those
  images where the cluster and Actor-private Docker can pull them. Node image-pull trust remains
  an operator prerequisite, not a privileged installer DaemonSet.
- Factory and Forgejo public TLS origins and reachable DNS. Native Git
  requires a DNS Forgejo hostname on port 443, admitted by the frozen native egress configuration.
  Factory's isolated browser hosts also need `*.runtime.<factory-hostname>` in DNS.
  The chart issues the Ingress certificate unless an operator supplies `ingress.tlsSecret`.

Factory's ServiceAccount is trusted infrastructure. It manages developer-editor namespaces and
exactly owned storage checks, bootstraps its data services and observes native capacity. Its
ClusterRole grants WorkerPool `get/list/create` and SandboxConfig `get`, but no native pool
patch/delete, Kubernetes RBAC administration, wildcard, bind, escalate or impersonation.
Native Actor lifecycle uses the scoped Substrate API. Actor/Project code receives neither the
Factory ServiceAccount nor a host Docker socket.

Substrate v1.0.0 requires a separate global Owner credential for Atespace creation. Put its
short-lived token in the provisioner Secret and rotate it before expiry. Actor calls use the
application's projected Editor identity. The provisioner credential is not passed to an Actor,
an editor backend or the Helm preflight. Its holder is still a trusted native global Owner.

## Hardening

- PostgreSQL (999), Forgejo (1000), Zero (1000), OpenBao (100:1000), Garage (1000) and the
  maintenance Job run non-root with a read-only root filesystem, no capabilities, no privilege
  escalation and the `RuntimeDefault` seccomp profile. Each was started with those settings against
  its pinned image. Factory runs as uid 1000 with the same settings. Fresh state claims need
  private UID-1000 ownership; the service process needs no root. `/tmp` is an `emptyDir`, `kubectl` and the Kubernetes
  connection file live under `/tmp`, and the image's tools need no installation at run time.
- Factory has no `fsGroup`. Kubelet would add group read and write to every retained state file,
  and Factory refuses an OpenBao token file that is group-accessible.
- Factory, Zero and OpenBao have a short init container (`own-state` and `own-data`). It runs as
  root with only `CHOWN`, `DAC_OVERRIDE` and `FOWNER` and hands fresh root-owned volumes to the
  service user. `own-state` chowns the Factory state claim once and writes `.owner-uid-1000` there.
  Existing correctly owned files do not need another ownership change.
  These init containers are why the release Namespace cannot enforce Pod Security `restricted`.
- `networkPolicy.enabled` (default true) denies ingress to every release Pod and allows only the
  flows Factory uses. Developer-editor namespaces, labelled
  `app.kubernetes.io/managed-by=open-software-factory`, may reach Factory on port 3000.
  Native Actors use their admitted public TLS ingress, not internal HTTP Forgejo.
  PostgreSQL, OpenBao and Garage have
  no egress except DNS (OpenBao also reaches itself). With `ingress.enabled`, set
  `networkPolicy.ingressControllerNamespaceSelector` to the controller's namespace labels. Empty
  allows every namespace. Port-forwarding enters through the Pod's loopback and is unaffected.
  The cluster's CNI must enforce NetworkPolicy; otherwise the objects have no effect.
- Every service has startup, readiness and liveness probes. Liveness tolerates about two minutes
  of failures and only starts after startup succeeds.
- PostgreSQL's steady-state probes check its TCP listener without starting a process in the
  container. A stalled container-exec request must not restart a database that still accepts
  connections. Startup still uses `pg_isready`. A listening socket alone does not prove that
  SQL queries succeed.
- OpenBao liveness also checks its TCP listener. Container-exec delays must not restart and
  reseal a reachable store. Startup and readiness retain their CA-verified HTTPS checks and
  accept the sealed state so bootstrap can unseal it. A listening socket is not proof that
  secret reads or writes work.
- No PodDisruptionBudget is rendered. Every service is a single replica on a ReadWriteOnce volume,
  so `minAvailable: 1` would block node drains for good, and `maxUnavailable: 1` would not protect
  anything. Factory itself cannot run more than one replica: the state claim is ReadWriteOnce, the
  Deployment uses `Recreate` and a lock on the state directory refuses a second process. A node
  drain therefore stops each service until its Pod restarts elsewhere. Expect an outage of a few
  minutes, longer when a zonal volume must follow the Pod. The backup CronJob is the mitigation
  for losing a node's storage, not for drains.

## Secrets and GitOps

By default the chart generates its credentials, object-store keys and OpenBao TLS identity once
and keeps them with `lookup` and `helm.sh/resource-policy: keep`. `helm template` and Argo CD
cannot see the cluster, so every render would invent new values. For those tools, create the
Secrets yourself and set `existingSecrets.credentials`, `existingSecrets.objects` and
`existingSecrets.openbaoTLS` (key names are in `values.yaml`). The chart then renders no Secret.
Factory, Zero, Garage and OpenBao carry a checksum of the Secrets they read, so Helm and Flux roll them
when a Secret changes. Argo CD cannot read the Secret, so bump `existingSecrets.revision`.
The OpenBao certificate must cover the OpenBao Service names and `127.0.0.1`, which the startup probe uses.

### Installation-owned HTTPS

With `ingress.enabled: true` and no `ingress.tlsSecret`, the chart creates a private CA and
certificates for Factory, Forgejo and `*.runtime.<factory-hostname>`. Issuance uses Kubernetes
Secrets and OpenSSL in the Factory image. It needs no external certificate service, ACME account,
cert-manager, mkcert, OrbStack or public wildcard DNS service.

The retained immutable Secret `<release>-ingress-ca` holds the ten-year CA. Only the issuer init
container and the daily `<release>-ingress-tls` CronJob mount its signing-key Secret. Native workloads
receive only its public certificate. The chart projects that
certificate as `/run/factory/substrate-configuration/factory-ca.pem`, so the native configuration
Secret needs only `configuration.json` and its normal `factoryCAFile` path, not a manually
prepared CA file. This does not change Substrate API trust or the node's image-pull trust.
Before readiness, the init container also retains the original CA and an initial leaf privately
under `/var/lib/factory/ingress-tls/identity.json`. The existing state backup includes that recovery
copy automatically. It contains a signing key and needs the same encrypted protection as the
OpenBao unseal key. Factory's infrastructure ServiceAccount already has Secret access; public-only
runtime mounts do not make a compromised control plane unable to read the signing authority.

The initial leaf lasts 90 days. The issuer replaces leaves with fewer than 30 days remaining,
both before Factory starts and on the daily schedule. Ingress must reload its referenced TLS
Secret when it changes. The issuer validates the original CA, key, exact hostnames, Secret
ownership, UID and resource version. A lost patch reply is not retried blindly. It never replaces
the CA, disables verification, changes global trust or renews an operator-owned certificate.
CA replacement needs an explicitly planned trust change before its ten-year expiry, not a
silent replacement of certificates already pinned by native workloads.

Private issuance cannot make arbitrary user browsers trust a new root. Export only the public
certificate for the client or enterprise trust policy:

```sh
mise exec -- kubectl get secret factory-ingress-ca --namespace factory \
  -o jsonpath='{.data.ca\.crt}' | base64 --decode > factory-ca.pem
```

Verify that fingerprint through the installation administrator before trusting it. Never export
`ca.key` to a browser, Project, runtime image or test artifact. Clients that cannot accept a
private root need an already trusted enterprise certificate through `ingress.tlsSecret`.
That option also retains the operator's `factory-ca.pem` in the native configuration Secret.
It creates no built-in issuer or renewal Job. Offline GitOps renderers must use that explicit
certificate path, just as they must provide the other retained Secrets instead of regenerating
identities on every render.

Reachable DNS and an HTTPS Ingress listener remain cluster prerequisites. Factory does not
modify the host's resolver or install a cluster-specific controller. The same issuer runs on
Linux arm64 and amd64, whether the cluster is local or remote.

## Install

Create the trusted control-plane Namespace and opt it into Substrate's official API
NetworkPolicy. Without this label, the native API drops connections even when the
ServiceAccount and TLS configuration are correct:

```sh
mise exec -- kubectl create namespace factory
mise exec -- kubectl label namespace factory ate.dev/api-access=true
```

For an existing, intentionally selected Namespace, apply the label there instead of
creating it again. Do not label Project execution or editor namespaces. This grants
network reachability, not native authority; the separate Owner/Editor credentials
and verified serving TLS are still required.

Configure the operator's Ingress controller to route HTTPS, not just load a certificate.
With Traefik, enable [TLS on the HTTPS entrypoint](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/),
or supply its TLS router annotations through `ingress.annotations`. A certificate Secret
alone does not enable that router. A single-node controller that binds host port 443 also
needs a rollout strategy that can release the existing port.

Create two operator-owned Secrets in the release Namespace:

- `substrate.workspaceConfigurationSecret`, with `configuration.json`. Add `factory-ca.pem` only
  when the operator owns HTTPS rather than using the built-in issuer.
- `substrate.provisionerTokenSecret`, with the separately rotated native Owner `token`.

The JSON is installation-wide and names no Project or setup draft. Use `deployment: fresh-workspaces`
and the exact Factory database name, normally `factory`. Its `editorPrincipal` must be
`user:system:serviceaccount:NAMESPACE:SERVICEACCOUNT`, with the ServiceAccount name generated by this
chart. Connections normally use `/usr/local/bin/factory-substrate-control`, serving name
`api.ate-system.svc`, CA/token files under `/run/factory/substrate-control`, the Owner token at
`/run/factory/substrate-provisioner/token`, and Factory trust at
`/run/factory/substrate-configuration/factory-ca.pem`.

Use the actually observed native runtime version and architecture, the exact pinned profile, an immutable
`workloadImage`, WSS `connectorURL`, selected WorkerPool labels and intended TLS egress hosts.
Choose finite Actor limits for the Project recipe and native pool budget. The old small smoke
limits did not qualify the shipped Starter. See
[the configuration and image contract](../../substrate/README.md#fresh-factory-workspace-provisioning).

```yaml
image: registry.example/factory@sha256:YOUR_APPLICATION_DIGEST
publicURL: https://factory.example.com
forgejoPublicURL: https://git.example.com
substrate:
  workspaceConfigurationSecret: factory-native-configuration
  provisionerTokenSecret: factory-native-provisioner
stateSize: 8Gi
storageClass: YOUR_DYNAMIC_RWO_CLASS
ingress:
  enabled: true
  className: your-existing-ingress-class
```

```sh
mise exec -- helm install factory ./deploy/helm/factory --namespace factory --create-namespace \
  --values /path/to/private-values.yaml --wait=legacy --timeout 20m
mise exec -- helm test factory --namespace factory
```

Both native Secrets are required at render time. There is no worker-image tuple or execution
reserve setting. The normal startup validates the native path, database, supported runtime architecture,
exact Editor principal and admitted Forge TLS origin before modifying installation resources.
Factory state also holds independently served Source trees while compute is paused; size it for
those trees and back it up with the private object store. Native ROOTFS and private Docker data
remain Substrate's responsibility, not a new Factory lifecycle engine.

Ticket implementation admits repository URLs on either the configured public Forgejo origin or
the installation's private API origin. Both identities stay fixed for that control-plane lifetime.
The Project must still name the configured Forge owner and one repository. Other hosts, ports,
URL credentials, query strings, fragments and nested repository paths are refused before branch
operations. Native Git continues to use the admitted public TLS destination.

`helm test` is read-only. It observes the exact SandboxConfig, original WorkerPool, suitable Ready
worker of the selected architecture, selected StorageClass and the release Namespace's
native API admission label. It creates no Actor, namespace, privileged probe or claim,
and receives no provisioner credential. A pass does not prove synchronized assets, an actual Actor
assignment, TLS/egress enforcement, Starter startup, Verification or Delivery. Run the explicit
native live lanes for those gates; controller fixtures are not their substitute.
The dedicated preflight ServiceAccount and read-only RBAC are normal release
resources, retained for the test Job and removed with the release. Only the Job
is a test hook. Marking those identities as successful disposable hooks would
revoke the Job's access before it runs. A successful Job is cleaned up; a failed
Job remains available for diagnosis.
The Job explicitly selects its projected ServiceAccount through `--service-account`.
It writes a private temporary kubeconfig referencing the rotating token and API CA files,
then removes that configuration when the check exits. It neither relies on kubectl's
localhost fallback nor overwrites an operator's kubeconfig. Standalone preflight calls
without that switch retain the operator's selected kubeconfig and context.

Model credentials are configured in Factory Settings and encrypted through OpenBao, not Helm values.
Add a custom model provider's HTTPS origin to `modelAllowedOrigins` before saving that connection.
Actor model, browser-MCP and personal Git callbacks use the HTTPS origin of their original
Substrate Connector binding. They do not use the chart's private `FACTORY_INTERNAL_URL`
backchannel or a loopback browser address.
The chart supplies PostgreSQL, Forgejo, Zero, OpenBao and a private Garage bucket for retained Source
chunks, attachments, QA recordings and stills. Public readiness includes an authenticated object
write/read. The store is not high availability. Project Git mirrors are optional HTTPS code copies,
not a backup of the installation's database, Source, objects or secrets.

MCP token verification fetches Factory's public signing keys through the same configured
backchannel used by Forgejo. It still verifies the public issuer, exact MCP audience, signature,
expiry, session and current consent. The NetworkPolicy admits this connection only from the same
release's Factory Pods. Private browser certificates need no global TLS-validation exception.

An OpenBao restart seals its retained store. Its Pod probe accepts that state so the existing
Factory bootstrap can reach and unseal it; Pod readiness alone does not prove that secret reads
or saves work. If only OpenBao restarts, an operator must unseal the original store, or run the
normal controlled Factory restart when idle so bootstrap uses its retained key. Do not initialize
the store again, replace its claim or mint a root token to clear this condition.

## Local development acceptance

The image also packages the pinned native Substrate gRPC bridge and Source service. Fresh
Workspace provisioning is installation-scoped and applies to all Projects. The chart requires
native configuration, not Factorybox workers. The source launcher and the fresh Helm product
qualification are separate checks.
See [the concrete Substrate configuration](../../substrate/README.md#fresh-factory-workspace-provisioning)
for the separate native Owner/Editor credentials, required rotation, immutable
profile/image bindings, same-node sleeping Source handoff and remaining qualification limits.

During rapid development, build the application image with the maintained image command and make
it available to the selected cluster. No public chart publication is necessary:

```sh
mise exec -- bun run factory:image
```

The image embeds the currently available, exact runtime role references. This build needs the
existing source-development artifact publication; the installed Factory never invokes that
publication or builds runtime tools. An image loaded into one host Docker daemon is not
automatically available to every Kubernetes distribution.

The source launcher also requires `FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION` before startup.
Native Git requires real Forge DNS/TLS and the configured native WSS endpoint, even when the
browser uses a loopback listener. The source launcher is not covered by the Helm qualification.
There is no one-image HTTP-worker installation or legacy runtime fallback.

For local acceptance, use the built-in issuer with stable, operator-managed
local DNS names. Do not depend on a public wildcard DNS service or encode a disposable container
IP in the installation origins. DNS must resolve from the Mac, the cluster and native workloads;
a Mac-only hosts entry or a loopback name is insufficient for Actor callbacks and Git.

The following is an optional operator-owned certificate setup for existing local fixtures, not a
Factory installation prerequisite. Generate an Ingress leaf with an existing trusted development CA:

```sh
mkdir -p .factory/local-tls
(umask 077; mise exec -- mkcert \
  -cert-file .factory/local-tls/ingress.pem -key-file .factory/local-tls/ingress-key.pem \
  factory.acceptance.local '*.runtime.factory.acceptance.local' git.acceptance.local)
```

These are example DNS names, not an automatic resolver configuration. Supply the public
`rootCA.pem` from `mise exec -- mkcert -CAROOT` as the Factory CA bundle and retain normal
hostname verification. Never copy `rootCA-key.pem` into the cluster, images or evidence.
On OrbStack, assign the names and wildcard to the fresh Ingress-hosting container through its
[`dev.orbstack.domains` label](https://docs.orbstack.dev/docker/domains#custom-domains).
OrbStack documents ports 443/8443 and `dev.orbstack.https-port` for
[serving your own certificate](https://docs.orbstack.dev/features/https#redirect-port-443).
Verify the actual peer certificate rather than assuming that a listener or label selected
that route. A local-domain request can still terminate at OrbStack's automatic certificate proxy.
Configure cluster DNS for the same local zone, including Runtime subdomains, to resolve directly
to the private Ingress listener. The owned Kind fixture can use a
[CoreDNS template](https://coredns.io/plugins/template/) scoped to that zone.

Qualify both client routes with hostname verification and their intended CA. If the Mac route
deliberately uses OrbStack's existing TLS proxy, give the Mac acceptance client its existing
public OrbStack root certificate. Keep the mkcert bundle for the cluster's direct Ingress route
and native workloads. Record the two TLS termination paths explicitly; do not claim that they
serve the same certificate. This requires neither global trust changes nor a CA private key.
The maintained clean-room command uses the native fixture's CA for its public readiness check.
It does not qualify a separate Mac CA; use the documented Helm operator path and separate
route checks for that topology.

Inspect the peer issuer or fingerprint and use a client with an explicit, isolated CA bundle.
A macOS `curl --cacert` success can also reflect a certificate trusted by the system keychain,
so it alone does not prove that the peer chains to the supplied mkcert root. Never disable
verification or add an unrelated CA to make a failed route pass.
Configure DNS and qualify HTTPS before creating the installation. Existing Workspace bindings
retain their original origins; replacing a test hostname requires a separate fresh installation,
not rewriting retained native identities.

For local browser transport, combine the small local preset with private values supplying the
required native Secret names and public TLS origins:

```sh
mise exec -- helm install factory ./deploy/helm/factory --namespace factory --create-namespace \
  --values ./deploy/helm/factory/values.local.yaml \
  --values /path/to/private-native-values.yaml \
  --set-string image=your-cluster-reachable-development-image \
  --wait=legacy --timeout 20m
mise exec -- bun run factory:connect
```

Open the Factory address printed by `factory:connect`, normally `http://127.0.0.1:58000`.
Keep that one command running. It discovers the Factory and planning browser addresses from the
selected installation and manages their two loopback Kubernetes port forwards. Forgejo keeps its
configured public HTTPS origin and operator-owned TLS route; the command does not forward it,
change DNS or substitute a local HTTP address. A forwarding process exiting,
including after Pod replacement, reconnects to the same installation automatically. It does not
restart services, modify Kubernetes resources, change public identities or repeat model work.
Small unauthenticated HTTP transport probes also detect idle forwards left attached to a dead Pod,
without waiting for a real browser request to fail. They inspect neither model work nor Project
history. An HTTP error from a bootstrapping application is still live transport, not a reason to
restart a connection.
Ctrl+C closes only connections owned by this invocation; the installation keeps running.
An occupied port fails with an explanation instead of stopping another process or choosing a
different origin. If you need different ports, choose them in a private values file before the
initial installation. Preserve that file and the origins for later upgrades.

For an existing native local installation, no upgrade or address change is needed. Select it
explicitly when its namespace, release or Kubernetes context differs from the defaults:

```sh
mise exec -- bun run factory:connect --namespace my-factory --release my-release --context my-cluster
```

The command pins the selected context and ConfigMap identity while it runs. Reconnection refuses
another installation or changed browser addresses under the same name. It reads no installation
Secrets and never exposes PostgreSQL, OpenBao or a non-loopback listener.
Use a Chromium-based browser for this local preset. Its ordinary loopback hostname resolution
supports the isolated `*.runtime.localhost` editor and App addresses without resolver flags,
an external DNS service or changes to the Mac's hosts file. Other browser engines need their own
acceptance before being claimed as supported for local wildcard access.

`developmentZeroURL` uses a separate port on exactly the same loopback hostname as `publicURL`,
so browser cookies still accompany planning traffic.
Ordinary Ingress installations do not set this value or need a third browser hostname.
The command confirms HTTP transport rather than just an open socket. That is not proof that an
application or its bootstrap is healthy. An Ingress installation does not need the local command.

The local HTTP exception is restricted to loopback browser transport. Factory's data-service
traffic uses Kubernetes Services. Actor callbacks use the pinned public WSS/HTTPS origin and
admitted TLS egress, never that loopback listener, the Mac's host alias or a selected VM address.
Forwarding and DNS checks do not qualify native Actor startup or a complete Project journey.

## Backups and restore

`backup.enabled` (default true) renders one CronJob, `<release>-backup`, a dedicated retained claim
(`backup.size`, default 40Gi) held by a one-container StatefulSet `<release>-backup-store` so
WaitForFirstConsumer storage binds it, and a ServiceAccount. It runs on `backup.schedule` (default
`17 2 * * *`). The CronJob's `Forbid` policy prevents overlapping scheduled Jobs. Manual Jobs
created with `kubectl create job <job-name> --from=cronjob/<release>-backup` also pass through a
nonblocking filesystem lock at `/backup/.lock`. If another backup holds it, the new Job fails
before changing `.current`, any set or the object mirror. Inspect that Job's logs. Start another
deliberately after the active backup finishes. Do not remove the lock file.

One runner holds the lock through every step, completion, pruning and offsite copy. Its local
child processes inherit the lock descriptor, so killing the runner cannot admit another backup
while a surviving child still writes. Termination signals reach the current step's process group.
The lock releases when its last inherited descriptor closes; no stale-lock cleanup is needed.
Each `kubectl exec` call logs its phase, start and exit status. `backup.execTimeoutSeconds`
(default 1800, a positive whole number) bounds one exec attempt, including connection, command,
archive transfer and remote exit-status completion. This is a wall-clock limit, not an idle limit.
Size it above the longest expected dump or validation on a large installation. The existing
six-hour deadline still bounds the whole Job, including retries, other steps and offsite copy.
An expired call reports an unknown remote outcome, kills its owned local client and descendants,
and fails that attempt. Existing retries still run, and exhausted retries leave the step failed
while later steps run. Neither a timeout nor apparently complete archive bytes permit `COMPLETE`
or upload. `kubectl --request-timeout` alone does not bound an upgraded exec stream.
Disconnecting a client cannot confirm that its remote command stopped; inspect the named phase
and data-service Pod when diagnosing a timeout.
`mise exec -- bun run test:native backup-runner.native` checks binary stdin and inherited lock
access in the pinned Linux runner image without a cluster. It does not qualify a backup or restore.
One Pod takes every part in this order, so the object mirror always contains the objects the
database dump refers to:

| Step | Tool | Result in `<timestamp>/` |
| --- | --- | --- |
| PostgreSQL | `pg_dump --format=custom` through exec in the existing pinned PostgreSQL Pod, checked there with `pg_restore --list` | `postgres.dump` |
| Forgejo | SQLite Online Backup plus `forgejo dump` through bounded `kubectl exec`, streamed back and checked | `forgejo.tar.gz` (`forgejo.sqlite3`, portable SQL, repositories, attachments, configuration) |
| Objects | `rclone sync` of the Garage bucket | one mirror at `objects/`; replaced or deleted objects move to `objects-changed/<timestamp>/` |
| OpenBao | `bao operator raft snapshot save`, logged in as the `factory-backup` AppRole | `openbao.snap` |
| State | `tar` of the Factory state claim, mounted read-only | `state.tar.gz` (unseal key, AppRole login, installation identity) |

A failed step leaves `<step>.failed` and does not stop the others. The final step writes
`COMPLETE`, prunes and uploads only when every step succeeded, and otherwise fails the Job so the
failure shows in `kubectl get jobs`. `backup.retention` (default 7) keeps that many complete sets.
Incomplete sets are removed when a later run completes. Every network call retries, because a new
Pod can be refused by NetworkPolicy for a few seconds. The release's ingress rules admit Pods
labelled `app.kubernetes.io/component=backup` to PostgreSQL, OpenBao and Garage, not the application
services. Backup Pods have no egress restriction in this chart; they also need the Kubernetes API
and, when configured, an offsite destination.

Init containers stage static `kubectl`, SQLite and `bao` binaries from the existing Factory and OpenBao
images into a tools volume; they do not mount backup data, object-store keys or OpenBao credentials.
The rclone runner alone writes backup data. It mounts the tools, state, OpenBao TLS/login and
optional remote configuration read-only. Its namespace-scoped Role permits exec only into the exact
`<release>-postgres-0` and `<release>-forgejo-0` Pods. Database credentials remain in PostgreSQL.
Every remote Forgejo dump attempt uses its own temporary directory named with the backup Pod UID.
The runner sends the packaged, architecture-matched static SQLite CLI over that same bounded exec
stream. It installs no package or additional service. SQLite's Online Backup API captures the live
WAL database, including Forgejo's original migration records. The completed snapshot is finalized
in standalone DELETE-journal mode and checked for integrity and foreign-key violations.
Factory and Forgejo must use the same control-plane CPU architecture for this staged tool.
Mixed-architecture control-plane scheduling is not qualified; separately selected Actor workers
retain their native profile.
The pinned Forgejo SQL exporter omits its own migration tables, so `forgejo-db.sql` is not an
authoritative recovery source. The raw live database copied into the archive is not used either.
Sets without the authoritative snapshot are refused; restore does not invent missing migration
history or fall back to the old SQL path.
The attempt's temporary space must hold the standalone snapshot and uncompressed Forgejo archive.
A dump left running after an exec disconnect cannot collide with a later Job or retry.
The remote shell removes its directory on normal exit or a handled signal. A forced kill can leave
it for operator inspection.

The explicit native tool check uses the built static CLI, not a workstation SQLite installation:

```sh
FACTORY_BACKUP_SQLITE_FILE=/absolute/path/to/built/factory-sqlite \
  mise exec -- bun run test:native backup-runner.native
```

Without that input the WAL/snapshot case is skipped, not qualified. The separate binary-input and
writer-lock check still runs. This component check does not replace an actual complete backup and
restore.

Limits to know before relying on this:

- **OpenBao is backed up with a login Factory creates.** At bootstrap Factory creates the
  `factory-backup` AppRole, whose policy allows only `read` on `sys/storage/raft/snapshot` and
  `update` on `auth/token/renew-self`, and writes its `role-id` and `secret-id` to the Secret
  `<release>-backup-openbao`. The Job logs in with it on every run, so no token expires. To use your
  own credential instead, put a token in a Secret under the key `token` and set
  `backup.openbao.tokenSecret`; each run renews it. Without either, the Job still succeeds but
  writes `openbao.skipped`, warns, and the set holds no OpenBao data. An installation created before
  this identity existed is not supported by this Greenfield installation path.
- **Backups hold everything needed to decrypt OpenBao.** `state.tar.gz` contains the unseal key.
  Treat the backup claim and any remote as sensitive as the cluster's Secrets and encrypt them.
  An rclone `crypt` remote does that for the optional copy.
- **Secrets are not in the sets.** Back up the credentials, object-store and OpenBao TLS Secrets
  yourself, for example `kubectl get secret <release>-credentials <release>-objects
  <release>-openbao-tls -o yaml`, or keep them in your own secret manager and set
  `existingSecrets.*`.
  Built-in HTTPS retains a recovery copy in `state.tar.gz` at `ingress-tls/identity.json`.
  Restore its original `<release>-ingress-ca` and `<release>-ingress-tls` Secret data and ownership
  before Helm or Factory starts. An expired saved leaf is renewed by the issuer init container
  under the same root. Do not invent another CA: that would invalidate retained workload trust.
- **The Pod runs on Factory's node** because the state claim is ReadWriteOnce. If Factory is down
  the Job waits until it returns or hits its six-hour deadline.
- **The Forgejo archive is taken from a running server.** The database part is a consistent SQL
  dump; repositories are copied while Forgejo runs. A push during the dump can leave a repository
  slightly newer than the database.
- **Orphaned rows are backed up and flagged.** A bulk delete with triggers disabled can leave rows
  whose parent row is gone. `pg_dump` writes them and `pg_restore` then cannot recreate their
  foreign keys. The Job keeps the set, warns, and lists the constraints with their row counts in
  `postgres.orphans`.
- The claim is a copy in the same cluster. Use `backup.remote` for protection against losing it.

To copy sets off the cluster, create a Secret with an `rclone.conf` key that defines one remote
(S3-compatible or Azure Blob, for example `[offsite]` with `type = azureblob`), then set
`backup.remote.existingSecret` and `backup.remote.path` (`offsite:container/factory`). The upload
uses `rclone copy`, so deletion is the remote's lifecycle rule. The image is
`docker.io/rclone/rclone`, pinned by digest in `upstream.json`.

### OpenBao identities

Factory logs in to OpenBao as the `factory-environments` AppRole and revokes the root token at the
end of its first bootstrap. Three more things are created in the same step, and their logins stay in
the Factory state claim next to the unseal key:

| AppRole | Policy | Token |
| --- | --- | --- |
| `factory-backup` | `read` snapshots, `update` `auth/token/renew-self` | 2 hours, used by the backup Job |
| `factory-admin` | write the `factory-environments` and `factory-backup` policies and AppRoles, plus a login for `factory-backup`. It cannot touch mounts, the seal, snapshots or its own policy | 15 minutes, used only on upgrade |

When an upgrade changes either policy, Factory starts, notices the stored policy version differs and
logs in as `factory-admin` to rewrite them. Nothing needs the root token and nothing needs an
operator. `factory-admin` is not a boundary against a compromised Factory, which already holds the
unseal key and can rewrite the policies it manages. It keeps routine upgrades away from root.

The native Greenfield bootstrap creates these identities initially. This guide does not offer an
adoption programme for an installation that predates them. Preserve real backup data and credentials;
never enable an extra unauthenticated root-token listener to rescue a disposable failed fixture.

### Reach the files

The claims are not exposed. Mount them in a throwaway Pod that you delete afterwards. It runs as
root so extracted files keep their owners. Use the rclone image the backup Job already pulled
(BusyBox `sh`, `tar` and `gzip`, plus `rclone`). Read its reference with
`kubectl get statefulset <release>-backup-store -o jsonpath='{.spec.template.spec.containers[0].image}'`.
The Pod mounts every claim a restore replaces, so apply it only while Forgejo, OpenBao and Zero are
scaled to zero. Its labels let it through the NetworkPolicy to Garage, the same way the backup Job
gets through.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: restore-toolbox
  namespace: factory
  labels: {app.kubernetes.io/instance: factory, app.kubernetes.io/component: backup}
spec:
  restartPolicy: Never
  containers:
    - name: tools
      image: RCLONE_IMAGE
      command: [sleep, "7200"]
      env:
        - {name: HOME, value: /tmp}
        - {name: RCLONE_CONFIG_S3_TYPE, value: s3}
        - {name: RCLONE_CONFIG_S3_PROVIDER, value: Other}
        - {name: RCLONE_CONFIG_S3_ENDPOINT, value: "http://factory-objects.factory.svc:3900"}
        - {name: RCLONE_CONFIG_S3_REGION, value: garage}
        - {name: RCLONE_CONFIG_S3_FORCE_PATH_STYLE, value: "true"}
        - name: RCLONE_CONFIG_S3_ACCESS_KEY_ID
          valueFrom: {secretKeyRef: {name: factory-objects, key: access-key-id}}
        - name: RCLONE_CONFIG_S3_SECRET_ACCESS_KEY
          valueFrom: {secretKeyRef: {name: factory-objects, key: secret-access-key}}
      volumeMounts:
        - {name: backup, mountPath: /backup, readOnly: true}
        - {name: forgejo-data, mountPath: /var/lib/gitea}
        - {name: forgejo-config, mountPath: /etc/gitea}
        - {name: openbao-data, mountPath: /bao/data}
        - {name: zero-data, mountPath: /zero}
        - {name: state, mountPath: /var/lib/factory}
  volumes:
    - {name: backup, persistentVolumeClaim: {claimName: store-factory-backup-store-0, readOnly: true}}
    - {name: forgejo-data, persistentVolumeClaim: {claimName: data-factory-forgejo-0}}
    - {name: forgejo-config, persistentVolumeClaim: {claimName: config-factory-forgejo-0}}
    - {name: openbao-data, persistentVolumeClaim: {claimName: data-factory-openbao-0}}
    - {name: zero-data, persistentVolumeClaim: {claimName: data-factory-zero-0}}
    - {name: state, persistentVolumeClaim: {claimName: factory-state}}
```

### Check a backup

`scripts/kubernetes/restore-check.ts` reads one set, or a single `postgres.dump`, and runs
`pg_restore --list`, `tar -tzf` and the marker checks. It writes nothing. It needs a `pg_restore`
of major version 16; set `PG_RESTORE` to a wrapper around
`docker run --rm -i postgres:16.14-bookworm pg_restore "$@"` if you have none.

```sh
kubectl --namespace factory cp restore-toolbox:/backup/20261104T021700Z ./set
mise exec -- bun scripts/kubernetes/restore-check.ts ./set
```

A pass proves the dump and both archives are readable and the snapshot has a gzip header, a
plausible size, `meta.json`, `state.bin` and `SHA256SUMS`, with both files matching their sums. It
does not prove a restore. Native restore qualification remains separate.

The checker handles SIGINT and SIGTERM by stopping and joining its own validation clients.
An interrupted check exits unsuccessfully, including when a client exits zero while handling
its termination signal. An external `PG_RESTORE` wrapper must manage any daemon-owned resources
it creates; the checker does not discover or delete arbitrary wrapper containers.

### Native restore qualification

The Factorybox `restore:rehearsal`, `release:upgrade-test` and `release:soak` programmes and their
commands have been removed. Their identity rewrites, old database queries and Kubernetes-only
write jail cannot qualify Substrate. No command adopts a Factorybox installation or rewrites
restored native identities into a new installation.
Do not run a restored control plane with live native Owner/Editor credentials before independently
verifying its immutable bindings and Source/Writer safeguards. A native-safe independent rehearsal
and complete restore proof remain unqualified. The read-only backup archive checker above remains
available.

Factory backups contain product intent and independently retained Source/objects. They do not
include the separate official Substrate control-plane database or its native ROOTFS snapshot
store. Back up those upstream-owned resources through Substrate's own supported operations, with
matching immutable Actor/snapshot identities. No Factory memory-restore or compatibility layer is
provided.

### Restore

Restoring replaces data. Do it into a new installation, or keep a copy of what is there. Do not
delete a retained claim to start clean; where a step empties a claim, that claim belongs to a
new installation and holds nothing yet.

1. Install the chart with the same release name, Namespace, origins and storage class, using the
   Secrets you backed up (`existingSecrets.*`). Factory refuses a changed installation identity, and
   the database records in-cluster addresses that contain the Namespace. Scale Factory and Zero to
   zero before they run, then Forgejo and OpenBao. Leave PostgreSQL and Garage running. A Factory
   that starts first creates its own OpenBao and Forgejo tokens, which steps 3 and 4 replace.
2. PostgreSQL. Recreate the database and restore the dump over standard input:

   ```sh
   kubectl exec <release>-postgres-0 -- psql -U factory -d postgres \
     -c 'DROP DATABASE factory WITH (FORCE)' -c 'CREATE DATABASE factory OWNER factory'
   kubectl exec -i <release>-postgres-0 -- pg_restore --no-owner -U factory -d factory < postgres.dump
   ```

   `pg_restore` must exit 0. A foreign key error means the source database held orphaned rows.
3. Files. Use the authoritative `forgejo.sqlite3` Online Backup snapshot. Do not execute the
   portable SQL dump or use the archive's raw live `data/data/forgejo.db` copy. Start the toolbox
   from the previous section, then:

   ```sh
   kubectl exec restore-toolbox -- sh -ec '
     S=/backup/<timestamp>
     find /var/lib/gitea /etc/gitea /zero /bao/data /var/lib/factory -mindepth 1 -delete
     tar -xzf $S/forgejo.tar.gz -C /var/lib/gitea --strip-components=1 \
       --exclude "repos*" --exclude app.ini --exclude forgejo-db.sql --exclude forgejo.sqlite3 --exclude "data/data/forgejo.db*"
     mkdir -p /var/lib/gitea/git/repositories
     tar -xzf $S/forgejo.tar.gz -C /var/lib/gitea/git/repositories --strip-components=1 \
       --exclude "data*" --exclude app.ini --exclude forgejo-db.sql --exclude forgejo.sqlite3
     tar -xzf $S/forgejo.tar.gz -C /etc/gitea app.ini
     tar -xzf $S/state.tar.gz -C /var/lib/factory
     mkdir -p /var/lib/gitea/data
     tar -xzOf $S/forgejo.tar.gz forgejo.sqlite3 > /var/lib/gitea/data/forgejo.db
     chmod 600 /var/lib/gitea/data/forgejo.db
     rclone sync /backup/objects s3:factory --create-empty-src-dirs'
   kubectl exec restore-toolbox -- chown -R 1000:1000 /var/lib/gitea /etc/gitea
   ```

   The `find` empties the claims of a new installation: Forgejo's data and configuration, Zero's
   replica (it rebuilds from the restored database), OpenBao's data and the Factory state. BusyBox
   `tar` cannot select a directory and matches `--exclude` against the whole member name, so each
   extraction excludes the other parts of the archive. `app.ini` holds the secret key that encrypts
   stored credentials, so the original must come back. `state.tar.gz` is extracted as root so tar
   restores the original owners (uid 1000). Earlier versions of replaced objects are in
   `objects-changed/<timestamp>/`.
4. OpenBao. Its snapshot only restores onto the key it was taken with. Read the original key first:
   `kubectl exec restore-toolbox -- tar -xzOf /backup/<timestamp>/state.tar.gz ./openbao/bootstrap.json`
   holds it as `keys_base64`. Then delete the toolbox, scale OpenBao to one and copy the snapshot in.
   OpenBao starts uninitialized and its readiness probe stays failing until the original TLS Secret is
   in place; exec still works.

   ```sh
   kubectl delete pod restore-toolbox
   kubectl scale statefulset <release>-openbao --replicas=1
   kubectl exec -i <release>-openbao-0 -c openbao -- sh -c 'cat > /tmp/openbao.snap' < openbao.snap
   kubectl exec <release>-openbao-0 -c openbao -- sh -c '
     export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt
     bao operator init -key-shares=1 -key-threshold=1 -format=json'
   ```

   Read `unseal_keys_b64[0]` and `root_token` from that output. Unseal with that temporary key
   (`bao operator unseal <key>`; the CLI refuses piped input), then restore with
   `BAO_TOKEN=<root_token> bao operator raft snapshot restore -force /tmp/openbao.snap`. OpenBao
   reseals and the temporary key and root token stop working. Unseal it with the original key, then
   `rm /tmp/openbao.snap`. Without `openbao.snap`, Factory cannot decrypt the secrets it stored. The
   restored state claim gives Factory the matching AppRole logins, so it signs in to the restored
   OpenBao on start.
5. Scale Forgejo, Zero and Factory to one and wait for readiness. Startup requires the exact native baseline fingerprint
   recorded by this image. Historical or mismatched schemas are refused without modification.
   Use the matching image and data, not a historical forward-migration sequence.

These data-service restore steps do not qualify restoration of native Actors, snapshots or a
complete Factory product journey. Keep native credentials withheld until an independent native-safe
rehearsal proves all relevant identities and Source/Writer safeguards.

#### Isolated restore rehearsal

`scripts/kubernetes/restore-rehearsal.ts` is an explicit **data-service acceptance lane**, not an
installation recovery command. It restores all five backup components into disposable Docker
volumes. It never starts Factory, Zero, a Forgejo server, a Connector or Substrate. There is no
activation option, native credential input, identity rewrite or data-repair SQL.

The operator supplies private inputs and independent witnesses. Do not generate expected values
from the destination being tested. Missing witnesses stop preparation; they are not permission
failures and must not be replaced with invented values. Observations must describe the selected
backup's consistent data, not a later installation state. An independently observed source snapshot
can supply those values. If that observation was not retained, record the missing proof rather
than treating a second restore of the same dump as an independent product witness.

Prepare a canonical, owned directory with mode `0700`. Every input file must be owned, regular,
mode `0600`, and have no symlink ancestor or hard links. Mirror directories also use `0700`.
Do not place native provisioner credentials in this directory.

```text
PRIVATE_ROOT/
  fixture.json
  witnesses.json
  20261117T100209Z/
    COMPLETE
    postgres.dump
    forgejo.tar.gz
    state.tar.gz
    openbao.snap
  objects/                       complete objects mirror for this set
  tls/{ca.crt,tls.crt,tls.key}     original OpenBao TLS Secret, supplied privately
```

Other backup markers may remain beside the four parts. `.part`, `.skipped` and `.failed` files
refuse a full rehearsal. The tool does not read an original cluster, download objects, assemble
Secrets or extract anything on the host. A mirror from a later backup is not automatically a mirror
for this set; resolve its matching object versions privately before running.

`Fixture` and `Witnesses` in the script are the input schema. JSON objects reject unexpected keys
where they carry configuration. The top-level `fixture.json` fields are:

| Field | Required value |
| --- | --- |
| `schema`, `owner` | `1`, and a fresh 32-character lowercase hexadecimal owner, also supplied on the CLI |
| `source` | `chartRevision: "39d7969bb3acd93d0bc497a5748cce08ae435091"`, exact 40-character `applicationRevision`, original `namespace`, `namespaceUID`, `release`, HTTPS `factoryOrigin`, HTTPS `forgejoOrigin`, and `storageClass` |
| `set` | Explicit backup timestamp, such as `20261117T100209Z` |
| `privateRoot` | Absolute canonical path to the directory above; `fixture.json` must be its direct child |
| `evidenceDirectory` | New absolute directory, outside private inputs and every retained path; its parent must already exist and not be group/world writable |
| `docker` | Explicit local `host` as a `unix:///...` socket, observed `daemonID`, and `platform` as `linux/arm64` or `linux/amd64` |
| `retained` | Nonempty `paths` denylist and explicit `containers`, `networks` and `volumes` inventory denylists for the retained installation; observed empty Docker inventories are allowed |
| `images` | Exact copy of the script's exported `images` map, not tags substituted by the operator |
| `limits` | Positive per-container `memoryMiB`, `cpus`, `pids`, `tmpfsMiB`; integer `commandTimeoutSeconds`, `requiredDiskBytes` and independently observed `availableDiskBytes` |

Use the chart's exact PostgreSQL 16.14, Forgejo 17, Garage 2.3, OpenBao 2.7.1 and rclone 1.74.1
digests. The tools image is the existing pinned Node 24 image in `upstream.json`; its built-in
SQLite library validates the restored standalone snapshot without downloading packages. All images must already be loaded
for the selected platform. The tool uses `--pull never`, the explicit socket, and a private empty
Docker configuration scope, not the user's saved Docker contexts, logins or proxy environment.

At most three containers run together. Reserve at least `3 × memoryMiB` and `3 × cpus`, plus Docker
overhead, before running. Daemon totals are checked, not free CPU admission. Working disk must cover
expanded state and Forgejo, two copies of the object mirror, the copied dump/snapshot, PostgreSQL
expansion and restore overhead. `availableDiskBytes` is the operator's measured allowance;
`requiredDiskBytes` is also checked against free space on the fresh volumes. It is not a Docker
volume quota. Do not run this lane on a nearly full shared daemon.

`commandTimeoutSeconds` is an explicit maximum duration for **each** daemon command, restore,
validation or cleanup operation. Size it for the largest real part, sorting all row witnesses and
downloading every object for comparison. There is no implicit short backup deadline. Expiry is an
incomplete result, never successful stream completion. A lost or cancelled exec client triggers
cleanup of its exact owned container, including daemon-owned descendants. Ordinary PostgreSQL
restore errors still allow the independent later component checks after its container stops.

`witnesses.json` contains no plaintext secret values:

- `schema`, `owner`, `source` and `set` match the fixture exactly.
  `provenance` must be `"independent-source-observation"`.
- `parts` maps each of the four filenames to its compressed-byte SHA-256.
- `postgres` maps **every ordinary table in `auth` and `factory`**, including empty tables, to
  `{ "rows": integer, "sha256": "64 lowercase hex characters" }`. The script's `requiredTables`
  includes product history, native bindings, capacity installation, Source and Writer rows.
  `postgresWitnessProgram` defines the exact witness encoding. With PostgreSQL 16, UTC,
  `extra_float_digits=3` and hex bytea, hash the bytes produced by
  `COPY (SELECT row_to_json(t)::text AS row FROM SCHEMA.TABLE t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT`.
  Quote schema and table identifiers to preserve case, including authentication tables such as
  `"auth"."oauthClient"`.
  This includes PostgreSQL COPY text escaping and each trailing newline. Do not hash display output
  from a GUI. The target uses read-only SQL and the existing backup foreign-key checker as well as
  `pg_restore --exit-on-error --single-transaction --no-owner`; any FK recreation error fails.
- `forgejo` has `tables`, `files` and `repositories`. `tables` covers every non-`sqlite_%` SQLite
  table. Hash sorted JSON row arrays in SQLite column order, with one LF after each row.
  Encode integers as `{"integer":"decimal"}` and blobs as `{"hex":"lowercase hex"}`.
  `files` is the complete archive member inventory, including authoritative `forgejo.sqlite3`,
  portable `forgejo-db.sql`, original `app.ini`,
  attachments, repositories and the ignored raw SQLite copy. `repositories` lists every
  `repos/OWNER/REPOSITORY.git` root represented by an archived `HEAD`.
- `state` has complete archive `files`, exact `excludedProvisionerPaths`, and
  `credentialReview: "no-native-provisioner-material-in-included-files"`. The operator must classify
  credential-bearing files, including arbitrary filenames; filename checks alone cannot do that.
  Excluded files are hashed but never copied into destination state. Original
  `kubernetes-installation.json`, `openbao/bootstrap.json` and `openbao/factory-login.json` are
  mandatory. The original installation identity must match, without rebinding any historical row.
- `objects` is the complete mirror file inventory, including empty objects.
- `openbao` is a nonempty array of `{ "path": "factory/data/...", "sha256": "..." }` for real existing
  KV-v2 values readable by the original `factory-environments` AppRole. Hash `response.data.data`
  as compact JSON with recursively sorted object keys, unchanged array order and no trailing LF.
  Do not put secret values, root tokens, unseal keys or AppRole credentials in the witnesses.

Each `files` or `objects` entry is `{ "path": "relative/path", "bytes": integer, "sha256": "..." }`.
Paths use normalized archive-relative names without leading `./`. A confined relative symlink also
has `"link": "relative target"`, zero `bytes`, and the SHA-256 of its target text. Directories need
no inventory entry. The streaming verifier refuses traversal, duplicate files, unlisted files,
missing witnesses, bad checksums, truncation, escaping symlinks, hard links, sparse files, devices,
FIFOs and unknown tar extensions. USTAR, GNU long names and supported per-file PAX fields work.
Symlink chains are checked in filesystem resolution order, including forward references.
Escaping, cyclic or longer-than-40-link chains fail the archive scan rather than being extracted.
Unsupported retained file metadata or archive types require separate implementation and proof;
they are not silently dropped or counted as restored.

Inspect the no-daemon, no-write plan first, then deliberately execute it:

```sh
mise exec -- bun --no-env-file scripts/kubernetes/restore-rehearsal.ts \
  --plan --fixture "$PRIVATE_ROOT/fixture.json" --owner "$OWNER"
mise exec -- bun --no-env-file scripts/kubernetes/restore-rehearsal.ts \
  --run --fixture "$PRIVATE_ROOT/fixture.json" --owner "$OWNER"
```

Before any create, the lane checks private paths, compressed part hashes, required witnesses,
pins, retained-resource non-overlap, daemon identity, image availability and fresh resource names.
It journals each create intent before the daemon call. The archive scan then verifies all raw file
hashes before extraction into owned volumes. PostgreSQL, OpenBao and their validation clients use
no network, with the OpenBao client sharing only that server's loopback namespace. Garage and
rclone alone join a new `--internal` network, with no published ports or external DNS forwarding.
Containers have no host sockets, application authority or inherited environment. Logs are disabled.

The actual restore operations are the normal ones:

1. Rebuild PostgreSQL in a fresh cluster. Verify the complete table inventory, row counts, full-row
   digests and FK integrity. Historical namespace, Actor, pool, UID and Writer identities stay intact.
2. Extract Forgejo files and its witnessed standalone `forgejo.sqlite3` into fresh volumes.
   Ignore the raw live SQLite copy and never execute `forgejo-db.sql`. Open the authoritative
   snapshot read-only, run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, and compare
   every table and full-row witness, including original migration timestamps. The pinned Forgejo
   image runs only read-only Git configuration checks and
   `git fsck --full --strict` for every bare repository. The Git check refuses restored `fsck.*`
   configuration, including included configuration files, so repository-local policy cannot
   suppress integrity errors.
   Neither its server nor restored hooks or application code run.
3. Start empty Garage with fresh rehearsal-only credentials. Run `rclone copy` and
   `rclone check --download` against its internal bucket. Input object contents are independently
   hashed first. This proves bytes, not original S3 credentials, object metadata or version history.
4. Start empty OpenBao over the original verified loopback TLS certificate. Temporarily initialize
   and unseal through the same `sys/init` and `sys/unseal` APIs Factory uses. Run
   `bao operator raft snapshot restore -force`, then unseal with the original state key, authenticate
   with the original AppRole and compare the selected KV content digests. Sensitive requests and
   tokens remain inside owned volumes or container memory, never command arguments or evidence.
5. Check every retained state/Source file against its independent content witness, excluding only
   explicitly classified native provisioner credentials. No restored Source process is activated.

`result.json` and `ownership.json` remain outside raw-secret directories. Only five passing
components **and confirmed cleanup** produce `status: "data-services-passed"` and exit 0.
`nativeActivation` always remains `"not-run-not-qualified"`. SIGINT/SIGTERM clean up before returning
unsuccessfully. After SIGKILL or an unavailable daemon, retry exact-label cleanup explicitly:

```sh
mise exec -- bun --no-env-file scripts/kubernetes/restore-rehearsal.ts \
  --cleanup --fixture "$PRIVATE_ROOT/fixture.json" --owner "$OWNER"
```

Cleanup checks the original journal, owner/run/source labels, container/network IDs and volume
creation identity. It never prunes and refuses observed replacements. Docker's named-volume
deletion has no atomic UID precondition, so no other actor may mutate this fresh owner's resource
names during the run or cleanup. An unconfirmed cleanup keeps the receipt incomplete and the
journal available. Cleanup exit 0 alone is not a restore pass.

Use `--inspect` instead of `--plan` to revalidate the same private inputs after a rehearsal has
created its evidence directory. Inspection checks all witnesses and part hashes without Docker
calls, writes or a new restore. It does not validate the receipt as successful or permit rerunning
`--run` into existing evidence. The application-target preparation checks the successful receipt
separately.

Unit mocks, local synthetic SQLite checks and archive tests do not qualify native restoration.
The operator must run this lane on the actual private set and review all component receipts and
cleanup. Even that pass does not prove a running Factory, authenticated Forgejo behavior, all
OpenBao secrets, official Substrate control-plane/ROOTFS recovery, cross-node restoration,
Source/Writer admission, Editor access, Verification or Delivery. Those require separate explicit
native qualification with original identity safeguards and controlled external-effect authority.

##### Check an already restored application

`scripts/kubernetes/restore-application-check.ts` adds a separate, test-only application check.
It requires an **already restored and running**, exclusively owned Kubernetes target. It creates
no cluster resources, restores no data, repairs no rows and starts no Factory server. The
data-service lane above does not create this target or qualify application usability.

The target owner must first establish these prerequisites without resetting the retained
installation:

- Distinct explicit source/target contexts, API endpoints and `kube-system` Namespace UIDs.
  The original source Namespace and Ingress remain readable. Preserve the backed-up Namespace
  name, Helm release, public Factory/Forgejo HTTPS origins, storage class and installation file.
  The isolated target Namespace UID must differ from the original.
- The target runs the exact backed-up immutable Factory image and its independently recorded
  platform digest. All restored data services, original Factory credentials, state, Source
  materializations and matching objects must already be usable. Normal startup must finish.
  This helper does not disable startup recovery. Establish a quiescent backup before starting
  its application, not by cancelling or deleting historical work after startup.
- The standard chart's Factory/Forgejo/PostgreSQL Services route only to the supplied target
  Pod UIDs. The target Ingress has a literal IP address disjoint from the source Ingress
  addresses, original HTTPS host rules and a valid certificate for both original hostnames.
  No other Ingress may overlap them. No rewrites, mirrors, external authentication, snippets
  or unknown Ingress annotations are accepted. The narrow annotation allowlist permits only
  matching Helm release metadata, the matching ingress class and enabled NGINX TLS redirects.
- Apply the already-owned target's `factory.restore-application.owner: OWNER` label to its
  Namespace, Factory Deployment and Ingress. Its Deployment annotation
  `factory.restore-application.backup` must equal the SHA-256 of the successful data-service
  `result.json`. Supply the exact UIDs observed by the target owner. The probe never adds them.
- An owned restored email/password account has normal Project, Ticket and Source read/edit
  authority. Supply a restored Forge token authorized to read the selected repository.
  No bypass, password reset, new account or access grant is performed.
- The selected Source lease is already service-owned, writable and independently checkpointed.
  Its original Actor binding records confirmed deletion and its runtime attempt is stopped.
  Preserve the original materialization and object manifest. A Git file or ROOTFS snapshot is
  not a substitute for this Source witness. A backup with no initialized independent Source
  cannot satisfy this check.

Normal native startup prerequisites still apply. If the original upstream is separately
operated, its authenticated access and identity/trust checks must already work for this target.
Copied Kubernetes ServiceAccount tokens or a different issuer are not equivalent credentials.
This helper neither supplies native credentials nor rewrites historical identities. Do not copy
a CA private key. The only TLS input to the probe is a public CA bundle.

Prepare a separate owned `0700` directory. Every input must be an owned `0600` regular file,
with no symlink ancestor or hard links. Keep it outside the new evidence directory.

```text
PRIVATE_APP_ROOT/
  application.json
  kubeconfig.json
  ca.pem
  password
  forge-token
  backup-result.json
  image-build.json
  application-witnesses.json
```

`ApplicationFixture` and `ApplicationWitnesses` in the script define the exact JSON shapes.
Configuration objects reject extra keys. Required `application.json` inputs are:

| Field | Private input |
| --- | --- |
| `schema`, `owner`, `exclusiveTarget` | `1`, the data-service receipt's 32-character lowercase hexadecimal owner, and `true` |
| `privateRoot`, `evidenceDirectory` | Canonical absolute input root, and a fresh absolute evidence directory outside it; its existing parent must be owned and not group/world writable |
| `kubeconfig`, `ca`, `password`, `forgeToken` | Absolute paths beneath the input root |
| `account` | Original restored `id` UUID and `email` |
| `backup`, `build`, `witnesses` | Each has `file` and the exact file-byte `sha256`; all are private files beneath the input root |
| `source` | Explicit `context`, expected `kubeSystemUID`, and original `ingress: {name, uid}` |
| `target` | Explicit `context`, `kubeSystemUID`, literal ingress `address`, and `{name, uid}` for `namespace`, `deployment`, `applicationPod`, `postgresPod`, `forgejoPod`, `ingress`, `factoryService`, `postgresService`, `forgejoService`, `configuration` ConfigMap and `credentials` Secret |
| `credentialHashes` | Independently observed SHA-256 of the original decoded `auth-secret`, `admin-password`, `database-password`, `zero-password` and `webhook-secret` Secret bytes, bound to this backup |
| `save` | Fresh UUID `commandID` and deliberately authorized new `description`, at most 10,000 characters, different from the restored description |
| `limits` | Positive per-command/request `seconds`, at most 3600, and `responseBytes`, at most 16 MiB; choose bounds for the actual history inventory |

Use a self-contained JSON kubeconfig with embedded public `certificate-authority-data` and
embedded client credentials for both selected contexts. Export it privately through the normal
Kubernetes tooling. Credential plugins, auth providers, external file references, proxy settings,
insecure TLS and a shared API endpoint are refused. The source credential needs read-only access
to the observed Namespaces and Ingress. The target credential needs those reads plus Deployment,
Pod, ReplicaSet, Service, EndpointSlice, ConfigMap and Secret reads, cluster-wide Ingress listing
and `pods/exec` for the supplied Factory and PostgreSQL Pods. Exec runs only the helper's fixed
read-only SQL and compiled-build inspection, not caller-supplied commands.

`image-build.json` has `schema: 1`, `image` as the original immutable `@sha256:` reference,
`platformDigest` as 64 lowercase hexadecimal characters without the prefix, the backed-up
`applicationRevision`, `treeSHA256`, and `functions` mapping exactly `getProjects`,
`getTicketDetail` and `saveTicketDocument` to their actual compiled IDs. Retain this evidence
independently from that exact image/build, not guessed function names or another local build.
The tree hash covers every regular file under `/opt/factory/apps/factory/dist`: sort relative
paths and hash `path + NUL + SHA256(file bytes) + LF` for every file. Symlinks refuse inspection.
After matching that complete tree and the Pod image digest, the probe imports only its fixed
`server/entry.js` for the existing `factoryFunctions`/`compiledFunctionID` introspection. It
compares all three IDs before making any application request and never invokes those functions
inside the inspection process.
It also compares hashes of the inherited container credentials, original origins and database
route with the supplied Secret/configuration, so merely replacing a Secret after Pod startup
does not pass.

`application-witnesses.json` must come from an independent consistent source observation for the
selected backup. Set `schema: 1`, `provenance: "independent-source-observation"` and
`backupWitnessDigest` equal to the data-service receipt's `witnessDigest`. Supply:

- `schemaDigest` from the baseline migration, exact `project`/`ticket` projections, descending
  `documents`/`requirements` arrays and `requirementRevisionID` using the script's field names.
  The safe save supports either a null requirement with no revision, or a complete unchanged
  canonical requirement matching the existing scope on a Ticket already past Inbox/Backlog.
  Partial documents, new requirement revisions, cancelled Tickets and state transitions refuse
  preparation rather than being repaired.
- `history` for every exported `historyTables` entry plus `other_tickets`, `old_documents` and
  `protected_ticket`, each `{rows, sha256}`. `applicationSQL` defines the projections. On
  PostgreSQL 16 with UTC, `extra_float_digits=3` and hex bytea, aggregate `to_jsonb` rows sorted
  by `row::text COLLATE "C"`, then hash the UTF-8 bytes of the resulting JSONB array text,
  or `[]` for no rows, without a trailing LF. This is not the earlier COPY witness encoding.
- `source` with original `workspaceID`, `leaseSHA256` of the complete Source row's JSONB text,
  exact relative `path`, byte count and file-byte SHA-256. `git` separately specifies `owner`,
  `repository`, exact 40-character `commit` and `blob` IDs, relative `path`, byte count and
  file-byte SHA-256. Keep expected Source bytes independent of the Git witness.

The original Project repository URL may use the installation's public Forgejo origin or its exact
`http://<release>-forgejo.<namespace>.svc:3000` service origin, with or without `.git`. The check
preserves that saved URL. Independent Git reads still use verified public HTTPS and the witnessed
owner/repository; a different service, namespace, port or repository refuses preparation.

The read-only database preflight refuses pending or uncertain work through `idleRules`, including
inference, runtime creation, access/credential recovery, external operations and enabled
automation. Some unsupported historical cases are also refused conservatively, including
retained learning trials and Workspace submission intents. No other user or process may mutate
this target during the check. These observations are not a global concurrency fence.

Once the owner has supplied these prerequisites, run deliberately:

```sh
mise exec -- bun --no-env-file scripts/kubernetes/restore-application-check.ts \
  --run --fixture "$PRIVATE_APP_ROOT/application.json" --owner "$OWNER"
```

Every HTTP request connects to the literal target IP, with the original public Host header,
SNI and explicit certificate hostname verification. The probe does not resolve or edit machine DNS or
follow redirects. It rechecks target ownership, routes and critical configuration before each
request, including logout. Complete readiness must match the target Pod's startup marker.
It then logs in, reads the known Project/Ticket and their document/requirement histories, reads
the exact Forge file at the known commit, and reads the exact independent file through the normal
public Source API. It journals one `saveTicketDocument` intent without `proposalEntryId`, changes
only that Ticket's description, reads it back and compares protected history and Source again.
There are no inference, compute, Verification or Delivery requests.

`result.json` includes probe/input hashes, target identities and save/logout outcomes, without
raw credentials, content or command errors. It reports `restored-application-passed` only after
the scoped checks and confirmed logout/session removal. An uncertain save is never retried.
An interrupted run, changed owner or unconfirmed logout remains incomplete; the helper does not
delete resources or repair the result. A successful scoped receipt proves those application
reads and one new human save, not browser usability, old Actor recovery or new compute.
`oldActors` and `newCompute` always remain `"not-run-not-qualified"`.

## Maintenance and upgrades

Save human edits, finish or explicitly stop active work, then select the next built image:

```sh
helm upgrade factory ./deploy/helm/factory --namespace factory \
  --values /path/to/private-values.yaml --wait=legacy --timeout 20m
```

The pre-upgrade Job refuses active or unresolved Coding work, pending Knowledge generation and
active model/setup probes. It commits a maintenance fence under the same database lock used by
new inference admissions. A concurrent request therefore cannot slip into the idle-check window.
A busy installation refuses the upgrade without stopping the running application.

Reserve scheduling headroom for that Job alongside the current Factory Pod. Its resource requests
and limits are independently configurable through `maintenance.resources`; `resources` controls
the application Pod. Adjust these in the installation's private values when required by measured
control-plane use. They do not change the admitted native worker profile or remove the maintenance
fence. An unscheduled Job has not run the idle check, so do not stop the application to force an upgrade.

The application uses a single-replica Recreate deployment. A short interruption is expected.
Each Helm revision replaces the Factory Pod, even when its image and configuration are unchanged,
so its bootstrap clears the maintenance fence after a successful same-image upgrade too.
Its replacement uses the same retained data, signing credentials and public identities.
Recovery does not commission another inference. Missing retained credentials or a changed
installation identity refuses startup instead of silently generating replacements.
Background observations wait for CA-verified public HTTPS readiness from this exact startup
before dispatching work. A listening process alone does not prove that the Ingress can route
an Actor's Source or Connector callbacks.

Chart rollback is not a database rollback. The native baseline fingerprint must match the image. If startup or upgrade fails, retain the installation and inspect its exact failed
bootstrap or maintenance Job; do not delete PVCs to make readiness pass.
An unreleased Greenfield baseline change requires a separately created empty
installation. It does not authorize rewriting an existing database's fingerprint,
dropping its retained fields or replacing its claims. Keep that installation with
its matching image and data.

Uninstalling the chart is not consent to erase Project source. The installation credentials,
OpenBao TLS identity, object-store credentials and claim, Factory state and StatefulSet claims are retained. Explicit deletion must
account for the exact installation's Workspace resources and data, never unrelated Namespaces,
volumes or another Helm release. High availability and migration from the disposable
source-development installation are not part of this chart.

## Operating Factory

Normal authenticated Workspace commands own Start, Pause and Stop. Reading or saving Source does
not start inference. Paused compute permits editing only after completed durable ROOTFS and
independent Source handoff. Stop requires independent Source and exact-UID native Delete; an
unconfirmed pause or lost Delete response is not a successful Stop. A subsequent explicit Start
selects a new immutable generation only after cleanup and the latest confirmed Source export.
Resume and Pause dispatch facts are immutable for the original Actor and preceding ROOTFS
checkpoint. A lost reply while the Actor still shows its preceding state does not authorize
another dispatch. A `SUSPENDING` Actor with the original dispatched intent and exact next
snapshot may continue Substrate's idempotent Suspend workflow. Substrate reuses that snapshot;
Factory neither clears dispatch facts nor requests a new capture. Only an independently observed
`SUSPENDED` Actor with that exact completed durable snapshot permits Source handoff or the next
deliberate Resume.

For active Coding, Compute Stop must first confirm the existing Agent Stop, including queued
work in its verified child-Session tree. It retains unrelated root Inbox entries and refuses
snapshot/deletion when settlement remains unknown. A never-confirmed fresh bootstrap has no
submitted input only when its original native-confirmation barrier is positively fenced.
Offline Stop now has a bound Stop-only cold path for a paused original Actor with
independent Source and the declared bootstrap capability. It does not use ordinary
Resume, replay an uncertain Resume, or create a recovery Actor for an already
deleted fixture. Settlement still requires its exact joined SDK result, a new
durable ROOTFS and independent Source handoff. Live Linux arm64 coverage includes
a previously completed input after normal idle Pause and a subsequent explicit
Coding follow-up. Running or queued-input variants, historical failed Stops and
the full amd64 journey remain unqualified; package checks do not extend that scope.

An upgrade can retain an unconfirmed Coding Stop only after re-observing its original
suspended Actor, exact completed durable ROOTFS, native template and recorded independent Source handoff
under the Workspace lock. The maintenance Job uses the existing Editor identity for these reads;
it has no provisioner credential, signing key or state volume. Busy Workspaces, changed or missing
identities, unresolved lifecycle dispatches and existing Stop workers still refuse the upgrade.
The hook does not check live Source-process health. This does not confirm Stop,
cancel queued input or resume compute. The original Stop remains pending for the normal
controller after startup.

Native prebuild, Verification, Staging replacement and publication use the existing product owners,
original revision/environment/job intents and Substrate operations. Verification and independent
review name the exact commit. Delivery still requires its deliberate human approval or the explicit
eligible Project delegation. No worker reserve, warmed-memory restore, Terraform, generic runtime
provider or private native fork is involved.

Changes to native trust, profile, runtime identity or egress cannot rebind an existing Workspace.
New image/resource defaults affect fresh owners only; old Actor/template/source identities remain
fixed. Missing or uncertain observations remain distinct from success. Actor-level budgets are the
current enforcement boundary; per-inner-container cgroup limits and process continuity are not
promised.
A node reboot does not invalidate an acknowledged WorkerPool reservation. Admission still requires
the original node and pool UIDs, profile, image, reserved budget and current readiness. Unsubmitted
capacity intents retain their original boot fence and are not replayed after a reboot. This permits
new work on the same recovered node; it is not proof of restoring old Actors or replacing a node.
Factory neither installs a cluster metrics-server nor requests its Pod metrics API. The pinned
native API does not expose per-Actor CPU/RAM samples. Current consumption stays unavailable rather
than substituting a shared Worker's aggregate or reporting missing measurements as zero.

## Runtime artifacts and qualification limits

The application packages the official gRPC adapter and Source service. The normal tool bundle,
Browser tools and independent developer IDE remain exact immutable artifacts. Source is embedded
in the Factory and Actor images, not published as a separate role. The
native Actor image is built through [the Substrate image recipe](../../substrate/Runtime.Dockerfile),
using the pinned rootless bootstrap and Factory tools. Native workers own Actor-private Docker and
snapshots. Do not use the old runtime-host launcher or Factorybox image as an Actor substitute.

The distribution workflow builds and signs `substrate-bootstrap` and `substrate-runtime` natively on
amd64 and arm64, using exact same-commit, same-architecture tool/bootstrap digests. It combines the
Actor manifests only after both package checks. Both control-plane architectures embed
the same complete four-role artifact catalog: `runtime-host`, `browser-tools`, `developer-ide`
and `substrate-runtime`. `workloadImage` in the operator's configuration must
match its `substrate-runtime` reference; startup refuses a mismatch before installation actions.
The released chart carries `runtime-artifacts.json`, also supplied as
`factory-runtime-artifacts-<version>.json`. Chart packaging no longer supplies per-architecture
Factorybox worker values. Runtime trust, Editor/Owner identities and TLS origins remain explicit
operator inputs, not fabricated release defaults.

The Actor package check is networkless and checks architecture, executable versions and packaged
bootstrap files. It does not start private Docker or a native Actor and is not lifecycle proof.
The `release:clean-room` check accepts only the native chart contract and explicit fresh native
inputs. It validates runtime/TLS inputs and renders the chart before creating an installation
Namespace. CPU and memory headroom use scheduler reservations, including resizing and
terminating Pods, not measured usage. Insufficient capacity fails before creating a Namespace
or Secrets; the check never stops workloads or resizes WorkerPools. Every nonzero Helm preflight
outcome fails, including capacity failures. Its receipts
explicitly say `control-plane-check` and `nativeProductAcceptance: false`. Kubernetes-only cleanup
refuses recorded native resources or unavailable database inventory. `--values` copies storage
and size settings, not retained identities. Successful packaging or control-plane checks are not
complete clean-install qualification.

### Owned native clean-room inputs

This helper currently qualifies the operator-owned certificate path below. The built-in issuer uses
the ordinary Helm installation path; do not provide fake certificate inputs to make this helper
claim managed-issuer acceptance.

Reserve distinct, unused public Factory and Forgejo DNS names through the existing Ingress
controller. Supply a currently valid leaf certificate and matching private key covering both
names and `*.runtime.<factory-hostname>`, plus its public CA bundle. The command checks for
overlapping existing Ingress hosts before creating resources. It does not configure DNS, install
a runtime or weaken certificate validation. Public readiness uses the supplied CA bundle.
The browser host must already trust the certificate.

Create a separate input JSON file. The `configuration` object supplies the actually observed
pinned native runtime/profile, immutable Actor image, WorkerPool selector and admitted egress.
Do not include database, Editor principal, callback URL or credential paths there. The command
derives those for its new Namespace and the chart's normal mounts; it never converts a retained
installation configuration.

```json
{
  "schema": 1,
  "factoryOrigin": "https://factory-cleanroom.example.com",
  "forgejoOrigin": "https://git-cleanroom.example.com",
  "ingressClass": "your-existing-ingress-class",
  "ingressNamespaceLabels": {
    "kubernetes.io/metadata.name": "your-ingress-controller-namespace"
  },
  "configuration": {
    "profile": "nightly-20261109-975fb172241c",
    "runtime": {
      "sandboxClass": "gvisor",
      "version": {
        "schemaVersion": "v1",
        "attributes": [
          {"key": "architecture", "value": "amd64"},
          {"key": "sandbox_bundle_hash", "value": "sha256:ACTUALLY_OBSERVED_BUNDLE_HASH"}
        ]
      }
    },
    "workloadImage": "registry.example/factory-runtime@sha256:EXACT_ACTOR_DIGEST",
    "workerSelector": {
      "factory.runtime/profile": "nightly-20261109-975fb172241c",
      "factory.dev/deployment": "your-owned-native-profile"
    },
    "egressHosts": ["git-cleanroom.example.com"],
    "resources": {"cpuMilli": 2000, "memoryMiB": 4096}
  },
  "factoryCAFile": "/absolute/public-ca-bundle.pem",
  "provisionerTokenFile": "/absolute/private-owner-token",
  "ingressCertificateFile": "/absolute/ingress-chain.pem",
  "ingressKeyFile": "/absolute/private-ingress-key.pem"
}
```

Replace the example image/runtime values with the qualified artifact and observed upstream
runtime. Choose resources for the actual Project recipe; these example limits do not qualify the
Starter. The provisioner token and TLS key must be private regular files owned by the invoking
user, without group/other access or symlinks. No CA private key is requested. Only the public trust
bundle reaches Actors; the Owner token and Ingress key stay in their separate intended Secrets.

```sh
mise exec -- bun run release:clean-room \
  --factory-image registry.example/factory@sha256:EXACT_APPLICATION_DIGEST \
  --native-fixture /absolute/fresh-native.json \
  --context your-explicit-context --node your-control-plane-node --keep
```

`--keep` deliberately retains the new installation and its native inventory. Native cleanup is
still unqualified and may refuse even without a Project, because capacity admission records its
own WorkerPools. Cleanup requires the saved original Namespace UID and context; an unknown create
outcome or replacement is never adopted. Do not remove PVCs or reset another installation to
make this check pass. `--with-sandbox` adds limited Project/Ticket/Wiki browser checks, not the
complete approved Ticket journey or native Starter, prebuild, Verification and Delivery proofs.

The clean-room backup check uses a local PostgreSQL 16 executable when available. Its automatic
Docker reader uses the installed chart's exact PostgreSQL image, no network and a read-only copy
of the set. It records the create intent and original Docker ID before cleanup, and deletes only
that owner-verified ID, even after its Docker client is interrupted. Missing acknowledgements,
changed ownership and unavailable Docker inventory fail the run and retain its private copied
files and intent. An interrupt during the final check or cleanup cannot produce a passing receipt.
Repeated interrupts do not bypass the owned-client joins or cleanup.

[The native operator profile](../../substrate/README.md) records image/CLI/worker/gVisor pins,
TLS/egress checks, concrete commands and the scope of existing evidence. Installation-wide native
configuration, normal Workspace/Source commands and isolated product owners have controlled
regression coverage. Native product acceptance is separate from `helm test` and the clean-room
command's control-plane receipt. Use the profile's qualification scope for the live Starter,
Workspace, prebuild, exact-commit Verification/review, Delivery, Staging and publication coverage.
Neither that scope nor an ARM run qualifies an independent disaster restore, joined-node
recovery, the source launcher or a full amd64 product journey.
