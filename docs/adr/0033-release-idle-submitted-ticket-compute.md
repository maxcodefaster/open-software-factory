---
status: accepted
---

# Release idle submitted Ticket execution instead of checkpointing it

After the existing idle period, Factory stops a Ticket's submitted, settled Agent execution
through its normal retained Stop path. It keeps canonical Source, native Sessions, the completed
Turn, commit, approvals and results. A later commissioned operation gets fresh execution without
replaying that completed Turn.

The settled Session must target the Ticket's current Runtime Attempt, have a completed active
Turn and a successful commit for that Change. Human writing, pending or uncertain work and
unfinished Git operations cannot qualify. The same genuine-use, open-terminal, in-flight-operation and observation guards used for
idle Pause still apply. Intent is persisted under the existing Project and Change locks before
external cleanup. Reading or opening an observation-only view does not restart the released compute.

Personal Workspaces and unsubmitted work retain idle RAM Pause/Resume. Checkpointing submitted
Agent execution instead would preserve an unnecessary private Docker tree and RAM image on the
bounded store while Verification needs its own fresh environment. This decision does not resize
an admitted store, retire an earlier worker epoch, remove Source or guarantee unlimited capacity.

## Known failed Agent execution

The same idle release applies to a known failed Agent Turn whose failed Session and admitted intent
both identify the Ticket's exact current Runtime Attempt and native Session. Explicit retry already
fences and stops that execution before granting a new writer. Checkpointing it first adds storage and
capture failure without providing a supported retry path.

Normal Stop retains unsubmitted Source, the failed Turn and native Session; it starts no retry.
Human writers, another or unknown execution, active or uncertain work and unfinished Git operations
do not qualify. The same terminal, genuine-use and in-flight-operation guards remain mandatory.

## Release before fresh Verification

Fresh Verification also releases its exact submitted Agent execution before admitting another
Sandbox. Waiting for the idle grace would overlap two private Docker trees for one finished
implementation and can exhaust the bounded store during dependency installation. Use normal Stop
and wait for its positive cleanup result; a lost response or failed cleanup cannot admit the
replacement or repeat the Stop dispatch. Existing Verification execution is left unchanged.
Continuing a queued bootstrap may release its completed Coding predecessor, but keeps the same
Verification Runtime Attempt. A running Verification is not interrupted. A failed or stopped
Attempt remains retained until an explicit bootstrap retry, never replaced by periodic reconciliation.

The submitted commit must be the Verification candidate. The completed Session or that commit's
successful integration must identify the Ticket's current execution. Integration does not retarget
the retained native Session. Unfinished work, human writing and unrelated executions never qualify
for this automatic release. Current terminal observations and in-flight-operation guards still
apply, without an additional idle grace at this phase boundary. Source, writer authority, native
Sessions, approvals and results remain retained. Independently commissioned work keeps its existing
admission rules; this is not a global Sandbox-count limit or an allocation guarantee.
