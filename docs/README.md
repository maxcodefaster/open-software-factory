# Factory architecture and domain reference

This reference describes the implemented product boundaries. ADRs explain why those boundaries
were chosen. Exact dependency versions live in manifests, lockfiles, `mise.toml` and `upstream.json`.

## Ownership and execution

```text
Solid 2 interface
  -> authenticated Factory commands
  -> PostgreSQL intent and product state
  -> Factory controllers
  -> Kubernetes / Forgejo / concrete agent engines

Zero -> planning mutations and cached read projections
```

Factory owns authority, admission, Stop, recovery, requirements and human decisions. PostgreSQL
owns durable product state and compact Evidence. Forgejo owns repositories, branches, commits,
pull requests, Action runs and full Verification logs. Kubernetes owns observed outer resources;
each private Docker daemon owns its inner containers, networks and volumes.

Domain modules remain independent of Solid, Zero, OpenCode, Forgejo, Kubernetes, Docker and Envbox
types. Concrete Factory adapters contain vendor APIs. Persist intent before external creation;
every create has deterministic identity, idempotency and ambiguous-outcome recovery.

| Work | Engine | Authority |
| --- | --- | --- |
| Investigate | Mastra in the Factory server | Authorized Project research; no execution Sandbox |
| Plan | Mastra in the Factory server | Typed questions and proposals; human confirmation grants scope |
| Build | OpenCode 2 in the primary Dev Container | One approved Change, with separate implementation and read-only review Sessions |

Engine assignment is fixed. Models, role instructions and eligible Skills are configurable.
Settings → Skills provides private authoring, a curated starter collection, package import previews
and manager-reviewed sharing. Anyone can keep a personal library across the instance; activation
choices are per Project. Required rules identify their Factory or Project source. Other choices
inherit individually and version updates are explicitly adopted for new work. See
[the engine decision](adr/0008-fixed-role-agent-engines.md) for package admission and privacy.
The editor leads with Name, When to use and Instructions; files and source details are optional.
Admission freezes the exact target, input, effective configuration and current authority before
external work. Navigation and reconnect never retarget an admitted turn. Unknown provider outcomes
remain uncertain and require an explicit new human retry. An expired lease alone does not authorize
another paid request. Both provider retries and Mastra error-processor retries are disabled.

Requirements work is manual by default. Creating or moving a Ticket into Requirements, saving its
document and reading it never commission model work. A complete manual specification may go
directly to Implement, which approves its exact saved revision and durably admits Build. The optional
Interview starts only with an explicit conversation command. Historical automatic-entry records
remain retained but are not a dispatch queue; already admitted Agent Turns keep their normal
recovery and outcomes.

The Interview uses the frozen selected Ticket without rereading it solely for attribution. Explicitly
invoked Skills, applicable required rules and the assigned Interview Skill load through Mastra's native `getSkill` API before
inference, with at most 8 KiB of reference text. Other Skills and larger references remain on demand.
Manual-only guidance still requires invocation. Task-specific structured context preserves earlier
decisions and option meanings within 96 KiB without duplicating the current input. Oversized core
context fails before inference; optional assistant background may be omitted. Research/Interview
instructions and output contracts stay separate. Project requests have a 60-second deadline,
six provider steps, 256 KiB of serialized per-step input and at most 6,000 output tokens per step.
These byte limits are conservative resource bounds, not tokenizer-specific context guarantees.
Wiki uses a shared budget of 32 provider requests, including tool rounds and deliberate repairs,
with at most 1 MiB of per-step input and 8,000 output tokens. Setup/probes use the same no-retry
policy and their existing task deadlines. Setup, runtime, source, IDE, Forge access, Change Writer
and execution-reserve coordination use
short-lived PostgreSQL sessions so infrastructure waits do not occupy the application pool.
These sessions close after each operation and count toward PostgreSQL's connection capacity.
Assistant research progress is ephemeral and contains no source text.
Ordinary Assistant answers stream provisional Markdown through the authenticated message command.
The first text is immediate; subsequent snapshots coalesce at 40 ms to bound authorization and
rendering work. Browser reads cannot overwrite a newer command result, and disconnected streams
have a bounded client lifetime without retrying the model request.
Questions and proposals stay hidden until validated. Partial text is not persisted; final validation
publishes the answer and its citations once. Disconnecting a browser does not stop or replay work.
The Project Agent adapter uses source-specific provider citations: only Code requires a commit/path;
an unused footnote is nullable. Factory validates the returned domain result, including Epic rules.
A known structured-output rejection is failed, not an unknown provider outcome.

One OpenCode server runs as the development user in the Ticket Workspace. Factory reaches its
native API through the Runtime Connector and `@opencode/client`; browsers do not connect directly.
OpenCode receives generation-bound inference access and no reusable forge credential. Factory
controls commit creation and the exact authorized branch push. Stop fences ownership, interrupts
owned descendants and removes owned background shells before confirming settlement.

The retained OpenCode upgrade preflight validates native history, preserves a complete
content-addressed SQLite/WAL backup and atomically adds the missing historical `started` timestamp
from each retained event's creation time. It preserves identities, sequence, counters and queued
inputs. Invalid history refuses startup. Historical creation time cannot recover dispatch latency,
and migration never replays inference. Upstream OpenCode remains unmodified.

## Workspaces and runtime

```text
Project
├── one Staging Preview for the promoted default-branch commit
├── one Personal Development Workspace per developer
└── one shared Ticket Workspace per active Change

Development Workspace
├── canonical durable source and approved development data
├── source access independent of execution
└── zero or one running Sandbox, with an immutable Runtime Attempt per start

Developer -> one independent Theia IDE across authorized Workspaces
```

Opening the IDE can prepare source without starting Apps or Build. A Ticket with an active Change
selects its shared Workspace; other editing uses the developer's personal Workspace and grants no
Ticket Build authority. Workspace-qualified file identities keep dirty buffers and later saves
bound to their original checkout when selection changes. PTY sessions, processes and Agent turns
also retain their original Workspace and Runtime Attempt.

The independent file service and assigned compute mount the same canonical source on the same
storage node. Factory's Theia extension adapts files, search and watch operations through scoped
access. Initialization runs no Project hooks or code and permanently drops ownership privileges
before serving source. No synchronized checkout, mutable current-directory alias or NFS watch
assumption is involved.
The independent editor has a pinned TypeScript/JavaScript and Python language preset. Start tools
explicitly prepares execution if needed; opening source alone never starts a language server.
The servers run in the actual Dev Container with Project dependencies, not on the editor backend.
Completion, semantic diagnostics, hover and definition navigation use Workspace/Runtime Attempt-bound
WebSockets. Lost authority, Stop and disconnect close their processes. Reconnect restores buffers
without replaying prior requests. Definitions from runtime-only dependencies open read-only through
session-reported, exact-Attempt identities, never backend-local `file://` access. Other languages
remain syntax-only. Arbitrary language plugins, shell commands, server edits, general formatting
and refactoring are not part of the preset.

Every Sandbox uses the same topology:

```text
Kubernetes -> digest-pinned Envbox Pod
  -> Sysbox workspace container with a private Docker daemon
    -> Factory Runtime Connector in parent mode
    -> exact Dev Containers CLI and approved container stack
      -> primary container with Connector child mode
      -> bounded Compose dependencies
```

Envbox, Sysbox, Docker, Compose and the Dev Containers CLI run unchanged. Project code has no node
Docker socket. The privileged outer Envbox wrapper is trusted infrastructure; Sysbox shares the
host kernel and does not establish VM-grade isolation. Factory has one concrete runtime topology
and no Coder control plane or generic runtime provider layer.

Exact role images separate ordinary execution, OpenCode Build, Forgejo Verification, the Developer
IDE, source service and optional browser tools. A persisted Runtime Attempt keeps its image through
later publication. Fresh Staging and Verification may consume never-used prepared slots. A used
slot never returns to the reserve, and no running Pod swaps its PVC. Existing Workspaces retain
their own source and data identities. The local reserve target is zero.

Project-owned prebuilds reuse only exact recipe, commit, image/Feature, platform and environment
inputs. Immutable artifacts can be reused; mutable dependency trees, used Sandboxes and previous
verdicts cannot. Required Dev Container hooks and resolved-container checks still run. Separate
Development and Main-Preview environments use encrypted OpenBao values, masked metadata and
durable external-write intent. Verification receives only explicitly approved credentials. An
authorized application and its coding Agent can read the runtime values they consume.

## Identity, planning and delivery

Better Auth handles local/OIDC login, SSO and optional SCIM. Factory owns Project membership and
access prohibition; Forgejo consumes Factory-issued OIDC and reconciled private repository grants.
Identity binds verified issuer and subject rather than mutable email. SSO has separate secured
emergency administration. Logout affects browser access without implicitly stopping admitted work;
disablement and authority loss fence further operations.

Contribution, development and Project management are independent permissions. Contributors can
plan, commission approved implementation and request corrections. Developers and managers retain
their permitted source/runtime operations and exact Delivery authority. App previews are available
to authorized Project members; personal source and IDE access remain owner-scoped. One durable
Change Writer coordinates Agent and human edits at source, terminal and Git boundaries.

Requirements Interviews retain partial answers, pause and resume. Project/Ticket context freezes
at admission. PostgreSQL full-text search and pg_trgm find current authorized Tickets, specifications,
Epics and Wiki; direct relationships and exact-commit Forgejo reads expand context. Code inspection
requires development authority. Human confirmation atomically accepts immutable requirements or
edited Epic/member proposals. New member Tickets enter Requirements without automatic Builds.

```text
Approved requirements -> commissioned Change -> OpenCode edits and local checks
  -> Factory commit and controlled push -> Forgejo pull request
  -> fresh Verification -> independent Candidate Review -> exact human Delivery Approval
  -> fast-forward merge -> healthy Staging replacement
```

Verification runs the protected default-branch workflow against the exact Change commit in a fresh
Sandbox, with a repository-scoped one-job Forgejo runner. The Change and recorded default-branch
heads must still match the approved values; movement invalidates Delivery. A correction needs a
new commit and Verification. Staging retains its previous healthy Preview until replacement is ready.
After successful Verification, the same admitted Coding model reviews the exact candidate in a fresh
OpenCode Session without implementation history. Fixed session permissions deny native execution,
editing, Skill execution and descendants. The existing Factory MCP facade supplies bounded,
immutable base/candidate file reads and diffs, App inspection and a review-report tool. No generic
agent registry, extra model-default role or second orchestration engine is introduced.
Factory retains the implementation Session separately for corrections. The current execution Session
continues to bind Stop, model relay, usage and browser authority. Both histories remain readable.
Only a settled review with accepted coverage and no blocking findings can pass. Frontend file changes
require actual App inspection and an exact-candidate screenshot; dirty or different-commit browser
observations cannot be accepted. The prompt also requires relevant UI behavior beyond that file
classification. A fresh reviewer is an evaluator, not a guarantee that every defect will be detected.
Factory persists compact findings, source-read evidence and screenshot digests/provenance, not image
blobs or another transcript. Screenshot images retain the browser's existing ephemeral lifetime.
Blocking findings request a bounded targeted correction in the retained implementation Session.
Missing proof stays incomplete. An explicit retry creates another fresh review attempt for the same
candidate without changing the old result. Changed Requirements or new source invalidate review eligibility. Human
Delivery Approval records the exact settled review as well as the commit and Verification.
Delivery ends at Staging, rather than a production application deployment.
Cleanup confirms no writers on the delivered Change branch while retaining its protected source
ref and history. It does not temporarily remove protection to force branch deletion.

Knowledge Pages have stable identities, ordered hierarchy, immutable revisions and recoverable
autosave. Generation reads one exact repository commit and fences concurrent human changes.
Publication also merges existing human text against a separate generated baseline; overlapping
edits keep the saved page rather than trusting a model to preserve its wording.
Omission never deletes a page. Editable Wiki and read-only Repository Documents remain separate;
code-derived reads and provenance require development authority. Signed forge events persist update
intent, and missed-event reconciliation confirms current source without a second code database.

Native agent observations feed a compact deduplicated usage journal with immutable pricing inputs.
Session totals reconcile usage rather than adding it again; inherited fork history is not new usage.
Missing consumption stays unknown. Optional Coding budgets prevent new starts, with a shared finish
reserve for commissioned work; in-flight calls can overshoot. Project research is measured separately.
CPU/RAM samples and runtime logs are ephemeral, not Zero projections or persisted Evidence.
Pricing reads use a validated in-memory catalogue. Cold/expired prices stay unknown while one
bounded background refresh runs; network requests never hold an inference or budget transaction.
Environment managers can read masked metadata without Developer access. Settlement and recovery
recheck their current management/account authority before publishing an externally written version.

Coding activity uses one shared native OpenCode SSE connection per observed Runtime Attempt.
The authorized Side Panel receives coalesced replacement snapshots, reconciles history on reconnect
and detaches when closed or hidden. It does not poll visible history. Native activity invalidates
Build observations; a fifteen-second reconciliation check covers missed events without replaying
inference. Independent ownership/browser renewal, ordered Stop and durable usage settlement remain
required. Closed-panel lifecycle reads omit native history, and command-result fences reject older
streams or reads. Native tool identities survive history updates without deduplicating legitimate
repeated text. Wiki bodies subscribe only while a Wiki
tab exists, including minimized tabs with retained drafts. Repository inventory refreshes on the
generation identity/state rather than every status tick. The signed-out entry loads no document editor.
Infrastructure commands have bounded combined output and deadlines; timeout leaves the external
outcome unconfirmed, never authorization to replace an immutable resource identity. Idle sweeps
advance through ID-ordered batches so busy early rows cannot indefinitely hide later Workspaces.

The Solid desktop uses shared semantic tokens, bundled Sansita/Inter and curated local artwork.
Wallpaper keys are durable user preferences. Open windows, panel visibility and geometry are
navigation state. Minimize retains work and dirty buffers; reduced motion and transparency have
usable fallbacks. Embedded IDE, Terminal and Preview content remains opaque.

## Domain vocabulary

| Term | Meaning |
| --- | --- |
| Project | One software product, source repository and System Contract |
| Project Import | One-time transfer of Git history into a Factory-owned repository |
| Project Setup Draft | A manager's unfinished creation/import, before Project or execution authority |
| Project Setup Proposal | Exact source-grounded configuration edits confirmed before preparation |
| Ticket | Shared planning record for one intended Project change |
| Ticket Draft | Human-owned, uncreated intent with no Interview or implementation authority |
| Idea | A shared Ticket not yet selected for Requirements work |
| Ticket Document | Human-authored intent refined through Requirements work |
| Requirement Proposal | Suggested edits against an identified document state, accepted by a human |
| Requirements Interview | Resumable clarification producing a proposal without granting implementation |
| Interview Round | Independently answerable questions; confirmed answers determine what remains |
| Requirement Revision | Immutable specification of one Ticket |
| Epic | Project-local grouping; a Ticket has at most one Epic and an Epic at most one parent |
| Epic Proposal | Proposed new/reused Ticket grouping, confirmed without commissioning implementation |
| Ticket Dependency | Same-Project prerequisite satisfied by delivery, not cancellation |
| Board Stage | Ideas, Requirements, Implementation or Review; Ready is a gate, not a stage |
| Change | Isolated implementation of one approved Requirement Revision |
| Verification | Evaluation of one exact Change commit in a fresh runtime |
| Candidate Review | Independent, read-only AI evaluation of one exact verified Change commit |
| Delivery Approval | Immutable human approval of one verified commit for merge and promotion |
| Promotion | Adopt the merged default-branch commit; switch Staging only when ready |
| App | Named Project service declared by its System Contract |
| Preview | Authenticated browser endpoint for one declared App |
| Staging Preview | Project Preview of the promoted default-branch revision |
| Development Workspace | Durable checkout and approved data, independent of running compute |
| Personal Development Workspace | One developer's Workspace per Project; it is not a Change |
| Ticket Workspace | Shared canonical Workspace of one Ticket's active Change |
| Developer IDE | One developer's editor across authorized Workspaces, retaining each editor state |
| Sandbox | Replaceable running compute for a Workspace or Staging Preview |
| Runtime Attempt | Immutable start identity; an explicit new retry does not replace prior history |
| Runtime Connector | Factory process connecting the approved container stack to its authority |
| Project Environment | Independent Development or Main-Preview variables and registry access |
| Development Image Prebuild | Exact prepared development image, not a released application artifact |
| Project Agent | Checkout-free investigation, Requirements and Knowledge work |
| Change Agent | Implementation in one approved Ticket Workspace |
| Change Agent Session | Resumable coding conversation shared with that Workspace |
| Project Conversation | Project-scoped history separate from Ticket conversations |
| Ticket Conversation | One visible history spanning research, planning and implementation |
| Conversation Mode | Investigate, Plan or Build authority for the next turn |
| Agent Turn | One durably admitted unit of work; explicit retry creates another identity |
| Agent Role | Product responsibility, distinct from human access and execution engine |
| Agent Profile | Versioned role instructions, Skills and model defaults, without extra authority |
| Skill / Skill Revision | Eligible reusable instructions and their immutable identified version |
| Effective Agent Configuration | Frozen role, model and eligible Skills for one admitted turn |
| Factory Policy | Binding constraint; lower scopes can tighten but cannot widen it |
| Model Connection | Managed provider access; credentials are not conversation content |
| Agent Usage | Observed consumption; a missing observation is not zero |
| Coding Budget | Optional monthly estimated-cost start threshold for Coding work |
| Finish Reserve | Shared allowance for commissioned work, without an invoice-ceiling guarantee |
| Compute Allowance | Optional concurrent-resource ceiling; source editing is independent |
| System Manager | Installation administrator; not a substitute for exact Delivery Approval |
| Project Manager | Delegated Project membership/defaults management, independent of development |
| Developer | Project member with permitted planning and development access |
| Product Contributor | Planning and commissioning access without direct code execution or Delivery |
| Project Membership | Contribution/development role plus independent management permission |
| Change Writer | The Agent or Developer currently authorized to change the shared Workspace |
| Editing Takeover | Controlled writing-authority transfer after the previous writer has stopped |
| Trash | Recoverable removed work; restoring it never automatically resumes implementation |
| Knowledge Page | Editable Project wiki page with stable identity, order and revisions |
| Knowledge Revision | Immutable page revision; generated revisions identify exact source |
| Knowledge Generation | Attempt to update Knowledge from one exact commit; omission never deletes |
| Repository Document | Source-controlled Markdown read from an exact commit, edited through source |
| Assistant Context | Known Project/work at admission; later navigation does not retarget it |
| Desktop Background | Curated artwork selected by stable Factory key |
| UI Preference | Durable presentation choice, excluding transient navigation and window state |

## Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-development-workspaces-and-staging.md) | Independent editing, durable Workspaces and prepared compute |
| [0002](adr/0002-opencode-change-agent.md) | OpenCode in the Ticket Workspace without forge authority |
| [0003](adr/0003-forgejo-actions-verification-and-promotion.md) | Forgejo Verification and Factory promotion |
| [0004](adr/0004-generated-project-knowledge.md) | Generated revisioned Knowledge separate from source documents |
| [0005](adr/0005-curated-desktop-visual-system.md) | Curated desktop and shared visual system |
| [0006](adr/0006-project-agent-and-ticket-conversation.md) | Project Agent and unified Ticket conversation |
| [0007](adr/0007-durable-agent-admission-and-uncertain-outcomes.md) | Durable admission and uncertain external outcomes |
| [0008](adr/0008-fixed-role-agent-engines.md) | Fixed concrete engines with configurable models and Skills |
| [0009](adr/0009-independent-workspace-file-access.md) | Canonical file access independent of execution |
| [0010](adr/0010-factory-identity-and-change-writers.md) | Factory identity and exclusive Change editing |
| [0011](adr/0011-delivered-branch-retention.md) | Delivered branches retain source behind a closed write fence |
| [0012](adr/0012-independent-candidate-review.md) | Independent review uses a fresh, read-only OpenCode Session |
| [0013](adr/0013-kubernetes-native-installation.md) | One Helm installation on existing Kubernetes, independent of the workstation |

## Verification and operating limits

The dependency baseline was accepted and locally deployed on 2026-10-12 with 404 unit tests,
43 browser cases, native retained OpenCode recovery/Stop/usage, Project process recovery, fresh
Starter, Connector race/vet and runtime conformance. The final native editor proof also passed
18 assertions with compute stopped, retained buffers, original-Workspace saves and access revocation.
This evidence describes those concrete checks, not a universal startup guarantee.

OpenCode 2.0.27 is stable. Solid 2.0.0-rc.14 remains a release candidate, as checked on 2026-10-13.
TypeScript 6 retains the transpilation API used by tooling; Effect stays aligned with OpenCode's
exact requirement. PostgreSQL and Forgejo remain on supported tested majors. The dependency audit
still reports 12 root upstream advisories and 36 affected Theia packages; the Starter audit is clear.
Supported tinypool and DOMPurify fixes are applied. The shared cluster Metrics service is not
Factory-owned and was not replaced merely to match the newer checked-in manifest.

Prepared editing can be fast while cold image builds, Terminal startup and Main-Preview preparation
take longer. The local RWO claim request does not establish a hard storage quota. Sporadic upstream
Sysbox startup failure remains a recorded local limit. Keep source, requirements, approvals and
runtime identities through Stop and recovery. Restart can interrupt inference; observe uncertain
work rather than silently resending it or clearing product rows.

Historical slice records and captures are archived locally under
`.factory/archives/repository-cleanup-20261013/`. Maintained tests provide repeatable checks; new
local screenshots and results belong under `.factory/test-results/`. See the root
[development commands](../README.md#development-and-checks) and
[runtime artifact guide](../deploy/runtime-host/README.md) for running the relevant checks.

The 2026-10-13 documentation cleanup passes documentation checks, affected formatting/lint,
TypeScript and the sign-in capture check. A sampled legacy unconfirmed-Stop browser fixture fails
before its changed output path: it selects a Ticket and expects Build controls, while the current
Assistant derives Build context from the IDE or an explicit correction. This fixture needs its
context setup updated separately; the cleanup changes no product behavior or provider execution.

The Project Agent hardening has native context/Skill/budget regressions, PostgreSQL turn/recovery,
directed research, Epic confirmation and setup-pool checks, plus three Assistant browser journeys
with inspected desktop/narrow captures. Configured Luna semantic cases cover settled option
meanings beyond 24 entries, scope, corrections, relevant questions and prerequisite reasoning.
Observed one-step results took 2.4–4.1 seconds; research took 4.9–9.3 seconds, with first actual
research feedback at 1.7–3.0 seconds. The previous repaired Ticket observation took 6.5 seconds
with one provider request, versus the broken 15–16-second/four-to-five-step path. These are individual
observations, not a matched benchmark or latency SLA. Run the opt-in
`FACTORY_AGENT_QUALITY_LIVE=1` cases in `apps/factory/src/project-agent/quality.test.ts` with the
configured model-secret environment. They incur usage but do not modify retained Tickets.
Custom choice answers and explicit correction phrases invalidate prefetched rounds; this is a
conservative dispatch rule, not a general semantic correction classifier. Assistant feedback is
ephemeral research progress, not streamed unvalidated proposal text.

The stabilization checks cover 482 fast tests, constrained-pool Forge/Writer/reserve coordination,
Environment authority-loss recovery, fair idle sweeps, immutable known/unknown usage and enabled
Coding limits. Owned fixture tests prove isolated databases and process recovery while reusing only
the empty migrated baseline. PostgreSQL CAS checks observe real lock contention between two
different sessions. Linux Connector race tests/vet include filesystem tests omitted by macOS;
the irreversible credential transition runs separately as CGO-free code, matching the shipped binary.
The root-private snapshot trust file covers only the validated checkout and its Git directory.

Native Envbox conformance passed restart, retained volume, Connector transport and unsafe-mount
rejection, then removed its unique owned Pod/claim without touching the shared registry. Browser
checks cover retained Skill drafts, Wiki draft recovery, Settings tabs, old reads after Stop and
signed-out editor exclusion, with inspected desktop/narrow captures. The entry bundle decreased
from about 1.35 MB to 204 KB uncompressed. These checks do not claim every historical browser
fixture or paid provider journey passed; native, paid and retained-installation restart lanes are
explicit commands. No paid provider requests are needed for the default lanes.
