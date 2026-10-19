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

New admissions include a versioned completion-report contract in their frozen instructions.
A normal OpenCode `stop` finish proves only that the native turn ended. Before submission,
Factory requires a valid final report covering every approved acceptance criterion, actual
passing local checks and no unfinished items. Missing, incomplete, blocked or invalid reports
retain source and fail the attempt without committing or pushing. A no-change correction
stays awaiting attention; it never restores an earlier submission's completed status.
Already admitted instructions keep their original semantics through recovery.
Rejected readiness reports identify missing criterion numbers, duplicate or out-of-range
evidence, failing checks and unfinished work. New instructions include an exact-length
report template whose numbers refer to the approved array positions, without splitting
combined criteria. They ask for each check's latest result on the final code, so an earlier
failure that the Agent fixed is not described as still failing. This changes neither the
submission gate nor frozen report interpretation.
UI guidance asks the Agent to exercise the changed workflow with exactly owned synthetic
fixtures and inspect that screen, rather than count only a landing or sign-in screenshot.
Evidence distinguishes browser observations, source inspection and automated tests. This
guidance adds no new report fields or automatic inference, and existing admissions retain
their frozen instructions.

The report is an agent claim, not independent proof of correctness. Forgejo Verification
still tests the exact submitted commit, and a person still reviews and approves Delivery.
The interface therefore labels a pushed result as submitted for verification, not complete.
Factory does not add another inference loop or silently change the model. OpenCode's native
tool loop owns implementation and local correction; unknown external outcomes still follow
the existing recovery and explicit-retry rules.

Cold browser-image preparation is a known pre-execution outcome. One `browser_open` waits
through the Connector's existing image-preparation window, probing only after its exact
confirmed non-execution response. Every probe rechecks current Build ownership, Stop,
permissions and runtime identity before receiving a fresh short execution lease. Other
failures never authorize a replay. Caller disconnect ends further preparation probes.
The fixed client's open-call deadline includes image preparation, container setup and cold
Chrome launch; mutation deadlines are unchanged. Native shell guidance allows that client to wait.
This avoids spending additional model turns guessing whether the browser is ready.
An actual preparation failure still confirms no App inspection and does not justify
repeating an uncertain UI mutation. Owned cleanup behavior otherwise remains unchanged.
The current Build also renews intended browser sessions during cold startup. Connector
renewal does not wait on the lock held by container creation or a browser call, and startup
cannot overwrite a newer lease with its original deadline. Renewal before creation starts
no resources. Expiry, Stop and disconnect still end access and require exact owned cleanup.
The existing Build ownership heartbeat renews browser authority independently of native
history and usage reads. A slow observation must not expire a browser owned by a live Build.
Renewal acknowledgements have a five-second deadline, shorter than the browser lease.
An unknown transport outcome releases the renewal guard so the existing heartbeat can
revalidate ownership and try again. Confirmed Connector failures still close the session.
This never revives an expired browser, extends its lease bounds or retries an App action.
Safe permanent failure reasons survive cleanup; cleanup confirmation is recorded separately.
Opening an App allows cold Chrome launch before the unchanged upstream navigation timeout.
Other browser actions retain their existing deadlines. Client and HTTP transport bounds
include image preparation, container setup and cold launch without extending execution authority.
The fixed facade exposes bounded viewport resizing and a navigation/activation key allowlist.
This lets the Agent inspect 390px layouts and keyboard behavior rather than infer them from CSS.
Both controls require the current declared App and the same Build authority as clicks and fills.
They grant no script evaluation, arbitrary key chords, URLs, files or upstream MCP registration.
After a known failed turn, a retained Session accepts explicitly submitted new Build
instructions in the IDE even when compute is stopped or disconnected. Factory confirms
the previous writer's teardown and prepares compute before execution. It does not silently
route those instructions to checkout-free research, require another initial specification
prompt, or repeat the failed input. Uncertain execution, pending Stop and commit recovery
still require resolution before new Build work.

A confirmed tool-error response in an already observed App may leave partial UI effects.
Factory retains that browser but blocks further UI actions until a fresh DOM snapshot
succeeds. It does not replay the failed interaction. Lost responses, invalid provenance
and changed authority still require the existing owned cleanup rather than this recovery.
This also covers a confirmed first-navigation error. No successful App observation is
claimed by that error. The next snapshot first reads the pinned browser's selected-page
metadata and requires exactly one selected page at the intended declared App origin.
Only then may it inspect that page and record checkout provenance. Navigation is not
repeated, and an absent, foreign or ambiguous page fails closed.
An initial selected `about:blank` page can be polled through that fixed metadata read
within the snapshot's existing deadline while the original navigation commits. Read-only
App requests allow twenty seconds for cold response headers, with twenty-one seconds in
the Unix bridge. Other methods retain their five-second App and six-second bridge header
deadlines. The current lease still cancels access; no App request or write is replayed.

IDE edits and agent edits are part of the same Change. A Sandbox can disappear without losing the
checkout or conversation, while every OpenCode process and inference capability remains
generation-bound. Commit and push are auditable Factory operations rather than ambient powers
available to arbitrary shell commands. A pushed commit enters exact-commit Verification.
