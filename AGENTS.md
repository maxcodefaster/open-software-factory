# Working in Factory

## Scope and documentation

- Implement the requested task. Keep temporary plans/status in the task or issue; do not activate
  later work, prepare speculative APIs or reopen completed programmes.
- Use the root README for commands/layout, `docs/README.md` for domain and service boundaries,
  and the relevant `docs/adr` decision when changing that boundary. Read what the task needs.
- Maintained Markdown is limited to `README.md`, `AGENTS.md`, numbered ADRs in `docs/adr`
  and the UI product brief at `apps/factory/PRODUCT.md`. The product brief summarizes durable
  product facts and links to the existing documentation; task plans and design specifications
  still belong in the task or issue.
  Put generated evidence under `.factory/test-results/`; do not add checkpoint or audit reports.
- Preserve changes made by others and use `apply_patch` for manual edits.
- Keep `/Users/max/Code/software-factory` read-only. Port isolated behavior only within the requested
  scope and bring its tests with it.

## Product boundaries

- Factory is the sole product control plane. No Coder stack, Terraform, generic runtime providers,
  compatibility layers or old migrations.
- Every new Sandbox uses an admitted, pinned Factorybox worker with Sysbox and CRIU, a private
  Docker daemon, the exact Dev Containers CLI and the Factory Runtime Connector. Keep each
  worker in one trust domain. Run upstream components exactly pinned; ordered runtime patches
  and native qualification belong to the standalone Factorybox repository.
- Keep vendor/framework types behind Factory adapters and out of domain modules.
- Use Solid 2 APIs and OpenCode 2 through `@opencode/client`. No OpenCode 1 compatibility SDK.
  Zero is for planning mutations/cached reads; runtime lifecycle and decisions use authenticated commands.
- Persist intent before external creates, with deterministic identity, idempotency and recovery.
  Preserve retained source, history, approvals and immutable runtime identities.
- Persist product state, external intent/outcome, human decisions, Verification/merge results and
  compact Evidence. Logs, heartbeats and resource samples stay ephemeral.

## Interface

- Before UI changes, read `apps/factory/PRODUCT.md` and the existing control owners. Preserve
  the visual system in ADR 0005 rather than inventing a new skin for each feature.
- `apps/factory/src/style.css` loads `ui/controls.css` once. Use native buttons, selects,
  inputs and textareas with those shared defaults. `workspace-action` and `data-primary`
  own quiet document actions; `quiet-button`, `primary-button` and `danger-button` cover
  standalone actions. `control-field`, `control-check` and `control-actions` own form groups.
  Keep page/header actions in the existing `WorkspaceActionBar`.
- Feature CSS owns layout and genuine domain-specific variations, not copies of control
  typography, borders, radii, focus or disabled styles. Extend the shared owner when needed.
  An isolated feature must not depend on another feature being mounted to load its controls.
- Check shared changes with `test/browser/ui-controls.spec.ts` and affected feature journeys.
  Inspect desktop, narrow and touch states. Compare actual production CSS and compressed
  transfer sizes before claiming a performance improvement; a preprocessor is not evidence.

## Verification

- Use `mise exec --` for pinned tools. Run the relevant commands from the README and fix regressions
  caused by the change. Rerun checks when relevant changes or uncertain results warrant it.
- Use configured paid models and live proofs when they help implement or verify the requested work.
  Do not skip necessary verification solely because it incurs model usage or ask for a separate
  budget discussion for routine calls. The requested implementation or verification authorizes
  routine model calls; do not invent a second approval step. Keep paid calls in explicit live lanes,
  not default tests.
- Honor explicit user spending/time limits and required approvals. Do not invent additional token,
  time or spending caps, maintain countdowns or report usage unless requested or required by tooling.
  This guidance does not change Factory's product-level execution limits or admission/retry rules.
- Documentation changes use `bun run check:docs`; Connector changes use `bun run connector:check`.
  UI changes need affected browser checks and inspected screenshots; runtime changes need native proof.
- Live fixtures must own separate resources. Cleanup requires exact ownership and preserves unrelated
  data. Never reset the retained installation to make a test pass.
- Change approach when work stalls instead of repeating unproductive steps. Finish with concrete
  evidence and any remaining limits.
