# Substrate runtime checks

Factory uses the pinned official Substrate API and gVisor ROOTFS profile. Factory owns product
authority and execution intent. Substrate owns Actor lifecycle and snapshots. The previous
Factorybox build, lifecycle, reserve and warm-memory benchmark commands have been removed.
Existing private evidence is retained; no old worker or storage cleanup is run by this checkout.
The source launcher also leaves cluster monitoring alone. It does not install metrics-server;
existing monitoring owned by the operator is not removed or reconfigured.

## Operator setup

Read [the native profile](../../deploy/substrate/README.md) for the approved upstream commit,
worker/gVisor pins, serving trust, separate Owner and Editor credentials, TLS egress, Actor image
and installation-wide configuration. Execution uses the explicit Linux amd64 or arm64 runtime
identity, never the control-plane host's architecture as a fallback. An artifact download,
control-plane build or ordinary Docker component test does not qualify that profile.
The owned ARM infrastructure proof has separately verified actual worker/runsc
checksums, current-image private Docker, native DNS/TLS policy, synchronous durable
ROOTFS cold restart and UID-bound Actor deletion. It is not the normal Factory
Workspace/Source path or complete product acceptance.
The [current qualification scope](../../deploy/substrate/README.md#qualification-scope) records
the separately exercised ARM product path. The commands below retain their individual fixture
boundaries; a passing component receipt is not a substitute for that product path.

The profile tools are explicit operator commands:

```sh
mise exec -- bun scripts/runtime/substrate-profile-command.ts assets /absolute/owned/arm64-assets arm64
mise exec -- bun scripts/runtime/substrate-profile-command.ts render /absolute/profile-input.json /absolute/owned/rendered
```

These commands download verified official assets or render declarations. They do not install
a private runtime or qualify a running Factory. Apply and live egress verification require the
exact upstream checkout, explicit kubeconfig and context described in the native profile.

## Native lifecycle proofs

Prepare separate, explicitly owned fixtures and set `FACTORY_SUBSTRATE_NATIVE_FIXTURE` and
`FACTORY_SUBSTRATE_WORKSPACES_NATIVE_FIXTURE` to their private JSON files. The concrete schemas
and ownership requirements live in the
[adapter proof](../../test/integration/substrate-adapter.native.test.ts) and
[Workspace proof](../../test/integration/substrate-workspaces.native.test.ts).
Do not point these at a retained user installation.

```sh
mise exec -- bun run runtime:conformance
```

This runs the official gRPC/Connector lifecycle proof and authenticated Factory Workspace proofs.
Missing fixture configuration is a failure, never a skipped or successful proof. These tests cover
their explicit assertions, not a released-image, two-Project Helm acceptance or the complete
approved Ticket through Delivery. The operator remains responsible for the exact native fixture
inventory the tests retain. There is no general Namespace cleanup or finalizer-removal command.

## Product live fixtures

The Environment and external MCP proofs use a separate Factory process and an `owned_<32 hex>`
database. Run their control plane on Linux as UID 1000. Supply
`FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION` with the normal `fresh-workspaces` configuration,
the observed pinned worker identity and separate Owner and Editor token files. The fixture writes a
private copy with its new database name. It never rewrites the operator's configuration or changes
the identity of a retained fixture.

Commission reachable TLS routing for the fixture's configured Connector and Forgejo origins.
The API and public Forgejo addresses may differ, but native Git uses the exact public HTTPS
origin on port 443, admitted by the frozen native egress configuration. Loopback browser
transport is not an Actor callback route. The fixture helpers do not install DNS, an Ingress,
a registry, native workers or the object store for you.

For the Environment proof, also set:

- `FACTORY_FORGEJO_API_URL`, `FACTORY_FORGEJO_PUBLIC_URL` and `FACTORY_FORGEJO_OWNER`.
- `FACTORY_NATIVE_RUNTIME_FORGE_TOKEN_FILE`, a private file with repository-creation authority
  for that owned Forgejo account.
- `FACTORY_NATIVE_REGISTRY_FIXTURE`, a private JSON file with `owner`, `deployment`, `host`,
  `username`, `password`, `certificate`, `developmentImage` and `feature`.
  `owner` is the fixture UUID. `deployment` matches the native WorkerPool selector. `host`
  matches both `prebuildRegistry` and an admitted egress host, without a port or IP address.
  The certificate contains only public PEM certificates. Both image references must be immutable
  digests below `HOST/open-factory/native-fixtures/OWNER_UUID/`.

The private development image must provide Node.js and the `node` user. The private Feature's
`install.sh` writes `prepared` to `/opt/owned-remote-feature`; its `postCreateCommand` writes
`ran` to `remote-feature-hook.txt` in the Workspace. Those markers distinguish authenticated
Feature installation from a plain successful base-image pull. The registry must reject an
unauthenticated request for the development image's exact manifest with HTTP 401 and permit
the commissioned credentials to pull the fixture artifacts and publish Factory prebuilds.

The external MCP proof starts its own Forgejo and requires
`FACTORY_FORGEJO_PUBLIC_URL` to route to that owned server. It exercises OAuth, local OpenCode,
browser collaboration, commands and file transfers against the same native Dev Container.
Its browser and native service dependencies must be available before selecting the lane.

The publication proof uses the same explicit native configuration and Forgejo HTTPS origin
on a Linux UID-1000 control plane. It starts an owned Forgejo and executes an admitted release
intent through Factory's native publication owner. It checks the original Actor binding,
downloads the actual package, verifies its exact source/release marker and digest, and confirms
credential revocation and Actor Stop. It retains the database, native names, Forgejo and encryption
dependencies. This execution proof does not stand in for the separate human publication admission
or the full approved Ticket/Helm journey. The Forgejo component check no longer hides it behind
an optional runtime flag.

```sh
mise exec -- bun run test:live project-environments.live
mise exec -- bun run test:live external-factory-mcp.live
mise exec -- bun run test:live native-publication.live
```

These proofs require the published runtime-host, browser-tools and developer-ide artifacts.
Missing commissioning inputs are failures, not skipped acceptance. Their assertions have not yet
been qualified together on the pinned live amd64 profile.

The startup browser journey uses an already running, separately owned Factory. Set
`FACTORY_BROWSER_BASE_URL`, `DATABASE_URL`, the Forgejo API/public origins,
`FACTORY_NATIVE_RUNTIME_FORGE_TOKEN_FILE` and `FACTORY_NATIVE_RUNTIME_REPOSITORY` as `owner/name`.
The database must have the owned fixture name above; it must not be the retained installation.
Select `workspace-startup.live.spec.ts` in `test:browser:native`. The proof records saved Actor
bindings alongside visible Source, IDE, PTY and Preview outcomes. Saved binding evidence alone
does not prove current liveness. No worker exec, cache inspection or warm-memory claim is involved.

Stop retains independent Source and product history. It is not permission to drop the fixture
database: native Atespaces, templates or editor inventory may still exist. These proofs pause their
own control plane and record retained inventory under `.factory/test-results/`. Generic live-fixture
disposal refuses database removal while that inventory remains or cannot be confirmed absent.
The commissioned registry and unrelated installation resources stay unchanged.

## Component checks

The rootless proxy regression requires an explicitly selected, already cached Actor or qualified
bootstrap image with Python 3 and Tinyproxy 1.11.2. Supply its immutable digest reference:

```sh
FACTORY_SUBSTRATE_PROXY_TEST_IMAGE='your-registry/actor@sha256:YOUR_CACHED_DIGEST' \
  mise exec -- bun run test:native substrate-rootless-proxy.native
```

Missing input or image cache fails the test. It never pulls or builds images, starts Factory or
acquires PostgreSQL. An exactly owned Docker container uses `--network=none`, a read-only root,
no capabilities, no privilege escalation, one CPU and 256 MiB memory. The unchanged repository
proxy configuration must carry a real verified-TLS HTTP 200 response after 35 silent seconds.
Wrong CA and hostname checks must fail certificate validation. Cleanup checks the owner UUID and
original container ID, removes that container and deletes both fixture private keys.
Receipts default to `.factory/test-results/substrate-rootless-proxy/OWNER_UUID/`; set
`FACTORY_SUBSTRATE_PROXY_TEST_RESULTS` to choose another evidence directory under
`.factory/test-results/`. This is a packaged-proxy component check, not native Actor lifecycle,
Substrate isolation or native product acceptance.

`substrate-image-proof.sh` checks the Actor package on its matching native Linux architecture
without starting an Actor. Emulated host/image mismatches are refused.
`compose-inputs-proof.sh` and `project-compose-prebuild-proof.sh` exercise the shipped Compose,
Buildx and Dev Containers components in separate, exactly owned ordinary Docker containers.
The latter proofs deliberately use no network, host Docker socket, Project source or credentials.
Their receipts state `nativeSubstrateProof: false`. They are publication gates for the packaged
components, not proof of Substrate isolation, actual worker placement or ROOTFS lifecycle.
Its `cold-prebuild` recipe stops the original prepared-image primary, removes its temporary
override, edits application Source and reopens that same container with the pinned CLI.
The image/input and public configuration must still match; a successful component run does
not qualify native Source restoration or an approved Ticket journey.
`credential-free` checks committed prebuild matching and CLI startup without Runtime
environment or registry credentials. The reserve/template-fork, captured-process activation
and private prepared-primary image paths have been removed, including their component recipes.
Normal startup still validates prebuild input identity, native dependency images and required hooks.

Controlled controller tests use real PostgreSQL and Factory owners with explicit RPC responses.
Keep them separate from live native evidence. Cold restart is the accepted model; no check here
promises warm memory, preserved process IDs, provider comparisons or billed compute savings.

The independent editor's Kubernetes admission and UID-bound cleanup have a separate real-API proof:

```sh
FACTORY_IDE_NATIVE_CONTEXT=your-explicit-context mise exec -- bun run test:native developer-ide-kubernetes.native
```

It creates an exactly owned Namespace and nonprivileged Node component Pod, then proves refusal
of a changed UID, deletion and cleanup without finalizer changes. It does not qualify Theia,
the editor browser journey or Substrate execution.

## Product acceptance

The old Factorybox upgrade, soak and restore-rehearsal programmes have been removed, including their
commands, historical-table queries, worker-Pod inspection and installation-identity rewrites.
The read-only `scripts/kubernetes/restore-check.ts` still checks backup archive readability and
checksums. That is not restore qualification.

The `release:clean-room` control-plane check requires `--native-fixture` with fresh native and
TLS inputs. Its receipt remains `nativeProductAcceptance: false`, even if the limited optional
Project steps run. See
[fresh native commissioning](../../deploy/helm/factory/README.md#owned-native-clean-room-inputs)
for the input contract, capacity/preflight checks and exact-owner cleanup limits. Native cleanup
still refuses recorded or unavailable native inventory. Do not substitute an older chart,
disable TLS or delete retained data to get a passing receipt.

The exact-commit `beta:gate` source receipt also includes `substrate:check` alongside the Connector,
controller and UI checks. Release receipt reuse requires that bridge result and its declared
`source-controller-ui` scope. It cannot turn a source receipt into native product acceptance.

The [native qualification scope](../../deploy/substrate/README.md#qualification-scope) records
the exercised ARM product journeys and remaining limits. A passing component or control-plane
receipt does not extend that scope.
