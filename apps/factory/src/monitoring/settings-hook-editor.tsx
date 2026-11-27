import { For, Show } from "solid-js";
import { Icon } from "../icon";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type { MonitoringSettingsState } from "./settings-state";

export function MonitoringHookEditor(props: {
  state: MonitoringSettingsState;
  onOpenMCP: () => void;
}) {
  const sourcesHelpId = `input-sources-${crypto.randomUUID()}`;
  const current = () => props.state.editState();
  const draft = () => current()?.draft;

  return (
    <Show when={draft()}>
      {(activeDraft) => (
        <form
          class="input-editor"
          aria-label="Input configuration"
          onSubmit={(event) => props.state.save(event)}
        >
          <header>
            <WorkspaceActionBar
              label="Input editor navigation"
              status={
                <h3
                  tabindex="-1"
                  ref={(element) => {
                    props.state.refs.editorHeading = element;
                  }}
                >
                  {activeDraft().input.expectedVersion ? "Edit input" : "New input"}
                </h3>
              }
            >
              <button
                type="button"
                class="workspace-action"
                disabled={props.state.blocked()}
                onClick={() => props.state.cancelEdit()}
              >
                Back to inputs
              </button>
            </WorkspaceActionBar>
            <p>
              Give this webhook a task. Factory will clarify incoming requests and prepare
              requirements automatically.
            </p>
          </header>
          <Show when={!props.state.draftHere()}>
            <p role="alert">
              This draft belongs to {activeDraft().projectName}. Return to that Project to save it.
            </p>
          </Show>
          <fieldset disabled={!props.state.editable()}>
            <label class="control-field">
              Name
              <input
                required
                maxlength={100}
                value={activeDraft().input.name}
                placeholder="Product feedback"
                onInput={(event) => props.state.change({ name: event.currentTarget.value })}
              />
            </label>
            <label class="control-field">
              Task
              <textarea
                required
                rows={5}
                maxlength={6000}
                value={activeDraft().input.instructions}
                onInput={(event) => props.state.change({ instructions: event.currentTarget.value })}
              />
            </label>
            <fieldset class="input-sources" aria-describedby={sourcesHelpId}>
              <legend>Connected sources</legend>
              <div class="input-chips">
                <For each={props.state.selectedIds()}>
                  {(id) => (
                    <button
                      type="button"
                      class="input-chip"
                      aria-label={`Remove ${props.state.sourceName(id)}`}
                      onClick={() => props.state.toggleSource(id)}
                    >
                      {props.state.sourceName(id)}
                      <Icon name="close" />
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="workspace-action"
                  aria-expanded={current()?.sourcePickerOpen ? "true" : "false"}
                  onClick={() => props.state.setSourcePickerOpen(!current()?.sourcePickerOpen)}
                >
                  Add source
                </button>
              </div>
              <Show when={current()?.sourcePickerOpen}>
                <fieldset class="input-source-picker" aria-label="Available shared sources">
                  <For each={props.state.available()}>
                    {(source) => (
                      <label>
                        <input
                          type="checkbox"
                          checked={props.state.selectedIds().includes(source.id)}
                          onChange={() => props.state.toggleSource(source.id)}
                        />
                        <span>
                          {props.state.sourceName(source.id)}
                          <small>
                            {source.scope === "system" ? "Factory" : "Project"} connection
                          </small>
                        </span>
                      </label>
                    )}
                  </For>
                  <Show when={!props.state.available().length}>
                    <p>No connected shared sources yet.</p>
                  </Show>
                  <button type="button" class="workspace-action" onClick={props.onOpenMCP}>
                    Connect a service
                  </button>
                </fieldset>
              </Show>
              <p class="input-help" id={sourcesHelpId}>
                {props.state.selectedIds().length
                  ? "Selected sources must be consulted before a Ticket is prepared. They remain available during Build."
                  : props.state.inherited().length
                    ? `Following shared Project sources: ${props.state
                        .inherited()
                        .map((source) => props.state.sourceName(source.id))
                        .join(", ")}.`
                    : "Following shared Project defaults. No external sources are enabled; the payload and Project knowledge supply context."}
              </p>
              <Show
                when={props.state
                  .selectedIds()
                  .some((id) => !props.state.available().some((source) => source.id === id))}
              >
                <p class="input-error">
                  A selected source is unavailable. Reconnect it or remove its chip before saving.
                </p>
              </Show>
            </fieldset>
            <details class="input-advanced" open={props.state.automatic()}>
              <summary>Automatic implementation</summary>
              <p>
                By default, prepared Tickets wait for human approval. You can explicitly delegate
                bounded application fixes and Delivery.
              </p>
              <label class="control-check">
                <input
                  type="checkbox"
                  checked={props.state.automatic()}
                  disabled={!props.state.view()?.canDelegate && !props.state.automatic()}
                  onChange={(event) =>
                    props.state.change({
                      delegation: event.currentTarget.checked
                        ? "application-fix-and-delivery"
                        : "prepare-ticket",
                    })
                  }
                />
                <span>Enable application Autofix and Delivery</span>
              </label>
              <Show when={props.state.automatic()}>
                <p>
                  Only source-grounded application defects are eligible. Verification and
                  independent review remain required. Delivery merges into the configured default
                  branch; it does not deploy to production.
                </p>
                <Show when={!props.state.selected().length}>
                  <p class="input-error">Connect a read-only source before enabling Autofix.</p>
                </Show>
                <label class="control-check">
                  <input
                    type="checkbox"
                    checked={current()?.confirmedBasis === props.state.basis()}
                    onChange={(event) =>
                      props.state.setConfirmedBasis(
                        event.currentTarget.checked ? props.state.basis() : "",
                      )
                    }
                  />
                  <span>
                    I authorize Factory to implement eligible fixes and deliver them automatically
                    after checks and independent review.
                  </span>
                </label>
              </Show>
              <Show when={!props.state.view()?.canDelegate}>
                <p>Autofix requires Project management and Developer access.</p>
              </Show>
            </details>
          </fieldset>
          <footer class="input-form-actions">
            <button
              type="button"
              class="workspace-action"
              disabled={props.state.blocked()}
              onClick={() => props.state.cancelEdit()}
            >
              Cancel
            </button>
            <button type="submit" class="primary-button" disabled={!props.state.canSave()}>
              {activeDraft().input.expectedVersion ? "Save & enable" : "Create input"}
            </button>
          </footer>
        </form>
      )}
    </Show>
  );
}
