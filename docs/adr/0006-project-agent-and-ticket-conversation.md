---
status: accepted
---

# Project Agent uses Mastra inside the Factory server

Factory runs one checkout-free Project Agent inside the existing Factory server. It uses
`@mastra/core` 1.67.0 for the Agent and typed tools. Authenticated server tools search current
Tickets, specifications, Epics and Wiki with weighted PostgreSQL full-text search and pg_trgm.
Exact references and titles rank first. Versioned bounded reads follow source relationships and
page through full text. Request-local memoization prevents repeated reads; six Mastra steps and
twelve distinct lookups bound one response. No embedding pipeline, BM25 or second code database.
Investigate returns cited answers; Plan may also return independent question rounds, a Requirement
proposal or an editable Epic/member proposal. Known Project/Ticket context is frozen at admission;
later navigation cannot retarget submitted work. Ambiguous intended targets require clarification.
Factory displays one question at a time and advances within a round without another inference.
The last answer or a changed direction requests fresh clarification against current intent.

Mastra does not own persistence or authority. Factory stores the Ticket Conversation, mode,
interview questions and human answers, Requirement proposal identity, and handoff markers in its
PostgreSQL product model. It validates every structured Agent result before applying a planning
proposal. Agent output never overwrites authored Ticket text. Explicit Confirm answers atomically
saves one immutable document and its exact Requirement Revision against the admitted document.
Manual edits autosave with version checks and never require another interview. Mastra Memory,
Workflows, RAG, vector storage, Studio, Agent Networks, and Sandboxes are not
used. This keeps Project Knowledge, Tickets, Requirements, and approvals as the only sources of
truth.

Developers and managers can discover allowed code paths and read numbered lines at an exact
Forgejo commit through the existing origin, inventory and blob-cache checks. Source data is not
instructions. Paths must be discovered before reading; code citations must name inspected files.
Contributors receive no code tools or code-derived conversation content. Every read, including
memoized reuse, rechecks authority. Investigate and Plan receive no checkout, shell, Runtime
capability or mutation tool. Build requires the latest exact Requirement Revision to have a human approval. Factory then
creates or resumes the existing Change path and sends later turns to OpenCode in the Ticket
Workspace. The interface shows one chronological Ticket Conversation and marks the authority
change without exposing an agent picker.

Mode is an internal authority boundary, not a user-selectable switch. Requirements entry records
one recoverable interview intent before inference. Personal Drafts remain local until creation.
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
