import { Show } from "solid-js";
import type { EnvImportState } from "./settings-state";

type OpenImportState = Extract<EnvImportState, { kind: "open" }>;

export function EnvironmentImportPanel(props: {
  id: string;
  state: OpenImportState;
  canEditDraft: boolean;
  onTextChange(text: string): void;
  onShownChange(shown: boolean): void;
  onPreview(): void;
  onApply(entries: Array<{ name: string; value: string }>): void;
  onClose(): void;
}) {
  const previewEntries = () =>
    props.state.result.kind === "preview" ? props.state.result.entries : [];
  const errorMessage = () =>
    props.state.result.kind === "error" ? props.state.result.message : "";
  return (
    <fieldset
      id={props.id}
      class="environment-import"
      aria-label="Import environment variables"
      disabled={!props.canEditDraft}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !props.canEditDraft) return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <h3>Import .env</h3>
      <label>
        Paste .env contents
        <textarea
          ref={(element) =>
            queueMicrotask(() => {
              if (element.isConnected) element.focus();
            })
          }
          aria-label="Paste environment variables"
          rows="4"
          class="environment-protected-value"
          data-masked={props.state.shown ? "false" : "true"}
          autocomplete="off"
          spellcheck={false}
          value={props.state.text}
          onInput={(event) => props.onTextChange(event.currentTarget.value)}
        />
      </label>
      <label class="environment-check">
        <input
          type="checkbox"
          checked={props.state.shown}
          onChange={(event) => props.onShownChange(event.currentTarget.checked)}
        />
        Show pasted text
      </label>
      <Show when={previewEntries().length > 0}>
        <p class="model-settings-note">
          {previewEntries()
            .map((item) => item.name)
            .join(", ")}{" "}
          · values hidden
        </p>
      </Show>
      <Show when={errorMessage()}>
        <p role="alert" class="model-settings-error">
          {errorMessage()}
        </p>
      </Show>
      <div class="environment-inline-actions">
        <button
          type="button"
          class="quiet-button"
          disabled={!props.state.text.trim()}
          onClick={props.onPreview}
        >
          Preview import
        </button>
        <Show when={previewEntries().length > 0}>
          <button
            type="button"
            class="quiet-button"
            onClick={() => props.onApply(previewEntries())}
          >
            Apply to draft
          </button>
        </Show>
        <button type="button" class="quiet-button" onClick={props.onClose}>
          Cancel import
        </button>
      </div>
    </fieldset>
  );
}
