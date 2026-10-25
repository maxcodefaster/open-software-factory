# Factory architecture and domain reference

This reference describes the implemented product boundaries. ADRs explain why those boundaries
were chosen. Exact dependency versions live in manifests, lockfiles, `mise.toml` and `upstream.json`.

## Client and application server

Factory has one application backend, written in TypeScript and running on Bun. Its
[composition root](../apps/factory/src/server.ts) creates the authenticated HTTP routes,
application services, controllers and background reconciliation in that process. The HTTP
listener uses native `Bun.serve`, not another web framework. Vite provides client development
and builds; it is not a second production application backend.

The Solid 2 SPA renders in the browser. Zero synchronizes authorized planning mutations and cached
read projections. Solid Server Functions replace hand-written UI transport, not Factory's
application services. The SPA's Bootstrap, settings, planning command adapters, lifecycle commands,
Review, Writer, IDE admission and conversation observations use named compiled functions. Agent
activity and Project answers use native typed streams rather than a second JSON/SSE API.
PostgreSQL retains product state, intent and outcomes. The Go Runtime Connector is a separate
execution component, not a second implementation of Factory's application services.

Server Functions run on the existing Bun host with the authenticated request actor and the same
application-service instances. Inputs and current authority are checked server-side. Protected
saves retain fresh-authentication and installation-maintenance gates, command identities and
explicit exact retries. A disconnected client, stale deployment or lost response never authorizes
automatic replay. The compiled adapter delegates error classification to the host so bundling
cannot change the identity of Factory command errors. The Usage read uses Solid's native async
memo without making the editable form state or writes reactive.

The production build emits separate client assets and a server-function handler. The server build
does not enable page SSR. Source development proxies function calls to the same backend instead
of creating application services inside Vite. Connector protocols, webhooks, authentication,
uploads, protected media and WebSockets retain their HTTP boundaries. Backend-language migration
is not part of this decision. Solid's browser reactivity does not make server commands reactive:
reading, reopening a panel and reconnecting an observer cannot commission work.

The browser protocol exceptions have specific owners and authorization:

| Browser use | Retained protocol and reason |
| --- | --- |
| Sign-in, SSO and sign-out | Better Auth owns session cookies and OIDC redirects. Factory security settings and fresh-authentication observations use named functions. |
| Planning cache | Zero owns authenticated query/mutation synchronization. It does not admit runtime lifecycle work. |
| Attachment transfer and display | Authenticated raw PUT with measured byte progress, protected original downloads and derived image URLs. Admission, metadata and usage use named functions. |
| Review stills and recordings | Multipart JPEG upload and authenticated range-capable media URLs for HTML image/video elements. Review decisions, feedback and metadata use named functions. |
| IDE and App navigation | One-use access grants redeem into separately scoped editor/runtime cookies. The embedded Theia client uses its grant-bound source/file-watch, Writer, runtime, Terminal and language-tool protocols. It cannot substitute its scoped cookie for a central Factory session or invoke unscoped UI commands. |
| External and execution traffic | Connector WebSockets, native OpenCode streams, callbacks, webhooks, Git and OAuth discovery are integration protocols, not alternate SPA command APIs. |

The SPA import-graph guard rejects unclassified raw network calls, including aliased helpers.
The remaining JSON helper accepts only the exact authentication and multipart-still paths.
The compiled-handler and real-host tests check authority, native stream cancellation and retired
logical routes. These checks do not replace owned runtime, editor and physical recovery proofs.

Hashed public assets use build-time Brotli/gzip variants and immutable caching. HTML stays
non-cached; private media, commands and Server Function responses do not enter that asset cache.
The rich document engine loads when its surface opens rather than with the Board. Attachment
conversion engines load only in bounded, terminated workers, not in the Factory store's import
graph. The concurrency limit remains two conversions per Factory process.

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
| Plan | Mastra in the Factory server | Questions, proposals and explicit Project Ticket creation; implementation requires human approval |
| Build | OpenCode 2 in the primary Dev Container | One approved Change, with separate implementation and read-only review Sessions |

Engine assignment is fixed. Models, role instructions and eligible Skills are configurable.
Personal Project Chat uses a turn-bound Factory MCP for existing source reads and explicit Ticket
creation. Creation shares the UI's planning command and saves an atomic conversation receipt;
it cannot approve requirements or start implementation. Other Project/Ticket contexts and external
MCP-library sources acquire no new writes. See [Factory MCP](adr/0020-factory-actions-through-mcp.md).
Settings → Skills library brings accessible personal, Project and Factory guidance into one
searchable gallery. Details separate personal activation from the permission-gated Manage view
for shared defaults and sharing reviews. New Skills and import previews are private by default;
saving does not enable them. Anyone can keep a personal library across the instance; activation
choices are per Project and work type. Required rules identify their Factory or Project source. Other choices
inherit individually and version updates are explicitly adopted for new work. See
[the engine decision](adr/0008-fixed-role-agent-engines.md) for package admission and privacy.
The editor leads with Name, When to use and Instructions; files and source details are optional.

Settings → Libraries → MCP connections applies the same discovery and selection structure to remote external
context. Exact definition sharing, authenticated connections and Project grants remain separate.
OAuth material lives in OpenBao. Admission retains approved tool contracts and credential epochs;
each lookup rechecks current access and execution ownership. Mastra uses native tools and OpenCode
uses a turn-bound Factory facade without provider tokens. Independent review cannot inherit
library tools. See [the MCP decision](adr/0015-managed-mcp-library.md) for read-only review and
network boundaries.

Inputs add named Project-bound JSON webhooks with saved tasks and shared MCP source selections.
The existing Project Agent automatically prepares grounded requirements, with no mode selection.
Prepared Tickets have no approval or Change. Background work excludes personal configuration and
retains source, Skill and model intent before inference. Explicit sources must be consulted;
empty selections inherit shared defaults at the saved policy revision. Human-approved Build retains
those sources, but independent review cannot acquire them. Duplicates coalesce and uncertain
inference is not replayed. See [the Inputs decision](adr/0018-project-inputs.md).

An explicit advanced delegation retains bounded monitoring Autofix. Eligible
requirements and Delivery Approvals identify the immutable delegation. The normal Verification,
independent review, exact-source and open-Thread gates still apply. Disabling, rotation, authority
loss and source changes fence further automatic work. See
[the Autofix decision](adr/0016-delegated-monitoring-autofix.md).

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

The [Factorybox admission command](../deploy/factorybox/README.md) inspects the same pinned worker
contract used by Workspace Start and the existing execution reserve. The consumer preparation and
lifecycle boundary is recorded in [ADR 0022](adr/0022-factorybox-workspace-execution.md).

Each immutable worker profile includes its explicit `arm64` or `amd64` architecture, exact image
and executable, node and kernel. The same Factory commands render and check either architecture;
the control-plane host does not select the worker's CPU. Node mismatch fails before the first
worker exec. This adapter contract is not native runtime qualification. The current standalone
Factorybox release remains AMD64-only; its ARM64 timer reader and continuation are not implemented.
RAM snapshots do not move between CPU architectures.

Every Sandbox uses the same topology:

```text
Kubernetes -> digest-pinned Factorybox worker Pod with its own bounded store
  -> same-worker Sysbox Sandbox with a private Docker daemon
    -> Factory Runtime Connector in parent mode
    -> exact Dev Containers CLI and approved container stack
      -> primary container with Connector child mode
      -> bounded Compose dependencies
```

Factory prepares the exact consumer image before native Start. Idle execution pauses; explicit
Start resumes the same Attempt and Connector credentials. The Source service and independent
editor retain the canonical checkout while execution is paused. Explicit Stop deletes execution
and its private store. Lost native command output is observed without replaying a mutation.

Docker, Compose and the Dev Containers CLI run unchanged. Project code has no node
Docker socket. The privileged outer Factorybox worker is trusted infrastructure; Sysbox shares the
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
  -> fresh Verification -> independent Candidate Review -> exact Delivery Approval
  -> fast-forward merge -> healthy Staging replacement
```

Verification runs the protected default-branch workflow against the exact Change commit in a fresh
Sandbox, with a repository-scoped one-job Forgejo runner. The Change and recorded default-branch
heads must still match the approved values; movement invalidates Delivery. A correction needs a
new commit and Verification. Staging retains its previous healthy Preview until replacement is ready.
After successful Verification, a fresh OpenCode Session reviews the exact candidate with the same
admitted Coding model and reasoning, without implementation history.
Fixed session permissions deny native execution,
editing, Skill execution and descendants. The existing Factory MCP facade supplies bounded,
immutable base/candidate file reads and diffs, App inspection and a review-report tool. No generic
agent registry, extra model-default role or second orchestration engine is introduced.
Factory retains the implementation Session separately for corrections. The current execution Session
continues to bind Stop, model relay, usage and browser authority. Both histories remain readable.
Only a settled review with accepted coverage and no blocking findings can pass. Frontend file changes
require actual App inspection and an exact-candidate screenshot; dirty or different-commit browser
observations cannot be accepted. The prompt also requires relevant UI behavior beyond that file
classification. A fresh reviewer is an evaluator, not a guarantee that every defect will be detected.
Factory persists compact findings, source-read evidence and screenshot digests/provenance.
New reviews begin concrete scenarios before observation, cover every criterion and include the
normal flow and a relevant adverse case before passing. Scenario outcomes bind the intervening source
or exact-candidate browser observations. UI cases need actual browser observations.
The existing independent review browser always records one protected WebM with scenario chapters.
There is no Project-level recording preference. The pinned MCP and
Chromium remain unchanged; a fixed adapter invokes the pinned FFmpeg with bounded worker threads.
Recording availability is separate from QA outcome and cannot replay inference or App mutations.
The video is published through bounded internal chunks, never included in model context.
Ordinary tool screenshots remain ephemeral. Explicit human annotation stills and QA recordings use
the existing installation state volume. Reads recheck Project access, use no-store responses and
support video byte ranges.
The Ticket is the shared human review surface: one QA player with scenario chips, open Threads,
comments and folded resolved Threads. General feedback needs no image anchor. Its Open Live Preview
action reuses the matching Factory tab; only ticket-bound Previews expose the comment affordance.
The isolated App bridge selects an element without screen capture permission. A pinned, lazy
DOM renderer may provide an explicitly labelled element reconstruction; absence or upload failure
does not prevent saving the anchor. App script policy and runtime access remain unchanged.
Preview provenance retains its Runtime Attempt basis, page and transient view identity, not a claim
that the current checkout is clean. Old anchors are not applied to another document or edited view.
Newer complete recordings replace older videos regardless of comments; stills and human feedback
remain. The last video expires thirty days after delivery or cancellation. Unattached stills expire
after one day. Publication/deletion intent and media identity stay durable across recovery.
Human comments do not block Delivery. Open Threads, including agent-reported implemented Threads,
block approval under the same Change lock. Only the author or an existing authorized developer
resolves them. One explicit Request revision admits the complete version-checked batch of
actionable open Threads in the retained implementation Session. Ordinary comments are discussion,
not work orders. Dispatched Threads are not automatically repeated; implemented Threads await
human rechecking, and Needs changes explicitly makes them actionable again. Failed or stopped
revision work permits an explicit retry. The admitted batch is available to the agent through
bounded list/read tools rather than injecting every discussion into the prompt.
No comment, reply, resolution, reconnect or recording failure starts work.
Blocking findings request a bounded targeted correction in the retained implementation Session.
Missing proof stays incomplete. An explicit retry creates another fresh review attempt for the same
candidate without changing the old result. Changed Requirements or new source invalidate review eligibility. Human
Delivery Approval records the exact settled review as well as the commit and Verification.
Eligible monitoring fixes can instead use an active Project delegation, recorded as the approval
basis and rechecked before merge. Operational file changes and human editing require human Delivery.
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
generation identity/state rather than every status tick. The signed-out entry and authenticated
Board load no document editor. The document engine loads when an editor opens; retained drafts
survive that first load. Versioned public assets use immutable caching and negotiated precompressed
Brotli/Gzip; the application shell is not cached. Factory loads inference engines and provider SDKs
on demand rather than when the host starts. Those adapters retain the same admission, cancellation
and usage rules. Attachment conversion engines run in bounded, short-lived workers rather than
loading into the host's ordinary imports.
Infrastructure commands have bounded combined output and deadlines; timeout leaves the external
outcome unconfirmed, never authorization to replace an immutable resource identity. Idle sweeps
advance through ID-ordered batches so busy early rows cannot indefinitely hide later Workspaces.

The Solid desktop uses shared semantic tokens, bundled Sansita/Inter and curated local artwork.
Wallpaper keys are durable shared Project settings. Project managers choose from six bundled
public-domain paintings. Creation assigns a random least-used artwork among the creator's
accessible Projects, serialized across concurrent creates and retained through recovery.
Existing Projects inherit their creator's previous personal choice, or the original default.
Zero synchronizes Project background changes for all members; only active Project managers
and Factory administrators may change them. Previous personal preferences remain retained for
the non-Project desktop. Open windows, panel visibility and geometry are
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
| Review Scenario | A named expected/observed normal, error or boundary case bound to actual review evidence |
| Review Thread | Human feedback requiring explicit human resolution before Delivery |
| Review Comment | Human feedback without a Delivery gate or automatic agent execution |
| Delivery Approval | Immutable human decision or active monitoring delegation accepting one verified, reviewed commit for merge and promotion |
| Review Case | A criterion-bound check with a fixed App or immutable-source observation kind and an expected versus observed outcome |
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
| Release | Human-confirmed named version of a delivered commit and its optional verified publication artifacts |
| Publication Attempt | Retained execution and native Forgejo outcome for one Release, independent of any consumer |
| External access | Project-bound machine read permission, not a registered deployment target |
| Project Agent | Checkout-free investigation, Requirements and Knowledge work |
| Factory MCP | Turn-bound Project research and explicit Ticket creation through existing Factory commands |
| Change Agent | Implementation in one approved Ticket Workspace |
| Change Agent Session | Resumable coding conversation shared with that Workspace |
| Project Conversation | Project-scoped history separate from Ticket conversations |
| Ticket Conversation | One visible history spanning research, planning and implementation |
| Conversation Context | Retained messages and admitted work of one conversation within personal Project or shared Ticket history |
| Active Coding Context | The Ticket's shared conversational execution target, independent of which history a person views |
| Conversation Mode | Investigate, Plan or Build authority for the next turn |
| Agent Turn | One durably admitted unit of work; explicit retry creates another identity |
| Agent Role | Product responsibility, distinct from human access and execution engine |
| Agent Profile | Versioned role instructions, Skills and model defaults, without extra authority |
| Skill / Skill Revision | Eligible reusable instructions and their immutable identified version |
| Effective Agent Configuration | Frozen role, model and eligible Skills for one admitted turn |
| Factory Policy | Binding constraint; lower scopes can tighten but cannot widen it |
| Model Connection | Managed provider access; credentials are not conversation content |
| MCP Definition / Revision | Reusable remote source configuration and its exact immutable version, without credentials |
| MCP Connection | Separately authorized external access with reviewed tool contracts |
| MCP Project Grant | Explicit permission for one Project to use a Factory-owned connection |
| Monitoring Delegation | A manager-developer's explicit Project-bound authority for eligible application-code Autofix and Delivery |
| Monitoring Incident | One deduplicated monitoring defect and its retained diagnosis, work and outcome |
| Input | Named Project webhook with a saved task, shared source policy and explicit delegation |
| Input event | One deduplicated external request with retained context and preparation outcome |
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
| Attachment | Immutable human-supplied file with retained original content and identified derived images/text |
| Attachment Reference | Authored association to a document revision, conversation, feedback discussion or exact admitted Agent Turn |
| Desktop Background | Curated artwork selected by stable Factory key |
| UI Preference | Durable presentation choice, excluding transient navigation and window state |

## Architecture decisions

Read the current boundaries above first. The records below retain decision rationale and stable
identities, grouped by concern rather than presented as twenty independent subsystems.

| Concern | Decisions |
| --- | --- |
| Workspaces, runtime and installation | [0001 Workspaces and prepared compute](adr/0001-development-workspaces-and-staging.md), [0009 independent file access](adr/0009-independent-workspace-file-access.md), [0013 Kubernetes installation](adr/0013-kubernetes-native-installation.md) |
| Identity and execution authority | [0007 durable admission and uncertain outcomes](adr/0007-durable-agent-admission-and-uncertain-outcomes.md), [0010 identity and exclusive writers](adr/0010-factory-identity-and-change-writers.md) |
| Agents, conversations and planning actions | [0002 OpenCode](adr/0002-opencode-change-agent.md), [0006 Project Agent](adr/0006-project-agent-and-ticket-conversation.md), [0008 fixed engines and Skills](adr/0008-fixed-role-agent-engines.md), [0019 retained conversations and editing](adr/0019-conversation-contexts-and-shared-editing.md), [0020 Factory MCP](adr/0020-factory-actions-through-mcp.md) |
| Verification, review and Delivery | [0003 Forgejo Verification and promotion](adr/0003-forgejo-actions-verification-and-promotion.md), [0011 protected delivered branches](adr/0011-delivered-branch-retention.md), [0012 independent review](adr/0012-independent-candidate-review.md), [0014 QA media and human feedback](adr/0014-qa-recordings-and-human-review.md) |
| Knowledge and retained content | [0004 revisioned Knowledge](adr/0004-generated-project-knowledge.md), [0017 private attachments](adr/0017-private-revision-bound-attachments.md) |
| External context and delegated Inputs | [0015 MCP library](adr/0015-managed-mcp-library.md), [0016 bounded monitoring Autofix](adr/0016-delegated-monitoring-autofix.md), [0018 Project Inputs](adr/0018-project-inputs.md) |
| Visual system | [0005 desktop and shared UI](adr/0005-curated-desktop-visual-system.md) |

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
