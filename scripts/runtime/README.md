# Substrate runtime checks

Factory uses the pinned official Substrate API and gVisor profile with native direct containers,
MEMORY preference and ROOTFS cold fallback. Factory owns product
authority and execution intent. Substrate owns Actor lifecycle and snapshots. The previous
Factorybox build, lifecycle, reserve and warm-memory benchmark commands have been removed.
Existing private evidence is retained; no old worker or storage cleanup is run by this checkout.
The source launcher also leaves cluster monitoring alone. It does not install metrics-server;
existing monitoring owned by the operator is not removed or reconfigured.

## Operator setup

Read [the native profile](../../deploy/substrate/README.md) for the approved upstream commit,
worker/gVisor pins, serving trust, separate Owner and Editor credentials, TLS egress, Actor image
and installation-wide configuration. Execution uses the explicit Linux amd64 or arm64 runtime
identity, never the control-plane host's architecture as a fallback.
The [qualification scope](../../deploy/substrate/README.md#qualification-scope) owns the current
ARM infrastructure and product evidence, including worker/runsc checksums,
TLS egress, ROOTFS restart and Actor deletion. Historical private-Docker receipts do not
qualify their direct-native replacements. The commands here distinguish live product,
controlled controller and packaged-component checks. Each receipt retains its tested source,
installation and scope; component or controller checks do not qualify the full product journey.

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

This selects the official gRPC/Connector lifecycle and authenticated Factory Workspace tests.
Declarations and passing static checks do not qualify their live behavior; retain each executed
lane's source, image, native identities and evidence scope.
Missing fixture configuration fails the command. The operator remains responsible for the exact
native fixture inventory it retains. There is no general Namespace cleanup or finalizer-removal command.

The adapter fixture requires an absolute `repositoryDirectory` containing the prepared Git
repository and the exact `sourceRevision`. Its committed `.factory/actor-template.json` supplies
the existing immutable native Work/service images; `workloadImage` supplies the Factory tools.
The fixture uses the production renderer and native `native-parent`/`native-project` entrypoints,
not an image-bundled initializer or rootless wrapper. Source clone and Project environment reads
use the existing authenticated internal routes. The adapter's already-granted Source ownership
is controlled fixture state; independent Source handoff and a complete Factory journey are not
claimed. This lane explicitly requests ROOTFS to require cold Parent/Child reconnect; it does not
qualify MEMORY continuity or change production's MEMORY preference. Converting its declaration
and passing unit/compile checks do not constitute a new live native receipt.

The Workspace fixture requires Linux UID/GID 1000, its explicit `kubeconfig`, `context` and `cli`,
and the normal `fresh-workspaces` deployment. The default `qualification: "lifecycle-and-git"`
includes the Parent Git regression; `qualification: "lifecycle"` omits those additional Git checks,
not the lifecycle assertions. Omitted checks are not passes.
The Workspace fixture constructs `.factory/actor-template.json` from the existing runtime Project
fixture and requires `FACTORY_STARTER_IMAGES` with published immutable images for its selected
native worker architecture. It retains a durable `/home/node` preparation marker and explicitly
requests ROOTFS cold continuation; that fixture construction alone is not live acceptance.
Factory's normal capacity admission remains enabled: commission a dedicated, fully reserved base
WorkerPool whose CPU/memory requests equal its limits, cover the configured Actor CPU and leave
memory for the worker itself. The generic profile's small bootstrap/smoke pool is not that
reservation. Use a short, private, writable `TMPDIR` for Unix sockets; a deeply nested evidence
directory can exceed the platform's socket-path limit. A Linux runner using host Docker helpers
also needs that temporary directory mounted at the same host and runner path.
Keep the fixture's checkout and Factory Source/state on a native Linux filesystem, not a macOS
shared-directory mount. Unsupported host xattr namespaces must remain a failed admission, not
be stripped or ignored to make checkpointing pass.
The cold proof also waits for actual node-local snapshot detachment, not merely worker release.
Commission and record accelerated native `--snapshot-upload-delay` / `--snapshot-detach-delay`
values on that separate test atelet if the proof must finish within its observation bound.
A suspended Actor may normally retain its node-local snapshot cache after releasing its worker;
do not reinterpret that cache as running compute or change production policy just for this test.
The Workspace lane now targets initial saved Source before compute, Source access before Project
preparation, and authenticated MCP lifecycle commands. Pause retains the same Actor, Runtime
Attempt, canonical Source and writer epoch. Passive metadata/watch observation must not wake it;
deliberate current-file access may resume it without inference. Actual process/RAM discontinuity,
image-backed rootfs and durable-directory state qualify the explicit cold path when the lane runs.
The Work rootfs witness uses `/var/tmp` and checks its actual root mount; `/tmp` is native tmpfs
and cannot prove image-backed ROOTFS retention.
It also tests personal Workspace isolation, concurrent Starts without a replacement generation,
and recovery of a lost caller connection through the original persisted Pause command rather than
redispatching Suspend. The old public destructive Workspace Stop alias must be refused.
Optional Git checks still use the real native Parent. The lane finishes with retained Pause;
UID/version-bound deletion of its fresh, disposable Actors and original native scopes is separate
fixture disposal, not ordinary Workspace Stop. Unconfirmed creates or cleanup retain fixture data.
These maintained assertions are not a fresh live receipt and do not establish MEMORY continuity,
the complete Starter/approval/Delivery journey or final platform/release acceptance.
Optional `directIngress` and `ingressListenPort` select an owned callback listener;
the native TLS origin remains on port 443. Cleanup confirms original template and Atespace UIDs
and native absence before deleting the fixture database or S3 data. Unconfirmed cleanup retains them.

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

The approved ActorTemplate must use an already published immutable native Work image providing
Node.js, Git and development UID/GID `1000:1000`. Project OCI workflows build and publish images
outside Factory. Environment settings contain only
`{variables:[{name,value?,runtime,verification}]}`: Runtime supports application settings and
private-package tokens, while Verification requires separate opt-in. There is no build-time flag
or per-Project registry bundle. Saving Environment settings alone must admit neither compute
nor an image publication.

Private native images remain supported through operator commissioning of pull authority and TLS
trust in Substrate's pinned upstream node image-credential provider before Work starts.
Factory installs no custom provider and copies no registry credentials into ActorTemplate JSON.
Missing authority or trust must surface as a fail-closed native pull/start error, not an anonymous
fallback or an anonymously pullable replacement image.
Environment-variable checks and per-Project registry-credential fixtures do not prove native
private-image access. That proof needs the exact private image's admitted Actor/ActorTemplate,
an observed successful native pull with commissioned authority and refusal without that authority.
Historical registry fixtures are not a prerequisite or substitute for this native qualification.

The external MCP proof starts its own Forgejo and requires
`FACTORY_FORGEJO_PUBLIC_URL` to route to that owned server. It exercises OAuth, local OpenCode,
browser collaboration, commands and file transfers against the same direct native Work container.
It checks UID 1000, actual Node/Git execution, the Workspace/checkout context and the Work container's
Substrate Actor UID against its original immutable binding, with the same Runtime Attempt and saved
Actor UID after client reconnect. After `pauseWorkspace`, a command resumes compute and checks that
the shared file exists and the Runtime Attempt/Actor UID are unchanged. These assertions do not
establish MEMORY process continuity or absence of Source handoff. No Project Docker daemon or
Dev Container is required.
Supply `FACTORY_STARTER_IMAGES` with published Starter images for the selected native worker
architecture; the fixture Work image must provide UID 1000, Node.js and Git.
An installed local OpenCode V2 service with its configured `github-copilot/gpt-6.1-sol` model,
normal browser OAuth consent and Chromium must be available before selecting this paid live lane.
The installed executable is resolved from `PATH`; `FACTORY_LOCAL_OPENCODE_BINARY` can select
that installation's executable explicitly.
Static checks or test discovery qualify lane maintenance only, not this live acceptance.

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

The external MCP lane's successful-fixture shutdown stops its editor clients and requests
authenticated `pauseWorkspace` with a caller ID saved before dispatch. It checks the original
Attempt and Actor in `paused` / `ACTOR_STATE_SUSPENDED` and compares retained Source, Workspace and
writer ownership without reading files that could wake compute. It does not delete the Actor.
Failed or unknown work stays retained without implicit Coding cancellation; an unconfirmed Pause
fails the lane rather than authorizing disposal. Controlled cleanup checks are not live acceptance.
Shutdown is not permission to drop the fixture database: native Atespaces, templates or editor
inventory may still exist. These proofs pause their
own control plane and record retained inventory under `.factory/test-results/`. Generic live-fixture
disposal refuses database removal while that inventory remains or cannot be confirmed absent.
The commissioned registry and unrelated installation resources stay unchanged.

## Component checks

The packaged browser check initializes the actual worker and verifies the pinned MCP version and
restricted tool list, without starting Chromium, an Actor or inference:

```sh
FACTORY_BROWSER_TOOLS_IMAGE='your-registry/browser-tools@sha256:YOUR_CACHED_DIGEST' \
  mise exec -- bun run test:native browser-tools-package.native
```

It owns one networkless Docker container and removes it after the check.

`substrate-image-proof.sh` checks the native tools and Actor packages on their matching Linux
architecture without starting an Actor. Emulated host/image mismatches are refused. It checks the
mounted tools, both supported Node/Bun ABIs and permissions, rejects the retired `parent` CLI,
and verifies that Docker/DinD, Compose, Dev Containers and the old image-producer CLI are absent.
The release workflow runs this proof before publishing those artifacts.

The private-Compose build, container-injection, deferred-hook and cold-primary component recipes
are removed. Their historical results do not qualify native Project preparation. Current templates
consume already prepared immutable OCI images and their explicit native Work preparation command;
actual native image admission and Work preparation still need their separate qualification.
There is no remaining Factory Project-image producer to qualify. No successful package check
supplies native acceptance.

Pinned OpenCode process checks exercise actual default/custom Workspace directories, native
tool execution, retained history and metadata-only Stop without paid model keys:

```sh
FACTORY_OPENCODE_TEST_IMAGE='your-registry/runtime-host@sha256:YOUR_CACHED_DIGEST' \
  mise exec -- bun run test:native opencode-history opencode-input-stop-worker
```

For focused worker-source iteration, build with
`mise exec -- bun scripts/factory/build-input-stop.ts .factory/test-results/input-stop-candidate`
and set `FACTORY_INPUT_STOP_TEST_WORKER` to that output's absolute `input-stop.mjs` path.
The fixture records its checksum and mounts only that candidate read-only. This qualifies the
candidate SDK executor, not the packaged image; omit the override for final package qualification.
The same focused Linux fixture accepts a cross-compiled `FACTORY_INPUT_STOP_TEST_CONNECTOR_BINARY`
alongside `FACTORY_INPUT_STOP_CONNECTOR_TEST_BINARY`; its checksum is recorded separately.
Omit both source overrides when qualifying the packaged Connector and SDK together.

Controlled controller tests use real PostgreSQL and Factory owners with explicit RPC responses.
They prove neither ROOTFS cold restart nor actual MEMORY continuity; each needs its native proof.

The independent editor's Kubernetes admission and UID-bound cleanup have a separate real-API proof:

```sh
FACTORY_IDE_NATIVE_CONTEXT=your-explicit-context mise exec -- bun run test:native developer-ide-kubernetes.native
```

It creates an exactly owned Namespace and nonprivileged Node component Pod, then checks refusal
of a changed UID, deletion and cleanup without finalizer changes. Theia's browser journey runs separately.

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
