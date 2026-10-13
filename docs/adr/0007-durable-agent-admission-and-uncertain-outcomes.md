---
status: accepted
---

# Factory admits agent turns before external execution

Factory records the command identity, bounded input, current authority/model snapshot and one
exclusive execution owner in PostgreSQL before submitting Project or Change Agent work. Reusing
a command identity returns its original turn, while changed input conflicts. Losing a connection
does not authorize another execution.

Recovery depends on the last proved external boundary. Undispatched intent can be claimed again.
OpenCode work uses recorded session/prompt identities and its pinned durable admission behavior,
subject to actual-runtime verification. A Project-provider outcome that cannot be established
becomes explicitly uncertain and needs a new human retry decision. An expired worker lease alone
is never proof that external work did not happen. Stop and changed authority fence old outcomes
before best-effort interruption.

## Considered options

Process-local busy sets cannot prevent another Factory process from submitting the same work.
Holding a database transaction across inference would tie up connections without resolving a
provider's lost response. Factory keeps bounded admission/outcome records and concrete
Mastra/OpenCode adapters. External provider execution is not exactly-once.

## Consequences

An explicit retry has a new command and turn identity. Product effects and terminal settlement
must check the exact owner and authority inside their database transaction. Uncertain outcomes
stay visible; they cannot be reported as failed-before-execution or zero usage. This decision
defines the implementation contract; the
[architecture reference](../README.md#verification-and-operating-limits) records concrete proof and limits.
