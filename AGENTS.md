# Working in Factory

## Scope and documentation

- Implement the requested task. Keep temporary plans/status in the task or issue; do not activate
  later work, prepare speculative APIs or reopen completed programmes.
- Use the root README for commands/layout, `docs/README.md` for domain and service boundaries,
  and the relevant `docs/adr` decision when changing that boundary. Read what the task needs.
- Maintained Markdown is limited to `README.md`, `AGENTS.md` and numbered ADRs in `docs/adr`.
  Put generated evidence under `.factory/test-results/`; do not add checkpoint or audit reports.
- Use one implementation writer. Preserve changes made by others and use `apply_patch` for manual edits.
- Keep `/Users/max/Code/software-factory` read-only. Port isolated behavior only within the requested
  scope and bring its tests with it.

## Product boundaries

- Factory is the sole product control plane. No Coder stack, Terraform, generic runtime providers,
  compatibility layers or old migrations.
- Every Sandbox uses pinned Envbox, Sysbox, a private Docker daemon, the exact Dev Containers CLI
  and the Factory Runtime Connector. Run upstream components unchanged and exactly pinned.
- Keep vendor/framework types behind Factory adapters and out of domain modules.
- Use Solid 2 APIs and OpenCode 2 through `@opencode/client`. No OpenCode 1 compatibility SDK.
  Zero is for planning mutations/cached reads; runtime lifecycle and decisions use authenticated commands.
- Persist intent before external creates, with deterministic identity, idempotency and recovery.
  Preserve retained source, history, approvals and immutable runtime identities.
- Persist product state, external intent/outcome, human decisions, Verification/merge results and
  compact Evidence. Logs, heartbeats and resource samples stay ephemeral.

## Verification

- Use `mise exec --` for pinned tools. Run the relevant commands from the README and fix regressions
  caused by the change. Rerun checks when relevant changes or uncertain results warrant it.
- Use configured paid models and live proofs when they help implement or verify the requested work.
  Do not skip necessary verification solely because it incurs model usage or ask for a separate
  budget discussion for routine calls. Keep paid calls in explicit live lanes, not default tests.
- Honor explicit user spending/time limits and required approvals. Do not invent additional token,
  time or spending caps, maintain countdowns or report usage unless requested or required by tooling.
  This guidance does not change Factory's product-level execution limits or admission/retry rules.
- Documentation changes use `bun run check:docs`; Connector changes use `bun run connector:check`.
  UI changes need affected browser checks and inspected screenshots; runtime changes need native proof.
- Live fixtures must own separate resources. Cleanup requires exact ownership and preserves unrelated
  data. Never reset the retained installation to make a test pass.
- Change approach when work stalls instead of repeating unproductive steps. Finish with concrete
  evidence and any remaining limits.
