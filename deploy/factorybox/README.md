# Factorybox worker admission

Factorybox is a separate Linux system-container runtime. This operator command admits one
dedicated worker for a customer or trust domain and controls administrator-prepared private OCI
bundles through its own CLI. Factory Workspace Start and the execution reserve use this same worker
contract with Factory-owned consumer preparation. See [Workspace execution](../../docs/adr/0022-factorybox-workspace-execution.md).

The Helm chart requires `factorybox.image`, `factorybox.executableSHA256`, `factorybox.nodeName` and
`factorybox.kernel`. The local launcher uses the equivalent environment variables
`FACTORY_FACTORYBOX_WORKER_IMAGE`, `FACTORY_FACTORYBOX_EXECUTABLE_SHA256`, `FACTORY_FACTORYBOX_NODE`
and `FACTORY_FACTORYBOX_KERNEL`. They must identify a verified package and the actual admitted node.
The worker image must be available in the operator's private registry or loaded on that node.
An image built in the developer's Docker daemon is not automatically available to Kubernetes.

Stop existing Envbox executions before changing the installation profile. Existing unused reserve
slots retire when their frozen profile differs. Never adopt a used Envbox execution as Factorybox
or overwrite its immutable runtime artifacts. The default reserve target remains zero; set
`executionReserveTarget` only after qualifying the target node, CNI and StorageClass.

Pause/Resume retains RAM on the same live worker. A worker restart or node loss retains canonical
source but requires an explicit fresh execution; automatic cross-node RAM recovery is unsupported.

The command renders ordinary Kubernetes objects and uses the installation's existing kubectl
context or ServiceAccount. It has no cloud-specific implementation, CRD, new database or pool
controller. The worker receives no Kubernetes token or host Docker socket. Keep distinct stores
and workers for distinct trust domains.

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
  "nodeName": "REPLACE_WITH_NODE_NAME",
  "kernel": "7.2.8-9-omarchy",
  "boundedBytes": 8589934592,
  "claimGiB": 32
}
```

Replace the example store and trust-domain IDs with random 32-character hexadecimal identities.
The native candidate currently accepts only its exact linked Linux AMD64 kernel and 4096-byte
pages. Setting `kernel` does not broaden that qualification. Inspection checks the node's OS,
architecture, kernel and boot identity against the live worker. Worker startup checks its actual
cgroups, component identities, store lease and filesystem. Another node profile needs native
qualification before use.

The Pod has a 3 CPU / 3 GiB limit and reservation, a private PID namespace, privileged access and
a read-only `/lib/modules` mount. Its complete `/var/lib/sysbox` state uses a dedicated RWO PVC.
The bounded filesystem size is explicit; the PVC must also cover 16 GiB of host admission
headroom and metadata. `storageClass` is optional. Empty volumes must have root-owned parents
without group/world write permissions; existing stores are never reformatted or migrated.

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
