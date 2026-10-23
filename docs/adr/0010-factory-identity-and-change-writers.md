# Factory identity and exclusive Change editing

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

[ADR 0019](0019-conversation-contexts-and-shared-editing.md) adds named writer attribution,
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
