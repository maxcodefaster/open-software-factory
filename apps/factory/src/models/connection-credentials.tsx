import { For, Show } from "solid-js";
import {
  type ModelConnectionView,
  type ModelProvider,
  modelProvider,
} from "#conversation-domain/model-connection";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import {
  type Catalogue,
  type ConnectionFormState,
  connectionLabel,
  isConnectionFormLocked,
} from "./connection-state";

type ActiveFormState = Extract<ConnectionFormState, { kind: "editing" | "saving" }>;

export function ModelConnectionCredentials(props: {
  data: Catalogue;
  form: ConnectionFormState;
  disabled: boolean;
  onAdd(): void;
  onEdit(connection: ModelConnectionView): void;
  onCancel(): void;
  onProviderChange(provider: ModelProvider): void;
  onKeyChange(value: string): void;
  onEndpointChange(value: string): void;
  onSubmit(event: SubmitEvent): void;
}) {
  const locked = () => props.disabled || isConnectionFormLocked(props.form);
  const activeForm = (): ActiveFormState | undefined =>
    props.form.kind === "viewing" ? undefined : props.form;
  const savedNotice = () => props.form.kind === "viewing" && props.form.saved;
  const configuredConnections = () => props.data.connections.filter((entry) => entry.configured);

  return (
    <details
      class="model-credentials"
      open={Boolean(activeForm()) || savedNotice() || configuredConnections().length === 0}
    >
      <summary>
        Connections <span>Keys encrypted in OpenBao</span>
      </summary>
      <section class="model-credentials-body" aria-label="API connections">
        <WorkspaceActionBar
          label="Model connection actions"
          status={
            <p class="model-settings-note">Saved keys are never shown here or sent to chat.</p>
          }
        >
          <button
            type="button"
            class="workspace-action"
            data-primary="true"
            disabled={locked()}
            onClick={props.onAdd}
          >
            Add connection
          </button>
        </WorkspaceActionBar>
        <For each={configuredConnections()}>
          {(entry) => (
            <div class="model-credential-row">
              <div>
                <strong>{connectionLabel(entry)}</strong>
                <small>Encrypted in OpenBao · v{entry.version}</small>
              </div>
              <button
                type="button"
                class="quiet-button"
                disabled={locked()}
                aria-label={`Update key for ${connectionLabel(entry)}`}
                onClick={() => props.onEdit(entry)}
              >
                Update key
              </button>
            </div>
          )}
        </For>
        <Show when={activeForm()}>
          {(form) => (
            <form class="model-credential-form" onSubmit={props.onSubmit}>
              <Show when={form().target}>
                {(entry) => (
                  <p class="model-settings-note">
                    Replacing the key for {connectionLabel(entry())}.
                  </p>
                )}
              </Show>
              <div class="model-role">
                <label for="connection-provider">Provider</label>
                <select
                  id="connection-provider"
                  value={form().provider}
                  disabled={locked() || Boolean(form().target)}
                  onChange={(event) =>
                    props.onProviderChange(modelProvider.parse(event.currentTarget.value))
                  }
                >
                  <For each={props.data.providers}>
                    {(entry) => <option value={entry.provider}>{entry.label}</option>}
                  </For>
                </select>
              </div>
              <div class="model-role">
                <label for="connection-key">API key</label>
                <input
                  id="connection-key"
                  type="password"
                  autocomplete="new-password"
                  spellcheck={false}
                  value={form().apiKey}
                  disabled={locked()}
                  placeholder={form().target ? "Enter a replacement key" : "Provider API key"}
                  onInput={(event) => props.onKeyChange(event.currentTarget.value)}
                />
              </div>
              <details open={Boolean(form().target?.endpoint)}>
                <summary>Custom endpoint, including Azure</summary>
                <label for="connection-endpoint">Approved HTTPS endpoint</label>
                <input
                  id="connection-endpoint"
                  type="url"
                  value={form().endpoint}
                  disabled={locked()}
                  placeholder="Use the provider's default endpoint"
                  onInput={(event) => props.onEndpointChange(event.currentTarget.value)}
                />
              </details>
              <footer class="model-settings-actions">
                <button
                  type="button"
                  class="quiet-button"
                  disabled={locked()}
                  onClick={props.onCancel}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="primary-button"
                  disabled={props.disabled || (!form().apiKey.trim() && !form().pendingSave)}
                >
                  {form().kind === "saving"
                    ? "Saving…"
                    : form().pendingSave
                      ? "Retry same save"
                      : "Save connection"}
                </button>
              </footer>
            </form>
          )}
        </Show>
        <Show when={savedNotice()}>
          <p role="status" class="model-settings-note">
            Connection encrypted in OpenBao. Choose it above, then save &amp; check a model.
          </p>
        </Show>
      </section>
    </details>
  );
}
