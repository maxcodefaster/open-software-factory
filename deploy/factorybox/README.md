# Factorybox worker admission

Factorybox is a separate Linux system-container runtime. This operator command admits one
dedicated worker for a customer or trust domain and controls administrator-prepared private OCI
bundles through its own CLI. Factory Workspace Start and the execution reserve use this same worker
contract with Factory-owned consumer preparation. See [Workspace execution](../../docs/adr/0022-factorybox-workspace-execution.md).

The Helm chart requires `factorybox.image`, `factorybox.executableSHA256`,
`factorybox.architecture`, `factorybox.nodeName` and `factorybox.kernel`. The local launcher uses
`FACTORY_FACTORYBOX_WORKER_IMAGE`, `FACTORY_FACTORYBOX_EXECUTABLE_SHA256`,
`FACTORY_FACTORYBOX_ARCHITECTURE`, `FACTORY_FACTORYBOX_NODE` and `FACTORY_FACTORYBOX_KERNEL`.
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

## Local worker build

`bun run factorybox:build REQUEST_JSON` invokes the standalone repository's pinned
worker pipeline. It records intent and output under `.factory/test-results/`, checks
the final image architecture and the actual executable bytes inside that image, and
writes `profile.candidate.json` in the existing Factory runtime-profile format.
It neither publishes an image nor changes an installed profile or retained Sandbox.

The request names exact completed inputs, not a floating tag or latest artifact:

```json
{
  "repository": "/absolute/path/to/factorybox",
  "platform": "linux/arm64",
  "nativeBaseBuild": "factorybox-build-native-base-REPLACE_WITH_32_HEX_CHARACTERS",
  "builder": "REPLACE_WITH_RUNNING_BOUNDED_BUILDER",
  "boundedBuild": true,
  "network": "host",
  "dockerContext": "orbstack",
  "nodeName": "orbstack",
  "kernel": "REPLACE_WITH_ACTUAL_KERNEL_RELEASE"
}
```

The standalone README describes native-base and bounded builder preparation.
Optional `sysboxBuild` and `retainedCandidate` reuse exact verified completed component
builds. All components must match `platform`. An AMD64 build on ARM64 remains a
cross-build; Factory runs the native `doctor` probe only on a matching Linux Docker
host. Even a matching doctor is not a lifecycle qualification.

The current ARM64 candidate implements timer continuation and has native functional
Start, shared-source Pause/Resume and Connector proofs. Full ARM64 release qualification
remains open in the standalone repository. Build success is not qualification, and
selecting a candidate profile requires native acceptance of its exact bytes on the target
node. The existing installation stays unchanged when a build or runtime probe fails.

## Request and deployment

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
  "kernel": "7.2.8-9-omarchy",
  "boundedBytes": 8589934592,
  "claimGiB": 32
}
```

Replace the example store and trust-domain IDs with random 32-character hexadecimal identities.
Factory renders and validates either Linux ARM64 or AMD64 using the same worker protocol.
The current standalone runtime candidate is qualified only on its exact Linux AMD64 kernel
and 4096-byte pages. ARM64 has its own native acceptance requirements. Selecting
`arm64`, building an image or changing `kernel` does not qualify that runtime. Inspection checks the node's OS,
architecture and kernel against the live worker. Node-reported and kernel-reported boot IDs
are pinned separately; a later change to either refuses the original admission. Worker startup checks its actual
cgroups, component identities, store lease and filesystem. Another node profile needs native
qualification before use.

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
after node loss. Keep a failed worker's complete PVC and original identity for explicit recovery.
The health port serves only `GET /readyz` with an empty 204/503 response; it is not an admin API.

## Recover an admitted product worker

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
See [ADR 0031](../../docs/adr/0031-recover-an-admitted-worker-with-its-retained-store.md).

## Lifecycle commands

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

## Verification and limits

```sh
bun test packages/runtime-kubernetes/src
bun run typecheck
bun run check:docs
```

The explicit native transport proof in `scripts/runtime/factorybox-worker-native.ts` is invoked by
Factorybox's owned `tools/kubernetes_worker_probe.py`. It uses fixture Kubernetes observations
and executes the real delivered worker CLI. It proves Start, useful work, RAM mutation, zero
anonymous/snapshot residency after Pause, exact RAM/file retention after Resume, completed replay
without a second process and Delete. This is not an API-server, kubelet, CSI or Kubernetes
qualification. A connected target cluster is still required for that acceptance.

Factory's product path binds the canonical Source directory under the admitted shared-source
contract. Native acceptance must preserve atomic editor saves made while paused, the same app RAM
and the original Dev Container after Resume. The actual Factory Connector and reserve activation
are exercised by Factorybox's `tools/factory_consumer_native.py`; this still does not qualify a
target cluster's CNI or CSI. Independent Theia remains outside worker resource accounting.
