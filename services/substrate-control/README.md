# Factory Substrate control boundary

This executable makes **one public gRPC call**, using the official generated
Substrate v1.0.0 client. The module checksum pins commit
`b34fbee742906494b5eb4f1f36987176bf8770a4`. There is no REST facade, daemon,
provider registry, native source fork, transition journal or retry controller.
Factory owns its existing Attempt intent and access checks; Substrate owns Actor
transitions. No action runs when Factory constructs the adapter.

```sh
mise exec -- go -C services/substrate-control build -trimpath -o "$OUT/substrate-control" .
mise exec -- bun run substrate:check
```

The JSON command on stdin contains `endpoint`, `serverName`, `caFile`,
`tokenFile`, `method` and the public protobuf-JSON `request`. Stdout is the public
protobuf-JSON response, or `{ "error": { "code": "...", "message": "..." } }`.
Credentials are paths, never command-line tokens. Each process reopens both
projected files, verifies the serving certificate against that CA and
`api.ate-system.svc`, and attaches the current bearer token. gRPC retries are
disabled. Suspend requires explicit synchronous durability; Delete requires UID
**and** version. Fresh Workspace provisioning additionally permits deterministic
Factory Atespace creation, its single Editor grant and ROOTFS runtime template;
global AccessPolicy administration remains unexposed. The Factory adapter also verifies GetAtespace, GetActorTemplate and the
Actor-specific egress policy before activating its Connector.
Resume and synchronous Suspend keep caller cancellation but add no Factory
wall-clock deadline. Substrate's own checkpoint, transfer and wakeup budgets apply;
a shorter client deadline can interrupt finalization after a checkpoint commits.
Other RPCs retain the existing finite lookup/create bound. No RPC is retried.
The Factory adapter also saves immutable Resume/Suspend dispatch facts under its
existing runtime lock, bound to the original Actor and preceding confirmed ROOTFS
UUID. Lost replies in the preceding native state are observed, not replayed. Only a
recorded SUSPENDING Actor may re-enter the official workflow with the original dispatched
operation and exact persisted snapshot identity. This continues that snapshot rather
than capturing a new one; PENDING progress never permits Source handoff or Resume.
A new confirmed checkpoint permits a later deliberate
Resume; an unresolved Pause never reopens Connector authority. These are execution
facts, not a second lifecycle controller.

The normal Factory image packages this executable at
`/usr/local/bin/factory-substrate-control`. The
[fresh Workspace product path](../../deploy/substrate/README.md#fresh-factory-workspace-provisioning)
uses authenticated Factory commands rather than operator-prepared Workspaces or
templates. It documents the unavoidable native global-Owner provisioning grant,
separate rotating credentials and the initial active-Actor Source boundary.

## Explicit adapter proof

The owned native test exercises
[`createSubstrateExecution`](../../apps/factory/src/runtime/substrate.ts) directly.
It is not an alternate Factory installation mode or a prepared-binding production
constructor. The normal runtime controller requires installation-wide Substrate
configuration and the persisted native provisioning owner.

The direct proof requires `deployment: "owned-test"`, an exact `database` named
`owned_<32 lowercase hex>`, `projectID`, the deterministic personal `workspaceID`,
`generation`, and these immutable native inputs:

- `connection`: absolute `bridge`, `caFile`, `tokenFile`, explicit gRPC `endpoint`
  and `serverName: "api.ate-system.svc"`.
- `connectorURL`: the exact `wss://HOST:PORT/internal/runtime-connect` endpoint.
  Factory creates only the matching TLS-passthrough egress allow, with no wildcard.
- `atespaceUID`, `templateUID`, `templateVersion`, `templateSHA256`.
  `substrateTemplateSHA256` hashes canonical public template spec without
  server-managed metadata/status. Use the actual GetActorTemplate response.
- `profile: "nightly-20261109-975fb172241c"` and `runtime`: the actual
  `sandboxClass: "gvisor"` and complete `version`/attributes from the qualified
  native worker. Running assignment and snapshot compatibility must match exactly.

The proof owns a fresh personal Workspace with no earlier Attempt. Its native
Actor receives no synthetic worker or Kubernetes Pod identity. Factory persists
Attempt, unique names, exact native
inputs and a secret-derived Actor selector before CreateActor. Atespace is
`fa-<Attempt UUID without hyphens>`, Actor is `runtime-<same suffix>` and template
is `runtime` in that never-reused Atespace. The adapter fixture prepares that exact
template and an owned WorkerPool with the label returned by
`substrateActorSelector(Factory connector signing secret, Attempt ID)`.
This selector, unique template/scope, dispatch time and returned UID prevent
name-only adoption. A preexisting Actor or a positively rejected Create is not
adopted. After a lost Create reply, Factory observes the same expected resource;
it never dispatches another Create. A missing original remains unknown.

## Authority and projections

Use the [dedicated ServiceAccount](../../deploy/substrate/control-serviceaccount.yaml)
and the [owned Deployment patch](../../deploy/substrate/control-deployment-patch.yaml).
Apply the patch explicitly to the **owned** Deployment with its namespace and
context; these are not part of the retained Helm defaults. The projected token
has audience `api.ate-system.svc` and a 600-second lifetime. The projected serving
CA follows the native live ClusterTrustBundle. Read-only mode 0444 permits the
non-root Factory container to read the projection without an `fsGroup` mutation
of retained storage. Mount it only in the trusted Factory control-plane container.
Neither a Kubernetes RBAC role nor global native owner permission is granted.

A separately authorized control-plane operator creates Atespace and
AtespaceAccessPolicy. Give only `editor` in that exact Atespace to
`user:system:serviceaccount:NAMESPACE:factory-substrate-control`. Never pass
bootstrap `ate-client`, operator, Kubernetes or host-Docker credentials to an
Actor. Atespace permission does **not** grant Factory Workspace access.
Factory's Developer, personal owner, current Attempt/generation and current
grant checks remain at Start, Resume and Connector admission; normal Factory
browser grants and writer checks remain in their existing owners.

The template launches the actual Parent/Child Connector with the immutable
assignment and per-role Attempt capabilities. Project the native Actor UID with
SystemInfo `ACTOR_METADATA_FIELD_UID` and set `FACTORY_SUBSTRATE_ACTOR_UID` from
that file. Factory checks this UID in addition to the bearer capability and
generation. This does not accept or trust an unvalidated Actor JWT. The
Connector uses standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` selection for both
roles. Set `FACTORY_CONNECTOR_CA_FILE` to an additional projected trust bundle
when needed; it is reopened on every WSS handshake, adds to system roots, and
never disables hostname validation. Cold reconnect creates new processes/PTYS;
no memory, terminal or connection continuity is promised.
The profile's `SSL_CERT_FILE` must remain its combined public + MITM bundle,
not a diagnostic-only CA. It is reopened as the authoritative bundle on each
handshake, including removal of rotated-out anchors; the optional Factory CA
file adds trust rather than replacing that bundle.

Use the profile's explicit command chain `start.sh connector.sh CONNECTOR_ENTRYPOINT`.
The optional [connector.sh](../../deploy/substrate/rootless/connector.sh) enters the
**existing Actor-private** RootlessKit user/mount/network namespace after private
Docker readiness. Otherwise the outer Actor's loopback cannot reach Tinyproxy
on `127.0.0.1:8888`. No host namespace, socket, mount or credential is injected.
This does not change the standard `start.sh` or its accepted runtime pins.

Public ResumeActor/SuspendActor in this release accept only ObjectRef, not
UID/version preconditions. Factory checks the original UID/template/runtime
before and after, and retains permanent name tombstones; operators must not
recreate resources under those names. Delete uses the public UID/version
preconditions. Mutation of templates or foreign resources fails closed rather
than being repaired or adopted.

## Durability and remaining gates

Factory requests SYNCHRONOUS Suspend, validates the returned ROOTFS snapshot,
then independently Gets the Actor and requires the same UUID/generation,
ActorUID in the storage URI, template UID, exact runtime and durable COMPLETED.
Local-only, PENDING, VOLUMES, another generation, and merely SUSPENDED are rejected.
Failures retain the previous good checkpoint. Workspace Stop confirms the
independent editable Source owner under the same Workspace lock before UID-bound
Actor Delete. Missing Source or its failed materialization prevents deletion.
Failed initial preservation may support Pause, but cannot masquerade as independent
Source or a completed Stop. A lost Delete reply reconciles the original Actor's
absence without recreating it.

There is no fallback/revert,
checkpoint garbage collector, model/tool replay or Source-node data release.

The Factory API exposes native observed status and explicitly
`coldRestart: true`, `portable: false`, and the recorded Source-handoff result.
The direct adapter proof is **not production runtime cutover**. Portable Source,
full Factory toolchain feature qualification, independent editor/Coding/Verification/Delivery and
different-node recovery remain separate gates. The native integration test is
explicitly classified in the native lane and errors if its owned fixture is
missing; it must not be reported as a complete Factory E2E.

```sh
mise exec -- bun run test:controllers substrate-adapter.test substrate-lifecycle-facts
FACTORY_SUBSTRATE_NATIVE_FIXTURE="$OUT/native-fixture.json" mise exec -- bun --no-env-file \
  test test/integration/substrate-adapter.native.test.ts --timeout 300000
```
