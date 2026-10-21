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

The resumable implementation Session remains separate. Only reproducible blocking defects within
approved scope enter automatic correction. A changed commit requires new CI and review. An
explicit retry can create another fresh attempt for an incomplete review without rewriting the
old attempt. After a settled bootstrap interruption, that retry may prepare fresh compute for the
same verified candidate. Unresolved input and incomplete cleanup remain fenced; retry never
restarts implementation. Delivery still needs an immutable human approval naming the exact commit,
Verification and settled passing review. Previously recorded Delivery Approvals remain intact.
