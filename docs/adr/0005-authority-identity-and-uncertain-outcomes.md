---
status: accepted
---

# Authority, identity and uncertain outcomes


This record holds the decisions formerly numbered 0007, 0010, 0025. Each section keeps its original wording.


## Factory admits agent turns before external execution

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
Normal Project dispatches retain the same lease-bound observation as startup recovery, including
after a transient observation failure. Explicit maintenance also reconciles already-expired
Project dispatches through that uncertainty boundary before checking admission. It never steals
a live owner, treats uncertain Coding as settled, retries inference or erases observed usage.

Setup inspection retains its existing PostgreSQL session lock on a short-lived coordination
connection, not the application pool. This costs one connection per active inspection but preserves
cross-process exclusion and allows authorization, usage writes and requests to proceed during
inference even with an application pool of one. Recovery never replays interrupted inference.

### Considered options

Process-local busy sets cannot prevent another Factory process from submitting the same work.
Holding a database transaction across inference would tie up connections without resolving a
provider's lost response. Factory keeps bounded admission/outcome records and concrete
Mastra/OpenCode adapters. External provider execution is not exactly-once.

### Consequences

An explicit retry has a new command and turn identity. Product effects and terminal settlement
must check the exact owner and authority inside their database transaction. Uncertain outcomes
stay visible; they cannot be reported as failed-before-execution or zero usage. This decision
defines the implementation contract; the
[architecture reference](../README.md#verification-and-operating-limits) records concrete proof and limits.

## Factory identity and exclusive Change editing

Factory is the company's sole identity and Project-access control plane. Use pinned native Better
Auth OIDC/SSO and optional SCIM, with provider-agnostic configuration and an Entra preset; Forgejo
uses Factory OIDC and automatically reconciled private repository grants. Bind external identity
to verified issuer and subject, never mutable email. Management permission is independent of
Contributor/Developer membership. SSO mode retains only a separately secured local emergency
administrator. Session termination does not cancel admitted Agent work; actual account disablement
and authority removal revoke further operations while retaining code.

Moving the local control-plane server into Linux does not rename its registered Forge identity.
Startup retains the recorded discovery endpoint separately from the runtime callback address.
The issuer bridge still requires development mode and the exact configured issuer host, port and
local listener. Existing clients, accounts and grants are not migrated or recreated.

The Developer IDE and Change Agent share the Ticket checkout, so one durable writer owns it at a
time. Observation stays available during Agent work. Completion or confirmed Stop transfers editing
without another approval ceremony; explicit early takeover fences source, Terminal and Change-branch
pushes. Parallel isolated checkouts would require another merge UX and are not this design. Native
Forgejo protection applies to authenticated identities, not commit authors; shared credentials cannot
represent separate writers. Protection updates have no CAS, so handoff persists intent, serializes
reconciliation and refuses writes until the confirmed boundary is safe. Local laptop editing cannot
be prevented; accepting an unauthorized shared-branch push can.

Writer handoff uses a persisted epoch and confirmed native Agent Stop, then stops the previous
execution Sandbox before giving the next writer access. Killing one PTY shell does not stop
detached jobs or nested Docker processes. Complete teardown provides the initial reliable boundary
while preserving canonical files, approved development volumes and OpenCode's checkout-local database.
After exact compute teardown, a fresh bootstrap Session without durable native confirmation has
not reached prompt submission and can settle Stop. Late confirmation is fenced by Stop. Reused
or confirmed Sessions still require native queued-input evidence; teardown alone never clears them.
The source editor remains available independently; compute restarts when commands are needed.
Development Stop and failed-start cleanup remove containers and networks, not named volumes in
that Workspace's retained private Docker storage. Verification and Preview teardown keep their
disposable-data cleanup. Process controls show observation authority rather than inviting rejected writes.
Source saves and each Terminal input acquire current writer authority at their actual send boundary.
Forgejo Change protection names the exact human writer or Factory's controlled Agent push identity.
Source service mutations and writer fences share one mutex. Fence acknowledgement waits for an
admitted filesystem operation to finish, then rejects older writer epochs, including delayed saves.
After Source restart, Ticket mutation headers fail closed until Factory confirms the current epoch.
Whole writer transitions serialize per Change; stale completion observations do not start a new
handoff while holding the same lock. Branch protection precedes creation and initially allows only
the Factory control identity, since native creation is itself a protected write.

A new admitted Build can wait for confirmed teardown of its previous writer without
failing the turn. A bounded observation releases only its pending execution lease;
the recorded turn, prompt and writer fence remain unchanged. Reconciliation resumes
that same undispatched turn only after its exact predecessor is observed stopped.
Source and branch writes remain fenced throughout the wait, and a later human Stop
prevents continuation. Uncertain or already dispatched inference is not replayed
through this path. Stale failure text from a prior turn is not the new admission's
current error.

[ADR 0004](0004-agents-and-conversations.md#retained-conversations-share-one-ticket-workspace-and-an-explicit-writer) adds named writer attribution,
ephemeral editing activity, explicit release and requested transfers. Idle indication never
automatically releases writing authority or expires an Agent's work.

Factory browser logout first destroys its own session, then navigates to an installation-owned
static page served by Forgejo's native custom-assets handler. That page uses native same-origin
logout and verifies the session ended before returning. No proxy cookie impersonation, disabled
CSRF protection or helper-token revocation is involved. Forgejo helper OAuth tokens can access
native APIs within the person's grants; they are not Git-only tokens. All-device termination ends
Factory sessions; native Forgejo browser sessions on other devices remain an explicit limitation.

App previews use separate runtime origins and cannot set Factory or IDE credentials. Factory
preserves App cookie values, expiry and HttpOnly, removes Domain, and scopes Path to the exact App.
It sets SameSite=None, Secure and Partitioned so authentication works inside the Factory frame
without sharing the session with another top-level site. Opening the App in a separate tab has its
own browser-session partition and may require a separate App sign-in.

## Human Ticket responsibility is independent of execution and decisions

A Ticket can name one optional human responsible for coordinating the intended result.
Responsibility does not mean that person writes the code. Agent commissioning, the current
Change Writer, exact approvals and existing Project capabilities retain their separate identities.
Agents are not alternate values in a human assignment field. Any member who can edit the Ticket
can choose an active member of its Project; assigning responsibility never starts, stops or
transfers implementation.

The personal Inbox spans currently authorized Projects. It projects retained questions, proposals,
blocked work, review rechecks, editing requests and ready Delivery decisions rather than creating
another workflow or granting approval authority. A responsible person receives a request when
eligible to perform it. Otherwise its required capability determines the recipients. Personally
addressed editing requests and private Project conversations retain their exact addressees.
Developer-only context cannot become Contributor activity.

Following controls discussion activity, not authorization or unresolved requests. Creating,
contributing to, commissioning work on or accepting responsibility for a Ticket establishes
following; an explicit personal choice overrides inferred participation. Structured mentions
address actual Project member identities and remain activity, not automatic work orders.
They reach authorized recipients independently of following. The author receives no notification
for their own contribution.

Activity groups by discussion and retains personal read and archive receipts against the exact
observed event. A later reply becomes unread again; stale reads cannot acknowledge a newer reply.
The dock counts open requests plus unarchived unread activity, counting each item once.
Reading or archiving cannot resolve shared requests. Their source decision, supersession or
cancellation removes them for every recipient. Navigation opens the source context and never
approves, retries or commissions work.
