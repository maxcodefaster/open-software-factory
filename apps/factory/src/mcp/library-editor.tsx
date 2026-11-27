import { For, Show } from "solid-js";
import type { MCPDefinition } from "#conversation-domain/mcp-library";
import { Icon } from "../icon";
import { type MCPDraft, type MCPScope, roleLabel } from "./library-shared";

export function MCPLibraryEditor(props: {
  open: boolean;
  draft: MCPDraft | undefined;
  monitoringSetup: boolean;
  draftForMonitoring: boolean;
  projectId: string | undefined;
  canManageProject: boolean;
  canManageSystem: boolean;
  busy: boolean;
  setupBlocked: boolean;
  onBack: () => void;
  onHeadingRef: (element: HTMLHeadingElement) => void;
  onUpdateContent: (value: Partial<MCPDefinition>) => void;
  onChangeScope: (scope: MCPScope) => void;
  onSubmit: (event: SubmitEvent) => void;
  onDiscard: () => void;
}) {
  return (
    <div class="skill-editor-screen" hidden={!props.open}>
      <Show when={props.draft}>
        {(current) => (
          <form class="skill-editor mcp-editor" onSubmit={(event) => void props.onSubmit(event)}>
            <button type="button" class="quiet-button skill-back" onClick={props.onBack}>
              <Icon name="chevron" />
              Back to library
            </button>
            <h3 tabindex="-1" ref={props.onHeadingRef}>
              {props.monitoringSetup && props.draftForMonitoring
                ? `Set up ${current().content.name || "a source"}`
                : current().entry
                  ? "Edit MCP definition"
                  : "Add MCP definition"}
            </h3>
            <p>
              {props.monitoringSetup && props.draftForMonitoring
                ? "Save this Project connection, then sign in and review its read-only access."
                : "Start with a remote HTTPS endpoint. Saving a definition does not connect or enable it."}
            </p>
            <Show when={props.monitoringSetup && !props.draftForMonitoring}>
              <p role="alert">
                You already have a draft outside this Project setup. It has not been changed.
                Discard it to start this connection, or return to the MCP library to finish it.
              </p>
            </Show>
            <Show when={current().scope === "project" && current().projectId !== props.projectId}>
              <p>
                This draft still belongs to {current().projectName ?? "its original Project"}.
                Switching Projects does not retarget it.
              </p>
            </Show>
            <label>
              Name
              <input
                required
                maxlength="100"
                value={current().content.name}
                onInput={(event) => props.onUpdateContent({ name: event.currentTarget.value })}
              />
            </label>
            <details
              class="mcp-definition-settings"
              open={!props.monitoringSetup || current().content.provider === "custom"}
            >
              <summary hidden={!props.monitoringSetup}>Connection settings</summary>
              <label>
                When to use
                <textarea
                  rows="3"
                  maxlength="2000"
                  value={current().content.description}
                  onInput={(event) =>
                    props.onUpdateContent({ description: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                MCP endpoint
                <input
                  required
                  type="url"
                  placeholder="https://example.com/mcp"
                  value={current().content.endpoint}
                  onInput={(event) =>
                    props.onUpdateContent({ endpoint: event.currentTarget.value })
                  }
                />
              </label>
              <p class="skill-help">
                Public HTTPS only. Never put credentials in the endpoint URL.
              </p>
              <label>
                Authentication
                <select
                  value={current().content.authentication}
                  onChange={(event) =>
                    props.onUpdateContent({
                      authentication: event.currentTarget.value as MCPDefinition["authentication"],
                    })
                  }
                >
                  <option value="oauth">Connect with OAuth</option>
                  <option value="bearer">Read-only access token</option>
                  <option value="none">No authentication</option>
                </select>
              </label>
            </details>
            <Show when={!props.monitoringSetup || current().entry}>
              <fieldset>
                <legend>Available for</legend>
                <For each={["planning", "build"] as const}>
                  {(role) => (
                    <label class="mcp-checkbox">
                      <input
                        type="checkbox"
                        checked={current().content.roles.includes(role)}
                        onChange={(event) =>
                          props.onUpdateContent({
                            roles: event.currentTarget.checked
                              ? [...current().content.roles, role]
                              : current().content.roles.filter((item) => item !== role),
                          })
                        }
                      />
                      {roleLabel(role)}
                    </label>
                  )}
                </For>
              </fieldset>
            </Show>
            <Show when={!props.monitoringSetup || !props.draftForMonitoring}>
              <label>
                Save in
                <select
                  value={current().scope}
                  disabled={Boolean(current().entry) || props.monitoringSetup}
                  onChange={(event) => props.onChangeScope(event.currentTarget.value as MCPScope)}
                >
                  <option value="personal">Personal library</option>
                  <Show when={props.canManageProject && current().projectId}>
                    <option value="project">{current().projectName ?? "Project"} library</option>
                  </Show>
                  <Show when={props.canManageSystem}>
                    <option value="system">Factory library</option>
                  </Show>
                </select>
              </label>
            </Show>
            <Show when={props.monitoringSetup && props.draftForMonitoring}>
              <p>
                Shared with {current().projectName ?? "this Project"} for clarification and
                implementation. Other work stays unchanged.
              </p>
            </Show>
            <div class="mcp-actions">
              <button
                type="submit"
                class="primary-button"
                disabled={
                  props.busy ||
                  props.setupBlocked ||
                  (props.monitoringSetup && !props.draftForMonitoring)
                }
              >
                {props.monitoringSetup && props.draftForMonitoring
                  ? "Save connection"
                  : "Save definition"}
              </button>
              <button
                type="button"
                class="quiet-button"
                disabled={props.busy}
                onClick={props.onDiscard}
              >
                Discard draft
              </button>
            </div>
          </form>
        )}
      </Show>
    </div>
  );
}
