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

OpenCode may inspect Git, edit files, and run the Project toolchain, but the checkout contains no reusable forge credential. When native execution ends normally and all owned work settles, Factory pauses agent writes, asks the Runtime Connector to create one commit, records the intended commit and push, and performs one controlled push to the Change branch for Verification. No separate submission action is required. Factory recovers an unclear push result by comparing the branch head with that commit. The Change Agent cannot approve requirements, approve delivery, merge, or mutate Factory product state.

## Consequences

New admissions express the approved specification and current correction as the Build goal.
OpenCode's native planning and tool loop owns implementation, local checks and browser inspection.
The final answer is ordinary prose, without a mandatory JSON completion form. A self-reported
checklist was neither independent evidence nor a reliable way to detect the end of native work.

A normal OpenCode `stop` finish proves only that the native turn ended. After all owned
descendants and shells settle, changed source can be submitted for independent Verification.
This does not prove local checks passed, the acceptance criteria are satisfied or the feature
is complete. Even an attempt reporting unfinished work may produce a reviewable submission;
it cannot approve itself. Native errors, interrupted or uncertain execution and unchanged
corrections retain their existing failure and recovery behavior.

Forgejo Verification still tests the exact submitted commit, and a person still reviews and
approves Delivery. The interface labels a pushed result as submitted for verification, not
complete. UI instructions still require the changed workflow with exactly owned synthetic
fixtures, console checks and an inspected screenshot, rather than just a landing or sign-in page.
Factory adds no outer inference loop and does not restart the model until a goal appears met.
Already frozen report-contract admissions retain their original parsing and submission rules;
an old failed turn is never retroactively promoted under the new policy.

Cold browser-image preparation is a known pre-execution outcome. One `browser_open` waits
through the Connector's existing image-preparation window, probing only after its exact
confirmed non-execution response. Every probe rechecks current Build ownership, Stop,
permissions and runtime identity before receiving a fresh short execution lease. Other
failures never authorize a replay. Caller disconnect ends further preparation probes.
The browser transport's open-call deadline includes image preparation, container setup and cold
Chrome launch; mutation deadlines are unchanged. Retained CLI instructions allow that client to wait.
New admissions register Factory's fixed MCP facade through the pinned native OpenCode API.
Registration is an in-memory, location-scoped override, not a Project configuration write.
Its endpoint freezes the Runtime Attempt and Turn; the existing gateway still checks current
owner, generation, lease and declared App for every call. Images reach the model in native tool
results. The shell/JSON/file-read client remains only for older immutable admission instructions,
not as a second path advertised to new work. Native registration never exposes an agent-facing
generic MCP registry or weakens browser isolation.
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

Native SSE is an ephemeral observation channel, not an admission or completion signal. Factory
shares one subscription per observed Runtime Attempt and reconnects read-only after transport loss.
The Side Panel receives authorized, bounded pending replacement snapshots, not a retained token
queue. Reconnect reads native history again; stable tool identities prevent duplicate activity.
Native events wake lifecycle and durable-usage observation, with a low-frequency reconciliation
check for missed events. An idle native event alone cannot authorize commit or release a writer.
Ownership renewal, ordered Stop, settled descendants/shells and final durable usage reconciliation
remain independent of the browser connection.
