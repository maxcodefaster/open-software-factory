# Factory on existing Kubernetes

This is a development chart maintained in the Factory repository, not a published chart release.
Install it from the checkout. The operator supplies Kubernetes; this chart does not install
OrbStack, Docker, a VM, an Ingress controller or a cluster.

## Prerequisites

- An admitted Linux AMD64 node/kernel profile for the pinned Factorybox worker. The cluster must permit
  privileged outer execution Pods and the read-only `/lib/modules` host mount. Factory does not
  disable cluster security policies to obtain these permissions.
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
  kernel: YOUR_ADMITTED_KERNEL_RELEASE
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
A new node, kernel or storage backend still needs its own native admission.

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
| OpenBao | `bao operator raft snapshot save` | `openbao.snap` |
| State | `tar` of the Factory state claim, mounted read-only | `state.tar.gz` (unseal key, AppRole login, installation identity) |

A failed step leaves `<step>.failed` and does not stop the others. The last container writes
`COMPLETE`, prunes and uploads only when every step succeeded, and otherwise fails the Job so the
failure shows in `kubectl get jobs`. `backup.retention` (default 7) keeps that many complete sets.
Incomplete sets are removed when a later run completes. Every network call retries, because a new
Pod can be refused by NetworkPolicy for a few seconds. The NetworkPolicy lets Pods labelled
`app.kubernetes.io/component=backup` reach PostgreSQL, OpenBao and Garage and nothing else.

Limits to know before relying on this:

- **OpenBao needs an operator token that Factory does not create.** Its AppRole policy cannot
  read snapshots, and it revokes the root token after bootstrap. OpenBao 2.7 also disables
  unauthenticated root generation, so the retained unseal key cannot mint a new one. Make a
  periodic token from an admin credential you hold. Its policy needs `read` on
  `sys/storage/raft/snapshot` and `update` on `auth/token/renew-self`. Put it in a Secret under the
  key `token` and set `backup.openbao.tokenSecret`. Each run renews it. Without it the Job still
  succeeds, but it writes `openbao.skipped`, warns, and the set holds no OpenBao data.
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
- The claim is a copy in the same cluster. Use `backup.remote` for protection against losing it.

To copy sets off the cluster, create a Secret with an `rclone.conf` key that defines one remote
(S3-compatible or Azure Blob, for example `[offsite]` with `type = azureblob`), then set
`backup.remote.existingSecret` and `backup.remote.path` (`offsite:container/factory`). The upload
uses `rclone copy`, so deletion is the remote's lifecycle rule. The image is
`docker.io/rclone/rclone`, pinned by digest in `upstream.json`.

### Reach the files

The claims are not exposed. Mount them in a throwaway Pod that you delete afterwards. This one runs
as root so extracted files keep their owners, and reads the backup claim; add the other claims
from the restore steps below only while their owning workload is scaled to zero.

```yaml
apiVersion: v1
kind: Pod
metadata: {name: restore-toolbox, namespace: factory}
spec:
  restartPolicy: Never
  containers:
    - name: tools
      image: YOUR_FACTORY_IMAGE # has sh, tar, gzip and kubectl
      command: [sleep, "7200"]
      volumeMounts:
        - {name: backup, mountPath: /backup, readOnly: true}
  volumes:
    - {name: backup, persistentVolumeClaim: {claimName: store-factory-backup-store-0, readOnly: true}}
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

A pass proves the dump, both archives and the snapshot are readable. It does not prove a full
restore, so rehearse one in a scratch Namespace on your own schedule.

### Restore

Restoring replaces data. Do it into a new installation, or keep a copy of what is there. Do not
delete a retained claim to start clean; where a step empties a claim, that claim belongs to a
new installation and holds nothing yet.

1. Install the chart with the same release name, Namespace, origins and storage class, using the
   Secrets you backed up (`existingSecrets.*`). Factory refuses a changed installation identity.
   Then scale Factory, Zero, OpenBao and Forgejo to zero. Leave PostgreSQL and Garage running.
2. PostgreSQL. Recreate the database and restore the dump over standard input:

   ```sh
   kubectl exec <release>-postgres-0 -- psql -U factory -d postgres \
     -c 'DROP DATABASE factory WITH (FORCE)' -c 'CREATE DATABASE factory OWNER factory'
   kubectl exec -i <release>-postgres-0 -- pg_restore --no-owner -U factory -d factory < postgres.dump
   ```

3. Forgejo. On your workstation, unpack `forgejo.tar.gz` into `./restore`, delete
   `restore/data/data/forgejo.db*`, and rebuild the database with
   `sqlite3 restore/data/data/forgejo.db < restore/forgejo-db.sql`. The archive's raw copy of the
   database was taken while Forgejo ran, so use the SQL dump. Mount `data-<release>-forgejo-0` at
   `/var/lib/gitea` and `config-<release>-forgejo-0` at `/etc/gitea` in the toolbox, then:

   ```sh
   tar -C restore -cf - data | kubectl exec -i restore-toolbox -- tar -xf - -C /var/lib/gitea --strip-components=1
   tar -C restore -cf - repos | kubectl exec -i restore-toolbox -- sh -c \
     'mkdir -p /var/lib/gitea/git/repositories && tar -xf - -C /var/lib/gitea/git/repositories --strip-components=1'
   tar -C restore -cf - app.ini | kubectl exec -i restore-toolbox -- tar -xf - -C /etc/gitea
   kubectl exec restore-toolbox -- chown -R 1000:1000 /var/lib/gitea /etc/gitea
   ```

   `app.ini` holds the secret key that encrypts stored credentials, so the original must come back.
4. Objects. Port-forward `<release>-objects` and run
   `rclone sync ./objects :s3:factory` with the `access-key-id` and `secret-access-key` from the
   objects Secret (`--s3-endpoint http://127.0.0.1:3900 --s3-region garage --s3-force-path-style`).
   Earlier versions of replaced objects are in `objects-changed/<timestamp>/`.
5. Planning cache. Zero's claim (`data-<release>-zero-0`) is a replica of PostgreSQL. Empty it in the
   toolbox so Zero rebuilds it from the restored database.
6. OpenBao. Its snapshot only restores onto the key it was taken with. Mount
   `data-<release>-openbao-0` at `/bao/data` and empty it. Scale OpenBao to one. It starts
   uninitialized. Port-forward `<release>-openbao` and, with `BAO_ADDR=https://127.0.0.1:8200` and
   `BAO_CACERT` set to the `ca.crt` of the OpenBao TLS Secret, run
   `bao operator init -key-shares=1 -key-threshold=1`, `bao operator unseal`, then
   `BAO_TOKEN=<that root token> bao operator raft snapshot restore -force openbao.snap`. OpenBao
   reseals. Unseal it with the original key, the `keys_base64` value in `openbao/bootstrap.json`
   inside `state.tar.gz`. Without `openbao.snap`, Factory cannot decrypt the secrets it stored.
7. Factory state. Mount `<release>-state` at `/var/lib/factory`, empty it, extract `state.tar.gz`
   into it as root so tar restores the original owners (uid 1000).
8. Scale Zero, Forgejo and Factory back to one and wait for readiness. Startup runs the migrator,
   which refuses a database newer than the image, so restore with an image at least as new as the
   backup.

The PostgreSQL, Forgejo and OpenBao parts of these steps were exercised with the pinned images
outside a cluster. The Zero reset and the full ordering have not been rehearsed end to end.

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
