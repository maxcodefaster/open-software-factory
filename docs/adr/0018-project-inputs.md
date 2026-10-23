# Project Inputs prepare requirements without granting execution authority

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
[ADR 0016](0016-delegated-monitoring-autofix.md) remains explicit and bounded. Neither saved task
text nor incoming data can widen it.

Factory reuses the existing webhook controller and retained history. Newly issued URLs use
`/hooks/inputs/`; previously issued monitoring URLs retain their keys and remain valid.
Settings keep Inputs under Project, independent Skills and MCP connections under Libraries,
personal settings together, and Factory administration visible only to administrators.
