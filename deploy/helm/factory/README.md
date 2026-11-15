# Factory with official Substrate

This chart installs the Factory control plane on an existing Kubernetes cluster. Factory uses
only the pinned official Substrate runtime. It does not install a cluster, an Ingress controller
or a private runtime fork. The native replacement is not yet qualified as a complete shipped
product. Use the checkout chart and explicitly qualified images until the live product gates pass.

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
- Factory and Forgejo public TLS origins, DNS and an operator-owned Ingress certificate. Native Git
  requires a DNS Forgejo hostname on port 443, admitted by the frozen native egress configuration.
  Factory's isolated browser hosts also need `*.runtime.<factory-hostname>` in DNS and the certificate.

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

Create two operator-owned Secrets in the release Namespace:

- `substrate.workspaceConfigurationSecret`, with `configuration.json` and `factory-ca.pem`.
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
  tlsSecret: your-existing-certificate-secret
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
native configuration, not Factorybox workers. Its full product cutover is not yet qualified.
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
browser uses a loopback listener. Source-launcher, Starter and Delivery qualification remain open.
There is no one-image HTTP-worker installation or legacy runtime fallback.

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
  this identity existed is not supported by this Greenfield installation path.
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
5. Scale Forgejo, Zero and Factory to one and wait for readiness. Startup requires the exact native baseline fingerprint
   recorded by this image. Historical or mismatched schemas are refused without modification.
   Use the matching image and data, not a historical forward-migration sequence.

These data-service restore steps do not qualify restoration of native Actors, snapshots or a
complete Factory product journey. Keep native credentials withheld until an independent native-safe
rehearsal proves all relevant identities and Source/Writer safeguards.

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
checkpoint. Unknown replies are not replayed, and SUSPENDING finalization belongs to Substrate.
Only a newly confirmed checkpoint permits the next deliberate Resume.

For active Coding, Compute Stop must first confirm the existing Agent Stop, including queued
work in its verified child-Session tree. It retains unrelated root Inbox entries and refuses
snapshot/deletion when settlement remains unknown. A never-confirmed fresh bootstrap has no
submitted input only when its original native-confirmation barrier is positively fenced.
Offline Stop now has a bound Stop-only cold path for a paused original Actor with
independent Source and the declared bootstrap capability. It does not use ordinary
Resume, replay an uncertain Resume, or create a recovery Actor for an already
deleted fixture. Settlement still requires its exact joined SDK result, a new
durable ROOTFS and independent Source handoff. This path still needs full native
qualification; package and controlled coordination checks are not a shipped journey.

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
Factory neither installs a cluster metrics-server nor requests its Pod metrics API. The pinned
native API does not expose per-Actor CPU/RAM samples. Current consumption stays unavailable rather
than substituting a shared Worker's aggregate or reporting missing measurements as zero.

## Runtime artifacts and remaining gates

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

Reserve distinct, unused public Factory and Forgejo DNS names through the existing Ingress
controller. Supply a currently valid leaf certificate and matching private key covering both
names and `*.runtime.<factory-hostname>`, plus its public CA bundle. The command checks for
overlapping existing Ingress hosts before creating resources. It does not configure DNS, install
a runtime or weaken certificate validation. The browser host must already trust the certificate.

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
regression coverage. Clean installed-image qualification, native prebuild/Verification, offline
OpenCode Stop/manual Continue and the complete approved Ticket through Delivery and healthy
Staging remain live gates. A fresh installation must serve at least two ordinary Projects before
this replacement is described as shipped.
