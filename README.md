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

If a repository-creation response is lost, Factory observes that same setup automatically and
updates the open setup panel. Status recovery never repeats repository creation or import.
Known setup failures still require an explicit retry.

Requirements can be written directly. New Ticket → Write requirements creates shared, editable
intent without calling a model or opening an Interview. Enter the specification and acceptance
criteria; Implement approves that exact saved revision and commissions Coding in one action.
An existing Idea has the same Write requirements action without starting AI.
Ask AI to clarify starts an optional Interview explicitly. Creating or moving Tickets, opening
their documents and reconnecting do not start clarification. An Interview proposal still needs
human confirmation, and neither path bypasses independent checks, review or Delivery approval.

Factory's Models settings show separate Planning & knowledge and Coding choices. Each has a
connection and model selector; OpenAI Coding has reasoning beside its model, with medium as the
minimum. Save & check adopts the Coding model and reasoning together only after a successful
access check. API keys are managed separately and encrypted in OpenBao. Before the first Build,
developers can open Ticket actions → Coding options to choose reasoning in the Coding chat before
commissioning the first Build. Opening or leaving those options starts no model work. The normal
Implement action still commissions work in one click with the configured defaults. Planning and
research chats, and contributor correction chats, have no model switcher. Existing Changes show developers their
fixed admitted value; changing defaults never reconfigures them. OpenAI Coding uses the native
Responses adapter.
Factory supplies OpenCode's configuration through its packaged read-only configuration directory
and admitted model settings. Home-directory and Project OpenCode configuration and compatibility
skills do not override that setup. Do not maintain a second `opencode.json` for Factory.
Coding uses native HTTP transport and automatic summary compaction with the selected model;
provider-native compaction is not enabled through the relay.
The packaged runtime policy augments OpenCode's native instructions rather than replacing its
tool guidance. Build reads the checkout's applicable `AGENTS.md` files explicitly. Required
non-manual Build Skills and human-invoked Skills load before inference; optional Skills remain
available on demand. Each Change retains its original eligible and required revisions through
corrections, even if defaults change later. Selected guidance also uses OpenCode's durable
instruction entries so context compaction cannot silently discard it. Each new turn replaces only
Factory's own instruction entries with its exact selection.
An intended Session ID is not a resumable Coding session until OpenCode confirms its creation.
Failed first preparation retains source and offers an explicit Retry.
Build works toward the approved requirements and ends with an ordinary summary, without a required
JSON checklist. A normal native finish submits changed source for independent Verification,
not as proof of completion. Exact-commit checks and human Delivery approval remain separate.
After successful checks, a fresh independent OpenCode Session reviews that exact candidate.
It keeps the Change's Coding model and reasoning, with no additional model selector. The reviewer
has only immutable Git reads, the existing restricted App browser and a bounded review-report tool.
It cannot edit, run shell commands or delegate to a writing agent. A native finish without an
accepted report remains incomplete. Passing checks alone no longer enables Delivery.
Reproducible blocking findings return to the retained implementation Session for targeted correction;
each changed commit needs new checks and a fresh review. Cosmetic suggestions do not expand scope.
An incomplete or failed review has an explicit Retry review action after active work
and Stop have settled. That creates a fresh attempt, never replays the old inference. A successful
review still requires deliberate human approval of the exact commit before Staging promotion.
Coding activity streams through authenticated Factory access, with history reconciliation after
reconnect and no repeated model request. New Build turns use native OpenCode MCP tools for the
restricted development browser, including inline screenshots. Already admitted CLI instructions
remain executable without rewriting their frozen input. Neither transport grants arbitrary MCP
registration, URLs, scripts or access to human browser sessions.
If the Connector confirms browser expiry or connection loss, the same active Build can explicitly
open a fresh browser after exact cleanup is confirmed. It cannot restore or reuse the old browser,
replay a UI action, bypass Stop, or reset the turn's browser-call limit. A fresh snapshot is required
before further actions.
Admitted corrections remain in the conversation even if source preparation fails before OpenCode
receives them. Retrying work requires a new explicit request; reconnecting never resends it.
Failed file access and editor services have separate Restart actions. Each confirms Stop before
starting another access epoch, without restarting Apps or Builds. Restarting the editor can lose
unsaved editor changes; restarting file access retains editor buffers.
Editor resources use a persisted random identity, separate from the account ID, so installations
sharing the emergency administrator ID cannot adopt each other's editor. Existing editor identities
remain unchanged until explicit Stop and restart.
Editor hostnames also include the local HTTP/HTTPS listener so browser cookies stay separate across
installations on different ports, even when the account and editor epoch match.

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

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
It reuses the existing frontend bundle. After changing UI source, run `factory:up` again to rebuild
that bundle and restart the same installation without resetting its data.
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
Pinned TextMate grammars provide syntax highlighting for source and configuration files without
compute. TypeScript/JavaScript and Python have a pinned project-language preset. In the editor
status bar, Start tools explicitly prepares compute if needed, then starts the language servers
in that exact Workspace's Dev Container. They use installed Project TypeScript and the actual
Python environment, including `VIRTUAL_ENV`, `.venv` and repository Pyright configuration.
Opening files never starts these processes. Other languages show Syntax highlighting rather
than claiming language support. The preset supplies completion, semantic diagnostics, hover and
Go to Definition; it does not supply general refactoring, formatting or arbitrary plugins.
Dependency definitions outside canonical source open as read-only documents bound to their
original Runtime Attempt. They are not copied into source or read from the editor host.

```sh
mise exec -- docker buildx build --load --file deploy/workspace-files/Dockerfile --tag factory-source:editor-proof .
mise exec -- docker buildx build --load --file deploy/runtime-host/Dockerfile --target developer-ide --tag factory-editor:editor-proof .
FACTORY_RUN_INDEPENDENT_EDITOR_PROOF=1 FACTORY_SOURCE_PROOF_IMAGE=factory-source:editor-proof FACTORY_EDITOR_PROOF_IMAGE=factory-editor:editor-proof mise exec -- bun --no-env-file test test/support/independent-editor.live.test.ts
```

The same owned editor proof can exercise actual TypeScript dependencies, a Python virtual
environment, semantic diagnostics, completion, dependency navigation and reconnect. Build
`runtime-host` as `factory-runtime:language-proof`, then build
`test/fixtures/language-tools/Dockerfile` as `factory-language-child:proof`, explicitly passing
`--build-arg FACTORY_LANGUAGE_TOOLS_IMAGE=factory-runtime:language-proof`. Add
`FACTORY_LANGUAGE_PROOF_IMAGE=factory-language-child:proof` to the proof command above. This
uses native Connector children and unchanged language servers in isolated containers, not models.
For the complete Envbox/Dev Container path, set `FACTORY_RUNTIME_LANGUAGE_CONFORMANCE=1`
and an exact `FACTORY_RUNTIME_CONFORMANCE_IMAGE` registry digest when running
`bun run runtime:conformance`. These overrides affect only the owned proof, never retained pins.

The unassisted coding acceptance uses its own disposable installation and real model calls.
It needs the provider bootstrap variables described in `.env.example`. Settings-only connections
from another installation are not copied. Its two independent UI journeys create fresh Starter
Projects, write manual Requirements or explicitly request an AI Interview, and commission Build.

```sh
mise exec -- bun run factory:up --disposable coding-proof-example
FACTORY_CODING_COMPLETION_INSTALLATION=coding-proof-example mise exec -- bun run test:live coding-completion.live
mise exec -- bun run factory:reset --disposable coding-proof-example --confirm coding-proof-example
```

Each journey requires the coding Agent's browser inspection, independent exact-commit review and
passing Verification. It independently checks the real App, clicks Deliver deliberately and checks
the promoted Staging revision. A saved human Wiki note must survive the generated delivery update.
The harness does not edit generated source or repair infrastructure. Set
`FACTORY_CODING_COMPLETION_PATH=manual` or `interview` to run only one path.
Screenshots and results go under `.factory/test-results/coding-completion/`. A passing sample
is evidence for that task, not a guarantee that every model request will finish unaided.
Successful runs remove their owned source storage as well as execution resources. Failed runs
retain source for inspection; the reset guard refuses deletion until that exact retained Workspace
storage is explicitly cleaned up.

The smaller `opencode-sol.live` proof runs the exact published OpenCode process in an owned
fixture, implements and tests a small goal through Azure `gpt-6.1-sol` at medium reasoning,
and checks the result independently without a final JSON form. Set `FACTORY_OPENCODE_SOL_LIVE=1`
and explicitly configure `FACTORY_MODEL_BASE_URL`, `FACTORY_MODEL_API_KEY` and
`FACTORY_AGENT_MODEL_ID` before running `mise exec -- bun run test:live opencode-sol.live`.
Set `FACTORY_OPENCODE_SOL_REASONING=high` to prove a higher selected effort instead of the
default medium.
It keeps the real provider credential outside the fixture and removes its owned containers.

The independent reviewer calibration uses the same explicit Azure Sol connection at medium
reasoning. Set `FACTORY_REVIEW_SOL_LIVE=1` and run
`mise exec -- bun run test:live candidate-review-sol.live`. It executes a healthy control and two
seeded defects independently, then checks the fresh native reviewer's judgments. This is a bounded
calibration, not the final application journey. `bun run test:controllers candidate-review` checks
exact-candidate Delivery, targeted correction, explicit retry, Stop and allowance behavior without
live models. `bun run test:native opencode-review-permissions` proves the pinned native tool boundary.

Wiki review has a separate Planning-model calibration. With the explicit Luna connection, set
`FACTORY_WIKI_QUALITY_LIVE=1` and run `bun run test:live wiki-quality.live`. It accepts an accurate
description of a source limitation and clearly marked improvement advice, while rejecting invented
cleanup and global-connection guarantees. It does not replace the full application journey.

Exact-commit code research has its own paid proof. With the explicit Luna Planning connection,
set `FACTORY_CODE_RESEARCH_LIVE=1` and run `bun run test:live contextual-research.live`.
It checks native code discovery, inspected-file citations and visibility after a permission
downgrade. It is not part of the ordinary controller lane.

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
