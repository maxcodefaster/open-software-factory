# Open Software Factory

Factory turns approved product intent into reviewed source changes. A Project brings together a
source repository, Tickets, revisioned Knowledge, shared development and a promoted Preview.
People approve the requirements and the exact verified commit. Factory controls the work between
those decisions.

The application uses Solid 2, Bun and PostgreSQL. Zero supplies planning mutations and cached read
projections. Mastra handles Project research and Requirements Interviews; OpenCode 2 implements
approved Changes. Forgejo owns Git and Verification runs. Every execution Sandbox uses Envbox,
Sysbox, a private Docker daemon, the Dev Containers CLI and the Factory Runtime Connector.

## Install into existing Kubernetes

The development Helm chart lives in [deploy/helm/factory](deploy/helm/factory/README.md).
Install it directly from this repository; a public chart repository and release publication are
not required during development. Kubernetes is provided by the operator. Factory does not
install a VM or cluster, require OrbStack, or manage the node's Docker daemon.

The chart runs Factory, PostgreSQL, Forgejo, Zero and encrypted OpenBao in Kubernetes. Internal
callbacks use Services and the application uses its ServiceAccount, without a personal kubeconfig
or a mounted host Docker socket. Envbox execution still requires compatible Linux workers,
permission for privileged outer Pods and usable persistent storage.

Choose an available development application image containing the exact runtime artifact bundle,
then supply the browser-facing Factory and Forgejo origins. See the chart's
[installation and maintenance instructions](deploy/helm/factory/README.md) for local access,
Ingress, credentials and retained data. Development images may be built locally; the installed
application does not build its own tools or require a source checkout on the operator's machine.

For local browser access, install with `deploy/helm/factory/values.local.yaml` and your
cluster-reachable application image. Then run:

```sh
mise exec -- bun run factory:connect
```

This one foreground command reads the installed addresses and manages all three native Kubernetes
connections. It reconnects after a forwarding process exits, including Pod replacement, without
restarting Factory or replaying work. Use `--namespace`, `--release` and `--context` for a different
installation. Ctrl+C closes only its own local connections. No hosts-file edits, external wildcard
DNS or browser resolver flags are needed in Chromium-based browsers for the isolated
`*.runtime.localhost` IDE and App addresses. This is local development access, not a public Ingress
or an installer for Kubernetes.

## Source development

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
Its frozen instructions identify the successful exact-commit Verification as Factory-observed CI
evidence. The reviewer still checks source, test relevance and actual App behavior independently.
It cannot edit, run shell commands or delegate to a writing agent. A native finish without an
accepted report remains incomplete. Passing checks alone no longer enables Delivery.
Reproducible blocking findings return to the retained implementation Session for targeted correction;
each changed commit needs new checks and a fresh review. Cosmetic suggestions do not expand scope.
An incomplete or failed review has an explicit Retry review action after active work
and Stop have settled. That creates a fresh attempt, never replays the old inference. A successful
review still requires deliberate human approval of the exact commit before Staging promotion.
After a confirmed Stop of an already submitted implementation, Resume checks continues its
Verification and independent review without calling the implementer again. It applies only to the
current submitted version and that exact Stop; unfinished source and editing takeover remain fenced.
Coding activity streams through authenticated Factory access, with history reconciliation after
reconnect and no repeated model request. New Build turns use native OpenCode MCP tools for the
restricted development browser, including inline screenshots. Already admitted CLI instructions
remain executable without rewriting their frozen input. Neither transport grants arbitrary MCP
registration, URLs, scripts or access to human browser sessions.
An unavailable runtime-status write does not terminate Factory or disconnect healthy compute.
Only the current authorized observation retries; newer observations supersede it, and revocation
cancels it. A terminating producer's final outcome remains observable after its connection closes.
These retries never create another Sandbox or resend an inference.
If the Connector confirms browser expiry or Factory confirms control-connection loss, the same active
Build can explicitly open a fresh browser after exact cleanup is confirmed. It cannot restore or reuse the old browser,
replay a UI action, bypass Stop, or reset the turn's browser-call limit. A fresh snapshot is required
before further actions.
Admitted corrections remain in the conversation even if source preparation fails before OpenCode
receives them. Retrying work requires a new explicit request; reconnecting never resends it.
Failed file access and editor services have separate Restart actions. Each confirms Stop before
starting another access epoch, without restarting Apps or Builds. Restarting the editor can lose
unsaved editor changes; restarting file access retains editor buffers.
Missing confirmed source resources are never recreated under their old access epoch. Explicit file
access Stop can retire a replaced Pod only after validating its full assignment and manifest against
the same recorded Namespace and volume. It never adopts that Pod's identity or removes source storage.
Temporary editor observation or connection loss rechecks the same recorded service automatically.
Interrupted source and editor observation workers also retry the same retained intent within
their existing unavailable-observation bounds, without a human wakeup or another access epoch.
An initial unavailable editor document reconnects without a manual reload. An already open editor
is never reloaded by that recovery, so its dirty buffers stay in place. Readiness changes do not
revoke its grant; Stop, failed resources, changed identity and lost authority still do.
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

Before replacing the running server or announcing readiness, startup checks the default Kubernetes
storage class with a fresh 8 GiB RWO claim. The pinned source image must write and read a marker as
the source-service UID, then its Pod, claim, backing volume and Namespace must be removed.
This checks usable storage, not just a reachable cluster or an existing volume. A failed check
keeps its own recorded identity for the next startup; it never resets Project storage.
`storage-readiness-diagnostic.json` in the installation state records compact claim, Pod and
provisioning-helper states, including observed exit codes when available. The last failed check
also remains in `storage-readiness-failure.json`, even after a successful retry. Neither file
contains raw logs, environment values or credentials. The explicit native proof is
`FACTORY_RUN_STORAGE_READINESS_PROOF=1 mise exec -- bun run test:live storage-readiness.live`.

```sh
mise exec -- bun run factory:status
mise exec -- bun run factory:restart
```

Restart adopts published pins for new runtime attempts and preserves existing intent and data.
Published defaults also supersede disposable-installation bootstrap pins, never an existing
Runtime Attempt's recorded image.
It starts stopped PostgreSQL and Forgejo services and waits for their health checks before running
migrations or replacing the server. A dependency failure leaves the existing server untouched.
It reuses the existing frontend bundle. After changing UI source, run `factory:up` again to rebuild
that bundle and restart the same installation without resetting its data.
Use [runtime artifact instructions](deploy/runtime-host/README.md) when changing runtime images.

### Run the existing installation's server on Linux

On macOS 27 with OrbStack 2.2.3, long-lived Pod connections through the Mac host alias can lose
responses. Keep Factory's server on the Linux side and use the Linux node's reachable IPv4 address
for runtime callbacks. This changes only the server process, not the installation, database,
Workspace storage, model settings or registered Forge identity.
Source initialization and runtime assignments share the same repository-transport check. Local
HTTP endpoints may use private or loopback IP literals as well as the local host aliases. Public
HTTP endpoints, credentials in URLs and executable clone protocols remain rejected.

After the initial artifact publication, build the application image and inspect the node address:

```sh
FACTORY_IMAGE=open-software-factory:local mise exec -- bun run factory:image
mise exec -- kubectl --context orbstack get node orbstack -o wide
```

Use the actual `INTERNAL-IP` from that output, rather than copying this example address:

```sh
FACTORY_SERVER_IMAGE=open-software-factory:local FACTORY_RUNTIME_HOST=192.168.139.2 mise exec -- bun run factory:restart
```

The native launcher still owns startup and Stop. It records the exact image/container identity
before creation, keeps credentials out of command arguments and reuses the selected image and
runtime host on later restarts. It mounts the configured OpenBao token and CA files read-only,
including a local CA stored outside installation state. Neither a static neighbour entry nor a
network repair loop is needed. Rebuild the image and explicitly select it to adopt source or UI changes. Setting
`FACTORY_SERVER_IMAGE=native` explicitly returns to a host process.

Compose supplies only the source-development data services. It is not another Factory installation
method. The application image starts the Kubernetes bootstrap and contains neither a Docker CLI
nor a workstation certificate generator. Install that image with the
[repository Helm chart](deploy/helm/factory/README.md).

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
| `bun run factory:connect` | Connect the browser to a local Helm installation and restore interrupted forwards |
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

Browser image acquisition retries recognized transient Registry failures within the existing
three-minute startup window, before any browser or App action exists. Stop cancels that wait.
Authentication, certificate, digest and unknown failures still fail explicitly. A later authorized
Build or review may prepare the same frozen image again without restarting the Workspace;
neither path repeats inference or an App interaction.
The explicit native recovery proof uses a private TLS Registry and one uniquely labeled image,
fails its first real Docker pull, restores the Registry and confirms the same exact image:

```sh
FACTORY_RUN_BROWSER_IMAGE_RECOVERY_PROOF=1 mise exec -- bun --no-env-file test test/support/browser-image-recovery.live.test.ts
```

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
