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
Implement approves the saved requirements and commissions Coding. Verification and independent
exact-commit review precede deliberate human Delivery approval. A Project manager with development
authority can delegate eligible monitoring Autofix through a Project-bound webhook and shared
read-only MCP connection. Background work does not inherit personal configuration. Insufficient
context creates no Ticket; disabling the delegation fences further automatic work. See
[the monitoring decision](../../docs/adr/0016-delegated-monitoring-autofix.md).

Project Inputs automatically clarify external JSON requests and prepare requirements through the
Project Agent. The creator asks for a name, task and Connected sources. Selected shared MCP sources
must be consulted; an empty selection inherits shared Project defaults. Prepared Tickets require
human implementation approval unless bounded Autofix was explicitly delegated.
See [Project Inputs](../../docs/adr/0018-project-inputs.md).

Settings group Project configuration first, then Libraries, Personal and admin-only Factory
administration. Small screens use a grouped title menu instead of a sidebar; desktop windows
keep their sidebars, including alongside the assistant. Skills are an
instance library with personal, Project and Factory ownership. Personal libraries span Projects,
but personal activation choices belong to a particular Project and work type.
Skills use portrait book covers in the gallery and detail view. The MCP library shares the ownership
controls and illustrated print style, but uses landscape connection covers. Source endpoints and connection states
identify services. Definitions, account authorization, Project grants and activation are separate
decisions.

Project switching is a secondary action in the desktop Settings menu. Chat composers keep file
previews above the draft and attachment controls beside Send. Skills use slash suggestions rather
than a separate composer button.
The current chat title opens conversation history, with New chat inside that menu rather than in
the header. History identifies private Project chats, shared Ticket chats and active Coding. Tool
activity uses compact command rows, with running calls and failures visible outside the collapsed
completed history.

The Board has no separate Epic filter. Epic stacks open a focused folder with child Epics and
Tickets across their stages; editing is available inside the folder. Empty root Epics remain
reachable in Ideas. Plus actions in Ideas and Requirements open the retained personal draft with
that destination emphasized, without an additional navigation row.

Personal Project Chat can create planning Tickets on an explicit human request through Factory MCP,
defaulting to Requirements. The same creation command serves the UI. A saved chat receipt links to
the created Ticket even if the final AI answer fails. Creation never starts implementation or grants
approval. Other chats and external MCP-library sources retain their existing authority.
See [Factory MCP](../../docs/adr/0020-factory-actions-through-mcp.md).

IDE terminal tabs support keyboard switching and F2 renaming. Session names and the selected tab
survive iframe reloads. Closing all terminals leaves an empty session list until New terminal is
chosen; it does not start another session on reload.

Each Project has one shared background from six curated public-domain paintings. Creation picks
an artwork automatically, preferring less-used choices, and retains it on later visits. Project
managers can change it in the desktop Settings menu; other members see the same saved choice.

## Capabilities and constraints

- Human images and documents can accompany Wiki, Tickets, chats and feedback discussions.
  Pending uploads and uncreated drafts stay private. Saving or sending determines sharing.
  Agent work uses exact file references; navigation and later replacements do not change them.
  See [attachment ownership and retention](../../docs/adr/0017-private-revision-bound-attachments.md).

- Project conversations are personal; Ticket conversations and their active Coding context are
  shared. A fresh Coding conversation keeps the same Workspace and requires settled work or
  confirmed Stop. History selection and drafts never retarget execution. Editing names its holder;
  inactivity is a courtesy signal, not automatic release.
  See [conversation contexts and shared editing](../../docs/adr/0019-conversation-contexts-and-shared-editing.md).
- Chats expose existing Skills, message Copy actions and grouped tool activity. File and recorded
  diff navigation is deliberate. A recorded diff is read-only and is not the current working diff.
- Investigate and Plan use Mastra; Build uses OpenCode 2. Engine assignment is fixed.
  Skills and model settings do not grant extra permissions.
- Skill authors can create private guidance and preview supported package imports. Authorized
  managers review sharing of exact versions and control shared defaults. An accepted shared copy
  does not expose the author's other private revisions.
- Enabled Skills are eligible when relevant, not guaranteed to load. Manual-only guidance needs
  explicit invocation. Required inherited guidance identifies its source and cannot be disabled.
- Version adoption is explicit. Existing work retains its admitted configuration and exact Skill
  revisions. Editing a Skill or changing a default does not reconfigure running work.
- MCP connections use public remote HTTPS endpoints and reviewed read-only tools. Sharing copies
  a definition without credentials. Account reconnect and access revocation fence older work;
  token renewal does not change its authorized identity. Independent review cannot inherit
  library tools. [ADR 0015](../../docs/adr/0015-managed-mcp-library.md) defines that boundary.
- Navigation, inspection and reconnect do not commission AI, start runtime work or replay an
  external operation. Actions must state their target and consequences before commitment.
- Persist intent before external creates. Preserve retained source, history, approvals and runtime
  identities. Show uncertainty and recovery honestly rather than claiming success.

[ADR 0008](../../docs/adr/0008-fixed-role-agent-engines.md) owns engine and Skill admission decisions.
[Repository instructions](../../AGENTS.md) own implementation and verification rules.

## Brand commitments

The product is Factory. Use its established interface typography, colors, materials, icons and
workspace conventions. Write direct, task-specific copy. Do not invent capability claims,
marketplace activity, popularity, ratings or endorsements.

## Product principles

- Explain what a person can do before exposing implementation details.
- Separate browsing and inspection from activation, sharing and administration.
- Make personal choices, shared defaults and required guidance distinguishable.
- Keep explicit human decisions explicit, including version adoption and Delivery.
- Preserve a person's place and drafts through ordinary navigation and recoverable failures.

## Accessibility and inclusion

Core flows must work with keyboard navigation and visible focus. Name controls and regions,
communicate status without color alone, respect reduced motion and keep long content usable.
Adapt layouts to narrow screens without horizontal page overflow or hiding essential actions.

## Evidence on hand

Current application code and the focused browser journeys under `test/browser` are implementation
evidence. Generated screenshots and test results belong under `.factory/test-results/`.
Existing captures can guide design inspection, but are not proof that the current checkout passes.
