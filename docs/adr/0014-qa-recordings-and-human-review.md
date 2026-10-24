# Keep QA recordings separate from review decisions

Factory records the existing independent review browser, with scenario chapters in one video.
Protected media uses the installation's existing state volume, not another Sandbox or storage
service. A missing recording is not a failed QA result. A newer complete recording replaces
older videos, including annotated ones; annotation stills and comments remain. The remaining
video expires thirty days after the Change is delivered or cancelled.

Factory persists media intent before private, atomic, fsynced file staging. Final publication
rechecks execution authority in a separate short transaction, so state-volume I/O does not hold
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
