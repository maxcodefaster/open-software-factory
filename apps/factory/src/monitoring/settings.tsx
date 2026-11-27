import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { DeliverySettings } from "../delivery/settings";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import { MonitoringHookEditor } from "./settings-hook-editor";
import { MonitoringHookList } from "./settings-hook-list";
import { MonitoringSecretView } from "./settings-secret-view";
import { createMonitoringSettingsState } from "./settings-state";
import "./settings.css";

export function MonitoringSettings(props: {
  active: boolean;
  project: { id: string; name: string } | undefined;
  onOpenMCP(): void;
  navigation?: JSX.Element;
  sourceRequest?: { id: string; projectId: string; connectionId: string } | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  const state = createMonitoringSettingsState(props);
  const activeSecret = () => {
    const current = state.screen();
    return current.kind === "secret" && props.active && current.projectId === props.project?.id
      ? current
      : undefined;
  };

  return (
    <section
      class="input-settings model-settings-body"
      aria-label="Project inputs"
      aria-busy={state.loading() || state.running() ? "true" : "false"}
    >
      <Show when={state.readError()}>
        <div class="input-message input-error" role="alert">
          <p>{state.readError()}</p>
          <button
            type="button"
            class="workspace-action"
            disabled={state.blocked()}
            onClick={() => void state.load()}
          >
            Retry loading inputs
          </button>
        </div>
      </Show>
      <Show when={state.error()}>
        <p class="input-message input-error" role="alert">
          {state.error()}
        </p>
      </Show>
      <Show when={state.running() || state.notice()}>
        <p class="input-message input-help" role="status">
          {state.running() ? "Saving Input…" : state.notice()}
        </p>
      </Show>
      <Show when={!state.running() && state.retryable()}>
        {(operation) => (
          <div class="input-confirmation">
            <p>
              The result is unconfirmed. Retry the same command in {operation().projectName}; do not
              create a replacement.
            </p>
            <button
              type="button"
              class="workspace-action"
              disabled={operation().projectId !== props.project?.id}
              onClick={() => void state.execute(operation())}
            >
              Retry same command
            </button>
          </div>
        )}
      </Show>
      <Show when={state.loading() && !state.view()}>
        <p role="status">Loading inputs…</p>
      </Show>
      <Show when={Boolean(activeSecret())}>
        <MonitoringSecretView secret={activeSecret} state={state} />
      </Show>
      <Show when={state.screen().kind === "edit"}>
        <MonitoringHookEditor state={state} onOpenMCP={props.onOpenMCP} />
      </Show>
      <Show when={state.screen().kind === "list"}>
        <Show when={state.view()}>
          {(current) => (
            <header class="input-overview-heading workspace-heading">
              <div class="workspace-heading-title">
                <h2 class="input-wide-title">Inputs</h2>
                <div class="workspace-action-leading">{props.navigation}</div>
              </div>
              <WorkspaceActionBar label="Input actions">
                <Show when={current().canManage}>
                  <button
                    ref={(element) => {
                      state.refs.addButton = element;
                    }}
                    type="button"
                    class="workspace-action"
                    data-primary="true"
                    disabled={state.blocked()}
                    onClick={() => state.edit()}
                  >
                    Add input
                  </button>
                </Show>
              </WorkspaceActionBar>
              <div class="workspace-heading-meta">
                <p>
                  Turn external requests into grounded Tickets. Sources and tasks stay scoped to
                  this Project.
                </p>
              </div>
            </header>
          )}
        </Show>
        <Show when={state.view()}>
          {(current) => (
            <MonitoringHookList
              view={current}
              projectId={props.project?.id}
              state={state}
              onOpenTicket={props.onOpenTicket}
            />
          )}
        </Show>
        <Show when={props.project?.id}>
          {(projectID) => <DeliverySettings projectID={projectID()} active={props.active} />}
        </Show>
      </Show>
    </section>
  );
}
