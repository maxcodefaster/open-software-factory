---
status: accepted
---

# Project Chat uses Factory MCP for planning actions

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
