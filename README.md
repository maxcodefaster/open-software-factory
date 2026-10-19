# Open Software Factory

Factory turns approved product intent into reviewed source changes. A Project brings together a
source repository, Tickets, revisioned Knowledge, shared development and a promoted Preview.
People approve the requirements and the exact verified commit. Factory controls the work between
those decisions.

The application uses Solid 2, Bun and PostgreSQL. Zero supplies planning mutations and cached read
projections. Mastra handles Project research and Requirements Interviews; OpenCode 2 implements
approved Changes. Forgejo owns Git and Verification runs. Every execution Sandbox uses Envbox,
Sysbox, a private Docker daemon, the Dev Containers CLI and the Factory Runtime Connector.

## Start locally

The source-development environment uses macOS with OrbStack's Linux Docker daemon and Kubernetes
context `orbstack`. Install [mise](https://mise.jdx.dev/), enable that environment, then run:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run factory:up
```

Open [Factory](http://127.0.0.1:3000). The initial local administrator is `admin@factory.local` with
password `factory-local-password`; these are development defaults. Configure provider connections
in Settings. Optional environment bootstrap is described in [.env.example](.env.example); put real
credentials in the ignored `.env` file.

The local listener defaults to `0.0.0.0` so OrbStack-hosted runtimes can call Factory.
Set `FACTORY_HOST` explicitly to narrow that listener, noting that loopback-only access may prevent
runtime callbacks. `FACTORY_ADMIN_EMAIL` and `FACTORY_ADMIN_PASSWORD` are honored for bootstrap and
Forge setup. Set a private password before first startup if the listener is reachable by others.
Bootstrap never resets an existing account's password; later starts must use that account's
current credentials for Forge setup.
Disposable installations keep their own generated administrator identity and private password
instead of inheriting the normal installation's administrator overrides.

Startup provisions the local database, Forgejo, planning cache and encrypted OpenBao, reuses a
complete set of pinned runtime artifacts or publishes them once, applies migrations and builds Factory. Cold artifact builds
and Sandbox preparation can take several minutes. Installation data and exact artifact references
live under the ignored `.factory/` directory.

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
Use [runtime artifact instructions](deploy/runtime-host/README.md) when changing runtime images.

### Run Factory through Compose

The same application can run in a container, with Compose managing PostgreSQL, Forgejo,
Zero and encrypted OpenBao. It still needs Kubernetes for Envbox execution. Compose does not
replace the runtime with host containers. See [local deployment](deploy/local/README.md) for
the Mac/Linux prerequisites, image publication and isolated local ports.

With a published Factory image and a self-contained kubeconfig:

```sh
export FACTORY_IMAGE=ghcr.io/maxcodefaster/open-software-factory/factory:<published-version>
export FACTORY_RUNTIME_HOST=host.orb.internal  # On Linux, use the host's reachable address.
docker compose --project-name factory-compose -f deploy/local/compose.yaml up -d factory
```

The initial password is generated privately in `.factory/compose/admin-password`. Provider
connections are configured in Factory Settings. No Bun, Node or compiler is needed on the host
when using published images. The publication workflow is manual; it does not publish on every push.

## Repository layout

```text
apps/factory/               Web interface, HTTP server and Factory controllers
packages/                   Domain rules and concrete integration adapters
services/runtime-connector/ Go connector inside the approved runtime
deploy/                     Upstream compositions, runtime images and local manifests
scripts/                    Local operation, integration and runtime verification tools
templates/starter-app/      Maintained application scaffold for new Projects
test/                       Browser, integration and live proofs with owned fixtures
docs/README.md              Architecture, domain vocabulary and operating limits
docs/adr/                   Lasting architecture decisions
AGENTS.md                   Repository-specific coding-agent instructions
upstream.json               Exact upstream versions, digests and package integrities
mise.toml                   Local tool versions
```

Domain packages named `*-domain` express product rules without framework or vendor types.
Adapters such as `auth`, `forge`, `runtime-kubernetes` and `zero-*` isolate those dependencies.
`apps/factory` composes them. Deployment recipes belong under `deploy`; operational commands belong
under `scripts`. Templates and test fixtures are separate from the Factory application.

Generated logs, screenshots, test output, builds, caches and installation state stay in ignored
directories. New persistent test artifacts go under `.factory/test-results/`.

## Development and checks

Run commands through `mise exec --` to use the pinned tools. Keep dependencies exact and install
from committed lockfiles. `upstream.json` owns the upstream artifact pins; package manifests and
lockfiles own application dependencies.

The test and type-check launchers prepare separately locked test dependencies when the selected checks need
them. Editor adapter tests install the Theia composition without dependency lifecycle scripts and
compile the Factory extension. The scoped Starter authentication proof prepares the template's
locked dependencies. Unchanged inputs reuse the local test cache; focused checks that do not use
these components skip preparation. This first-run setup performs no model inference.

Start the backend with `factory:up`, then use `factory:dev` and open the Vite URL it prints.
Development proxies authenticated API and planning-cache traffic to that backend without
allowing foreign browser origins. `FACTORY_DEV_BACKEND_URL` selects a different loopback backend
for an isolated installation. It does not start or reset that installation.

| Command | Purpose |
| --- | --- |
| `bun run factory:dev` | Vite frontend development against the local Factory server |
| `bun run factory:build` | Build the frontend |
| `bun run factory:image` | Build the local application image with the currently published runtime pins |
| `bun run check:docs` | Validate documentation names, local links and anchors |
| `bun run typecheck` | Check all TypeScript projects and tests |
| `bun run test:unit` | Fast domain, adapter and operation tests, including pure `test/support` tests; no live models |
| `bun run test:controllers` | Owned PostgreSQL/controller checks; separate fixture databases on one migrated test daemon |
| `bun run test:native` | Explicit owned OpenCode, source, Forgejo and OpenBao adapter proofs |
| `bun run test:live` | Opt-in live proofs, still requiring each proof's environment flag |
| `bun run connector:check` | Host and digest-pinned Linux race tests, native privilege checks and vet |
| `bun run test:postgres` | Database integration checks |
| `bun run test:forgejo` | Forgejo integration checks |
| `bun run runtime:conformance` | Actual Envbox/Dev Container/Connector conformance |
| `bun run test:browser` | UI journeys; excludes native, paid and retained-installation restart tests |
| `bun run test:browser:native` | Explicit real IDE/Terminal/Preview/Delivery journeys |
| `bun run test:browser:paid` | Explicit real provider journeys; incurs model usage |
| `bun run test:browser:manual` | Retained-installation captures/restarts; run only when no admitted work is active |
| `bun run check` | Documentation, formatting, lint, types, units and Connector checks |
| `bun run check:integration` | Complete check plus PostgreSQL invariants and the owned controller lane |

Live proofs under `test/support` opt in through their documented environment flags. Some use real
model providers and incur usage. Test fixtures own separate databases, Projects and runtime
identities; their cleanup must preserve unrelated work. Run the affected checks for a change rather
than repeating every live journey after a documentation edit.

The independent editor proof builds and uses separate local artifacts. It opens canonical source
without Project compute or model inference, switches retained buffers, verifies original-Workspace
saves and rejects stale saves. Its containers and volumes have exact cleanup ownership.

```sh
mise exec -- docker buildx build --load --file deploy/workspace-files/Dockerfile --tag factory-source:editor-proof .
mise exec -- docker buildx build --load --file deploy/runtime-host/Dockerfile --target developer-ide --tag factory-editor:editor-proof .
FACTORY_RUN_INDEPENDENT_EDITOR_PROOF=1 FACTORY_SOURCE_PROOF_IMAGE=factory-source:editor-proof FACTORY_EDITOR_PROOF_IMAGE=factory-editor:editor-proof mise exec -- bun --no-env-file test test/support/independent-editor.live.test.ts
```

The unassisted coding acceptance uses its own disposable installation and real model calls.
It needs the provider bootstrap variables described in `.env.example`. Settings-only connections
from another installation are not copied.

```sh
mise exec -- bun run factory:up --disposable coding-proof-example
FACTORY_CODING_COMPLETION_INSTALLATION=coding-proof-example mise exec -- bun run test:live coding-completion.live
mise exec -- bun run factory:reset --disposable coding-proof-example --confirm coding-proof-example
```

It creates a fresh Starter feature, requires the coding Agent's own browser inspection, and
independently checks behavior, exact Verification and Delivery without editing generated source.
Screenshots and results go under `.factory/test-results/coding-completion/`. A passing sample
is evidence for that task, not a guarantee that every model request will finish unaided.
Successful runs remove their owned source storage as well as execution resources. Failed runs
retain source for inspection; the reset guard refuses deletion until that exact retained Workspace
storage is explicitly cleaned up.

Filter a controller or native lane by filename, for example `bun run test:controllers agent-read`.
Use `--list` to inspect its selection. Ordinary unit/controller/native lanes discard inherited live
model flags and provider credentials, and do not load `.env` in the test runner. Native runtime
conformance and Forgejo checks remain explicit commands, not hidden steps in the default integration gate.
Runtime conformance owns unique Pods/claims in the shared registry namespace. `runtime:smoke:down`
removes only labeled conformance resources with UID preconditions; it never deletes the namespace
or registry. Old unlabeled resources require separate ownership review.

## Documentation

- [Architecture and domain reference](docs/README.md) explains ownership, runtime topology,
  terminology, decisions and verification limits.
- [Runtime artifacts](deploy/runtime-host/README.md) describes image publication and preparation.
- [Runtime fixture](test/fixtures/runtime-project/README.md) explains the conformance Project.
- [Artwork attribution](apps/factory/public/art/README.md) preserves bundled source and rights details.
- [AGENTS.md](AGENTS.md) contains only rules specific to work in this repository.

Maintained Markdown is limited to READMEs, AGENTS.md and ADRs. Task plans and progress belong in
the task or issue. Lasting decisions belong in ADRs; current behavior belongs in code, tests and
the relevant README. Historical local reports and captures are preserved under
`.factory/archives/repository-cleanup-20261013/`.

Factory is licensed under [Apache-2.0](LICENSE). Bundled third-party assets retain their own notices.
