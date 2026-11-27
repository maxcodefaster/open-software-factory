import { Show } from "solid-js";
import { Icon } from "../icon";
import type { MCPMonitoringSetup } from "./library-shared";

export function MCPMonitoringSetupBanner(props: {
  setup: MCPMonitoringSetup | undefined;
  setupHere: boolean;
  hasView: boolean;
  canManageProject: boolean;
  busy: boolean;
  onHeadingRef: (element: HTMLHeadingElement) => void;
  onReturn: () => void;
}) {
  return (
    <Show when={props.setup}>
      {(setup) => (
        <section class="mcp-monitoring-setup" aria-label="Input connection setup">
          <button
            type="button"
            class="quiet-button skill-back"
            disabled={props.busy}
            onClick={props.onReturn}
          >
            <Icon name="chevron" />
            Back to inputs
          </button>
          <h2 tabindex="-1" ref={props.onHeadingRef}>
            Connect a source for {setup().projectName}
          </h2>
          <p>
            Connect a read-only source for this Input. Its task and webhook stay in Inputs.
            Connecting alone starts no work.
          </p>
          <Show when={!props.setupHere}>
            <p role="alert">
              This setup belongs to {setup().projectName}. Return to that Project to continue, or go
              back to Inputs for the current Project. Your draft has not moved.
            </p>
          </Show>
          <Show when={props.setupHere && props.hasView && !props.canManageProject}>
            <p role="alert">Project management access is required to connect a shared source.</p>
          </Show>
        </section>
      )}
    </Show>
  );
}

export function MCPLibraryFeedback(props: {
  readError: string;
  error: string;
  statusText: string;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      <Show when={props.readError}>
        <div class="skill-library-error" role="alert">
          <span>{props.readError}</span>
          <button
            type="button"
            class="quiet-button"
            disabled={props.disabled}
            onClick={props.onRetry}
          >
            Retry loading
          </button>
        </div>
      </Show>
      <Show when={props.error}>
        <p class="skill-library-error" role="alert">
          {props.error}
        </p>
      </Show>
      <p class="skill-library-status" role="status">
        {props.statusText}
      </p>
    </>
  );
}
