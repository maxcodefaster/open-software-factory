# Working in Factory

These instructions govern development of Factory itself. Admitted Project agents follow the
separate [runtime coding policy](deploy/opencode-server/config/AGENTS.md).

## Scope and documentation

- Implement the requested scope without speculative APIs or unrelated redesigns.
- Use the root README for orientation, commands and test lanes, and `deploy/helm/factory/README.md`
  for installation and operation. Read existing code and tests before changing behavior.
- Update existing documentation owners instead of creating parallel descriptions. Keep task-only
  plans and status in the task or issue; generated evidence belongs under `.factory/test-results/`.
- Preserve unrelated work and keep reference checkouts read-only. Port only requested behavior,
  with its tests. Use `apply_patch` for manual edits.

## Autonomous execution and collaboration

- Perform authorized inspection, fixes, configured paid-model calls and owned test setup/cleanup
  without repeated confirmation. Commit and push when authorized; never force-push shared history
  or publish secrets.
- Respect explicit budgets, platform approvals and product authorization; do not invent extra
  spending approvals, limits or deadlines. Ask only for genuinely missing authority or information.
- Use one integration owner and bounded delegated tasks with separate write scopes, browser sessions
  and test resources. Coordinate heavy builds and live tests against measured host capacity.
- Owned test accounts may exercise normal authenticated approvals, never bypass product gates.

## Product boundaries

- Factory owns product authority and execution intent; pinned official Substrate owns Actor
  lifecycle and snapshots. Use native ActorTemplates, direct Project containers and the Factory
  Runtime Connector; remove nested Docker and Dev Containers rather than translating or retaining
  them. Prefer native MEMORY snapshots while supporting Substrate's cold ROOTFS fallback. Never
  promise RAM continuity from a preference or snapshot label without actual restore evidence.
- A Workspace retains its native Actor and canonical files after first Source admission.
  Anhalten/Pause is native durable Suspend; continuing uses native Resume. Do not copy or transfer
  canonical Source to another writer on normal Pause/Resume or delete the Actor as a routine Stop.
  Destructive removal is explicit and separate; Coding cancellation remains a distinct operation.
  Show retained UI/tree state promptly and honestly. Current file access may wake paused compute,
  never inference; App health must not gate Source or general UI interaction.
- This is Greenfield development. Remove obsolete execution paths instead of adding compatibility.
  No Coder/Terraform stack, generic runtime providers, private runtime fork or new lifecycle engine.
- Preserve TLS, egress, writer ownership, external-effect safeguards and real user data. Recreate
  exactly owned disposable fixtures rather than building product recovery solely to rescue them.
- Keep vendor/framework types behind Factory adapters and out of domain modules.
- Use Solid 2 and OpenCode 2 through `@opencode/client`, without OpenCode 1 compatibility.
  Zero serves planning mutations/cached reads; runtime lifecycle and decisions use authenticated commands.
- Persist intent before external creates, with deterministic identity, idempotency and recovery.
  Retain source, history, approvals, immutable runtime identities, external outcomes, Verification
  and merge results and compact Evidence. Logs, heartbeats and resource samples stay ephemeral.

## Product authority

- Contributors define requirements and research; Developers also use source, Workspaces and Coding.
  Project management controls access/defaults and is separate from Developer status. Administrators
  manage the installation.
- Requirements are manual by default; Interview and technical planning require an explicit request.
  Reading/saving never starts inference. Implement approves saved requirements. Exact-commit
  Verification and independent review precede human Delivery approval or eligible explicit delegation.
  Retain the decision authorizing each operation.
- Background work never inherits personal configuration. Edits after approval create a new revision
  without changing the pinned approved requirements.
- Explain user actions without requiring runtime knowledge. Keep Settings scopes distinct and show
  saved progress; never present unknown outcomes as success.

## When changing the interface

- Read the existing control owners and preserve the current tokens, public-domain art, Sansita/Inter,
  contrast and material rules, accessibility and OS preferences. Do not start unrelated redesigns,
  audits or polish passes.
- Use `WorkspaceActionBar` and native controls from `ui/controls.css`, loaded once by `style.css`.
  Feature CSS owns layout and genuine variations, not duplicate controls. Keep related actions
  together, overflow right, focus returning to the opener and isolated features independently styled.

## Verification

- Use `mise exec --` and README test lanes. Reuse existing tests; after fixes run affected checks first,
  then the relevant combined regression/acceptance suite on the final candidate.
- Reuse owned test installations. Fresh installs qualify installation changes and final release
  candidates; they are not required after every commit.
- Documentation uses `bun run check:docs`; Connector changes use `bun run connector:check`.
  UI changes require affected browser checks and actually inspected screenshots. Shared controls also
  require `test/browser/ui-controls.spec.ts`; inspect desktop, narrow, keyboard and touch behavior.
- Runtime changes require native proof. Fixture/controller tests are not live product acceptance.
  Keep paid calls in explicit live lanes, not default tests. Bind evidence to the tested source and
  installation; report unsupported or untested cases without counting them as passes.
- Measure before optimizing; use actual production sizes and observed workload timings/resource use.
- Live fixtures own separate resources. Cleanup requires exact ownership; never reset a retained
  installation to pass a test. Cancellation cleans up owned subprocesses/containers, and interrupted
  checks remain incomplete. Honor explicit takeover; do not leave continuations or log followers running.
- Change approach when work stalls. Finish with concrete evidence and remaining limits.
