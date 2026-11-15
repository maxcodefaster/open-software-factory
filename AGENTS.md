# Working in Factory

These instructions govern development of Factory itself. Admitted Project agents follow the
separate [runtime coding policy](deploy/opencode-server/config/AGENTS.md).

## Scope and documentation

- Implement the requested scope without speculative APIs or unrelated redesigns.
- Use the root README for orientation, commands and test lanes, and `deploy/helm/factory/README.md`
  for installation and operation. Read existing code and tests before changing behavior.
- Maintained Markdown is limited to READMEs, `AGENTS.md` and `SECURITY.md`. Task plans, design
  specifications and status belong in the task or issue; generated evidence belongs under
  `.factory/test-results/`.
- Preserve unrelated work and keep reference checkouts read-only. Port only requested behavior,
  with its tests. Use `apply_patch` for manual edits.

## Autonomous execution and collaboration

- Within an authorized implementation or acceptance task, perform routine inspection, fixes,
  configured paid-model calls and owned disposable test setup/cleanup without repeated confirmation.
  Commit and push when authorized; never force-push shared history or publish secrets.
- Respect explicit budgets, platform approvals and product authorization. Do not invent extra
  spending approvals, token limits or deadlines. Ask only when required authority, information or
  access is genuinely missing and cannot be resolved within the task.
- Use one integration owner. When delegation is authorized, give subagents bounded tasks and
  disjoint write scopes or worktrees. Never let agents mutate the same checkout files, browser
  session or test resources concurrently.
- Schedule heavy builds and live/browser tests against measured host capacity. Parallelize
  independent preparation and isolated checks; do not increase test workers blindly.
- Acceptance tests may use explicitly owned test accounts to exercise normal authenticated
  approvals. This does not authorize bypassing Factory's gates or fabricating decisions/results.

## Product boundaries

- Factory owns product authority and execution intent; pinned official Substrate owns Actor
  lifecycle and snapshots. Use its native operations, private Docker, the exact Dev Containers CLI
  and the Factory Runtime Connector. ROOTFS cold restart is the contract, not warm memory restore.
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

## Product and design brief

- Product Contributors define requirements, research Projects and give feedback. Developers also
  use source, Workspaces and Coding. Project managers control access/defaults; administrators manage
  the installation. Management permission and Developer status are separate.
- A Project combines a repository, Tickets, revisioned Knowledge, shared development and a promoted
  Preview. People approve requirements and the exact verified commit, or explicitly delegate
  eligible monitoring fixes and Delivery. Record which decision authorized the work.
- Requirements are manual by default. AI Interview and technical planning require an explicit request;
  reading/saving never starts inference. Implement approves saved requirements. Exact-commit
  Verification and independent review precede deliberate human Delivery approval.
- Background work never inherits personal configuration. Edits after approval create a new revision
  without changing the pinned approved requirements.
- Design for product contributors without requiring runtime or agent-engine knowledge. Settings show
  one scope at a time: Project, Libraries, Personal or Factory administration. Small screens use a
  grouped title menu. Show saved progress and distinguish unknown outcomes from success.

## Interface

- Read existing control owners before UI changes. Preserve one semantic token system, three bundled
  public-domain paintings with fixed contrast-tested accents, Sansita for display and Inter for
  interface/documents. Document windows use one subtly translucent blurred base; nested editors stay
  transparent, menus readable, IDE/Terminal/Preview bodies opaque. Use solid surfaces for reduced
  transparency or unsupported backdrop filters, and respect OS motion preferences.
- Keep frequent actions adjacent, overflow at the far right and focus returning to the opener.
  Use the existing `WorkspaceActionBar` for page/header actions.
- `apps/factory/src/style.css` loads `ui/controls.css` once. Use native controls with its defaults:
  `workspace-action`/`data-primary` for quiet document actions; `quiet-button`, `primary-button` and
  `danger-button` for standalone actions; `control-field`, `control-check`, `control-actions` for forms.
- Feature CSS owns layout and genuine variations, not duplicated control styles. Extend shared
  owners when needed; isolated features must load their controls without another feature mounted.

## Verification

- Use `mise exec --` and README test lanes. Reuse existing tests; after fixes run affected checks first,
  then the relevant combined regression/acceptance suite on the final candidate.
- Documentation uses `bun run check:docs`; Connector changes use `bun run connector:check`.
  UI changes require affected browser checks and actually inspected screenshots. Shared controls also
  require `test/browser/ui-controls.spec.ts`; inspect desktop, narrow, keyboard and touch behavior.
- Runtime changes require native proof. Fixture/controller tests are not live product acceptance.
  Keep paid calls in explicit live lanes, not default tests. Bind evidence to the tested source and
  installation; report unsupported or untested cases without counting them as passes.
- Measure before optimizing. Use actual production CSS/transfer sizes for frontend size claims and
  observed workload timings/resource use for runtime performance claims.
- Live fixtures own separate resources. Cleanup requires exact ownership; never reset a retained
  installation to pass a test. Cancellation cleans up owned subprocesses/containers, and interrupted
  checks remain incomplete. Honor explicit takeover; do not leave continuations or log followers running.
- Change approach when work stalls. Finish with concrete evidence and remaining limits.
