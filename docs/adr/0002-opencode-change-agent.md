---
status: accepted
---

# OpenCode runs inside the Ticket Workspace without forge authority

Each active Change has one resumable OpenCode 2 Change Agent Session. OpenCode runs as the development user in the Ticket Workspace's primary Dev Container and edits the same checkout shown by the IDE. Factory connects to the OpenCode HTTP server through the generation-bound Runtime Connector using `@opencode/client`; the browser talks only to Factory and never receives a direct OpenCode endpoint or provider credential.

The Developer IDE has an independent lifecycle. It accesses the canonical Ticket checkout rather
than running another Change Agent or keeping a synchronized source copy. Editor, PTY and Agent
readiness are separate; opening source does not itself admit Build. See
[ADR 0001](0001-development-workspaces-and-staging.md).

The Ticket Workspace volume retains OpenCode session state across Sandbox restarts. Factory persists the OpenCode session identity, execution intent and terminal outcome, but not message streams, logs, heartbeats, or model credentials. The agent uses the configured model, one active turn per Change, and bounded file and shell tools inside the Sandbox. Questions and permission requests appear in the Factory chat, but answering them does not create a Requirement Approval or Delivery Approval. Manual edits should happen while the agent is stopped so two writers do not race in the shared checkout.

Factory keeps raw model-provider credentials outside the Sandbox. OpenCode receives a generation-bound inference capability for a Factory model relay, so shell commands and Project code cannot read or reuse the upstream credential.

OpenCode may inspect Git, edit files, and run the Project toolchain, but the checkout contains no reusable forge credential. When the agent finishes an implementation attempt and its local checks pass, Factory pauses agent writes, asks the Runtime Connector to create one commit, records the intended commit and push, and performs one controlled push to the Change branch. No separate submission action is required. Factory recovers an unclear push result by comparing the branch head with that commit. The Change Agent cannot approve requirements, approve delivery, merge, or mutate Factory product state.

## Consequences

IDE edits and agent edits are part of the same Change. A Sandbox can disappear without losing the
checkout or conversation, while every OpenCode process and inference capability remains
generation-bound. Commit and push are auditable Factory operations rather than ambient powers
available to arbitrary shell commands. A pushed commit enters exact-commit Verification.
