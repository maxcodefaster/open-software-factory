---
status: accepted
---

# Agents, conversations and planning


This record holds the decisions formerly numbered 0002, 0006, 0008, 0019, 0024. Each section keeps its original wording.


## OpenCode runs inside the Ticket Workspace without forge authority

Each active Change has one resumable OpenCode 2 Change Agent Session. OpenCode runs as the development user in the Ticket Workspace's primary Dev Container and edits the same checkout shown by the IDE. Factory connects to the OpenCode HTTP server through the generation-bound Runtime Connector using `@opencode/client`; the browser talks only to Factory and never receives a direct OpenCode endpoint or provider credential.

The Developer IDE has an independent lifecycle. It accesses the canonical Ticket checkout rather
than running another Change Agent or keeping a synchronized source copy. Editor, PTY and Agent
readiness are separate; opening source does not itself admit Build. See
[ADR 0001](0001-workspaces-source-and-app-access.md#independent-editing-durable-workspaces-and-prepared-compute).

The Ticket Workspace volume retains OpenCode session state across Sandbox restarts. Factory persists the OpenCode session identity, execution intent and terminal outcome, but not message streams, logs, heartbeats, or model credentials. The agent uses the configured model, one active turn per Change, and bounded file and shell tools inside the Sandbox. Questions and permission requests appear in the Factory chat, but answering them does not create a Requirement Approval or Delivery Approval. Manual edits should happen while the agent is stopped so two writers do not race in the shared checkout.

Factory keeps raw model-provider credentials outside the Sandbox. OpenCode receives a generation-bound inference capability for a Factory model relay, so shell commands and Project code cannot read or reuse the upstream credential.

OpenCode may inspect Git, edit files, and run the Project toolchain, but the checkout contains no reusable forge credential. When native execution ends normally and all owned work settles, Factory pauses agent writes, asks the Runtime Connector to create one commit, records the intended commit and push, and performs one controlled push to the Change branch for Verification. No separate submission action is required. Factory recovers an unclear push result by comparing the branch head with that commit. The Change Agent cannot approve requirements, approve delivery, merge, or mutate Factory product state.

### Consequences

New admissions express the approved specification and current correction as the Build goal.
OpenCode's native planning and tool loop owns implementation, local checks and browser inspection.
The final answer is ordinary prose, without a mandatory JSON completion form. A self-reported
checklist was neither independent evidence nor a reliable way to detect the end of native work.

A normal OpenCode `stop` finish proves only that the native turn ended. After all owned
descendants and shells settle, changed source can be submitted for independent Verification.
This does not prove local checks passed, the acceptance criteria are satisfied or the feature
is complete. Even an attempt reporting unfinished work may produce a reviewable submission;
it cannot approve itself. Native errors, interrupted or uncertain execution and unchanged
corrections retain their existing failure and recovery behavior.

Forgejo Verification still tests the exact submitted commit, and a person still reviews and
approves Delivery. The interface labels a pushed result as submitted for verification, not
complete. UI instructions still require the changed workflow with exactly owned synthetic
fixtures, console checks and an inspected screenshot, rather than just a landing or sign-in page.
Factory adds no outer inference loop and does not restart the model until a goal appears met.
Already frozen report-contract admissions retain their original parsing and submission rules;
an old failed turn is never retroactively promoted under the new policy.

Cold browser-image preparation is a known pre-execution outcome. One `browser_open` waits
through the Connector's existing image-preparation window, probing only after its exact
confirmed non-execution response. Every probe rechecks current Build ownership, Stop,
permissions and runtime identity before receiving a fresh short execution lease. Other
failures never authorize a replay. Caller disconnect ends further preparation probes.
The browser transport's open-call deadline includes image preparation, container setup and cold
Chrome launch; mutation deadlines are unchanged. Retained CLI instructions allow that client to wait.
New admissions register Factory's fixed MCP facade through the pinned native OpenCode API.
Registration is an in-memory, location-scoped override, not a Project configuration write.
Its endpoint freezes the Runtime Attempt and Turn; the existing gateway still checks current
owner, generation, lease and declared App for every call. Images reach the model in native tool
results. The shell/JSON/file-read client remains only for older immutable admission instructions,
not as a second path advertised to new work. Native registration never exposes an agent-facing
generic MCP registry or weakens browser isolation.
The pinned server propagates MCP changes into an already used tool registry through a
100-ms debounce. Factory allows that metadata propagation and performs a fresh connected-state
read before submitting the paid prompt. A connected MCP receipt alone is not that barrier.
The owned native proof first uses the Session without MCP, then registers the facade and submits
its next turn immediately. No paid probe, failed first turn or automatic inference retry is used.
This avoids spending additional model turns guessing whether the browser is ready.
An actual preparation failure still confirms no App inspection and does not justify
repeating an uncertain UI mutation. Owned cleanup behavior otherwise remains unchanged.
The current Build also renews intended browser sessions during cold startup. Connector
renewal does not wait on the lock held by container creation or a browser call, and startup
cannot overwrite a newer lease with its original deadline. Renewal before creation starts
no resources. Expiry, Stop and disconnect still end access and require exact owned cleanup.
The existing Build ownership heartbeat renews browser authority independently of native
history and usage reads. A slow observation must not expire a browser owned by a live Build.
Renewal acknowledgements have a five-second deadline, shorter than the browser lease.
An unknown transport outcome releases the renewal guard so the existing heartbeat can
revalidate ownership and try again. Confirmed Connector failures still close the session.
This never revives an expired browser, extends its lease bounds or retries an App action.
Safe permanent failure reasons survive cleanup; cleanup confirmation is recorded separately.
After a confirmed Connector expiry or control-connection failure and exact browser cleanup,
a still-authorized native Build can explicitly open a fresh inspection without another model turn.
Factory latches that specific recovery permission at closure, separate from diagnostic prose.
Normal completion, Stop, invalid provenance and unknown failures grant no such permission.
Factory persists the next browser ordinal and deterministic
identity before external creation. The old session remains closed and immutable. A partial unique
constraint permits only one unclosed browser per Turn and owner; the database also requires the
previous exact scope's confirmed cleanup before a successor. No successor is admitted after Stop,
lease expiry, changed permission or runtime identity. Legacy session-specific capabilities do not
gain access to successors. Native access stays bound to the same Turn and runtime generation.
This is a new read-only navigation, not a replay or restoration of the old page, cookies or actions.
A fresh snapshot must precede further UI actions, and request deduplication and the 128-call bound
span all browser sessions in that Turn.
Opening an App allows cold Chrome launch before the unchanged upstream navigation timeout.
Other browser actions retain their existing deadlines. Client and HTTP transport bounds
include image preparation, container setup and cold launch without extending execution authority.
The fixed facade exposes bounded viewport resizing and a navigation/activation key allowlist.
This lets the Agent inspect 390px layouts and keyboard behavior rather than infer them from CSS.
Both controls require the current declared App and the same Build authority as clicks and fills.
They grant no script evaluation, arbitrary key chords, URLs, files or upstream MCP registration.
After a known failed turn, a retained Session accepts explicitly submitted new Build
instructions in the IDE even when compute is stopped or disconnected. Factory confirms
the previous writer's teardown and prepares compute before execution. It does not silently
route those instructions to checkout-free research, require another initial specification
prompt, or repeat the failed input. Uncertain execution, pending Stop and commit recovery
still require resolution before new Build work.

A confirmed tool-error response in an already observed App may leave partial UI effects.
Factory retains that browser but blocks further UI actions until a fresh DOM snapshot
succeeds. It does not replay the failed interaction. Lost responses, invalid provenance
and changed authority still require the existing owned cleanup rather than this recovery.
This also covers a confirmed first-navigation error. No successful App observation is
claimed by that error. The next snapshot first reads the pinned browser's selected-page
metadata and requires exactly one selected page at the intended declared App origin.
Only then may it inspect that page and record checkout provenance. Navigation is not
repeated, and an absent, foreign or ambiguous page fails closed.
An initial selected `about:blank` page can be polled through that fixed metadata read
within the snapshot's existing deadline while the original navigation commits. Read-only
App requests allow twenty seconds for cold response headers, with twenty-one seconds in
the Unix bridge. Other methods retain their five-second App and six-second bridge header
deadlines. The current lease still cancels access; no App request or write is replayed.

IDE edits and agent edits are part of the same Change. A Sandbox can disappear without losing the
checkout or conversation, while every OpenCode process and inference capability remains
generation-bound. Commit and push are auditable Factory operations rather than ambient powers
available to arbitrary shell commands. A pushed commit enters exact-commit Verification.

Native SSE is an ephemeral observation channel, not an admission or completion signal. Factory
shares one subscription per observed Runtime Attempt and reconnects read-only after transport loss.
The Side Panel receives authorized, bounded pending replacement snapshots, not a retained token
queue. Reconnect reads native history again; stable tool identities prevent duplicate activity.
Native events wake lifecycle and durable-usage observation, with a low-frequency reconciliation
check for missed events. An idle native event alone cannot authorize commit or release a writer.
Ownership renewal, ordered Stop, settled descendants/shells and final durable usage reconciliation
remain independent of the browser connection.

## Project Agent uses Mastra inside the Factory server

Factory runs one checkout-free Project Agent inside the existing Factory server. It uses
`@mastra/core` at the exact manifest version for the Agent and typed tools. One authenticated search tool searches current
Tickets, specifications, Epics and Wiki with weighted PostgreSQL full-text search and pg_trgm.
Exact references and titles rank first. Versioned bounded reads follow source relationships and
page through full text. Relationships distinguish prerequisites, dependents, Epic membership and
Wiki parent/child edges. Search snippets discover sources; full reads authorize citations.
Request-local memoization prevents repeated reads. Research ends when the model has sufficient
evidence and returns its structured result, not at a fixed step or distinct-lookup count.
The admitted caller owns cancellation and task deadlines; the adapter adds no fixed one-minute
deadline across an otherwise progressing research turn. Per-step context/media bounds and
authority checks still apply. A tool result is not a completed answer.
When earlier immutable code-read bodies fill the model request, Factory transiently replaces
only the oldest necessary bodies with explicit omission markers, exact provenance and reread
arguments. The latest tool batch, authored decisions and native call/result pairs remain intact.
Complete results stay in the turn-local cache; inspecting them again rechecks authority without
repeating the repository read. This projection does not alter retained messages, create a verdict,
compact mutation receipts or widen the existing input/media bounds. An oversized core or current
batch still fails before another provider request.
No embedding pipeline, BM25 or second code database.
Investigate returns cited answers; Plan may also return independent question rounds, a Requirement
proposal or an editable Epic/member proposal. Known Project/Ticket context is frozen at admission;
later navigation cannot retarget submitted work. Ambiguous intended targets require clarification.
Factory displays one question at a time and advances within a round without another inference.
Question controls do not turn general planning into a single-Ticket Requirements Interview.
Answers retain the scope of the request which produced their question, including after paused
research. Only an explicitly started Requirements Interview imposes the single-Ticket output contract.
Choice questions expose one custom-answer control; a generic model-provided Other or Something
else placeholder uses that control instead of appearing as a second, non-editable fallback.
The last answer, a custom choice outside a prefetched option set, or an explicit correction requests
fresh clarification against current intent. Ordinary independent answers advance without inference.

The model receives one structured data envelope, separate from task instructions. It contains the
current input once, the frozen Ticket/Project, ordered authored decisions with question/option
meanings, and current advisory Requirement/Epic proposals. Earlier decisions are not cut off at a
fixed number of entries. A 96 KiB core bound rejects oversized conversations before inference;
only background assistant prose may be omitted. Research, Interview and larger planning tasks use
their own instructions and output contracts. Ephemeral Assistant progress reports actual guidance
loading and research work without publishing unvalidated questions or proposals.

Ordinary answers use Mastra's native object stream on the existing authenticated message command,
with SSE content negotiation. Only cumulative answer text appears provisionally in the Assistant;
tools, reasoning, questions, Requirement proposals and Epic proposals remain hidden until validated.
Each text emission rechecks admitted authority, including development permission after code reads.
Only the final validated answer and citations enter the Conversation. Provider usage remains
recorded independently, including failed work. A failed
response discards provisional text. HTTP disconnect detaches observation without stopping or
replaying admitted work; bounded slow-reader queues skip intermediate snapshots. The browser binds
provisional answers to their original Project/Ticket and turn, renders sanitized Markdown and
replaces them with the persisted result. Minimize hides the panel without interrupting streaming.

Mastra does not own persistence or authority. Factory stores the Ticket Conversation, mode,
interview questions and human answers, Requirement proposal identity, and handoff markers in its
PostgreSQL product model. It validates every structured Agent result before applying a planning
proposal. Agent output never overwrites authored Ticket text. Explicit Confirm answers atomically
saves one immutable document and its exact Requirement Revision against the admitted document.
Manual edits autosave with version checks and never require another interview. Mastra Memory,
RAG, vector storage, Studio, Agent Networks, and Sandboxes are not
used. This keeps Project Knowledge, Tickets, Requirements, and approvals as the only sources of
truth.

Developers and managers can discover allowed code paths and read numbered lines at an exact
Forgejo commit through the existing origin, inventory and blob-cache checks. Source data is not
instructions. Paths must be discovered before reading; code citations must name inspected files.
Contributors receive no code tools or code-derived conversation content. Every read, including
memoized reuse, rechecks authority. Investigate and Plan receive no checkout, shell or Runtime
capability. Personal Project Plan can create planning Tickets through the bounded
[Factory MCP](0008-external-context-mcp-inputs-and-autofix.md#project-chat-uses-factory-mcp-for-planning-actions); other mutation authority is unchanged.
Build requires the latest exact Requirement Revision to have a human approval. Factory then
creates or resumes the existing Change path and sends later turns to OpenCode in the Ticket
Workspace. The interface shows one chronological Ticket Conversation and marks the authority
change without exposing an agent picker.

Retained conversation contexts, safe fresh Coding Sessions and research alongside implementation
are defined in [ADR 0004](#retained-conversations-share-one-ticket-workspace-and-an-explicit-writer). The canonical Ticket
history and its shared Workspace remain intact when a person starts or views another conversation.

Mode is an internal authority boundary, not a user-selectable switch. Creating or moving a Ticket
into Requirements is planning, not model admission. An explicitly started Interview records one
recoverable Agent Turn before inference. A complete human-authored specification can be approved
and commissioned directly without an Interview. Personal Drafts remain local until creation.
Planning Luna uses the OpenAI Responses API with low reasoning and provider storage disabled,
through the pinned SDK and existing governed selection. Other models retain their chat path.
Investigate and Plan need no Sandbox. Preview uses the Project's Staging runtime; IDE or
implementation starts compute for the durable Development Workspace when needed.

Ticket owns lifecycle actions. Minimize only hides the Assistant; pausing retains clarification
and enables ordinary research chat. Interview controls replace the normal composer. A finished
proposal appears directly editable in its Ticket and hides only the initiating active panel.
Confirm answers preserves visible human edits in one immutable revision; later edits autosave.
No managed context attachment chip or duplicate long proposal in chat.

Epic confirmation is one immutable, atomic, idempotent human decision. It validates current source
and reused Ticket versions, Project scope and dependency cycles. New members enter Requirements
without automatic Interviews or Builds. Unimplemented intent converts to an Epic without a duplicate
aggregate Ticket; previously admitted implementation remains an unchanged member. Existing links
must be resolved before converting unimplemented intent. Original clarification/history remains.

## Fixed engines for Project and Change work

Factory owns the product lifecycle and one Ticket Conversation. Mastra executes checkout-free
Investigate and Plan turns; OpenCode 2 executes Build turns in the approved Ticket Workspace.
Keeping engine assignment fixed makes authority and recovery specific to each execution boundary,
while models, role instructions, and Skills can be configured without a second orchestration layer.

Use the pinned engines' native provider/model adapters, catalogue metadata, bounded tool loops,
structured outputs, streaming, usage and error types rather than copying their mechanisms into
Factory. Factory owns secure credentials, endpoint policy, admitted configuration, permissions,
external-operation recovery and immutable human decisions. Capability metadata does not prove
account access or quota; bounded model probes and provider-reported headers do. No automatic
fallback changes an admitted model or paid request. OpenCode receives only a Build-bound Factory
capability; native provider traffic passes through the authorized relay without protocol conversion.

New OpenAI Build admissions freeze a reasoning effort of at least medium and use the pinned
native Responses adapter. The administrator sets the default beside the Coding model; a person
may select another allowed effort in chat before the first Build. Model and reasoning defaults
are adopted together only after the exact access probe succeeds. Probe intent retains the
requested effort, and changed command replays cannot silently adopt another value.
The chat shows the fixed admitted value after work starts rather than offering an ineffective
runtime override. The relay rejects a different effort or
transport rather than rewriting the request. Admin changes apply to new Changes and probes,
not running work or retained historical configurations. Other providers retain their concrete
native adapters and options. A successful access probe proves a real native tool call, not
just that an account can list a deployment.

Run the exact published OpenCode server with native durable event persistence enabled. The CLI
does not expose this setting and its sequence-only log cannot recover usage after interruption.
Retain the upstream server, native assets and lockfile unchanged rather than forking OpenCode or
copying transcripts into analytics; Factory consumes the log through the pinned v2 client.

Skills belong to an instance library with personal, Project and Factory ownership. Product
Contributors can author private guidance; Project managers and administrators can publish exact
shared copies. Sharing proposals and work admissions expose only the specific immutable revision,
never the author's other private versions. Personal choices remain per Project. Each library
identity has its own Inherit, Enable or Disable choice; required inherited revisions are locked.
Untouched identities receive later defaults, while revision updates require explicit adoption.
An owner or Project manager may separately delegate future plain Planning Skill instruction
updates at the owning scope. A fixed, calibrated text comparison must reproduce two retained
failures, correct both and preserve a later healthy control before version adoption. This does
not cover Factory guidance, required rules, packages or Build. Admitted work remains pinned.
Every paid comparison step, delegated adoption and version-protected recovery retains its exact
intent and outcome; a model's recommendation alone grants no publication authority.

Use native discovery and on-demand loading in both engines. Project admission retains required
versus optional revision choices. Applicable required rules, explicitly invoked Skills and the
assigned Interview Skill load through native Mastra APIs before inference. Manual-only Skills
still require human invocation. References preload up to a shared 8 KiB; larger references stay
on demand. Observations distinguish actual loads from eligibility. Checkout-free work receives readable
references through Mastra's inline skills and cannot execute package scripts. Execution-dependent
packages are Build-only. Build intent retains the exact manifest and slash-invocation attachments
before installation. The privileged Runtime Connector parent installs verified packages outside
the source checkout, seals them for the development user and refuses a different set for that
runtime. OpenCode's ambient global and Project discovery are disabled; its session permissions
permit only admitted skill identities. Upstream built-in skills remain installed and are denied
by these session rules. Native observations record actual loads rather than every eligible skill.

Historical Build intent keeps its recorded eager prompt and exact versions. New Changes use native
packages. A script may run only with the existing Sandbox tools and permissions; installation and
skill selection add no authority. The Sandbox remains the security boundary, including any root
access deliberately allowed by its approved development configuration.

## Retained conversations share one Ticket Workspace and an explicit writer

Factory keeps personal Project conversations and shared Ticket conversations. A Conversation
Context separates the messages and admitted work of one conversation from its containing Project
or Ticket history. Browsing another context never changes execution authority. The Ticket has one
shared active Coding context, while checkout-free research can continue in separate contexts.
There is no semantic routing model, supervisor or engine selector. Known application context
determines the work; Coding can search and read authorized Project sources through the same
functions as the Project Agent. Independent candidate review does not inherit these source tools.

A fresh Coding conversation retains the previous native Session, recent message snapshot and
immutable admitted configuration. It creates a new deterministic Session intent, not another
Workspace, branch, worktree or Sandbox. Native creation waits for an explicit Coding command.
Restart requires settled implementation or positively confirmed Stop, with no unresolved turn,
commit operation or editing handoff. A failed or disconnected observation is not Stop confirmation.
The next command still follows the existing writer and runtime fences. Existing source, approvals,
Verification and Delivery gates remain unchanged. If native history is unavailable, saved prompts
and snapshots stay visible; observing history neither starts compute nor resends work.

Commands identify their conversation context at admission. A stale Coding draft cannot be sent to
the replacement context. Browser drafts and history selection are scoped by person, Project,
Ticket and context. Returning to an older Coding conversation makes its composer read-only.
Separate Project research admissions do not compete with the Ticket's exclusive Coding boundary,
but every read still checks the original person's current Project authority.
The first Build establishes the canonical Ticket conversation before freezing its command.
An earlier unversioned turn is never attached to a newly created journal while unresolved.
Ticket, membership and conversation locks follow the same order for research and Coding.

The canonical Ticket Workspace has one durable writer. Factory names the human holder or the
person who commissioned the Agent; a handoff requester is a separate identity. Editor input,
authorized source mutations and Terminal input provide ephemeral editing activity. Heartbeats
only indicate connection. Five minutes without observed editing is an idle indication, never a
lease expiry or automatic release. Restarting Factory discards these signals.

Another developer can request editing. The holder can explicitly approve the transfer or release
editing. An authorized developer can deliberately take over an idle human holder. Each decision
binds the exact writer epoch and persists before source and branch fences or process teardown.
Old saves and Terminal sends lose authority before the new writer is granted access. Unsaved
buffers stay with their original developer and Workspace; they are neither discarded nor
transferred. Agent and uncertain work never become available through inactivity.

Chat presents existing Skills rather than another slash-command catalogue. Human and Assistant
messages have Copy actions; toolcalls do not. Contiguous toolcalls share a disclosure, while active
calls and errors stay visible. Shortened output is labeled. Structured file targets open canonical
source only after a deliberate action. Recorded tool diffs open read-only in the IDE and identify
themselves as snapshots, not comparisons against current files. The editor accepts these messages
only from its authenticated Factory parent and only for its acknowledged Workspace.

This extends the [Project Agent conversation decision](#project-agent-uses-mastra-inside-the-factory-server)
and [exclusive writer decision](0005-authority-identity-and-uncertain-outcomes.md#factory-identity-and-exclusive-change-editing). It deliberately avoids
personal Ticket Sandbox collections and the merge coordination they would require.

## Ticket-owned technical planning follows confirmed product intent

Factory keeps Product Requirements and Technical Design as separate, immutable revisions owned
by the Ticket, not speculative files or pull requests in the product repository. The existing
Mastra Project Agent performs both tasks with separate instructions and output contracts.
Technical Planning reads authorized source at one pinned commit and maps every product criterion
to a concrete verification step. OpenCode remains the Build engine.

An explicit full Planning request commissions the Product Interview and its technical continuation.
Confirming the Product proposal atomically saves the product revision and admits one technical
turn. Its command identity is the confirmation identity. Recovery dispatches only retained,
undispatched intent; disconnect and repeated confirmation cannot repeat paid inference.
Manual saves and ordinary Interviews do not acquire this continuation. A developer can explicitly
plan or replan a saved specification without repeating the Product Interview.

Code-derived Technical Designs, their sources and diagrams require development authority on both
reads and writes. Product Contributors retain their existing product workflow. When a technical
revision exists, Implement requires a developer to approve its exact identity together with the
current Requirement Revision. Source movement or changed product scope refuses that admission.
Unanswered technical questions, failed requests and missing source evidence keep implementation
blocked until a revision fulfills the latest explicit Technical Planning request.
An existing approval and running Change retain their original scope. Build and independent review
receive the approved technical content, never the latest unapproved revision.

Architecture diagrams are optional, self-contained PlantUML text with a plain-language explanation.
A pinned upstream JavaScript engine renders them in bounded, terminated Factory workers without
third-party rendering requests, filesystem includes or resource loaders. Factory rejects active or
external SVG content and displays the result as an image, never raw inline SVG. Source and renderer
identity remain retained with each revision. Diagrams explain a proposed design; they are not a
claim that static analysis extracted a complete architecture graph.

An optional diagram's syntax, worker availability or rendering deadline must not discard an
otherwise valid Technical Design. Retain its exact safe source and an explicit unavailable render
in the same guarded revision transaction. Show that outcome with the source, without a broken
image or an Open diagram link. This is not a successful diagram render and never retries inference.
Unsafe source, active/external SVG, missing source evidence and changed authority still reject
publication. Human design saves keep their existing validation; correcting or removing a diagram
creates another immutable revision. Reading the unavailable result starts neither rendering nor work.

The Ticket remains one reading surface with chapter navigation, not separate Product/Tech tabs.
The existing visual system and document editing conventions remain authoritative.
