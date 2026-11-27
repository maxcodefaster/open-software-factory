import { createEffect, createSignal, For, Show } from "solid-js";
import type { EnvironmentSettingsView, ProjectEnvironment } from "#project-domain/environment";
import { Icon } from "../icon";
import {
  type ActionMenuState,
  type EnvironmentVariable,
  grantLabels,
  grants,
  isVariableChanged,
  type VariableEditorState,
} from "./settings-state";

function ProtectedValueField(props: {
  label: string;
  name: string;
  placeholder: string;
  value: string;
  onInput(value: string): void;
}) {
  const [shown, setShown] = createSignal(false);
  return (
    <div class="environment-value-field">
      <label>
        {props.label}
        <textarea
          rows="2"
          class="environment-protected-value"
          data-masked={shown() ? "false" : "true"}
          aria-label={`Value for ${props.name}`}
          autocomplete="off"
          spellcheck={false}
          placeholder={props.placeholder}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      </label>
      <label class="environment-check">
        <input
          type="checkbox"
          checked={shown()}
          onChange={(event) => setShown(event.currentTarget.checked)}
        />
        Show what I type
      </label>
    </div>
  );
}

function EnvironmentVariableRow(props: {
  variable: EnvironmentVariable;
  index: number;
  changed: boolean;
  saved: boolean;
  editing: boolean;
  menuExpanded: boolean;
  canManage: boolean;
  canEditDraft: boolean;
  variableAccessID: string;
  onOpenMenu(opener: HTMLButtonElement): void;
  onToggleEdit(): void;
  onChange(patch: Partial<EnvironmentVariable>): void;
  onDoneEditing(): void;
}) {
  return (
    <article
      class="environment-variable"
      aria-label={props.variable.name || "New variable"}
      data-editing={props.editing ? "true" : undefined}
    >
      <div class="environment-variable-summary">
        <div class="environment-variable-identity">
          <Show
            when={props.canManage}
            fallback={
              <span class="environment-variable-name">{props.variable.name || "New variable"}</span>
            }
          >
            <button
              type="button"
              class="environment-variable-name"
              aria-expanded={props.editing ? "true" : "false"}
              disabled={!props.canEditDraft}
              onClick={props.onToggleEdit}
            >
              {props.variable.name || "New variable"}
            </button>
          </Show>
          <Show when={props.changed}>
            <span class="environment-variable-state">Unsaved</span>
          </Show>
        </div>
        <span class="environment-masked-value" role="img" aria-label="Value hidden">
          <span aria-hidden="true">••••••••••••</span>
        </span>
        <span class="environment-variable-uses">
          {grants
            .filter((grant) => props.variable[grant])
            .map((grant) => grantLabels[grant])
            .join(" · ") || "No access"}
        </span>
        <Show when={props.canManage}>
          <button
            type="button"
            class="bare-icon environment-actions-trigger"
            aria-label={`Actions for ${props.variable.name || "new variable"}`}
            aria-haspopup="menu"
            aria-expanded={props.menuExpanded ? "true" : "false"}
            disabled={!props.canEditDraft}
            onClick={(event) => props.onOpenMenu(event.currentTarget)}
          >
            <Icon name="more" />
          </button>
        </Show>
      </div>
      <Show when={props.editing}>
        <fieldset
          class="environment-variable-editor"
          disabled={!props.canEditDraft}
          aria-label="Edit variable"
        >
          <label>
            Name
            <input
              ref={(element) =>
                queueMicrotask(() => {
                  if (element.isConnected) element.focus();
                })
              }
              aria-label={`Variable ${props.index + 1} name`}
              autocomplete="off"
              spellcheck={false}
              value={props.variable.name}
              onInput={(event) => props.onChange({ name: event.currentTarget.value })}
            />
          </label>
          <ProtectedValueField
            label={props.saved ? "Replace value" : "Value"}
            name={props.variable.name || "new variable"}
            placeholder={props.saved ? "Leave unchanged or enter a replacement" : "Enter value"}
            value={props.variable.value ?? ""}
            onInput={(value) => props.onChange({ value })}
          />
          <fieldset class="environment-grants" aria-describedby={props.variableAccessID}>
            <legend>Available to</legend>
            <For each={grants}>
              {(grant) => (
                <label>
                  <input
                    type="checkbox"
                    checked={props.variable[grant]}
                    onChange={(event) => props.onChange({ [grant]: event.currentTarget.checked })}
                  />
                  {grantLabels[grant]}
                </label>
              )}
            </For>
          </fieldset>
          <p id={props.variableAccessID} class="environment-access-note model-settings-note">
            Runtime values can be read by your application and its coding agent. Verification access
            is opt-in. For package authentication, use Runtime variables with your repository's
            configuration.
          </p>
          <button
            type="button"
            class="quiet-button environment-editor-done"
            onClick={props.onDoneEditing}
          >
            Done editing
          </button>
        </fieldset>
      </Show>
    </article>
  );
}

export function EnvironmentVariableList(props: {
  environment: ProjectEnvironment;
  current: EnvironmentSettingsView;
  totalCount: number;
  visibleVariables: Array<{ variable: EnvironmentVariable; index: number }>;
  editor: VariableEditorState;
  menuState: ActionMenuState;
  canEditDraft: boolean;
  variableAccessID: string;
  onOpenMenu(index: number, button: HTMLButtonElement): void;
  onChangeVariable(index: number, patch: Partial<EnvironmentVariable>): void;
  onDoneEditing(): void;
  onClearFilters(): void;
}) {
  const [inlineEditing, setInlineEditing] = createSignal<number | undefined>();
  createEffect(
    () => [props.current, props.totalCount, props.editor.kind] as const,
    () => setInlineEditing(undefined),
  );
  function toggleEdit(index: number) {
    if (!props.canEditDraft) return;
    if (props.editor.kind === "editing" && props.editor.index === index) {
      props.onDoneEditing();
      return;
    }
    if (inlineEditing() === index) {
      setInlineEditing(undefined);
      return;
    }
    if (props.editor.kind === "editing") props.onDoneEditing();
    setInlineEditing(index);
  }
  return (
    <fieldset class="environment-variable-list" aria-label="Variables">
      <For each={props.visibleVariables} keyed={(entry) => entry.index}>
        {(entry) => (
          <EnvironmentVariableRow
            variable={entry().variable}
            index={entry().index}
            changed={isVariableChanged(entry().variable, props.current)}
            saved={props.current.variables.some((item) => item.name === entry().variable.name)}
            editing={
              (props.editor.kind === "editing" && props.editor.index === entry().index) ||
              inlineEditing() === entry().index
            }
            menuExpanded={props.menuState.open && props.menuState.index === entry().index}
            canManage={props.current.canManage}
            canEditDraft={props.canEditDraft}
            variableAccessID={props.variableAccessID}
            onOpenMenu={(button) => props.onOpenMenu(entry().index, button)}
            onToggleEdit={() => toggleEdit(entry().index)}
            onChange={(patch) => props.onChangeVariable(entry().index, patch)}
            onDoneEditing={() => {
              setInlineEditing(undefined);
              props.onDoneEditing();
            }}
          />
        )}
      </For>
      <Show when={props.totalCount === 0}>
        <div class="environment-empty">
          <p>
            No variables in {props.environment === "development" ? "Development" : "Main-Preview"}.
          </p>
          <p class="model-settings-note">
            {props.current.canManage
              ? "Add a variable or paste a .env file to get started."
              : "Project managers can add variables here."}
          </p>
        </div>
      </Show>
      <Show when={props.totalCount > 0 && props.visibleVariables.length === 0}>
        <div class="environment-empty">
          <p>No variables match these filters.</p>
          <button type="button" class="quiet-button" onClick={props.onClearFilters}>
            Clear filters
          </button>
        </div>
      </Show>
    </fieldset>
  );
}
