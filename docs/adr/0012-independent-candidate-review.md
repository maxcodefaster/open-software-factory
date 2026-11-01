# Independent review uses a fresh, read-only OpenCode Session

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
patch bodies are withheld. Action times exclude work after the candidate receipt, with unknown
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
