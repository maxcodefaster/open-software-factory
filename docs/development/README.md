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
| `bun run beta:gate` | Release gate: secret and forbidden-term scans, every lane, receipt for the exact commit |
| `bun run release:clean-room` | Install a chart on a fresh Namespace of the current kubectl context, prove it works, remove it |
| `bun run release:soak` | Long run on one installation: Preview open, idle pause, resume, Wiki update and backup every cycle, one Ticket journey every six hours; stops at the first error nobody allowed |
| `bun run release:upgrade-test` | Upgrade a previous build to the new one on a fresh Namespace and prove no data is lost |
| `bun run factorybox:publish` | Push and sign a worker image that passed conformance; refuses unproven bytes |
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

## Clean-room install test

`release:clean-room` installs a chart package on a Namespace it creates, checks the installation and
removes exactly what it created. It never reads or reuses a retained installation's values.

```sh
mise exec -- bun run release:clean-room --factory-image REF@sha256:DIGEST --node NODE
mise exec -- bun run release:clean-room --chart ./factory-0.1.0-beta.1.tgz --node NODE
mise exec -- bun run release:clean-room --chart oci://ghcr.io/maxcodefaster/charts/factory:0.1.0-beta.1 --node NODE
```

`--chart` takes a `.tgz` file or an OCI reference. Without it the run packages this working tree with
`scripts/release/package-chart.ts`, using `--factory-image` and the worker in
`deploy/factorybox/release.json`. A locally available tag such as `open-software-factory:release-<sha>`
is accepted for `--factory-image` on a local run; a published digest reference is the normal case.
`--node` is optional on a one-node cluster. `--values FILE` adds settings, but only storage class, sizes,
resource requests and worker sizing are copied. Origins, Secret names, images and the node are dropped,
and the receipt lists the dropped paths. `--small-requests` lowers scheduling memory requests.
`--keep` skips cleanup, and `--cleanup factory-cleanroom-<8 hex>` removes an interrupted or kept run.

The run uses the current kubectl context, pinned at the start, and a new Namespace
`factory-cleanroom-<8 hex>` that carries an owner label. It refuses an existing Namespace. In order, it:

1. checks that the node's unrequested allocatable memory covers the control plane, and names the
   largest requesters when it does not (it stops nothing itself);
2. installs with `helm install --wait=legacy --timeout 20m` and runs `helm test`, whose preflight
   starts a short probe Pod and no worker;
3. waits for `/health/ready?installation=complete` through the `factory:connect` port forwards;
4. reads the generated admin password from the installation Secret and signs in with Chromium from
   `node_modules`, asserting no console errors and no 5xx response;
5. checks that OpenBao is unsealed and that the Factory settings Models page loads;
6. runs a manual backup Job from the chart's CronJob, copies the newest set and runs `restore-check`
   (needs `pg_restore` 16 or Docker; otherwise that check is recorded as skipped);
7. runs `helm uninstall`, then deletes the PVCs, the Namespace, any released PVs and the chart's
   ClusterRole and ClusterRoleBinding. Each deletion is by exact name, after the Namespace's name and
   owner labels and the claims' recorded UIDs match.

Known limits, also written to the receipt. A Starter Project makes Factory prepare images and start
Main-Preview, which admits a Factorybox worker, so the Project, Ticket and Wiki steps run only with
`--with-sandbox` and are recorded as skipped otherwise. With it, worker and editor Namespaces count
as owned only when the installation database recorded their UID; others are listed, never deleted.
Wiki pages need a model connection, so the Wiki edit is skipped on a clean installation. The settings
check proves OpenBao is unsealed and the connection list reads, not that a provider key decrypts.
Memory on a crowded node can be too tight for the control plane; the capacity check fails before
anything is installed.

The receipt is `.factory/test-results/clean-room/<namespace>.json`, written before the Namespace
exists and updated after each step. It holds versions, chart and image digests, timings, every check
and the cleanup result, and never the admin password. Screenshots sit beside it in a folder of the
same name.

## Upgrade test

`release:upgrade-test` installs a previous build, fills it with data, upgrades the chart to the new
build and compares everything before and after. It owns one Namespace, `factory-upgrade-<8 hex>`,
and never reads or changes a retained installation.

```sh
mise exec -- bun run release:upgrade-test \
  --from-chart git:7b339b88 --from-image open-software-factory:release-7b339b88 \
  --to-chart deploy/helm/factory --to-image open-software-factory:release-NEW \
  --node NODE --values /path/to/private-values.yaml
```

`--from-chart` takes a chart directory or `git:<commit>`, which extracts `deploy/helm/factory` at that
commit with `git archive`. Both images must be pullable by the cluster; for a local run an older
locally built tag is enough. `--values` is the private file both builds need, mainly the Factorybox
worker image, executable hash and architecture. The script overrides every origin, Secret, backup
and reserve setting. The release runs with `executionReserveTarget: 0` and backups off, so it starts
no worker and no Sandbox, and it asks for about 0.8 GiB of scheduling memory. The memory check
runs first and, when the node is too full, names the Namespaces holding the most requests. It stops
nothing itself.

The run, in order:

1. creates the labelled Namespace (refusing an existing one) and installs the previous build with
   `helm install --wait=legacy --timeout 20m`;
2. seeds data. Chromium signs in as the administrator with the generated password (read from the
   Secret, never printed), creates a managed account and writes two Tickets as ideas. The Forgejo
   API creates a repository with the starter scaffold. The factory role writes the rows that need a
   runtime or a model: the Project, Tickets in four more states, a Wiki page with two revisions, two
   Inbox assignments and a model connection placeholder whose secret is written to OpenBao. One
   plain object is written to the object store. An attachment row has no path without the UI, so
   none is seeded;
3. takes a fingerprint: for every ordinary table outside `pg_*`, `information_schema` and the Zero
   cache, a row count and a digest of per-column hashes in primary-key order (volatile columns such
   as `updated_at`, and sessions, verification tokens, read versions and the maintenance fence, are
   left out); the applied migrations; every Forgejo repository's branch heads and file listing from
   the API; every OpenBao secret path the database names, read and decrypted as Factory's own
   AppRole and compared by digest, plus the seal state; and every object key with its size and ETag;
4. runs `helm upgrade` to the new chart and image with the same values and takes the fingerprint
   again. A row, file, secret or object that disappears or changes fails the run. New migrations,
   tables and columns are allowed. A new row in an existing table is refused unless `--allow
   row:<schema.table>` names it;
5. checks that OpenBao is unsealed, the claims and generated Secrets are the same objects, the
   administrator and the new account still sign in with their original passwords, and the Project,
   each Ticket and the Wiki page load with zero console errors (`--ignore-console REGEX` for a known
   benign message);
6. upgrades again to the same build and requires a fingerprint identical to the one before it, with
   no allowances and no new migration;
7. removes the release, then the claims, the Namespace, released volumes and the chart's cluster
   roles. Each deletion follows a check that the Namespace name and owner label match, and
   nothing in `factory-box-*`, `factory-editor-*` or another Namespace is touched. `--keep` skips
   this and `--cleanup factory-upgrade-<8 hex>` removes a kept or interrupted run.

On failure the script prints each refused difference with its table, row key and column (hashes,
never values). The receipt is `.factory/test-results/upgrade-test/<namespace>.json`. It holds both
images, the memory check, every step and check, the fingerprint summaries, both diffs and the
cleanup result, and never a password or token. Screenshots of a failed browser step sit in a folder
of the same name.

Rollback is documented, not performed. A chart rollback does not roll the database back. Once the
upgrade has applied a migration the previous image refuses the newer schema at startup, so a
rollback leaves Factory not ready with all data intact. Recover by upgrading forward or by restoring
the last backup set into a new installation.

The browser steps use the selectors of the current UI. Run the test with a previous build whose UI
still matches them, or adjust `scripts/release/upgrade-test-browser.ts` for the build under test.

## Release soak

`bun run release:soak` runs on a retained installation for 24 hours before a release. Each cycle (every
20 minutes) checks Factory restarts, the worker Pod, failed runtime attempts and free disk, then runs
`scripts/release/soak-ui-cycle.ts`, which opens the Development Preview. Idle pause turns the Sandbox
off between cycles, so the next open is also a Resume. Every third cycle runs a Wiki update
(`soak-wiki.ts`) and a backup Job. Every eighteenth cycle runs one complete Ticket journey with the real
model (`soak-journey.ts`). A log line the allowlist does not name ends the run with a receipt that
says why.

```sh
FACTORY_SOAK_PROJECT=PROJECT_ID FACTORY_SOAK_STATE=session-state.json \
FACTORY_SOAK_NAMESPACE=NAMESPACE FACTORY_SOAK_RELEASE=RELEASE \
mise exec -- bun run release:soak --namespace NAMESPACE --release RELEASE \
  --worker-namespace WORKER_NAMESPACE --ui-cycle scripts/release/soak-ui-cycle.ts \
  --wiki "bun scripts/release/soak-wiki.ts" --journey "bun scripts/release/soak-journey.ts" \
  --allow allow.txt --hours 24 --interval 20
```

`session-state.json` is a Playwright storage state of a signed-in administrator. `allow.txt` lists one
regular expression per line for log lines that are known and harmless on that installation.
