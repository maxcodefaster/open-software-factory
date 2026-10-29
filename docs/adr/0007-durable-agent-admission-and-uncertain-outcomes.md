---
status: accepted
---

# Factory admits agent turns before external execution

Build startup follows the recorded Sandbox lifecycle rather than a separate poll-count cutoff.
Runtime operations retain their preparation bounds. Stop, authority loss and a changed runtime
generation interrupt waiting before inference. A known failed Agent turn can be retried by an
explicit human command, but an assigned previous Sandbox must be fenced and stopped before the
new Agent receives writing authority. An uncertain turn never qualifies for that retry path.

Read-only OpenCode transport failures retain observation of the same admitted execution. They
do not authorize another prompt or turn a status-read deadline into a lost dispatch receipt.
Each observation cycle still rechecks its lease, Stop and authority before continuing.

Factory records the command identity, bounded input, current authority/model snapshot and one
exclusive execution owner in PostgreSQL before submitting Project or Change Agent work. Reusing
a command identity returns its original turn, while changed input conflicts. Losing a connection
does not authorize another execution.

Recovery depends on the last proved external boundary. Undispatched intent can be claimed again.
OpenCode work uses recorded session/prompt identities and its pinned durable admission behavior,
subject to actual-runtime verification. A Project-provider outcome that cannot be established
becomes explicitly uncertain and needs a new human retry decision. An expired worker lease alone
is never proof that external work did not happen. Stop and changed authority fence old outcomes
before best-effort interruption. A definite provider rejection or validated output failure is failed;
a lost response, timeout or ambiguous server error remains uncertain. Provider and native processor
retries are disabled. A small shared native policy bounds per-step input bytes and output tokens,
with task deadlines. Project research has no separate step or distinct-lookup ceiling that can
terminate a response immediately after a tool call. Wiki's shared request budget counts each provider step, including
deliberate schema repair, rather than each call to `generate`.

Each Project provider step and research lookup rechecks the admitted conversation and execution
owner, not just Project membership. Known authority loss fails without publishing a response;
an existing Stop remains stopped. This says nothing about whether earlier inference was charged.
Lease loss, process interruption and a timed-out provider without a recoverable result remain
uncertain rather than authorizing a retry. Native error wrapping preserves Factory command codes.

Setup inspection retains its existing PostgreSQL session lock on a short-lived coordination
connection, not the application pool. This costs one connection per active inspection but preserves
cross-process exclusion and allows authorization, usage writes and requests to proceed during
inference even with an application pool of one. Recovery never replays interrupted inference.

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
