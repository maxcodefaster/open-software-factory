# Managed remote MCP connections share selection, not credentials

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
