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
