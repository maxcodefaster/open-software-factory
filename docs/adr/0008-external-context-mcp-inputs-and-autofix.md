---
status: accepted
---

# External context: MCP, Inputs and delegated Autofix


This record holds the decisions formerly numbered 0015, 0016, 0018, 0020. Each section keeps its original wording.


## Managed remote MCP connections share selection, not credentials

Factory has one MCP library for external context in Investigate, Plan and Build. It follows
the Skills library's personal, Project and Factory ownership, exact definition revisions,
sharing review and per-work-type inheritance. Saving, sharing and selecting a definition
do not authorize an external account. Accepted sharing copies only the reviewed definition.

An authenticated connection is separate from its definition. Factory-owned connections require
explicit Project grants. Project connections stay within their Project and personal credentials
stay owned by their author. Results used in shared work are visible there. Required inherited
choices cannot be disabled by a lower scope. Admission retains the exact definition, approved
tool schemas and credential epoch. Defaults affect new admissions; revocation fences further
lookups. Reconnecting an account creates another credential epoch, while token renewal preserves it.
Factory Project grants bind that epoch and must be renewed after account reconnect, so a replaced
account cannot silently broaden previously shared access.
Build corrections retain the Change's original selection, including an originally empty selection.

Only public remote HTTPS endpoints on port 443 are admitted. There is no local process launcher,
stdio package installation, extra gateway service or alternate agent engine. Factory uses the
official MCP TypeScript client for transport and OAuth. Mastra receives bounded native tools.
OpenCode receives a turn-bound Factory MCP facade rather than reusable provider credentials.
The independent reviewer retains its fixed tools and cannot acquire library connections.

OAuth registrations, PKCE state and tokens use the existing OpenBao infrastructure. PostgreSQL
retains identities, grants, immutable human tool approvals and secret-write intent, not token
values. Secret objects are create-only and referenced after their recorded outcome is checked.
OAuth callbacks bind the initiating account, expiring state, authorization server and resource.
An interrupted code exchange or rotating refresh does not authorize an automatic replay.

Read-only access requires explicit review of exact tool names and schemas and an appropriately
restricted provider account. A server's read-only annotation is not proof. Factory checks the
current grant and execution owner before and after each lookup, rejects changed tool contracts
and retains compact result digests rather than a separate telemetry archive. A remote server's
implementation remains controlled by its operator; pinning its catalogue does not freeze its code.
General external writes and local MCP processes require a separate scope decision.

## Monitoring delegates a bounded fix and Delivery, not general agent authority

Factory accepts monitoring alerts through a named, Project-bound webhook with a rotatable URL
key. A manager who also has development authority explicitly delegates application-code fixes
and Delivery. The payload cannot choose a Project, account, connection or execution policy.
This avoids maintaining ticket importers, provider-specific OAuth applications or another
integration service. The webhook is not an OpenTelemetry collector.

The delegation freezes a shared read-only MCP connection and its reviewed contracts. Personal
models, Skills and credentials do not enter background work. Factory records diagnosis intent,
model selection and ownership before inference. Mastra must read the monitoring source and
identified application code before proposing exact requirements. Missing context and operational
events settle without a Ticket. Lost inference outcomes remain uncertain, never automatic retries.
Repeated deliveries update an existing incident rather than commission another fix.

Eligible diagnoses create one Ticket, immutable requirements and an approval whose basis identifies
the delegation. Build uses native OpenCode and the existing fresh Verification and independent
read-only review. Automatic Delivery retains all normal exact-commit, default-branch, settled-work
and open-Thread gates. It also rejects operational/configuration/dependency paths and deleted
regression tests. Delivery approval records the actual policy, candidate and passing review,
not a claim that a human inspected generated requirements or the candidate.

Disabling a webhook, rotating its key, losing its delegator's authority or changing source access
fences further automatic execution. Human source-editing takeover disables automatic Delivery.
The irreversible merge rechecks current delegation under the same authority locks used by
revocation. A merge already accepted by the forge remains observable and its promotion/cleanup
continues. Delivery adopts the configured default branch and Staging, not a production deployment.

Factory retains compact incident context, source/result digests and decisions rather than a new
log archive. Named sensitive fields and URL query strings are removed, but free-text redaction
remains the monitoring sender's responsibility. Provider references are citations, not URLs that
the agent may fetch arbitrarily.

## Project Inputs prepare requirements without granting execution authority

Inputs generalize the Project webhook beyond monitoring. A Project manager saves a name, task
and optional shared MCP sources. Incoming JSON automatically enters the existing Project Agent's
planning workflow. There is no selectable investigation mode, provider importer or workflow engine.
Manual Tickets and explicitly requested Interviews keep their existing behavior.

Each Input policy freezes its task, delegation and reviewed source assignments. An empty selection
inherits shared Project source defaults at that policy revision, never personal credentials.
Explicitly selected sources must be consulted before preparing a Ticket. The Project Agent uses
the payload as evidence, not instructions or a grant of authority. Missing context settles without
a Ticket. Duplicate deliveries retain one event and outcome; uncertain inference is never replayed
automatically.

Prepared requirements have no approval or Change. A human can approve implementation normally.
That Build retains the Input's sources, subject to current access checks; independent review
receives no library MCP tools. The separate application Autofix and Delivery delegation from
[ADR 0008](#monitoring-delegates-a-bounded-fix-and-delivery-not-general-agent-authority) remains explicit and bounded. Neither saved task
text nor incoming data can widen it.

Factory reuses the existing webhook controller and retained history. Newly issued URLs use
`/hooks/inputs/`; previously issued monitoring URLs retain their keys and remain valid.
Settings keep Inputs under Project, independent Skills and MCP connections under Libraries,
personal settings together, and Factory administration visible only to administrators.

## Project Chat uses Factory MCP for planning actions

The personal Project Chat consumes a Factory MCP server from the start rather than maintaining
separate native mutation tools and adding MCP later. The pinned TypeScript SDK connects client and
server through its linked in-process transport. Factory remains one service, with no public
endpoint, credential configuration or external-client access introduced by this decision.
Search and source reads use the existing research functions; code access remains developer-only.

An ordinary human-initiated personal Project request in Plan may create Tickets when the human
explicitly asks. Creation defaults to Requirements; Ideas remains available. Questions and suggestions
are not permission to create work. Ticket conversations, explicit research, Interviews, background
Inputs and independent review acquire no new mutation tool. The server binds the actor, Project and
execution token; model arguments cannot replace them. Every call rechecks current authority.

Zero and MCP share the authoritative Ticket creation command. The admitted Agent Turn retains
the human request before execution. A per-Ticket action key determines its identity, and the Ticket
and a private conversation receipt commit atomically. Repeating the same key returns its recorded
result; changed content conflicts. A failed final answer does not undo a completed action or hide
its receipt. Reconnect never repeats inference. The existing execution fence blocks expired,
settled or revoked work.

This is planning authority only. Creation does not approve a specification, start an Interview,
commission implementation, change existing Tickets or authorize Delivery. External MCP-library
connections retain their reviewed read-only boundary. Additional Factory actions need their own
command and authority decision, not a generic API, SQL or shell tool.

The read-only `readProjectReleases` tool reports confirmed versions and advisory bump suggestions
without credentials or consumer state. It cannot publish or grant access. Human-confirmed
[Release publication](0009-installation-releases-and-hardening.md#release-publication-has-no-dependency-on-consumers) uses its own authenticated command.
