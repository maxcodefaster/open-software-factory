# Open Software Factory

Factory turns approved product intent into reviewed source changes. A Project brings together a
source repository, Tickets, revisioned Knowledge, shared development and a promoted Preview.
People approve the requirements and the exact verified commit. A Project monitoring delegation can
commission eligible application-code fixes and Delivery under those same independent gates.
Factory records the delegation instead of pretending a human reviewed generated results.

The application uses TanStack Start with Solid 2, Bun and PostgreSQL. Zero supplies planning
mutations and cached read projections. Mastra handles Project research and Requirements
Interviews; OpenCode 2 implements approved Changes. Forgejo owns Git and Verification runs.
Every new execution Sandbox uses an admitted Factorybox worker, pinned Sysbox and CRIU, a private
Docker daemon, the Dev Containers CLI and the Factory Runtime Connector.

## Install into Kubernetes

Factory runs on a Kubernetes cluster you provide, from the Helm chart in
[deploy/helm/factory](deploy/helm/factory/README.md). The chart runs Factory, PostgreSQL, Forgejo,
Zero, encrypted OpenBao and one private Garage object store, and generates their credentials.
Factorybox execution needs a Linux node with a recent kernel (the worker checks its capabilities), permission for privileged
outer Pods and persistent storage. Supply the exact worker image and executable hash in the
`factorybox` values.

- Tools are pinned: `kubectl` 1.35.6 (API servers 1.34 to 1.36) and Helm 4.2.2. Helm 4.2.0 and
  4.2.1 can wait forever on a missing pre-upgrade hook.
- Non-development installations need HTTPS, a unique `FACTORY_AUTH_SECRET` and an administrator
  password. Factory refuses to start without them.
- Operations, worker admission, storage sizing and recovery are in
  [docs/operations](docs/operations/README.md).

## Source development

macOS with OrbStack's Linux Docker daemon and Kubernetes context `orbstack`:

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun run factory:up
```

Open [Factory](http://127.0.0.1:3000). The launcher generates the local administrator password
(`admin@factory.local`) and writes it to `.factory/` in the installation state; it prints the
path. Set `FACTORY_ADMIN_PASSWORD` before first startup to choose your own. Provider connections
are configured in Settings; [.env.example](.env.example) lists optional bootstrap values. Real
credentials go in the ignored `.env` file.

`factory:status` and `factory:restart` manage the running installation. `factory:connect` opens
local browser access to a Helm installation. The database starts from one
[baseline](packages/db/migrations/0001_baseline.sql) plus numbered upgrades, applied in order.

## Checks

```sh
mise exec -- bun run check              # docs, format, lint, types, unit tests, Connector
mise exec -- bun run check:integration  # adds PostgreSQL and controller tests
mise exec -- bun run test:browser       # owned UI journeys
```

Native, live and paid lanes are listed in [docs/development](docs/development/README.md).
GitHub runs the checks only for release tags and by hand. Before a release, `mise exec -- bun run beta:gate`
runs every lane locally and writes a receipt for the exact commit.

## Repository layout

```text
apps/factory/               Web interface, HTTP server and Factory controllers
packages/                   Domain rules and concrete integration adapters
services/runtime-connector/ Go connector inside the approved runtime
deploy/                     Upstream compositions, runtime images and local manifests
scripts/                    Local operation, integration and runtime verification tools
templates/starter-app/      Maintained application scaffold for new Projects
test/                       Browser, integration and live proofs with owned fixtures
docs/                       Architecture reference, product behavior, operations, development, ADRs
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

## Documentation

- [Architecture and domain reference](docs/README.md): ownership, runtime topology, vocabulary.
- [Product behavior](docs/product/README.md): what Projects, Tickets, review and Delivery do.
- [Operating Factory](docs/operations/README.md): installation, worker admission, recovery.
- [Developing and checking Factory](docs/development/README.md): test lanes and proofs.
- [Architecture decisions](docs/adr) and the [UI product brief](apps/factory/PRODUCT.md).
- [Runtime artifacts](deploy/runtime-host/README.md), [Factorybox worker](deploy/factorybox/README.md),
  [runtime fixture](test/fixtures/runtime-project/README.md) and
  [artwork attribution](apps/factory/public/art/README.md).
- [AGENTS.md](AGENTS.md) has the rules for coding agents in this repository.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability.

Maintained Markdown is limited to READMEs, AGENTS.md, SECURITY.md, ADRs and the UI product brief.
Task plans and progress belong in the task or issue.

Factory is licensed under [Apache-2.0](LICENSE). Bundled third-party assets retain their own notices.
