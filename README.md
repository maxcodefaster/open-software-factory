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

The maintained local environment uses macOS with OrbStack's Linux Docker daemon and Kubernetes
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

Startup provisions the local database, Forgejo, planning cache and encrypted OpenBao, publishes
the pinned runtime artifacts, applies database migrations and builds Factory. Cold artifact builds
and Sandbox preparation can take several minutes. Installation data and exact artifact references
live under the ignored `.factory/` directory.

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
Use [runtime artifact instructions](deploy/runtime-host/README.md) when changing runtime images.

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

| Command | Purpose |
| --- | --- |
| `bun run factory:dev` | Vite frontend development against the local Factory server |
| `bun run factory:build` | Build the frontend |
| `bun run check:docs` | Validate documentation names, local links and anchors |
| `bun run typecheck` | Check all TypeScript projects and tests |
| `bun run test:unit` | Domain, adapter, controller and operation-tool unit tests |
| `bun run connector:check` | Go race tests and vet for the Connector |
| `bun run test:postgres` | Database integration checks |
| `bun run test:forgejo` | Forgejo integration checks |
| `bun run runtime:conformance` | Actual Envbox/Dev Container/Connector conformance |
| `bun run test:browser` | Browser journeys against the local Factory |
| `bun run check` | Documentation, formatting, lint, types, units and Connector checks |
| `bun run check:integration` | Complete check plus PostgreSQL, Forgejo and native runtime conformance |

Live proofs under `test/support` opt in through their documented environment flags. Some use real
model providers and incur usage. Test fixtures own separate databases, Projects and runtime
identities; their cleanup must preserve unrelated work. Run the affected checks for a change rather
than repeating every live journey after a documentation edit.

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
