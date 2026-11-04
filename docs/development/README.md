# Developing and checking Factory

Run commands through `mise exec --` to use the pinned tools. Keep dependencies exact and install
from committed lockfiles. `upstream.json` owns the upstream artifact pins; package manifests and
lockfiles own application dependencies.

For everyday work, use `factory:up` to prepare the source-development backend, `factory:dev`
for frontend development and `check` for the standard checks. `factory:connect` is only the
local browser connection to a Helm installation; it is not another server launcher.
It resolves and checks the exact pinned kubectl executable through mise instead of trusting
the inherited PATH. Restart this connection command after updating tool pins. That reconnects
the browser without restarting Factory or repeating model work.
Installed Factory lifecycle stays with Helm, including upgrades. Do not start the server directly
to bypass bootstrap, readiness or owned process cleanup.
The focused commands below remain available for diagnosing one area. Select a particular browser
test by passing its path to the appropriate lane, for example
`bun run test:browser:manual test/browser/runtime-recovery.spec.ts`; no per-file alias is needed.

The test and type-check launchers prepare separately locked test dependencies when the selected checks need
them. Editor adapter tests install the Theia composition without dependency lifecycle scripts and
compile the Factory extension. The scoped Starter authentication proof prepares the template's
locked dependencies. Unchanged inputs reuse the local test cache; focused checks that do not use
these components skip preparation. This first-run setup performs no model inference.
Integration lanes also build the client and Server Function handler before starting owned
Factory processes. Each lane uses its own build directory and removes it during cleanup;
parallel proofs do not replace each other's assets or the source-development `dist`.
Those handlers use the same application services as the installed Bun host.
The browser lanes share one pinned Bun entrypoint so owned suites can load Factory's Bun adapters.
Playwright prepares one separate production build for direct browser runs and removes it
afterward. A browser run nested in an integration proof reuses that proof's immutable build
without rebuilding or deleting it. Isolated component journeys belong to `test:browser`;
the controller lane does not launch duplicate browser-only wrappers.
Direct UI runs also own a temporary Factory, PostgreSQL and Zero cache, including a synthetic
Starter Project. They never adopt the source-development database. An explicit
`FACTORY_BROWSER_BASE_URL` keeps the caller's existing fixture and its supplied database/build;
native, paid and manual lanes retain their explicit installation requirements. Listing tests
starts no services. Cleanup removes only the directly owned resources.
Live UI inspection does not require a browser extension. If a browser update or its automation
connection prevents inspection, use native desktop controls in that same browser. Check the
rendered editor and Apps, not just service readiness. Do not disable browser security or install
another browser to turn an automation failure into a claimed product pass.
If an isolated frame's document remains pending with an automation debugger attached, detach that
debugger and inspect the same navigation natively before restarting Factory, the editor or compute.
Repeat a fresh first-open journey without Retry; a successful manual reload is not a product fix.
The owned desktop browser group shares one immutable build and one empty migrated PostgreSQL
daemon per invocation. Every journey still owns its database, application process and Zero cache.
Playwright's dependent teardown removes only that invocation's resources after the journeys finish.
Browser checks reject structural Solid diagnostics as well as page errors. The controller lane
also checks client-entry budgets, including deferred Settings code.

TypeScript's `noPropertyAccessFromIndexSignature` requires bracket access for index signatures.
The overlapping `useLiteralKeys` style rule is disabled rather than weakening that compiler check.
Production code checks missing values at their owning boundary or keeps a narrowed snapshot.
Tests use checked fixture values rather than unchecked non-null assertions.

Start the backend with `factory:up`, then use `factory:dev` and open the Vite URL it prints.
Development proxies authenticated API and planning-cache traffic to that backend without
allowing foreign browser origins. `FACTORY_DEV_BACKEND_URL` selects a different loopback backend
for an isolated installation. It does not start or reset that installation.
Keep its compiled Start entry available locally at `FACTORY_BUILD_DIRECTORY`, or the default
Factory build directory. The development proxy uses that entry's function identities to forward
Start's development references to the existing backend. It does not instantiate application
services in Vite or implement a second RPC encoder.

| Command | Purpose |
| --- | --- |
| `bun run factory:dev` | Vite frontend development against the local Factory server |
| `bun run factory:build` | Build the Start client, server handler and precompressed public assets |
| `bun run factory:image` | Build the local application image with the currently published runtime pins |
| `bun run factorybox:build REQUEST_JSON` | Build a local ARM64 or AMD64 worker candidate, check its image/executable and retain an unselected Factory profile |
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
| `bun run runtime:conformance` | Actual Factorybox/Kubernetes/Dev Container/Connector conformance |
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
`test:postgres` always creates and migrates its own empty PostgreSQL daemon, including its probe
users, and removes only that owned daemon/network. It does not use `DATABASE_URL` or a pre-existing
development administrator.

Shared UI controls live in [controls.css](../../apps/factory/src/ui/controls.css), loaded by the
application stylesheet. The [control fixture](../../test/fixtures/ui-controls-surface.tsx) covers
native interaction, quiet/primary/destructive actions and field states without mounting
another feature for its styles. Run `mise exec -- bun run test:browser test/browser/ui-controls.spec.ts`
and the affected feature journeys after changing the shared controls. The
[product brief](../../apps/factory/PRODUCT.md#interface-consistency) records their visual contract.

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
For the complete Factorybox/Dev Container path, set `FACTORY_RUNTIME_LANGUAGE_CONFORMANCE=1`
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

Project and Browser image acquisition retry recognized transient Registry transport failures within
their existing three-minute preparation windows. Project recovery precedes Dev Container and hook
execution; Browser recovery precedes browser and App actions. Stop cancels that wait.
Storage, memory, authentication, certificate, rate-limit, missing
manifest, digest and unknown failures still fail explicitly. Project acquisition reports a static
failure class without retaining or exposing Registry output or credentials. A later authorized
Build or review may prepare the same frozen image again without restarting the Workspace;
neither path repeats inference or an App interaction.
Each explicit native recovery proof uses a private TLS Registry and one uniquely labeled image,
fails its first real Docker pull, restores the Registry and confirms the same exact image.
Neither proof starts a container or invokes a model:

```sh
FACTORY_RUN_PROJECT_IMAGE_RECOVERY_PROOF=1 mise exec -- bun --no-env-file test test/support/project-image-recovery.live.test.ts
FACTORY_RUN_BROWSER_IMAGE_RECOVERY_PROOF=1 mise exec -- bun --no-env-file test test/support/browser-image-recovery.live.test.ts
```

The Connector's opt-in `TestBrowserRuntimeManagerLive` checks the actual browser and App proxy
without model calls. Supply exact `FACTORY_BROWSER_PROOF_IMAGE` and
`FACTORY_BROWSER_PROOF_PARENT_IMAGE` references. Its Docker daemon must match the pinned parent;
a different host daemon is not the Factory execution environment.
Inside an admitted Linux parent, `FACTORY_BROWSER_PROOF_NATIVE_SELF=1` reuses the matching
prebuilt test executable and the parent's existing Docker CLI and Git, without another parent
image or a Go installation. Set `FACTORY_BROWSER_PROOF_DOCKER_VERSION` to the exact version in
`upstream.json`. `FACTORY_BROWSER_PROOF_STANDALONE=1` covers an image-only primary without a
Compose label. Both paths retain the App, source, lease, isolation, recording and cleanup checks.
This component proof does not update worker pins or replace the full Factory Delivery journey.

The browser's `browser_http_observations` tool reads only responses already observed by its
isolated App proxy. It exposes bounded cookie attributes without values and sanitized CORS
metadata, with explicit pagination and history-loss indicators. The read sends no App request.
Cookie acceptance still requires actual browser behavior; this is not a historical write audit.

The review-only `review_execution` tool reads Factory commit receipts for the exact candidate
and paginated implementation tool inputs from its recorded Workspace Sessions. Factory checks
historical environment identities before reading native actions, masks their protected values
and common credential syntax before pagination, and withholds prompts, reasoning, native outputs
and browser-typed values. Patch indexes show paths; selecting one action reads its redacted recorded
patch with bounded pagination, including temporary helpers absent from Git. Recorded input alone
does not prove which bytes a later execution used. Missing identities or secret-store receipts fail
closed. Action timestamps
exclude later implementation; unclassified or redacted material stays unknown. Only a response
digest and provenance enter compact Review Evidence. Runtime-owned history is not a tamper-proof
or exhaustive external-write audit, and neither action history nor commit receipts replace
source or App coverage. A receipt's `source=agent` identifies the trigger, not forge authority.
The inventory section lists every eligible tool position on one native page without copying inputs;
its cursor and next Session identify the remaining history. Selected action reads inspect the
material inputs. The inventory itself is not a compliance verdict.

The smaller `opencode-sol.live` proof runs the exact published OpenCode process in an owned
fixture, implements and tests a small goal through Azure `gpt-6.1-sol` at medium reasoning,
and checks the result independently without a final JSON form. Set `FACTORY_OPENCODE_SOL_LIVE=1`
and explicitly configure `FACTORY_MODEL_BASE_URL`, `FACTORY_MODEL_API_KEY` and
`FACTORY_AGENT_MODEL_ID` before running `mise exec -- bun run test:live opencode-sol.live`.
Set `FACTORY_OPENCODE_SOL_REASONING=high` to prove a higher selected effort instead of the
default medium.
It keeps the real provider credential outside the fixture and removes its owned containers.

The independent reviewer calibration uses an explicitly configured Azure Coding connection at medium
reasoning. Set `FACTORY_REVIEW_MODEL_LIVE=1` and run
`mise exec -- bun run test:live candidate-review-model.live`. It executes a healthy control and two
seeded defects independently, then checks the fresh native reviewer's judgments. It also gives
fresh finding checkers a healthy false alarm and both real defects, requiring dismissal or confirmation.
This is a bounded calibration, not the final application journey.
`bun run test:controllers candidate-review` checks
exact-candidate Delivery, targeted correction, explicit retry, Stop and allowance behavior without
live models. `bun run test:native opencode-review-permissions` proves the pinned native tool boundary.

A failed Verification environment does not commission another Sandbox or code correction.
After Factory confirms that the workflow was still queued and the failed Sandbox and runner
are cleaned up, the Ticket offers **Retry checks**. This explicit command retains the failed
outcome and Runtime identity before preparing another environment for the same Forgejo run.
It does not rerun executed checks, repeat implementation or approve Delivery. Unconfirmed cleanup,
active or uncertain work and a changed candidate remain ineligible. Repeating the same command
observes its result without dispatching another runner.

Wiki review has a separate Planning-model calibration. With the explicit Luna connection, set
`FACTORY_WIKI_QUALITY_LIVE=1` and run `bun run test:live wiki-quality.live`. It accepts an accurate
description of a source limitation and clearly marked improvement advice, while rejecting invented
cleanup and global-connection guarantees.
With that same connection, set `FACTORY_WIKI_PLAN_COVERAGE_LIVE=1` and run
`bun run test:live wiki-plan-coverage.live`. The plan check accepts research intent before
investigation, rejects an empty plan that leaves essential guidance missing and accepts a
genuinely complete Wiki without changes. It also rejects a redundant guide for an already covered
reader task. Page publication still requires its separate factual checks.
Set `FACTORY_WIKI_UPDATE_LOCALITY_LIVE=1` and run `bun run test:live wiki-update-locality.live`
to exercise the full writing workflow against synthetic changed sources. An internal refactor
must publish nothing; a changed development command must update its existing guide without
rewriting the overview, duplicating pages or losing human context. These paid proofs do not
modify the retained installation.

Exact-commit code research has its own paid proof. With the explicit Luna Planning connection,
set `FACTORY_CODE_RESEARCH_LIVE=1` and run `bun run test:live contextual-research.live`.
It checks native code discovery, inspected-file citations and visibility after a permission
downgrade. It is not part of the ordinary controller lane.

The worker's read-only storage admission check has a separate Linux proof. Set
`FACTORY_STORAGE_ADMISSION_LIVE=1` and `FACTORY_STORAGE_ADMISSION_IMAGE` to the exact pinned worker
image already available locally, then run `bun run test:live factorybox-storage-admission.live`.
It checks real insufficient capacity on an owned small filesystem, exact capacity boundaries and
foreign-storage refusal without Project source, network, native filesystem allocation or model
calls.

Retrospective work review has a separate configured Planning-model calibration. Set
`FACTORY_LEARNING_MODEL_LIVE=1` and run `mise exec -- bun run test:live learning-model`.
The default controller and browser lanes use isolated evidence and make no paid calls.

Monitoring diagnosis has a separate configured Planning-model proof. Set
`FACTORY_MONITORING_MODEL_LIVE=1` and run `mise exec -- bun run test:live monitoring-model.live`.
It reads owned synthetic incidents through the official MCP transport and exact local Git source,
then distinguishes an application defect, missing code and an operational alert. It records native
model usage.

Generic Input preparation has its own configured-model proof:

```sh
FACTORY_PROJECT_INPUT_LIVE=1 mise exec -- bun run test:live project-input.live
```

It reads two selected sources through the official MCP client, prepares one unapproved Ticket
with requirements, and checks that duplicate deliveries do not repeat inference. It starts no
Build or Delivery. `bun run test:browser test/browser/project-inputs-ui.spec.ts` exercises the real
settings components with controlled API responses on desktop and phone. The full-Factory
`monitoring-settings.spec.ts` additionally exercises authenticated commands and durable policies.

The full monitoring proof uses separate PostgreSQL, OpenBao and Forgejo resources, the published
runtime pins and configured Planning/Coding models:

```sh
FACTORY_RUN_MONITORING_AUTOFIX_PROOF=1 mise exec -- bun run test:live monitoring-autofix.live
```

Only the external monitoring provider is synthetic. The proof connects it with an encrypted bearer
token, reviews its exact tools and grants Project access. Duplicate alerts must create one Ticket
and one Change, then pass native Build, fresh Verification and independent review before delegated
Delivery advances `release`, the configured default branch. The unrelated `main` branch must stay
unchanged. The harness checks the promoted App's missing and known invoice responses without
editing source or approving Delivery after intake.
Failures retain exact owned identities under `.factory/test-results/monitoring/native/`.
`FACTORY_MONITORING_AUTOFIX_RESUME` accepts that run's `state.json` to observe its existing work.
It never commissions a replacement for a blocked or uncertain incident. Successful runs remove
their owned runtime storage, services and credentials.

Filter a controller or native lane by filename, for example `bun run test:controllers agent-read`.

Technical Planning has an owned, opt-in model proof:

```sh
FACTORY_TECHNICAL_PLANNING_LIVE=1 mise exec -- bun run test:live technical-planning.live
```

It exercises Product confirmation, exact-commit code reads and a rendered PlantUML diagram without
starting implementation. The configured Planning connection incurs ordinary model usage.
Use `--list` to inspect its selection. Ordinary unit/controller/native lanes discard inherited live
model flags and provider credentials, and do not load `.env` in the test runner or owned Factory
children. Native runtime
conformance and Forgejo checks remain explicit commands, not hidden steps in the default integration gate.
Runtime conformance uses an explicit admitted Factorybox profile and Registry trust. It owns a
separate namespace, worker and claims, never the shared Registry or retained installation.
`runtime:smoke:down` removes only completed labeled conformance namespaces with UID preconditions.
Failed native stores stay retained for diagnosis while their owned worker Pod is fenced to release RAM.

