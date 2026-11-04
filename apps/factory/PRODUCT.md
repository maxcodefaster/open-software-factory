# Factory product brief

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Product Contributors define requirements, research Projects, inspect results and give feedback.
Developers also work with source, development Workspaces and Coding. Project managers control
Project access and shared defaults. Factory administrators manage instance-wide configuration.
Management permission and Developer status are separate.

Design for people who understand their product but need not understand agent engines, package
formats or runtime infrastructure. Make technical details available without requiring them for
ordinary product work.

## Product purpose

Factory turns approved product intent into reviewed source changes. A Project combines a source
repository, Tickets, revisioned Knowledge, shared development and a promoted Preview. People
approve requirements and the exact verified commit, or explicitly delegate eligible monitoring
fixes and Delivery. Factory records which decision authorized the work.

The [root README](../../README.md) describes supported workflows and operating commands.
The [architecture reference](../../docs/README.md) owns domain terminology and service boundaries.

## Operating context

Requirements are manual by default. An optional AI Interview requires an explicit request.
For developers, the single clarification action includes technical planning after Product
confirmation. Contributors keep their product-only Interview. Reading or saving starts neither.
If technical planning remains unfinished, that same action continues the technical task instead
of starting another Product Interview.
Implement approves the saved requirements and commissions Coding. Verification and independent
exact-commit review precede deliberate human Delivery approval. A Project manager with development
authority can delegate eligible monitoring Autofix through a Project-bound webhook and shared
read-only MCP connection. Background work does not inherit personal configuration. Insufficient
context creates no Ticket; disabling the delegation fences further automatic work. See
[the monitoring decision](../../docs/adr/0008-external-context-mcp-inputs-and-autofix.md#monitoring-delegates-a-bounded-fix-and-delivery-not-general-agent-authority).

Developers can commission full Planning or replan an existing technical design.
Product confirmation durably starts the technical continuation only for an explicit full Planning
request. The Ticket is one document with compact chapter navigation for Product, Technical design,
optional Architecture and Validation. Technical Designs, inspected source references and PlantUML
diagrams remain development-only. A single-chapter Ticket has no navigation rail and an absent
technical design has no empty placeholder. Responsibility and following share one People menu.
An unavailable optional diagram keeps the technical design and safe diagram source visible,
with an explicit status instead of a broken image. It does not repeat inference.
Implement approves the exact product and technical revisions;
edits to an unconfirmed proposal stay private until confirmation. Edits after approval save as a new
revision and leave the approved requirements pinned. "Document updated since implementation"
appears only when the saved wording differs from the approved document; writing the approved text
back clears it.
Reading and ordinary saving never start Planning. See
[Ticket technical planning](../../docs/adr/0004-agents-and-conversations.md#ticket-owned-technical-planning-follows-confirmed-product-intent).

Project Inputs automatically clarify external JSON requests and prepare requirements through the
Project Agent. The creator asks for a name, task and Connected sources. Selected shared MCP sources
must be consulted; an empty selection inherits shared Project defaults. Prepared Tickets require
human implementation approval unless bounded Autofix was explicitly delegated.
See [Project Inputs](../../docs/adr/0008-external-context-mcp-inputs-and-autofix.md#project-inputs-prepare-requirements-without-granting-execution-authority).

Settings show one selected scope at a time: Project, Libraries, Personal or admin-only Factory
administration. The scope chooser replaces a repeated list of all scopes. Libraries holds Skills
and MCP connections, Personal holds model overrides and login & security, and Project holds
Environments, Inputs, Releases, Monitoring and, with the authority, Models and People & access.
Login & security lets people with a Factory password change it after confirming their identity, ending their other browser sessions; company sign-in accounts have no such form.
Repository mirrors in Factory administration configure native Forgejo push
mirrors for a selected Project, with explicit target-overwrite consent, native attempt status,
manual synchronization and removal that preserves the external repository. They copy pushed
Git history, not Factory accounts, Tickets, secrets, uploads or unpushed Workspace work.
Configured mirrors lead with status; another target opens an explicit form. Token guidance
identifies Forgejo's unencrypted Git configuration rather than claiming OpenBao storage.
See [repository mirrors](../../docs/product/README.md#repository-mirrors).
Small screens use a grouped title menu instead of a sidebar; desktop windows
keep their sidebars, including alongside the assistant.

Project setup remains reachable under Environments → Setup & recovery after leaving onboarding. Project managers
can resume the retained configuration inspection and its answers there, and request a corrected
proposal before confirming any source changes. Preparation status and
explicit retries remain available without creating another Project or starting inference on read.
Developers without management authority can read preparation status without configuration or retry controls.

While the Wiki updates, its window names the recorded phase (queued, planning, writing or
publishing a numbered guide), counts pages published so far and shows the viewer's elapsed time.
This progress comes from saved generation state, starts no inference and leaves saved pages readable.
Wiki topic plans receive a whole-Wiki coverage check before progressive publication, including
proposed no-op updates. A short overview that defers useful source-supported guides is not their
replacement. Page options → Update Project Wiki explicitly requests another source-grounded update,
even after a previous update completed. Saved pages remain readable and human edits retain their
existing publication protections. Reading the Wiki starts no inference.
See [revisioned Project Knowledge](../../docs/adr/0007-knowledge-and-files.md#project-knowledge-is-generated-revisioned-and-separate-from-repository-documents).

Skills are an instance library with personal, Project and Factory ownership. Personal libraries span Projects,
but personal activation choices belong to a particular Project and work type.
Skills use portrait book covers in the gallery and detail view. The MCP library shares the ownership
controls and illustrated print style, but uses landscape connection covers. Source endpoints and connection states
identify services. Definitions, account authorization, Project grants and activation are separate
decisions.
New custom entries receive a saved cover automatically from thirty bundled illustrations.
Owners and authorized managers can change it through a compact image picker in the detail view.
Cover changes leave Skill versions, activation choices and MCP authorization unchanged. The
application does not generate images or require an image-model connection.

Monitoring opens with a schematic learning stream of recent retained decisions. Each record shows
its current state and opens its existing proposal, applied revision, comparison or source review
for inspection. Unchanged and uncertain outcomes remain distinct from adoption. The stream uses
the already authorized history, not additional inference. Hover and keyboard focus preview a
record without changing selection; touch selection exposes the same details. Brief interaction
feedback respects reduced motion and does not imply active Agent work.
Work outcomes, sampled quality, avoidable rework and model costs precede
usage limits. Its graphs show denominators, unknown evidence and daily UTC observations. Shared and
owner-private learning are separate contexts. Retrospective AI review is automatic, sampled and
batched; a fixed judge calibration precedes real work review. Improvement proposals expose their
evidence and validation before preparing an unapproved Ticket. Exact edits to observed Skill, Wiki
and Input revisions can be deliberately applied at their owning scope. The review shows the before
and after passage, scope, version and any required private release. Applied changes keeps the edit
and revision; Undo creates a new revision only if newer writing or activation choices do not block it.
Publication and measured effect are distinct. Reading Monitoring commissions no work, and private
source packets do not accompany an explicitly shared proposal.
An optional scoped permission allows future plain Planning Skill instruction edits after two
reproduced failures and a later healthy control pass an isolated, blinded text comparison. It does
not authorize Factory guidance, required rules, packages, Build, Wiki, Inputs or repository changes.
Compared changes exposes actual responses and verdicts. Later sampled uses identify the exact
adopted revision; counts are not a causal score. Repeated problems can commission one compared,
version-protected recovery, while newer human choices and writing remain authoritative.
See [work review and monitoring](../../docs/product/README.md#work-review-and-monitoring).

Desktop navigation puts the Project selector beside the Assistant toggle and a compact
New ticket action on the right, with matching control heights. Phones keep the single dock row,
Project switching in Settings and one New ticket action above the Board. The narrow Assistant leaves
that navigation available rather than making it part of a modal backdrop. Chat composers keep file
previews above the draft and attachment controls beside Send. Skills use a compact slash list with
names and single-line descriptions rather than a separate composer button or explanatory panel.
Document and library headers put the title before right-aligned text actions in the same row when
space permits. Narrow headers wrap actions after the title; status and document metadata sit below.
Search/filter controls and form-specific save actions remain with their content.
The current chat title opens conversation history, with New chat inside that menu rather than in
the header. Long histories can be filtered by name without changing active Coding. History
identifies private Project chats, shared Ticket chats and active Coding. Tool
activity uses compact command rows, with running calls and failures visible outside the collapsed
completed history. Confirmed Agent and Workspace Stop marks unfinished retained calls as interrupted,
never as running or successfully completed. Unconfirmed Stop and disconnection remain distinct.
Message Copy actions appear on hover or keyboard focus, and stay available on
touch devices without hover.

The Board has no separate Epic filter. Epic stacks open a focused folder with child Epics and
Tickets in a centered, responsive grid directly over the blurred Board, without an enclosing
panel. Each Ticket keeps its stage or status visible; editing is available inside the folder.
Empty root Epics remain reachable in Ideas. Lanes use subtle separators and compact, aligned titles
that stay visible while tickets scroll, without a continuous heading bar. Tickets, Epic stacks
and stage labels use the same Project-tinted glass and blur tokens as the dock and navigation
actions. Content interaction states reuse the navigation hover material. Materials and Board
spacing use shared tokens; reduced transparency keeps
the content surfaces opaque. Lane headings have no creation buttons or visible
counters; collapsed Epics and History retain their useful totals. New ticket opens the retained
personal draft with Requirements emphasized; creating an Idea remains a choice inside that draft.
Ticket quick-find searches the current Project by title or reference, including Tickets inside
Epics and completed work. Opening a document hands keyboard focus to its content; minimizing or
closing the workspace returns focus to its opener without trapping navigation in the window.

Projects, Tickets, Wiki pages, Settings and Inbox have shareable resource URLs. Document windows
offer an icon-only Copy link action with a tooltip and copy feedback. Links preserve their
destination through sign-in and reload, but never grant access or include private draft content.
Back and Forward restore resources while the desktop retains other tabs and local drafts.
Missing and inaccessible resources show the same unavailable
message with a read-only retry. Navigation does not start Agent work or runtime compute.

Personal Project Chat can create planning Tickets on an explicit human request through Factory MCP,
defaulting to Requirements. The same creation command serves the UI. A saved chat receipt links to
the created Ticket even if the final AI answer fails. Creation never starts implementation or grants
approval. Other chats and external MCP-library sources retain their existing authority.
See [Factory MCP](../../docs/adr/0008-external-context-mcp-inputs-and-autofix.md#project-chat-uses-factory-mcp-for-planning-actions).

IDE terminal tabs support keyboard switching and F2 renaming. Session names and the selected tab
survive iframe reloads. New terminal explicitly opens the first session; opening the IDE or its
Terminal panel does not create an unused shell that prevents idle Pause. Closing all terminals
leaves an empty session list until New terminal is chosen; it does not start another session on reload.

Opening a Workspace for editing automatically starts or resumes its compute, without commissioning
Coding. For developers on a wide pointer-driven window, the editor backend may warm while hidden,
but only after the page has loaded, gone idle and received a first interaction or four seconds more.
Narrow and touch windows start it when the IDE is opened. It selects a Workspace only when opened.
Opening in observation mode does not retain a deferred Start: a later editing grant or
Coding Stop cannot wake compute without renewed editing use or deliberately reopening the Workspace.
An observation-only IDE stays observation-only after Coding settles. Status refreshes do not take
human editing authority or block submitted Verification; taking over editing remains an explicit action.
Eligible Personal or unsubmitted Development compute pauses after fifteen minutes without genuine use (two minutes when no IDE, Terminal or App is attached).
Submitted, settled Ticket compute instead stops after the same idle period, retaining its Source,
native Sessions and submitted result while releasing private execution storage. This never repeats
implementation; a later commissioned operation prepares fresh compute.
Known failed Agent execution also stops after the idle period when the failed Session and its intent
identify that exact runtime. Its explicit retry already requires fresh, fenced compute; unsubmitted
Source and native history remain retained. Uncertain work and human writing do not qualify.
Fresh Verification releases its exact submitted Agent execution before starting a separate check
environment, rather than holding both private environments through the idle grace. It waits for
confirmed cleanup and preserves Source, native Sessions, writer authority and the submitted result.
Running work
and open terminal sessions remain protected. Close terminal sessions to permit automatic Pause.
An unattended Run view does not keep compute awake.
The IDE's Git tab shows personal-Workspace status and diffs, commits saved changes and offers
Fetch/Pull. Pull never resets or stashes work and stops on divergent history. Unsaved buffers block
Commit and Pull. Ticket commits and Delivery remain in Factory's reviewed workflow.

When a paused Sandbox cannot be restored and its native record positively proves the failed Resume,
the Preview, Run and Terminal panels say so and offer Start fresh. It discards the paused memory and
private container data, keeps the Workspace files, and starts a new Attempt. An unknown outcome
offers no action and keeps the paused Sandbox untouched.

A starting Preview names its recorded stage: waiting for execution capacity, starting compute,
waiting for the App on its port, then opening the document. After a delay it says the App has
not answered yet and keeps waiting. An unavailable Preview shows its recorded startup cause. A settled current Main Preview offers
one explicit Retry in that error view, preserving the previous attempt until the command confirms
the recorded successor. Reading, reconnecting, historical previews and unconfirmed cleanup cannot
commission another Start. Ticket compute remains controlled from its existing work context.
On first attachment, a temporary Factory transport refusal reconnects the same Preview document
while its view is active. Permanent failures and documents already used by a person require an
explicit reload; App writes and runtime Starts are never repeated by this recovery.
A slow document keeps its loading state and can finish without a reload. After a delayed-opening
hint, a person can choose to reload that view; elapsed time alone is not a failed connection.
Once the complete HTML document arrives, Preview exposes it while deferred App modules still load.
Document delivery does not establish App health, completed hydration or Verification evidence.

A merged Ticket whose replacement Main Preview failed offers one developer-only Retry Main
Preview action. It retains the failed attempt and original merge, starting a separately recorded
replacement only after owned cleanup is confirmed. An unconfirmed command keeps its identity;
reading or refreshing never repeats it.

Each Project has one shared background from six curated public-domain paintings. Creation picks
an artwork automatically, preferring less-used choices, and retains it on later visits. Project
managers can change it in the desktop Settings menu; other members see the same saved choice.

The personal Inbox spans authorized Projects, separating Needs you from discussion Activity.
Its dock badge counts open requests and unread activity once per item. Reading never resolves
a decision; source state does. Activity groups by discussion and supports personal read and archive
choices. New replies become unread again. Each entry opens its source before a person acts.
Tickets can name one optional human Responsible for coordinating the outcome, independently of
Agent execution, the current writer and approval rights. Eligible responsible people receive
requests; otherwise the required capability determines recipients. Following and structured
Project-member mentions control personal activity without granting access or starting work.
See [human responsibility and the Inbox](../../docs/adr/0005-authority-identity-and-uncertain-outcomes.md#human-ticket-responsibility-is-independent-of-execution-and-decisions).

Independently commissioned Tickets implement in parallel. An explicit queued implementation waits
for delivered prerequisites, then starts without another commission when its saved scope and
authority remain valid. Epics group work; Ticket dependencies determine ordering. Delivery reuses
the Ticket Workspace and serializes integration through Staging per Project. Settings → Inputs
also offers explicit, revocable delegation of eligible Ticket Delivery. Operational, migration,
dependency and access-policy decisions remain human. See
[parallel Tickets and serialized Delivery](../../docs/adr/0006-verification-review-and-delivery.md#parallel-ticket-implementation-reuses-the-existing-delivery-path).

## Capabilities and constraints

- Project Settings → Releases publishes a human-confirmed version of a delivered commit.
  The last published version and editable Patch/Minor/Major suggestions support the decision;
  they never publish automatically. History distinguishes published, failed and unconfirmed
  outcomes and links to native Forgejo. External access manages read credentials, not deployment
  targets or consumer status. Factory never waits for a consumer or claims production success.
  Project Chat can read confirmed versions and suggest a bump, but cannot publish or grant access.
  See [independent Releases](../../docs/adr/0009-installation-releases-and-hardening.md#release-publication-has-no-dependency-on-consumers).

- Human images and documents can accompany Wiki, Tickets, chats and feedback discussions.
  Document editors use `/image`, `/file`, paste and drop instead of standalone Add file buttons.
  Pending uploads and uncreated drafts stay private. Saving or sending determines sharing.
  Agent work uses exact file references; navigation and later replacements do not change them.
  See [attachment ownership and retention](../../docs/adr/0007-knowledge-and-files.md#keep-human-attachments-private-and-bound-to-immutable-work).

- Project conversations are personal; Ticket conversations and their active Coding context are
  shared. A fresh Coding conversation keeps the same Workspace and requires settled work or
  confirmed Stop. History selection and drafts never retarget execution. Editing names its holder;
  inactivity is a courtesy signal, not automatic release.
  See [conversation contexts and shared editing](../../docs/adr/0004-agents-and-conversations.md#retained-conversations-share-one-ticket-workspace-and-an-explicit-writer).
- Chats expose existing Skills, message Copy actions and grouped tool activity. File and recorded
  diff navigation is deliberate. A recorded diff is read-only and is not the current working diff.
- Independent QA browser runs record automatically, without a Settings switch. The Ticket owns
  the video, scenario chapters and frame comments. Capture failure remains separate from the QA
  result and never replays an App action.
- Investigate and Plan use Mastra; Build uses OpenCode 2. Engine assignment is fixed.
  Skills and model settings do not grant extra permissions.
- Skill authors can create private guidance and preview supported package imports. Authorized
  managers review sharing of exact versions and control shared defaults. An accepted shared copy
  does not expose the author's other private revisions.
- Enabled Skills are eligible when relevant, not guaranteed to load. Manual-only guidance needs
  explicit invocation. Required inherited guidance identifies its source and cannot be disabled.
- Version adoption is explicit or authorized by the scoped comparison permission above. Existing work retains its admitted configuration and exact Skill
  revisions. Editing a Skill or changing a default does not reconfigure running work.
- MCP connections use public remote HTTPS endpoints and reviewed read-only tools. Sharing copies
  a definition without credentials. Account reconnect and access revocation fence older work;
  token renewal does not change its authorized identity. Independent review cannot inherit
  library tools. [ADR 0008](../../docs/adr/0008-external-context-mcp-inputs-and-autofix.md#managed-remote-mcp-connections-share-selection-not-credentials) defines that boundary.
- Board/history navigation, inspection and reconnect do not commission AI or replay an external
  operation. Opening a Workspace for editing starts its compute as described above; failed work
  still needs explicit Retry. Actions state their target and consequences before commitment.
- The Ticket explains current work and the next action from saved state. It distinguishes an
  automatic correction from unavailable checks, incomplete review and a human Delivery decision.
  Progress explanations use no additional model calls and never turn uncertainty into success.
- Persist intent before external creates. Preserve retained source, history, approvals and runtime
  identities. Show uncertainty and recovery honestly rather than claiming success.

[ADR 0004](../../docs/adr/0004-agents-and-conversations.md#fixed-engines-for-project-and-change-work) owns engine and Skill admission decisions.
[Repository instructions](../../AGENTS.md) own implementation and verification rules.

## Brand commitments

The product is Factory. Use its established interface typography, colors, materials, icons and
workspace conventions. Write direct, task-specific copy. Do not invent capability claims,
marketplace activity, popularity, ratings or endorsements.

## Interface consistency

Ordinary buttons and form controls share geometry, interface typography and the active Project
palette across Tickets, Settings and other workspaces. A new feature extends that vocabulary
instead of introducing another visual variant. Native selects, checkboxes and text fields retain
their keyboard and platform behavior.

Document actions remain quiet text controls with one emphasized next step per decision.
Standalone primary and destructive actions keep their existing meanings. Related actions stay
together; form actions stay with their fields. Labels, help, validation and pending outcomes
remain distinguishable without relying on color alone.

Controls have consistent hover, keyboard focus, disabled, pending and invalid states.
Touch targets remain usable on phones, while desktop controls stay compact. The dock's instance
choosers keep their small look and answer the same rule below.
Tab starts at a Skip to board control that moves past the header and dock to the first Ticket. A feature looks
the same when opened alone or after another workspace. Shared changes are checked in the
control fixture and the affected product flows; implementation and verification rules belong
in [AGENTS.md](../../AGENTS.md).

## Product principles

- Explain what a person can do before exposing implementation details.
- Separate browsing and inspection from activation, sharing and administration.
- Make personal choices, shared defaults and required guidance distinguishable.
- Keep explicit human decisions explicit, including version adoption and Delivery.
- Preserve a person's place and drafts through ordinary navigation and recoverable failures.

## Accessibility and inclusion

Touch targets are at least 44 px where the layout allows and never below 24 px; the dock keeps one row.
Core flows must work with keyboard navigation and visible focus. Name controls and regions,
communicate status without color alone, respect reduced motion and keep long content usable.
Adapt layouts to narrow screens without horizontal page overflow or hiding essential actions.

## Evidence on hand

Current application code and the focused browser journeys under `test/browser` are implementation
evidence. Generated screenshots and test results belong under `.factory/test-results/`.
Existing captures can guide design inspection, but are not proof that the current checkout passes.
