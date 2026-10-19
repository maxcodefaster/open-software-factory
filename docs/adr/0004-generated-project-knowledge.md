---
status: accepted
---

# Project Knowledge is generated, revisioned, and separate from repository documents

Factory stores Knowledge Pages and immutable revisions in PostgreSQL. This gives the Wiki stable identity, editable hierarchy, chosen icons, autosave and readable human/AI History without generated repository churn. Wiki serves Product Contributors and developers. Generate only facts that materially improve understanding, use, operation or safe changes; do not mirror source files or invent product intent.

Factory automatically configures signed repository push webhooks. Default-branch events persist update intent before acknowledgement, coalesce rapid changes and wake exact-head API reconciliation. Startup and rare reconciliation cover missed events; polling is not the primary update trigger. Hook creates have deterministic identity, persisted intent and ambiguous-outcome recovery. Repository setup requires no per-Project Click-Ops. Sources must belong to the configured Factory Forgejo.

One concrete pinned Mastra workflow plans useful topics, investigates source groups, writes pages and checks/repairs specific flaws through bounded loops. Source limits apply per analysis job, with overall execution bounds rather than one global 48-file ceiling. A checked overview may publish before checked topic packages; unfinished text never publishes. Factory owns durable work intent, recovery and exact revision publication, not a second Mastra store, generic scheduler or claims registry. Organize by reader tasks and concepts rather than source files. Important claims need inspected source/test evidence and valid internal links. Iterate on small and multi-component repositories, using observed defects as regressions for accuracy, coverage, readability, useful density, duplication and update locality.

Known-invalid structured results, topic plans and unread research citations receive one deliberate correction inside
the same generation and shared request budget, with the rejected result and specific validation
failure. Research must inspect a cited file and verify its claims before publication. Provider errors and
unknown outcomes do not take this correction path. Default-branch reconciliation does not commission
another generation for a source commit already attempted. A new commit or explicit human Retry can
start another generation; setup's Wiki Retry is an explicit request, not background reconciliation.
An authenticated Wiki retry hands a failed setup observation to the exact generation returned by
that command, including already-admitted work. The original failure remains in generation history.
Ordinary status reads never adopt unrelated newer generations, and a completed setup step is not
reopened by later Wiki work.

Factory binds new page identities and hierarchy to the validated topic plan. Writers supply content
and inspected sources, not new slugs or parents. Existing-page writers can update only the topic's
allowed identities; publication preserves their slugs and hierarchy. The checker reviews the
normalized publication package without treating Factory-supplied metadata as a writer error.
Source discovery includes SQL migrations and browser styles/markup, but excludes environment files.
Public failure diagnostics distinguish invalid plans, rejected drafts and execution bounds without
exposing provider prose, source paths or credentials.
Each model task reserves its final allowed step for the structured result with tools disabled.
Repeated source reads cannot consume every step and leave the checker without a verdict. This
does not increase the task or shared request bounds and never permits unsupported claims.

Inspect manifests, entrypoints, source relationships, real flows and focused tests, then update only affected useful pages. Read current human prose and preserve its business framing and hierarchy. AI may automatically correct or remove generated prose contradicted by current evidence, but absence from code does not disprove human product knowledge. Omission never removes a page; whole-page archival remains human-controlled. Unchanged content creates no revision. Failure retains readable current content.

Publication retains human text edits separately from the generated baseline. Notes outside that
baseline survive a rewritten introduction or ending verbatim. Disjoint inline edits use the existing
document merge, including removing repeated human edits from the next generated baseline rather
than adopting them as model-owned text. Overlap, ambiguity or an oversized combined page fails that
package atomically and keeps the human revision for review. Model instructions are not the
preservation mechanism. A rejected structured result and its local validation reason are transient
correction input, not published diagnostics; they remain subject to the existing step input bound.

Publication fences the exact current revision and retries against fresh input after concurrent edits. A focused cursor is not a lock. Pristine editors adopt new content; dirty drafts preserve text/cursor, merge non-overlapping edits and offer Compare changes for actual conflicts. Restore creates a new immutable revision. History renders the selected Markdown document with human/AI attribution and time. Development-authorized readers can open exact Git provenance; Product Contributors receive no technical source links or paths.

One tree separates expanded Wiki from collapsed Code docs. Repository Markdown remains source-owned and read-only in Wiki. Only development-authorized roles can discover/search/read it or open technical source actions; enforce the boundary in server responses as well as UI. Discover nested files through complete Forgejo tree pagination and truncation recovery; cache inventory by exact commit and content/search by blob hash. Refresh on default-branch change and reconcile missed events, not on every Wiki open. Search opens from the Wiki root row and leaves the tree intact. Drag/drop shows insertion/child targets with explicit promotion and retained keyboard movement; navigation width is user-resizable. Source reordering is rejected, never converted into a Git mutation.

Page bodies are Markdown behind the shared Factory rich-editor adapter. Caret-anchored filtered slash commands, table controls, highlighted code and a compact page menu share design tokens with Tickets. No arbitrary text-color or database-table suite. Keep caches bounded and separate from product Evidence; persist immutable revisions, generation intent/outcome and compact exact citations.
