# Factory on existing Kubernetes

This is a development chart maintained in the Factory repository, not a published chart release.
Install it from the checkout. The operator supplies Kubernetes; this chart does not install
OrbStack, Docker, a VM, an Ingress controller or a cluster.

## Prerequisites

- A Linux node (Ubuntu 22.04 or newer, kernel 5.15 or newer, cgroup v2, 4 KiB pages) for the pinned
  Factorybox worker. The worker's own capability gate decides whether the node's kernel is usable;
  Factory does not pin a kernel release. The cluster must permit privileged outer execution Pods.
  The worker Pod has no hostPath volumes and mounts no host `/lib/modules`. Factory labels the
  Namespaces it creates for Sandboxes and workers `pod-security.kubernetes.io/enforce=privileged`
  and does not otherwise disable cluster security policies.
- Dynamically provisioned RWO persistent storage with normal POSIX filesystem behavior. Set
  `storageClass` when the cluster has no appropriate default.
- A reachable application image containing the complete exact `runtime-artifacts.json` bundle.
  All worker nodes and private Workspace Docker daemons must be able to pull those images.
  A private registry's additional CA can be supplied through `registryCASecret`, with a `ca.crt`
  key. Node image-pull trust is an operator prerequisite, not a privileged installer DaemonSet.
- Browser-facing Factory and Forgejo origins. Non-development installations require HTTPS.
  DNS, an existing Ingress controller and its certificate are supplied by the operator.
  The Factory hostname also needs `*.runtime.<factory-hostname>` for isolated editors and Apps.
  For `factory.example.com`, route `*.runtime.factory.example.com` to the same Ingress and cover
  that wildcard in its TLS certificate. Each isolated host uses exactly one wildcard label.

The application ServiceAccount's ClusterRole lists exactly the verbs Factory's `kubectl` calls use
(see the comments in `templates/rbac.yaml`): no `watch`, no wildcards, no RBAC administration, and
`update` only on `namespaces/finalize`. It still holds `get`, `list`, `create`, `patch` and `delete` on
Secrets, plus `pods/exec`, cluster-wide. Factory creates a Namespace per worker with a generated
name, so a Role cannot grant this, and Kubernetes cannot limit `create` by name. The same binding
covers the release's own Namespace. The ServiceAccount is trusted infrastructure, not a restricted
tenant application. Project containers receive neither that ServiceAccount nor the node Docker
socket. This is not a hostile-code public service or a promise of VM-grade isolation.

There is no `rbac.namespaceScoped` switch. A RoleBinding per Namespace would need Factory to create
RoleBindings, which needs RBAC administration, a larger grant than the ClusterRole it would replace.
Secret `list` and Pod `list` are cluster-wide for the node-wide Pod scan and the storage check's
emptiness listing, and a Role cannot narrow them either. The only narrowed grant is the optional
backup ServiceAccount: a Role in the release Namespace that lets it `get` and exec into the
Forgejo Pod (`resourceNames`) and nothing else.

## Hardening

- PostgreSQL (999), Forgejo (1000), Zero (1000), OpenBao (100:1000), Garage (1000) and the
  maintenance Job run non-root with a read-only root filesystem, no capabilities, no privilege
  escalation and the `RuntimeDefault` seccomp profile. Each was started with those settings against
  its pinned image. Factory runs as uid 1000 with the same settings. Earlier releases ran it as
  root only because the state claim, its `0700` directory and its `0600` OpenBao token file were
  root-owned. Nothing else needed root: `/tmp` is an `emptyDir`, `kubectl` and the Kubernetes
  connection file live under `/tmp`, and the image's tools need no installation at run time.
- Factory has no `fsGroup`. Kubelet would add group read and write to every retained state file,
  and Factory refuses an OpenBao token file that is group-accessible.
- Factory, Zero and OpenBao have a short init container (`own-state` and `own-data`). It runs as
  root with only `CHOWN`, `DAC_OVERRIDE` and `FOWNER` and hands retained, root-owned volumes from
  earlier releases to the service user. `own-state` chowns the Factory state claim once and writes
  `.owner-uid-1000` there; delete that file to force another pass, for example after rolling back to
  a release that ran as root. `own-data` changes nothing on fresh installs or later restarts.
  These init containers are why the release Namespace cannot enforce Pod Security `restricted`.
- `networkPolicy.enabled` (default true) denies ingress to every release Pod and allows only the
  flows Factory uses. Runtime namespaces (labelled `app.kubernetes.io/managed-by=open-software-factory`)
  may reach Factory and Forgejo on port 3000 and nothing else. PostgreSQL, OpenBao and Garage have
  no egress except DNS (OpenBao also reaches itself). With `ingress.enabled`, set
  `networkPolicy.ingressControllerNamespaceSelector` to the controller's namespace labels. Empty
  allows every namespace. Port-forwarding enters through the Pod's loopback and is unaffected.
  The cluster's CNI must enforce NetworkPolicy; otherwise the objects have no effect.
- Every service has startup, readiness and liveness probes. Liveness tolerates about two minutes
  of failures and only starts after startup succeeds.
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
The OpenBao certificate must cover the OpenBao Service names and `127.0.0.1`, which the liveness probe uses.

## Install

Set a small private values file:

```yaml
image: your-registry/factory@sha256:YOUR_BUILT_APPLICATION_DIGEST
factorybox:
  image: your-registry/factorybox@sha256:YOUR_VERIFIED_WORKER_DIGEST
  executableSHA256: YOUR_VERIFIED_FACTORYBOX_EXECUTABLE_SHA256
  architecture: amd64 # or arm64, matching the independently qualified worker package
  nodeName: YOUR_ADMITTED_NODE
  # kernel: "5.15.0-*-azure,6.8.0-*-azure" # optional; omit to admit any kernel
publicURL: https://factory.example.com
forgejoPublicURL: https://git.example.com
ingress:
  enabled: true
  className: your-existing-ingress-class
  tlsSecret: your-existing-certificate-secret
```

Then install from the repository:

```sh
helm install factory ./deploy/helm/factory --namespace factory --create-namespace \
  --values /path/to/private-values.yaml --wait=legacy --timeout 20m
```

The repository pins Helm 4. These commands select its supported `legacy` readiness strategy.
The newer watcher waited for the full timeout when observing an absent cleanup hook in the
local native check; the same hook completed normally with `legacy`. This is Helm's installation
readiness behavior, not a Factory polling implementation. Helm 3 uses `--wait` instead.
Allow twenty minutes for cold volume provisioning and the owned storage write/read check with
its confirmed cleanup. The Factory Deployment uses the same progress window. Concurrent local
validation exceeded the former ten-minute default before bootstrap settled; a
timeout does not authorize resetting retained state or deleting an in-flight claim.

Size private execution storage before the first execution pins the worker profile.
`factorybox.storeGiB` defaults to a 64 GiB maximum and accepts whole sizes of at least 8 GiB
whose byte counts are safe integers.
`factorybox.minimumStoreGiB` defaults to 8 and must not exceed that maximum.
The pinned worker must support the `bounded-min-bytes` contract. On its actual backing
filesystem it chooses the largest whole-GiB size in the range while preserving its 12 GiB
host floor and existing 4 GiB operating write reserve. Factory retains the actual selected size in its native identity, not as a mutable
installation setting. Existing admitted profiles and stores are never resized by an upgrade.
`factorybox.claimGiB` defaults to 128 and must cover the maximum bounded image plus 17 GiB
for the host admission floor and metadata. For example, a 24 GiB bounded image needs
at least a 41 GiB claim; a 48 GiB claim leaves additional room. Canonical Project source remains on its separate
claim; source files are not moved into the bounded image.
Changing these values is not an in-place storage expansion. An already observed
worker refuses a different profile and retains its original objects and data.
If an admitted store is undersized, the authenticated System Manager command
`POST /api/admin/worker/recover` accepts `{"requestID":"<new UUID>","storage":"fresh"}`.
First Stop all execution and observe its private backing cleanup, then terminate the exact
original worker while retaining its Pod object for terminal observation. Fresh recovery refuses
unresolved backing from any admission sharing the old claim. It records a new store intent,
keeps the old claim and history, and retains canonical Source on its original claim and node.
Omitting `storage` retains the exact original store. Retry a request only with the same UUID and
storage selection. See [ADR 0003](../../../docs/adr/0003-worker-recovery-and-storage-retirement.md#admit-fresh-execution-storage-only-after-confirmed-drain).
A new node, storage backend or architecture still needs its own native admission.
`factorybox.kernel` is optional. Leave it empty (or `"*"`) to let the worker decide, or list
releases with `*` wildcards to restrict which nodes Factory admits. Run `helm test` to see the
node's kernel capability report.

Fresh worker resource admission checks the configured node's readiness and allocatable resources
and its assigned Pods before selecting a finite aggregate budget. The worker reserves the remaining
memory after other scheduling requests and `factorybox.memoryHeadroomMiB`, 2048 MiB by default.
Its CPU ceiling follows node allocatable CPU; `factorybox.cpuRequestMilli` remains the smaller
scheduling reserve. The selected profile and bootstrap image are retained before worker creation.
The pinned native binary must admit finite aggregate budgets. Existing workers, including the
original 3 CPU / 3 GiB profile, never resize during an upgrade. Native qualification fixtures keep
their original ceilings; a different worker budget still needs native deployment evidence.

Factory bootstraps the retained database, encrypted OpenBao and its scoped credentials, Forgejo
service identities and the native OIDC connection. It checks actual writable runtime storage.
Public readiness requires that complete bootstrap, not merely an open application port.
The application uses an internal Service during bootstrap; public traffic uses the readiness-gated
Service. Internal discovery leaves the public OIDC issuer and browser authorization URL unchanged.
The same Ingress routes `/zero` to the planning cache without a rewrite or another public hostname.
Zero's native optional base path carries its WebSocket protocol there. Keeping the browser on
the Factory hostname also preserves the host-only session cookies forwarded to query and mutation
authorization. The internal cache address is never supplied to the browser.
Preserve the incoming Host header. Factory restores the configured public HTTPS identity for that
host and its isolated runtime hosts across the Ingress's HTTP backend hop. It does not trust
caller-provided forwarding headers to select an identity. Internal Service requests keep their
actual HTTP transport.

The initial account is `admin@factory.local`, unless `adminEmail` was set. Retrieve its generated
password from the installation's Secret without putting it in Git:

```sh
kubectl --namespace factory get secret factory-credentials \
  --output 'jsonpath={.data.admin-password}' | base64 --decode
```

Configure model connections in Factory Settings. Provider keys are not Helm values and are not
required to start the interface. They are encrypted through the normal OpenBao adapter.
For a custom provider endpoint, list its allowed HTTPS origin in `modelAllowedOrigins` first.
The chart preserves its generated signing credentials and OpenBao TLS identity on upgrade.
Authentication cookies are scoped by installation, so local releases on different ports do not
overwrite each other's Factory login.
The unseal material and AppRole login are retained in the private Factory state claim, separate
from OpenBao's encrypted data claim. Protect and back up these installation resources together.

The chart also starts one pinned Garage object store. It creates the private `factory` bucket,
credentials and a retained 16 GiB persistent claim automatically. Original attachments, derived page images,
QA recordings and annotation stills use that same store. No external S3 account, endpoint or
bucket setup is required. Set `objectStorage.size` to request more capacity using the cluster's
normal storage rules. The internal-only service has no Ingress or workstation port forward.
Public Factory readiness includes an authenticated object write/read, not just an open storage port.
The single-node store is not high availability. The backup CronJob below mirrors it.
Extracted attachment text remains in PostgreSQL. Git mirroring does not protect uploads or
this installation's other retained data.

Factory administrators can configure native Forgejo push mirrors in Settings → Factory
administration → Repository mirrors. The target Git repository must already exist and have
appropriately scoped HTTPS write credentials. GitHub, GitLab.com and Codeberg are allowed by
default. `gitAllowedOrigins`, for example `["https://git.example.com"]`, adds exact public HTTPS
origins to both Factory's Project-import/mirror validation and Forgejo's native allowed hosts.
Paths, credentials, wildcard hosts and custom ports are not accepted by the chart. Private
network access remains disabled. No external storage, sync worker or backup account is needed
for ordinary Factory file storage; the external Git target is only an optional code copy.
Forgejo keeps HTTPS mirror credentials in its repository Git configuration, not OpenBao.
The chart does not encrypt that token. Protect the Forgejo claims and their backups, and use
encrypted underlying storage when encryption at rest is required.

The planning cache starts with one sync worker, independent of the Kubernetes node's CPU count.
Set `zeroSyncWorkers` to a larger positive integer when measured concurrent sync traffic requires
it. This changes only Zero's native worker configuration, not its retained data or authorization.
Source development uses the same default; `FACTORY_LOCAL_ZERO_SYNC_WORKERS` overrides it in the
local Compose service. Worker-count changes require the normal service update.

## Local development acceptance

During rapid development, build the application image with the maintained image command and make
it available to the selected cluster. No public chart publication is necessary:

```sh
mise exec -- bun run factory:image
```

The image embeds the currently available, exact runtime role references. This build needs the
existing source-development artifact publication; the installed Factory never invokes that
publication or builds runtime tools. An image loaded into one host Docker daemon is not
automatically available to every Kubernetes distribution.

For local browser access, use the repository's small local preset:

```sh
helm install factory ./deploy/helm/factory --namespace factory --create-namespace \
  --values ./deploy/helm/factory/values.local.yaml \
  --set-string image=your-cluster-reachable-development-image \
  --wait=legacy --timeout 20m
mise exec -- bun run factory:connect
```

Open the Factory address printed by `factory:connect`, normally `http://127.0.0.1:58000`.
Keep that one command running. It discovers the three browser addresses from the selected
installation and manages the native Kubernetes port forwards. A forwarding process exiting,
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

For an existing local installation, no upgrade or address change is needed. Select it explicitly
when its namespace, release or Kubernetes context differs from the defaults:

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

The local HTTP exception is restricted to loopback browser access. Internal callbacks still use
Kubernetes Services, never the Mac's host alias or a manually selected VM address.

## Backups and restore

`backup.enabled` (default true) renders one CronJob, `<release>-backup`, a dedicated retained claim
(`backup.size`, default 40Gi) held by a one-container StatefulSet `<release>-backup-store` so
WaitForFirstConsumer storage binds it, and a ServiceAccount. It runs on `backup.schedule` (default
`17 2 * * *`) and never overlaps itself. One Pod takes every part in this order, so the object
mirror always contains the objects the database dump refers to:

| Step | Tool | Result in `<timestamp>/` |
| --- | --- | --- |
| PostgreSQL | `pg_dump --format=custom` from the pinned postgres image, checked with `pg_restore --list` | `postgres.dump` |
| Forgejo | `forgejo dump` run in the Forgejo container through `kubectl exec`, streamed back and checked | `forgejo.tar.gz` (`forgejo-db.sql`, repositories, attachments, configuration) |
| Objects | `rclone sync` of the Garage bucket | one mirror at `objects/`; replaced or deleted objects move to `objects-changed/<timestamp>/` |
| OpenBao | `bao operator raft snapshot save`, logged in as the `factory-backup` AppRole | `openbao.snap` |
| State | `tar` of the Factory state claim, mounted read-only | `state.tar.gz` (unseal key, AppRole login, installation identity) |

A failed step leaves `<step>.failed` and does not stop the others. The last container writes
`COMPLETE`, prunes and uploads only when every step succeeded, and otherwise fails the Job so the
failure shows in `kubectl get jobs`. `backup.retention` (default 7) keeps that many complete sets.
Incomplete sets are removed when a later run completes. Every network call retries, because a new
Pod can be refused by NetworkPolicy for a few seconds. The NetworkPolicy lets Pods labelled
`app.kubernetes.io/component=backup` reach PostgreSQL, OpenBao and Garage and nothing else.

Limits to know before relying on this:

- **OpenBao is backed up with a login Factory creates.** At bootstrap Factory creates the
  `factory-backup` AppRole, whose policy allows only `read` on `sys/storage/raft/snapshot` and
  `update` on `auth/token/renew-self`, and writes its `role-id` and `secret-id` to the Secret
  `<release>-backup-openbao`. The Job logs in with it on every run, so no token expires. To use your
  own credential instead, put a token in a Secret under the key `token` and set
  `backup.openbao.tokenSecret`; each run renews it. Without either, the Job still succeeds but
  writes `openbao.skipped`, warns, and the set holds no OpenBao data. An installation created before
  this identity existed needs the one-time adoption below.
- **Backups hold everything needed to decrypt OpenBao.** `state.tar.gz` contains the unseal key.
  Treat the backup claim and any remote as sensitive as the cluster's Secrets and encrypt them.
  An rclone `crypt` remote does that for the optional copy.
- **Secrets are not in the sets.** Back up the credentials, object-store and OpenBao TLS Secrets
  yourself, for example `kubectl get secret <release>-credentials <release>-objects
  <release>-openbao-tls -o yaml`, or keep them in your own secret manager and set
  `existingSecrets.*`.
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

OpenBao 2.7 disables the unauthenticated `sys/generate-root` endpoints on its Service listener, so
the retained unseal key alone cannot mint a root token there. **An installation that was bootstrapped
before this change has no `factory-admin` or `factory-backup` and needs one adoption.** Upgrade once
with the chart's loopback recovery listener on, let Factory start, then turn it off. OpenBao restarts
sealed whenever its Pod spec changes and only Factory's start unseals it, so restart Factory after
each upgrade unless the upgrade already rolled it:

```sh
helm upgrade factory ./deploy/helm/factory --namespace factory \
  --values /path/to/private-values.yaml --set openbao.recovery.enabled=true --wait=legacy --timeout 20m
kubectl --namespace factory rollout restart deployment/factory
kubectl --namespace factory rollout status deployment/factory --timeout=20m   # adoption ran when this succeeds
helm upgrade factory ./deploy/helm/factory --namespace factory \
  --values /path/to/private-values.yaml --wait=legacy --timeout 20m
kubectl --namespace factory rollout restart deployment/factory
kubectl --namespace factory rollout status deployment/factory --timeout=20m
```

The listener binds `127.0.0.1:8210` inside the OpenBao Pod. It is not in the Service or the
NetworkPolicy, so only `kubectl port-forward` through the Pod reaches it, and Factory is the only
caller. Factory generates a root token with the unseal key, creates the three identities, revokes
that token and cancels the generation attempt. If the listener is off when adoption is needed,
Factory stops before becoming ready and says so. Data is untouched either way.

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
does not prove a restore. The rehearsal below does.

### Rehearse a restore

```sh
mise exec -- bun run restore:rehearsal --namespace factory --release factory [--context NAME]
```

The script needs `kubectl`, `helm`, `sqlite3` and a `pg_restore` of major version 16 (or Docker, which
it wraps), and a cluster user who may create Namespaces, ValidatingAdmissionPolicies and a Helm
release. It reads the live installation and changes it only by running one backup Job (and deleting
that Job again) when the newest complete set is older than `--max-age-minutes` (default 60; `0`
always takes a fresh one). Then it:

1. checks the live database for rows without a parent row, copies the set to a temporary directory
   and runs `restore-check`;
2. installs the chart from this checkout into a new Namespace `factory-restore-rehearsal-<8 hex>`,
   labelled `factory.dev/rehearsal-owner=<id>`, with the live release's values and image, backups
   off, small scheduling requests and copies of the credentials, object-store and registry-CA
   Secrets (never printed);
3. runs the Restore steps below, scaling the owning workloads to zero, and starts Factory;
4. compares the two installations: every table's row count and a checksum of every row of the key
   tables (users, Projects, Epics, Changes, requirement documents, wiki pages and revisions, model and
   MCP connections, attachment metadata), the Forgejo repositories with their refs, head commits and
   users, the object listing, every OpenBao secret path the database names (read as Factory's own
   AppRole, compared by digest), Factory's log, `/health/ready` and the administrator's sign-in;
5. writes `.factory/test-results/restore-rehearsal/<timestamp>.json` with the counts and durations,
   then deletes that exact Namespace, its policies and volumes. `--keep` skips the deletion, and
   `--cleanup factory-restore-rehearsal-<id>` removes an interrupted run after checking the label.

The scratch installation starts no Sandbox and cannot touch the live one. The restored database names
the live Factorybox worker, and Factory's ServiceAccount is cluster-wide, so the script installs two
admission policies for the run. One holds Factory and Zero Pods back until the data is restored. The
other denies every write by the scratch ServiceAccount outside its own Namespace and the storage
check Factory creates at start. The script proves both work before it relies on them, and after the
run it checks that no Sandbox, worker or editor Pod or claim of the live installation changed.

A rehearsal in another Namespace differs from a real restore in what the move forces:

- the Helm release name and origins stay as they are, because the database records the origins;
- the OpenBao TLS Secret is generated again, since its certificate names the Namespace;
- the restored `kubernetes-installation.json` is rewritten to the new Namespace, which Factory
  otherwise refuses as a changed installation identity;
- Service addresses in `forge_connection.discovery_url`, `project.repository_url`,
  `wiki_source_update.target_url` and the Forgejo SQL dump contain the Namespace and are rewritten.
  The receipt compares the Factory tables before this rewrite.

A source database that already violates its foreign keys, for example after a bulk delete with
triggers disabled, cannot restore cleanly: `pg_restore` exits non-zero when it recreates those keys.
The script reports the orphaned rows before it backs anything up and stops. `--allow-orphans`
accepts that source if the restore fails on exactly those constraints and on nothing else. Repair the
rows instead when you can.

Compare against a live installation that is idle. The script runs the key-table checksums before and
after its own backup and refuses to continue if they moved. Tables that changed during the backup
(sessions, read versions) are left out of the all-table comparison.

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
3. Files. On your workstation, rebuild Forgejo's SQLite database from its SQL dump. The archive's raw
   copy was taken while Forgejo ran, so never use it. Start the toolbox from the previous section,
   then:

   ```sh
   kubectl exec restore-toolbox -- tar -xzOf /backup/<timestamp>/forgejo.tar.gz forgejo-db.sql | sqlite3 forgejo.db
   kubectl exec restore-toolbox -- sh -ec '
     S=/backup/<timestamp>
     find /var/lib/gitea /etc/gitea /zero /bao/data /var/lib/factory -mindepth 1 -delete
     tar -xzf $S/forgejo.tar.gz -C /var/lib/gitea --strip-components=1 \
       --exclude "repos*" --exclude app.ini --exclude forgejo-db.sql --exclude "data/data/forgejo.db*"
     mkdir -p /var/lib/gitea/git/repositories
     tar -xzf $S/forgejo.tar.gz -C /var/lib/gitea/git/repositories --strip-components=1 \
       --exclude "data*" --exclude app.ini --exclude forgejo-db.sql
     tar -xzf $S/forgejo.tar.gz -C /etc/gitea app.ini
     tar -xzf $S/state.tar.gz -C /var/lib/factory
     rclone sync /backup/objects s3:factory --create-empty-src-dirs'
   kubectl exec -i restore-toolbox -- sh -c 'cat > /var/lib/gitea/data/forgejo.db' < forgejo.db
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
5. Scale Forgejo, Zero and Factory to one and wait for readiness. Startup runs the migrator, which
   refuses a database newer than the image, so restore with an image at least as new as the backup.

`restore:rehearsal` runs exactly these steps against a scratch Namespace and compares the result, so
run it after any change to the backup or restore procedure and on a schedule you trust.

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
control-plane use. They do not change Factorybox's admitted worker profile or remove the maintenance
fence. An unscheduled Job has not run the idle check, so do not stop the application to force an upgrade.

The application uses a single-replica Recreate deployment. A short interruption is expected.
Each Helm revision replaces the Factory Pod, even when its image and configuration are unchanged,
so its bootstrap clears the maintenance fence after a successful same-image upgrade too.
Its replacement uses the same retained data, signing credentials and public identities.
Recovery does not commission another inference. Missing retained credentials or a changed
installation identity refuses startup instead of silently generating replacements.

Chart rollback is not a database rollback. Do not assume an older image can read newer schema
changes. If startup or upgrade fails, retain the installation and inspect its exact failed
bootstrap or maintenance Job; do not delete PVCs to make readiness pass.

Uninstalling the chart is not consent to erase Project source. The installation credentials,
OpenBao TLS identity, object-store credentials and claim, Factory state and StatefulSet claims are retained. Explicit deletion must
account for the exact installation's Workspace resources and data, never unrelated Namespaces,
volumes or another Helm release. High availability and migration from the disposable
source-development installation are not part of this chart.

The former `attachments.endpoint`, `attachments.bucket` and `attachments.existingSecret` settings
are rejected rather than silently switching existing attachments to an empty bucket.
Startup also refuses retained QA files in the former state-volume `review-media` directory.
Transfer retained bytes and verify their exact identities before changing an existing installation;
the chart does not migrate or erase them automatically.
