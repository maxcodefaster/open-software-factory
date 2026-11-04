---
status: accepted
---

# Verification, review and Delivery


This record holds the decisions formerly numbered 0003, 0011, 0012, 0014, 0026. Each section keeps its original wording.


## Forgejo Actions is the Change CI path and Factory owns promotion

Forgejo remains the internal source forge for repositories, commits, branches, pull requests, Action runs, and merge results. Factory remains the only product control plane. It exposes Factory concepts in its own UI and uses a narrow Forgejo adapter instead of exposing Forgejo as a second product UI or implementing Git hosting and pull-request semantics itself.

Factory protects the default branch against direct pushes and creates one pull request per Change after the first commit reaches its Change branch. Factory records its intent before creating the pull request and recovers an unclear result by finding the pull request for the expected repository and branches. Forgejo branch protection is an additional safeguard; Factory still decides whether the current commit may be delivered.

The binding Verification runs through the native Forgejo Actions `pull_request` event. Opening the pull request or pushing another commit starts `.forgejo/workflows/factory-verification.yml`; Forgejo owns scheduling, cancellation, concurrency, and manual retries. Factory does not implement a second workflow scheduler. Factory accepts the result only while the workflow definition matches the protected default-branch version. An agent-authored Change cannot alter that protected workflow.

Each pending verification run receives a fresh Factory Verification Sandbox using the standard Factorybox, Sysbox, Dev Containers, and Runtime Connector topology. Factory registers a repository-scoped, one-job Forgejo runner inside that Sandbox and revokes it after the run. The runner executes in host mode inside the disposable Project Dev Container, where the Sandbox provides the isolation that a shared host runner would lack. It has read-only source access, receives no delivery secrets, cannot reach the Kubernetes control plane, and never uses a shared host Docker socket. The workflow checks that it is testing the pull request's current commit before running the Project toolchain.

Fresh Verification may consume approved immutable prebuilt images and dependency artifacts, or a
never-used prepared execution slot. It never adopts development source, a mutable dependency tree,
an already-used Sandbox or a cached Verification result. Preparation cannot weaken exact-commit,
protected-workflow or one-job runner authority.

Forgejo keeps workflow logs and retry state. Factory records which commit ran, whether it passed, and a compact result summary. Webhooks wake reconciliation, but Factory confirms the final result through the Forgejo API. Repeating a run needs no separate Factory retry system.

A failed run does not mark the Change complete. Factory sends a bounded failure summary from the Forgejo run back to the same Change Agent, which may edit, run local checks, and push another controlled commit. Forgejo then starts another pull-request run. This repair loop continues while the developer leaves the agent running, but it pauses on user stop, an unresolved agent question, exhausted execution limits, or repeated failure without a new code change. Factory never stores the full CI log as product state.

Factory permits merge only when the current pull-request commit passed and a Delivery Approval names that same commit and test result. The Project default branch must also still point to the commit from which the Change started. Factory uses fast-forward-only merge, so the tested commit itself becomes the default-branch and Staging revision. If either branch moved, the code must run through CI and approval again.

After Forgejo confirms the merge, Factory persists Promotion intent for the exact merged commit and creates replacement Staging compute. The existing healthy Staging Preview continues serving traffic until the replacement is ready. Only then does Factory switch the Preview and clean up owned compute and runners. The delivered Change branch stays protected with no writers, rather than dropping its protection to delete the ref; [the branch-retirement decision](#delivered-change-branches-remain-protected-with-no-writers) records that constraint. A failed Verification, merge, or Promotion leaves enough state for deterministic retry and does not replace healthy Staging.

A developer may explicitly retry a failed Main Preview from its merged Ticket after the
failed replacement's cleanup is confirmed. The retry appends a numbered Promotion bound to
the failed predecessor, exact merged commit and retained human command. It never resets that
predecessor, reissues merge or creates another approval. A repeated command observes the same
new Promotion; a changed command target, moved default branch, changed current Preview or
unconfirmed cleanup refuses. Current reads and the Project Delivery fence use the latest
Promotion, while prior failures and Runtime Attempts remain unchanged. Reading does not retry.

Factory owns desired state for Development Workspaces and Project Staging. This delivery path
ends at the healthy Staging Preview, with Forgejo Actions providing exact-commit Verification.

[Independent Release publication](0009-installation-releases-and-hardening.md#release-publication-has-no-dependency-on-consumers) is a separate explicit
action after Delivery. It does not extend Promotion into production or require a release per Ticket.

[Parallel Tickets and serialized Delivery](#parallel-ticket-implementation-reuses-the-existing-delivery-path)
retains the original Change basis while binding each integrated candidate to the current
default-branch commit. It also retains failed merge attempts instead of reusing their decisions.

## Delivered Change branches remain protected with no writers

Delivery cleanup seals the exact Change branch through the existing durable Forge protection
intent and confirms an empty writer set. It retains the protected source ref and its history.
Compute and runner cleanup still complete; branch retirement must be confirmed before clearing
the cleanup outcome.

The native forge rejects deletion of protected branches. Removing protection merely to delete
a ref would open a write-permission gap while developers retain repository access. Retaining a
closed branch avoids that gap and preserves any late source work instead of blindly deleting it.
Delivery Approval, the merge and Staging remain bound to the exact verified commit.

This replaces the earlier merged-branch deletion detail in ADR 0006. It does not relax default-branch
protection, reopen delivered Changes or grant another writer.

## Independent review uses a fresh, read-only OpenCode Session

Factory reviews each exact CI-successful candidate in a new OpenCode Session rather than asking
its implementer to self-certify or forking that implementer's history. Review uses the admitted
Coding model and reasoning. It keeps existing runtime, ownership, Stop, usage, SSE and browser
boundaries rather than creating another orchestration service.

The reviewer runs in the existing Sandbox, but its session permissions deny all native tools
except Factory's fixed review and App-browser facade. Source reads come from immutable Git
commits, not a mutable checkout. This deliberately excludes arbitrary shell checks and writing
subagents; the existing fresh Forgejo Verification owns executable checks. Browser observations
must identify the clean candidate. Factory's explicit report tool records compact findings and
coverage, while ordinary native finish settles execution. Missing reporting or missing proof
does not pass. This is not a JSON completion form imposed on implementation.

Source tools can also inspect full 40-character commits within the same authorized
repository, so a Ticket's named prior changes can be compared independently.
Mutable refs, abbreviated hashes, revision expressions and other repositories are
not admitted. Historical reads retain their exact source commit and cannot alone
satisfy a current-candidate case; diffs always end at the admitted candidate.

The fixed facade's source and reporting authority belongs to the admitted turn,
not to its ephemeral browser. A failed or unconfirmed browser cleanup must not
discard source findings or prevent an honest incomplete report. These calls still
check the exact Runtime Attempt, generation, owner, lease, active Session, Stop and
Project authority. App calls separately require the original live or explicitly
reopenable browser; reporting access cannot revive it or replay a UI mutation.

The fixed browser facade can read bounded, ephemeral metadata from HTTP responses already
observed by its exact App proxy. A separate Unix control socket prevents browser proxy requests
from reaching that read handler. Observations contain method, path without queries, status,
cookie attributes without values and sanitized CORS metadata. They remain subject to the same
turn, runtime, browser Session and lease checks. Pagination exposes history eviction and omitted
cookie headers. This neither sends requests nor enables network tools or JavaScript evaluation.
Response attributes do not prove browser cookie acceptance or provide an exhaustive historical
implementation/write audit; missing observations remain unknown. Metadata reads cannot replace
a case's own actual App inspection and supply no video chapter position.

Execution claims use the fixed review-only `review_execution` tool. Factory supplies the exact
candidate's commit-operation receipts, separately from runtime-owned implementation action inputs.
Only recorded implementation roots and their checked native descendants in the same canonical
Workspace are readable through the current Review Runtime. The caller cannot select a foreign
Session or Runtime. Historical environment identities, committed fingerprints and masked manifests
must agree with OpenBao before native inputs are read. All historical protected values and common
credential syntax are masked before bounded byte pagination. Prompts, reasoning, tool outputs and
browser-typed values are withheld. Patch indexes contain paths; an explicit selected-action read can
inspect the redacted recorded patch, including a temporary helper absent from Git. This is recorded
input, not proof that its later execution used identical file bytes. Action times exclude work after
the candidate receipt, with unknown
times disclosed rather than assumed complete. Evidence retains only response digests and candidate
provenance, not raw action logs. These observations cannot establish an exhaustive or tamper-proof
external-write audit. Missing, redacted, unclassified or unread material stays unknown; execution
evidence never substitutes for a scenario's source or App observation. Reading it grants no
execution authority and does not replay implementation or wake released compute.

The resumable implementation Session remains separate. Only reproducible blocking defects within
approved scope enter automatic correction. A changed commit requires new CI and review. An
explicit retry can create another fresh attempt for an incomplete review without rewriting the
old attempt. After a settled bootstrap interruption, that retry may prepare fresh compute for the
same verified candidate. Unresolved input and incomplete cleanup remain fenced; retry never
restarts implementation. Delivery still needs an immutable human approval naming the exact commit,
Verification and settled passing review. Previously recorded Delivery Approvals remain intact.

## Keep QA recordings separate from review decisions

Factory records the existing independent review browser, with scenario chapters in one video.
Protected media shares the installation-owned private object store with human attachments,
as defined in [ADR 0007](0007-knowledge-and-files.md#one-installation-owned-private-file-store), not another Sandbox or
a separate media store. A missing recording is not a failed QA result. A newer complete recording replaces
older videos, including annotated ones; annotation stills and comments remain. The remaining
video expires thirty days after the Change is delivered or cancelled.

Factory persists media intent before an immutable, verified object write. Final publication
rechecks execution authority in a separate short transaction, so object storage I/O does not hold
the turn lease lock. Still uploads are idempotent by client UUID, content hash and original source
context. Video deletion retains the original recording metadata, so an earlier captured frame
can still be saved with its reviewed commit and timestamp without restoring the video.
Encoder process measurements stay ephemeral.

Each Review Case fixes its observation kind before work begins. App cases need their own actual
App observation; source cases need their own immutable candidate read or diff and may cite the
Factory-confirmed exact-commit Verification for executable checks. Normal/error/boundary describes
the tested condition, not its evidence source. Source checks cannot replace normal and adverse
App coverage for user-facing changes. They are labelled separately and have no invented video
chapter position. A result without its required observation is rejected while the case remains
active, so the reviewer can gather missing evidence without replaying an App mutation. Existing
case intent and completed outcomes are not rewritten.

Human comments and resolvable Threads are separate from immutable candidate-review results.
Open Threads block Delivery under the same Change lock used by approval. Only an explicit
correction submission admits work in the retained implementation Session. The agent can request
rechecking, but only the author or an existing authorized developer can resolve a Thread.
Comments remain discussion; Threads are the actionable work. One Request revision submits all
currently actionable open Threads, with no checkbox selection or separate correction composer.
The command checks the complete versioned batch under the Change lock. Already dispatched work
and implemented Threads awaiting rechecking are not silently repeated. A failed or stopped turn
allows explicit retry; Needs changes returns a reviewed Thread to a new revision batch. Agent
tools list the admitted batch and read each discussion without expanding the initial prompt.

The Ticket owns the QA player and shared feedback. Its matching Live Preview remains a separate
Factory workspace tab, not another review sub-tab or Sandbox. Only ticket-bound Previews accept
anchored comments. A restricted App-side bridge provides selection, bounded labels and view-local
pins without screen capture permission. A lazy, pinned DOM renderer may supply a reconstructed
element image from the same human session; it is supplementary context, not exact screenshot proof.
Rendering or image-storage failure keeps the anchor saveable. Browser tab sharing was rejected
because it made ordinary commenting depend on a screen-capture permission dialog.
The bridge grants no Factory authority and does not weaken App script CSP. Preview anchors retain
their Runtime Attempt and its source basis, page and view identity, not a claim of a clean checkout.
Input, navigation and visible content changes invalidate live pin placement rather than moving old
feedback onto a possibly different state. General feedback does not need an image or element.
Video stills retain the recording's exact reviewed commit and frame timestamp.
Chapters use observed encoder positions rather than wall time, because upstream can omit
startup or unchanged frames. Missing timing is shown rather than inventing a seek position.
Video-frame page labels come from structured browser identity with query strings and fragments
omitted. They describe the last observed page, not an atomic frame/DOM identity.
The Ticket uses custom playback controls, scenario boundaries and timestamped feedback markers.
Playback continues across chapters; seeking preserves play/pause and updates the active scenario.
Discussions use one reply level, with technical source details and resolved Threads folded.

## Parallel Ticket implementation reuses the existing Delivery path

Factory implements independently commissioned Tickets in their existing Ticket Workspaces.
Epics group work; explicit Ticket prerequisites determine ordering, including across Epics.
A retained implementation order binds the commissioner, exact approved product and technical
revisions, reasoning and source basis. It waits without inference until prerequisite Delivery,
then passes ordinary admission again. Cancellation is not Delivery. Changed scope or lost
authority blocks the order rather than selecting a different specification.

The existing Delivery controller owns one durable Project slot through integration, fresh
Verification, independent Candidate Review, merge and Staging Promotion. Work awaiting a human
releases the slot so independent Tickets can proceed. An unconfirmed merge or unsuccessful
Promotion fences later Delivery. Recovery observes the same intended operations; it never
rewinds the default branch or replaces a healthy Preview merely to unblock the queue.

Integration uses the existing Ticket checkout and Sandbox. Factory records the exact current
default-branch commit before fetching and merging it. A clean merge needs no inference.
An observed conflict goes to the retained implementer, which may resolve only within the
approved intent and leaves committing to Factory. Dirty human work, exclusive writing,
Stop and uncertain outcomes retain their existing fences.

The original Change basis stays immutable. Commit intent retains the integration basis and
any exact second parent. Connector recovery recognizes only the exact Factory operation,
message and ordered parent list; observation cannot commit subsequent edits. New candidates
require fresh Verification and independent review against their recorded integration basis.
The source basis of a previously commissioned waiting order is retained with its approval;
later integration alone does not reopen unchanged Requirements or Technical Planning.

A manager with development authority may explicitly delegate ordinary approved application
changes and their tests, including features. The existing independent reviewer reports whether
Delivery needs a human; missing or uncertain classification cannot authorize automatic Delivery.
The existing application-source inventory gate also excludes operational, dependency and
migration changes and deleted regression tests. Human editing still requires human Delivery.
While a Project delegation is active, reading a settled Ticket does not automatically transfer
its writer to the viewer. Explicit editing takeover retains the existing fences and human Delivery.
Approval records the actual immutable delegation, commit, Verification and review, not a
fictional human inspection. Revocation and authority loss fence the irreversible merge.

This extends the exact-base detail of [ADR 0006](#forgejo-actions-is-the-change-ci-path-and-factory-owns-promotion)
and the monitoring-only delegation of [ADR 0008](0008-external-context-mcp-inputs-and-autofix.md#monitoring-delegates-a-bounded-fix-and-delivery-not-general-agent-authority).
It adds no general scheduler, integration Sandbox, extra reviewer role, Epic-wide mutex,
atomic multi-Ticket release or automatic Backlog selection.
