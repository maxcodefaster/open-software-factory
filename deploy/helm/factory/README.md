# Factory on existing Kubernetes

Releases publish this chart as a signed OCI artifact at `oci://ghcr.io/maxcodefaster/charts/factory`
and as an asset of the GitHub release. The released chart pins the released Factory image and the
signed Factorybox worker that passed its native conformance. The operator supplies Kubernetes;
this chart does not install OrbStack, Docker, a VM, an Ingress controller or a cluster.

The release publishes native Linux arm64 and amd64 images. Each worker needs admission on its
own node. Azure AKS has not been qualified.

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

Install a release. Its chart already pins the Factory image and the verified worker, so a small
private values file is enough:

```yaml
factorybox:
  nodeName: YOUR_ADMITTED_NODE
  # kernel: "5.15.0-*-azure,6.8.0-*-azure" # optional; omit to admit any kernel
publicURL: https://factory.example.com
forgejoPublicURL: https://git.example.com
ingress:
  enabled: true
  className: your-existing-ingress-class
  tlsSecret: your-existing-certificate-secret
```

```sh
helm install factory oci://ghcr.io/maxcodefaster/charts/factory --version 0.1.0-beta.1 \
  --namespace factory --create-namespace --values /path/to/private-values.yaml \
  --wait=legacy --timeout 20m
```

On amd64, also pass `--values
https://github.com/maxcodefaster/open-software-factory/releases/download/v0.1.0-beta.1/factory-amd64-0.1.0-beta.1.yaml`.
This selects the signed amd64 worker and its executable hash.

Check the signatures first with `cosign verify --certificate-identity-regexp
'^https://github.com/maxcodefaster/open-software-factory/' --certificate-oidc-issuer
https://token.actions.githubusercontent.com ghcr.io/maxcodefaster/charts/factory:0.1.0-beta.1`.
The worker image is signed with the project key; its public half is `deploy/factorybox/cosign.pub`.

To run a build from a checkout instead, supply the image and worker yourself:

```yaml
image: your-registry/factory@sha256:YOUR_BUILT_APPLICATION_DIGEST
factorybox:
  image: your-registry/factorybox@sha256:YOUR_VERIFIED_WORKER_DIGEST
  executableSHA256: YOUR_VERIFIED_FACTORYBOX_EXECUTABLE_SHA256
  architecture: arm64 # arm64 or amd64
  nodeName: YOUR_ADMITTED_NODE
publicURL: https://factory.example.com
forgejoPublicURL: https://git.example.com
```

Then install from the checkout:

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
storage selection. See the worker recovery design.
A new node, storage backend or architecture still needs its own native admission.
`factorybox.kernel` is optional. Leave it empty (or `"*"`) to let the worker decide, or list
releases with `*` wildcards to restrict which nodes Factory admits. Run `helm test RELEASE` to
check the node, storage class and Pod admission. A passing test leaves nothing behind. After a
failure, `kubectl logs job/RELEASE-preflight` names each failed check and its fix.

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

## Operating Factory

Installing, sizing and recovering a Factory installation and its Factorybox worker.
The chart's own instructions are in [deploy/helm/factory](README.md).

### Installation and worker admission

Select `registryCASecret` before admitting the installation's first Factorybox worker and keep
that CA bundle unchanged for the retained worker. This configures its private Sandbox registry
trust; it does not configure Kubernetes node image pulls. Node image-pull trust is an operator
prerequisite. Publishing new digest-pinned runtime tools does not itself require changing this
setting, and Factory refuses to overwrite a retained worker's shared trust declaration.
The Dev Containers CLI receives that admitted Factory Registry CA alongside any
Project Registry certificates. Empty Project settings do not discard the installation
trust or disable TLS verification.

The development Helm chart lives in [deploy/helm/factory](README.md).
Releases publish it as a signed OCI chart that pins the released Factory image and the verified
worker; `v0.1.0-beta.1` is verified on arm64 Linux only, and amd64 and Azure AKS are not
supported yet. The worker needs a private cgroup namespace, which the Docker runtime of the
verified node gives privileged Pods and a default containerd setup may not; the other platforms
have not passed the native conformance. A checkout can still install it directly. Kubernetes is provided by the operator. Factory does not
install a VM or cluster, require OrbStack, or manage the node's Docker daemon.
Local tools and the Factory image pin `kubectl` 1.35.6. Use a Kubernetes API server
within one minor version, 1.34 through 1.36, as required by the upstream version-skew policy.
Use the repository-pinned Helm 4.2.2 for installation and upgrades. Helm 4.2.0 and 4.2.1
can wait indefinitely for deletion of a missing pre-upgrade hook, including Factory's
maintenance Job. The [upstream fix](https://github.com/helm/helm/issues/32231) is included in
4.2.2; skipping hooks would bypass Factory's work-settlement guard rather than fix the wait.

A Factory restart waits up to 100 seconds for running Start, Pause, Resume and Delete commands
before it exits (the Pod's grace period is 120 seconds). A kill between a native Resume's intent
and its outcome leaves that Sandbox unconfirmed. Factory retains it as `cleanup-failed` and never
guesses, so roll Factory when no Pause or Resume is in flight and prefer `helm upgrade --wait`
over deleting the Pod.

The chart and owned Forgejo fixtures pin 17.0.0 by image digest. Its native job/step/log API
supplies Verification diagnostics. Upgrading an existing Forgejo is an explicit operator action:
back up its database, repositories, configuration and secrets, review the upstream 16/17 breaking
changes, and verify the upgrade before normal work resumes. Changing the repository pin or running
an owned proof never upgrades a retained installation.

An upgrade from the previous build to the new one loses no data. Every row of the Factory and auth
schemas, every Forgejo repository head and file, every OpenBao secret and every stored object is
the same afterwards, apart from new migrations and what they add, and the administrator signs in
with the same password. `release:upgrade-test` proves this on a disposable Namespace before a tag
(see the upgrade test (`bun run release:upgrade-test`)). A chart rollback is not part of
that promise. It does not roll the database back, so after a migration the previous image refuses
to start. Upgrade forward or restore the last backup set into a new installation.

The chart runs Factory, PostgreSQL, Forgejo, Zero, encrypted OpenBao and one private Garage
object store in Kubernetes. It creates the file bucket, credentials and persistent volume
automatically; no separate S3 provisioning is required. Internal
callbacks use Services and the application uses its ServiceAccount, without a personal kubeconfig
or a mounted host Docker socket. Factorybox execution requires a Linux node whose kernel passes the worker's capability gate,
permission for privileged outer Pods and usable persistent storage. Supply the exact
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
them. See worker resource admission.
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
admitted worker recovery
and bootstrap admission recovery.
An explicit `storage: "fresh"` recovery can admit a distinct store with the configured capacity
only after private backing cleanup is confirmed across every admission sharing the old claim.
The old store and execution history remain unchanged, and canonical Source keeps its exact claim,
Namespace and node. This does not resize or migrate a retained store. See
fresh execution storage.
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
See consumer transport retirement.
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
Development compute keeps its Sandbox for `FACTORY_EXECUTION_IDLE_MINUTES` (default 15) and pauses after
`FACTORY_EXECUTION_QUIET_MINUTES` (default 2, capped at the idle value) when no IDE, Terminal, App or
browser request is open; every Pause fence is unchanged. A submitted Change stays warm for
`FACTORY_EXECUTION_REVIEW_MINUTES` (default 30, 0 disables) after its last commit or Verification verdict
and while Verification runs. Native commands hold the cross-process lock `factorybox-worker-lifecycle` one call at a time;
image export, Kubernetes reads and sweeps do not, and background retirement yields to waiting Start, Resume and Pause.

Choose an available development application image containing the exact runtime artifact bundle,
then supply the browser-facing Factory and Forgejo origins. See the chart's
[installation and maintenance instructions](README.md) for local access,
Ingress, credentials and retained data. Development images may be built locally; the installed
application does not build its own tools or require a source checkout on the operator's machine.

The image workflow publishes only when a GitHub release is published, never on branch pushes or
pull requests. A release tag such as `v0.1.0` must point to a commit contained in `main`.
The shared verification workflow runs the standard checks, PostgreSQL/controller tests and
owned UI journeys natively on ARM64. It does not run on pushes or pull requests;
release publication calls it, and it can be started by hand. Release publication must pass those
same checks on its exact tagged source before any image build or push. Before tagging, the
maintainer runs `bun run beta:gate` on a clean checkout: it scans the history for secrets and for
terms that must not ship, runs every lane and writes a receipt that names the exact commit.
A native ARM64 job builds the runtime roles and Factory, then publishes their manifests; a last job
packages the chart with those digests and the signed worker, pushes it to GitHub's container
registry, signs it and attaches it to the release. Existing versioned architecture images are not overwritten. Publishing Factory does
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
not rewritten. See published App addresses.
The Connector preserves the browser-visible App Host for HTTP and WebSocket requests while
dialing only the admitted internal target. Factory reconstructs proxy authority after discarding
client-supplied forwarding headers; same-origin authentication does not need a relaxed origin check.
Preview grants bind the exact Runtime Attempt and App channel. Their host-only cookies cover that
App's origin; Factory credentials are not forwarded, and App cookies cannot escape to another App.


### Trust boundary and node hardening

Sandboxes run on the node's kernel, next to the privileged worker. Sysbox user namespaces, a
seccomp policy and the Connector's Dev Container checks limit what Project code reaches. None of
them is a virtual machine boundary, and a kernel bug can cross it. Plan the node accordingly.

- **One worker per Factory.** Factory keeps a single worker. Every Project and user of that
  installation runs in it. Use a separate installation, with its own node, for a customer or trust
  domain you do not want to share a kernel with.
- **A node for the worker.** Run it on a node pool that hosts nothing else you need to protect.
  Do not give that pool cloud credentials beyond what its kubelet needs.
- **Egress is open.** A Sandbox reaches the network through NAT in the worker Pod, with the Pod's
  address. The worker accepts every forwarded destination, and Factory creates no NetworkPolicy in
  the `factory-box-*` Namespaces. The release's own policies cover only the release's Pods.
  Whether a Sandbox reaches the cluster DNS, other Pods, the node, the Kubernetes API server or a
  cloud metadata endpoint depends on your CNI and cloud. Test it from inside a Sandbox. On a cloud
  cluster, refuse 169.254.169.254 and the node's kubelet port for those Namespaces. A policy needs a
  CNI that enforces NetworkPolicy, and the addresses to except depend on that CNI. Verify the
  result before you rely on it:

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: sandbox-egress
    namespace: factory-box-UUID
  spec:
    podSelector: {}
    policyTypes: [Egress]
    egress:
      - to:
          - ipBlock:
              cidr: 0.0.0.0/0
              except: [169.254.0.0/16, NODE_SUBNET_CIDR]
  ```

- **Node sysctls.** The preflight warns when `kernel.unprivileged_bpf_disabled`,
  `kernel.perf_event_paranoid`, `kernel.kptr_restrict`, `kernel.dmesg_restrict` or
  `vm.unprivileged_userfaultfd` leave unprivileged entry points open. It also reports
  `kernel.yama.ptrace_scope` and `kernel.io_uring_disabled`. Sandboxes have their own PID
  namespace and a seccomp rule that returns EPERM for io_uring, so those two never warn. The
  worker itself is privileged and does not depend on any of them.
- **Kernel updates.** A kernel fix matters more on this node than on an ordinary one. The
  recommended node image settings below stop automatic image upgrades, so schedule kernel updates
  yourself: stop execution, upgrade the pool, then recover the worker as described under
  Upgrades and reboots.


### Managed clusters such as Azure AKS

Azure AKS is not supported yet. The notes below describe the intended setup and are not verified.

Factory runs on a standard managed cluster when one dedicated node can host the privileged
Factorybox worker. Nothing here is verified on AKS yet. Run the preflight first, and treat its
FAIL lines as blockers.

**Node pool.** Use one Ubuntu 22.04 amd64 node (`--os-sku Ubuntu`), kernel 5.15 or newer, cgroup v2,
containerd, a 128 GiB OS disk, and a VM size with at least 4 data-disk slots and 8 GiB of memory
after system reservations. Do not taint the pool; the worker and Source Pods declare no
tolerations. Set `factorybox.nodeName` to the node's `kubernetes.io/hostname` label and
`factorybox.architecture: amd64`. Source, the worker store and every Developer IDE claim use
ReadWriteOnce disks, so they all stay on that one node.

**Kernel.** Factory does not pin a kernel release. Leave `factorybox.kernel` empty (or `"*"`) and the
worker's own capability gate decides: it checks the kernel facilities, cgroup v2 and page size, and
`factorybox doctor` reports any refusal. The worker reports the node's exact kernel and boot ID and
marks it `qualification: verified` or `unverified`. That mark is informational, and Factory still
admits an unverified kernel the gate accepts. Node image upgrades change the release string, so an
empty value keeps working across them. To restrict nodes anyway, list releases with `*` wildcards,
for example `factorybox.kernel: "5.15.0-*-azure,6.8.0-*-azure"`. A node outside the list is
refused, and the restriction never relaxes the worker's gate. With `--set` on the command line,
escape the comma as `\,`. The node boot ID still pins each retained worker whatever you choose.

**Namespaces.** The release Namespace may enforce `baseline` but not `restricted` (the volume-ownership
init containers run as root with `CHOWN`, `DAC_OVERRIDE` and `FOWNER`). Factory creates `factory-box-<uuid>` Namespaces for the privileged worker and labels them
`pod-security.kubernetes.io/enforce`, `audit` and `warn` at `privileged`, so a cluster default of
`baseline` or `restricted` does not reject the worker. Namespaces that existed before this label
keep their labels. If you run Azure Policy or Gatekeeper rules against privileged Pods, exempt
Namespaces labelled `app.kubernetes.io/managed-by=open-software-factory`, because labels cannot
override a policy engine. The preflight shows which layer denies the Pod.

**Storage.** Use Azure Disk CSI: `storageClass: managed-csi` (or `managed-csi-premium`) with
`volumeBindingMode: WaitForFirstConsumer`. Azure Files and Blob are refused, because the store is a
loop-mounted ext4 image with direct I/O. A disk is zonal, so keep the pool in one zone.

**Upgrades and reboots.** A reboot or image upgrade ends the worker's processes and RAM. A
reboot in place leaves the Pod `Failed` and the retained store intact. Stop remaining
execution and POST `/api/admin/worker/recover`, as in the Factorybox README. A replaced node
gets a new name, and its original Pod is garbage-collected, so Factory refuses recovery and
keeps the data. Prevent that. Set `az aks nodepool update --node-os-upgrade-channel None` (or the
`Unmanaged` channel) and `az aks update --auto-upgrade-channel none`, so node images and
Kubernetes versions change only when you run them. Upgrade the worker pool by itself, after
stopping all execution and recording the retained Pod UID.

**Preflight.** After `helm install`, run `helm test RELEASE --namespace NAMESPACE --logs`. Or run
it from a checkout with your kubectl context:

```sh
bun scripts/kubernetes/preflight.ts --node NODE --architecture amd64 \
  --image REGISTRY/factorybox@sha256:DIGEST \
  --storage-class managed-csi --namespace factory
```

Add `--kernel '5.15.0-*-azure,6.8.0-*-azure'` only to test a restriction. The preflight checks the
node platform, taints, memory and CPU budget, the storage class and attach limit, and the release
Namespace. It reports the node's kernel and checks it against the 5.15 minimum and any
`factorybox.kernel` restriction. It FAILs on a missing kernel capability or a `factorybox doctor`
refusal and only WARNs when the worker accepts a kernel its build has not verified. Unless you pass `--read-only`, it also creates one throwaway
`factory-preflight-*` Namespace, dry-runs the real worker Pod and claim against admission, runs one
privileged Pod to read the kernel configuration, cgroup, BTF and userfaultfd facts and run
`factorybox doctor`, then deletes the Namespace. Each FAIL names its fix.

### Runtime host

The runtime host builds Docker Compose from the verified upstream source archive pinned in
`upstream.json`. It includes the configured-input grants needed for Dev Containers' temporary
Dockerfiles while keeping Bake's filesystem checks enabled. This is an upstream development

### Local source installation

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
Use the runtime artifact instructions below when changing runtime images.

#### Run the existing installation's server on Linux

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
[repository Helm chart](README.md).


## Factorybox worker admission

Factorybox is a separate Linux system-container runtime. This operator command admits one
dedicated worker for a customer or trust domain and controls administrator-prepared private OCI
bundles through its own CLI. Factory Workspace Start and the execution reserve use this same worker
contract with Factory-owned consumer preparation. See Workspace execution.

The Helm chart requires `factorybox.image`, `factorybox.executableSHA256`,
`factorybox.architecture` and `factorybox.nodeName`. `factorybox.kernel` is optional. The local launcher uses
`FACTORY_FACTORYBOX_WORKER_IMAGE`, `FACTORY_FACTORYBOX_EXECUTABLE_SHA256`,
`FACTORY_FACTORYBOX_ARCHITECTURE` and `FACTORY_FACTORYBOX_NODE`, plus an optional
`FACTORY_FACTORYBOX_KERNEL`.
They must identify a verified package and the actual admitted node. Architecture is explicitly
`arm64` or `amd64`; Factory never infers it from the control-plane host.
The worker image must be available in the operator's private registry or loaded on that node.
An image built in the developer's Docker daemon is not automatically available to Kubernetes.

Stop existing Envbox executions before changing the installation profile. Existing unused reserve
slots retire when their frozen profile differs. Never adopt a used Envbox execution as Factorybox
or overwrite its immutable runtime artifacts. The default `executionReserveTarget` is two unused
paused Forks, not a limit of two running Sandboxes. Qualify the target node, CNI and StorageClass
before admitting its worker.

Pause/Resume retains RAM on the same live worker. A worker restart or node loss retains canonical
source but requires an explicit fresh execution; automatic cross-node RAM recovery is unsupported.

The command renders ordinary Kubernetes objects and uses the installation's existing kubectl
context or ServiceAccount. It has no cloud-specific implementation, CRD, new database or pool
controller. The worker receives no Kubernetes token or host Docker socket. Keep distinct stores
and workers for distinct trust domains.

### Local worker build

`bun run factorybox:build REQUEST_JSON` invokes the standalone repository's pinned
worker pipeline. It records intent and output under `.factory/test-results/`, checks
the final image architecture and the actual executable bytes inside that image, and
writes `profile.candidate.json` in the existing Factory runtime-profile format.
It neither publishes an image nor changes an installed profile or retained Sandbox.

The request names exact completed inputs, not a floating tag or latest artifact:

```json
{
  "repository": "/absolute/path/to/factorybox",
  "commit": "REPLACE_WITH_40_HEX_CHARACTER_HEAD_COMMIT",
  "upstreamVersion": "REPLACE_WITH_FACTORYBOX_VERSION",
  "platform": "linux/arm64",
  "nativeBaseBuild": "factorybox-build-native-base-REPLACE_WITH_32_HEX_CHARACTERS",
  "builder": "REPLACE_WITH_RUNNING_BOUNDED_BUILDER",
  "boundedBuild": true,
  "network": "host",
  "dockerContext": "orbstack",
  "nodeName": "orbstack"
}
```

The build refuses a repository whose `HEAD` differs from `commit` or whose working tree has any
change, and records the commit, tool versions and timestamps in `provenance.json` beside the
candidate. The build tool receives an allowlisted environment, not Factory's.

The standalone README describes native-base and bounded builder preparation.
Optional `sysboxBuild` and `retainedCandidate` reuse exact verified completed component
builds. All components must match `platform`. An AMD64 build on ARM64 remains a
cross-build; Factory runs the native `doctor` probe only on a matching Linux Docker
host.

The ARM64 candidate implements timer continuation and passes native Start, shared-source
Pause/Resume and Connector checks. Select a candidate profile only after the standalone
repository's native checks pass on the target node with its exact bytes. The existing
installation stays unchanged when a build or runtime probe fails.

### Request and deployment

Save the immutable request under `.factory/test-results/`. Supply an exact worker image digest
available to the selected node and the SHA-256 of that image's Factorybox executable. Both must
come from the same verified build. The new image must support `--health-listen`, `--worker-store-id`
and `--worker-epoch`. The previous first-release image does not expose these options.

```json
{
  "version": 1,
  "namespace": "factorybox-owned-example",
  "podName": "worker",
  "storeID": "0123456789abcdef0123456789abcdef",
  "trustDomainID": "abcdef0123456789abcdef0123456789",
  "image": "registry.example/private/factorybox@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST",
  "executableSHA256": "REPLACE_WITH_EXECUTABLE_SHA256",
  "architecture": "amd64",
  "nodeName": "REPLACE_WITH_NODE_NAME",
  "boundedBytes": 8589934592,
  "claimGiB": 32
}
```

Replace the example store and trust-domain IDs with random 32-character hexadecimal identities.
Factory renders and validates either Linux ARM64 or AMD64 using the same worker protocol.
The standalone worker gates on kernel capabilities and 4096-byte pages, not one kernel release.
It reports the node's exact kernel and boot ID, and an informational `qualification` of
`verified` or `unverified`. Inspection checks the node's OS and architecture against the live
worker. `kernel` is optional. Unset, empty or `*` admits any kernel. To restrict nodes, set one
release or a comma-separated list using `*` wildcards (`5.15.0-*-azure,6.8.0-*-azure`); a node
outside the list is refused. The restriction never relaxes the worker's own capability gate, and
the node boot ID still pins each retained worker. Node-reported and kernel-reported boot IDs
are pinned separately; a later change to either refuses the original admission. Worker startup checks its actual
cgroups, component identities, store lease and filesystem. Another node profile needs the
standalone native checks before use.

The Pod has a 3 CPU / 3 GiB limit and reservation, a private PID namespace and privileged access.
Required kernel facilities must already be present on the admitted node. Factory does not mount
host `/lib/modules`: Sysbox can pass that external tree into a guest, which violates private
filesystem capture admission. Its complete `/var/lib/sysbox` state uses a dedicated RWO PVC.
The bounded filesystem size is explicit; the PVC must also cover 16 GiB of host admission
headroom and metadata. `storageClass` is optional. Empty volumes must have root-owned parents
without group/world write permissions; existing stores are never reformatted or migrated.

The product Pod initializes only a new empty root-owned store volume before exporting the
consumer image. It records the original Pod/store identity and sets private directory modes.
Nonempty, aliased or differently owned volumes are refused without changing their permissions.
This handles StorageClasses that provision an initially world-writable root, without repairing
or adopting a retained worker store.

`bun run runtime:conformance` uses these actual product manifests and adapters against the
configured Kubernetes API. Supply the `FACTORY_FACTORYBOX_*` profile above and explicit
Registry trust through `FACTORY_REGISTRY_CA_FILE`, or `FACTORY_REGISTRY_CA_NAMESPACE` and
`FACTORY_REGISTRY_CA_SECRET`. It creates a unique namespace, worker and store, exercises the
maintained Dev Container and Connector assertions, and adds native Pause/Resume and
per-Sandbox resource observations. It never uses an Envbox container or fixture Kubernetes
responses. A failed runtime proof retains its private store and fences only its own Pod to
release fixture RAM. `runtime:smoke:down` refuses that retained evidence.

```sh
bun run factorybox:worker render .factory/test-results/worker-request.json > .factory/test-results/worker-resources.json
kubectl create -f .factory/test-results/worker-resources.json
bun run factorybox:worker inspect .factory/test-results/worker-request.json .factory/test-results/worker-identity.json
```

Use a fresh namespace and `create`, not adoption of existing resources. If creation has an
uncertain outcome, inspect the exact named objects and original request before any new create.
Inspection requires matching namespace/Pod/PVC ownership, bound storage, node placement, complete
worker configuration and HTTP readiness before its first exec. The identity file is created
exclusively and records Kubernetes UIDs, store, worker epoch, boot and executable. The probe starts
inside PID 1 after cgroup delegation. An early Kubernetes exec probe would interfere with that
delegation, so the manifest uses HTTP probes.

The Pod has `restartPolicy: Never`. There is no Deployment, automatic replacement or recovery
after node loss. A node reboot leaves the Pod `Failed` and changes the node boot ID. Inspection
then reports a node-loss error naming the recovery command. If the node is deleted and the Pod
object is garbage-collected, Factory cannot observe termination and refuses recovery, so keep
the node (see the managed-cluster section of the operations guide). Keep a failed worker's complete PVC and original identity for explicit recovery.
The health port serves only `GET /readyz` with an empty 204/503 response; it is not an admin API.

### Recover an admitted product worker

Settle or explicitly Stop existing execution before stopping the original worker. Keep its Pod
with `restartPolicy: Never` so Factory can observe its exact UID and terminal phase.
Do not delete its Namespace, Source claim or store, mutate the admitted Pod, edit database rows
or repeat an uncertain Sandbox Start.

An authenticated System Manager can POST `{"requestID":"<new UUID>"}` to
`/api/admin/worker/recover` with the normal Factory session and same-origin command header.
The configured worker image and executable select the independently qualified successor.
Reuse that request UUID to observe the same completed recovery after a lost response.
The command refuses running, missing or replaced original Pods, unresolved execution and
foreign stores. Refusal leaves the admission unchanged.

Recovery retains the new declaration without starting a Sandbox. The next explicitly commissioned
execution creates the successor Pod on the original node, reusing the exact store and Source claim.
A read-only inspector verifies the original initialization receipt, bounded image inode and
capacity and requires its old lease to be released. Old imports, exports and runtime histories
remain retained; new exports have separate admission-scoped inputs. A failed successor bootstrap
using that store needs another explicit operator recovery, never a new-store bootstrap retry.
See the worker recovery design.

### Lifecycle commands

Prepare the complete OCI bundle inside the bounded store, for example
`/var/lib/sysbox/fixed-store/data/store/input/project/bundle`, using Factorybox's admitted overlay
layout. This command does not pull/unpack images, prepare a Project checkout or replace the
Factory Connector. Factory's product preparer separately declares and validates the canonical
Source bind; this administrator command does not prepare it.

Save one operation JSON before calling `run`:

```json
{"action":"start","sandboxID":"owned-example","bundle":"/var/lib/sysbox/fixed-store/data/store/input/project/bundle"}
```

```sh
bun run factorybox:worker run .factory/test-results/worker-request.json .factory/test-results/worker-identity.json .factory/test-results/start.json
```

Supported operation shapes:

| Action | Additional fields |
| --- | --- |
| `capacity` | none |
| `state`, `delete` | `sandboxID` |
| `start` | `sandboxID`, `bundle` |
| `pause`, `resume` | `sandboxID`, `snapshotID`, an immutable 32-character hexadecimal ID |

`run` exclusively creates and fsyncs `OPERATION.intent.json` before external work, then writes
`OPERATION.result.json`. It never overwrites either file. A nonzero exit, timeout or partial response
remains unconfirmed. Inspect the original operation and worker state. An explicit exact replay
uses a new journal filename with the same Sandbox/snapshot identities, not a replacement Sandbox.
Every lifecycle exec pins the expected store and epoch inside Factorybox itself. This closes the
race between the Kubernetes read and an exec reaching a replacement worker. The 420-second
lifecycle deadline includes inspection; no automatic command retry is enabled.

Changed UIDs, epochs or boots refuse execution. An explicit new inspection is not permission to
resume an old Sandbox in a new epoch. Retained recovery requires Factorybox's separate exact
recovery protocol and remains outside this command.

### Verification and limits

```sh
bun test packages/runtime-kubernetes/src
bun run typecheck
bun run check:docs
```

The explicit native transport proof in `scripts/runtime/factorybox-worker-native.ts` is invoked by
Factorybox's owned `tools/kubernetes_worker_probe.py`. It uses fixture Kubernetes observations
and executes the real delivered worker CLI. It proves Start, useful work, RAM mutation, zero
anonymous/snapshot residency after Pause, exact RAM/file retention after Resume, completed replay
without a second process and Delete.

Factory's product path binds the canonical Source directory under the admitted shared-source
contract. Native acceptance must preserve atomic editor saves made while paused, the same app RAM
and the original Dev Container after Resume. The actual Factory Connector and reserve activation
are exercised by Factorybox's `tools/factory_consumer_native.py`. Independent Theia remains outside worker resource accounting.

## Runtime artifacts

`runtime-host` is the common Factorybox consumer image for Development, Coding, Staging,
Verification and publication. It contains Docker
Engine 29.9.0, the integrity-checked Dev Containers CLI 0.89.0 and the static Factory Runtime Connector.
It also contains the pinned OpenCode server, admitted Skill installer and Forgejo runner.
Factory starts only the processes and grants only the capabilities of the assigned role.
Its development language preset
contains pinned TypeScript Language Server and Pyright packages with the exact Node 24.21.0
runtime for glibc and musl. Only interactive Development assignments inject those tools; source
opening starts none of them. They use the Dev Container's Project toolchain and dependencies.
The Connector injects the tools required by the assigned role into its primary
Dev Container. A Runtime Attempt records its exact artifact and role before creating compute;
recovery cannot replace that artifact through changed installation settings.

`developer-ide` contains the independent pinned Theia 1.76.0 composition. One developer backend
serves authorized Workspace-qualified source through Factory. Theia does not run in each execution
Sandbox. Its package composition and npm integrity lock remain in `deploy/theia-ide/`.

Publish the artifacts with:

```sh
mise exec -- bun scripts/factory/index.ts publish-runtime
```

Publication updates the local digest files without restarting Factory or replacing existing runtime
identities. `factory:restart` loads those pins for new Attempts; existing artifact intents remain fixed.
Runtime manifests use registry digest references, never publication tags.

The local Registry keeps artifacts on its retained `registry-data` claim, not in a Pod's temporary
filesystem. Publication refuses to replace an existing temporary store with an empty claim.
Preserve that Registry's contents on the claim before adopting the persistent layout; do not reset
Workspaces or replace frozen Runtime Attempt image references to repair missing images.

Startup, restart and local Factory image builds check every role's remote manifest without pulling
or warming an image cache. The local Registry check uses its approved CA and verifies the exact
manifest digest. Missing images fail with the artifact name before replacing the running Factory
server; local Registry failures also identify the HTTP status. Restore the exact artifacts, or publish
a complete generation and restart to select it for new Attempts. Publication adopts its complete
generation atomically only after the common runtime, editor, source and browser manifests and
the Starter images are confirmed.

Normal `factory:up` reuses an available published set instead of rebuilding all roles. The manual
[distribution workflow](../../../.github/workflows/images.yaml) builds amd64/arm64 roles and embeds
their exact multi-architecture digests in the Factory image. A release bundle replaces defaults
atomically during container startup; it cannot change a persisted Runtime Attempt. See
local deployment for Compose and Linux setup.

The clean execution reserve prepares fresh Staging and Verification only. It contains pinned tools
and base images, no checkout, user/model/forge capabilities or used containers/volumes. Default target
is one slot per role, with one concurrent creation, two spare slots and sixteen total admitted or
spare/creating/retiring slots. Unassigned slots expire after fifteen minutes; preparation is bounded
at three minutes and failure replacement waits thirty seconds. `FACTORY_EXECUTION_RESERVE_TARGET`
accepts 0–4 per role; `FACTORY_EXECUTION_MAX_SLOTS` accepts 2–256 and must cover the configured reserve.
Every Factorybox worker currently has a shared 3-CPU/3-GiB ceiling, including reserve workers.
Assignment preserves its exact Pod/PVC, issues new Attempt capabilities and immediately requests
refill. Used slots are destroyed, never returned. Development Workspaces retain their canonical
source and normal retained-storage preparation; no running Pod/PVC hot swap is performed.

Opening an editable Workspace automatically starts or resumes its compute. This commissions no
Agent Turn. Read-only observation does not claim writing authority. A failed Start remains visible
with an explicit Retry, rather than repeating on every observation.

Development compute idles after fifteen minutes without use (two when nothing is attached). `FACTORY_EXECUTION_IDLE_MINUTES`
accepts 0–1440; zero disables it. Admitted/uncertain Build, working Sessions, pending commits,
open terminal sessions and pending runtime operations prevent automatic Pause. Native PTY Resume
currently fails to reopen `/dev/tty`, so even detached idle prompts block Pause. A Run view,
language connection or background App polling does not count as human use.
The Connector samples terminal work every five seconds; missing or stale observations block Pause.
Pause intent is committed under the Build admission locks before the native operation.
Real editor activity resumes the same Attempt. Restart grants a fresh inactivity period.
Source/approved data and the independent editor are retained. Staging and Verification do not idle.

After successful prebuild and compute cleanup, private Docker trims unused build cache toward
1 GB within fifteen seconds. It never prunes images, containers, volumes, installed dependencies or
checkout. This is a best-effort cache target, not a filesystem quota. The local RWO provisioner's
8 GiB claim request does not establish a hard disk quota; deployments need storage-enforced quotas
for that guarantee. CPU bursts and RAM use the worker's declared total limits;
local measured RAM remains unavailable when Kubernetes Metrics is not installed.

The parent resolves the approved Dev Container configuration before startup and prepares only the
selected registry images and their required Compose dependencies. Images must be digest-pinned;
Docker's canonical repository/digest identity, rather than a tag's text, confirms a cache hit. At most
two acquisitions run concurrently, with an overall 180-second deadline and Stop cancellation. Required
Dev Container hooks and resolved-container boundary checks still run. Each Workspace retains its own
private Docker graph. Registry artifacts can be reused; mutable dependency trees and prior
Verification results cannot.

The host also includes `factory-project-prebuild`. Run it inside the assigned Sysbox host, where it
uses that Workspace's private daemon, with an exact commit, target architecture and Project-owned
registry repository:

```sh
factory-project-prebuild --commit <full-commit> --platform linux/arm64 \
  --config .devcontainer/prebuild/devcontainer.json \
  --image-repository <approved-registry>/open-factory/prebuilds/<project-id>
```

The optional configuration is a normal committed Dev Container image/Dockerfile recipe, not a new
Factory configuration format. The producer resolves it with the pinned CLI, builds local Features
from the exact committed tree, requires digest-pinned external image/Feature inputs and uses the
CLI's committed frozen Feature lock. Local Features must remain inside `.devcontainer`, as required
by that pinned CLI. Put locked dependency installation in the Dockerfile. Its image can
carry immutable dependency seeds; required normal lifecycle hooks populate each owner's writable
checkout without sharing a mutable dependency tree. Compose consumers reference the resulting
ordinary registry digest. This producer does not prebuild a multi-image Compose stack or run a
background build service.

The producer snapshots committed inputs separately from human/Agent files. Its identity includes
Project, commit/tree, configuration, platform, exact CLI integrity and immutable image inputs.
It persists intent before build/publication, verifies image ownership/platform, recovers a produced
image after lost acknowledgement and never treats a publication tag as the consumer identity.
Publication names retain the first creating Runtime Attempt, so independent private daemons cannot
race on a shared tag; Stop/restart retains that persisted name. Dockerfile snapshots receive ordinary
Factory ownership labels at each selectable stage because the pinned CLI forwards its label option
only in the image/Feature path. Neither the canonical Dockerfile nor upstream CLI is modified.
One producer runs per Workspace, with a ten-minute bound, bounded snapshot size and owned interrupted
snapshot cleanup. It passes no reusable Factory, model or forge capabilities into the build. Git,
CLI and registry output does not become product Evidence. This freezes the recipe and identifies
the resulting artifact; arbitrary network-dependent Dockerfile commands are not a reproducibility
guarantee. Private cache eviction does not delete canonical source or approved data.

Snapshot creation uses a temporary root-private Git configuration trusting only that canonical
checkout and its Git directory. This passes the exact trust boundary to local upload-pack on Git
versions that discard command-line overrides, without changing user or installation configuration.
