import { For, Show } from "solid-js";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import {
  appendEmptyDiagram,
  removeDiagramAt,
  updateDiagramAt,
  updateValidationCheck,
} from "./ticket-planning-state";

const proseFields = [
  { key: "context", label: "Current system" },
  { key: "proposedChanges", label: "Proposed changes" },
] as const;

const listFields = [
  { key: "decisions", label: "Decisions" },
  { key: "assumptions", label: "Assumptions" },
  { key: "risks", label: "Risks" },
] as const;

export function TechnicalDesignEditorForm(props: {
  formID: string;
  draft: TechnicalDesignContent;
  disabled: boolean;
  onChange: (content: TechnicalDesignContent) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      id={props.formID}
      class="ticket-design-editor"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <fieldset disabled={props.disabled}>
        <div class="ticket-design-card">
          <For each={proseFields}>
            {(field) => (
              <label>
                {field.label}
                <textarea
                  rows={6}
                  value={props.draft[field.key]}
                  onInput={(event) =>
                    props.onChange({ ...props.draft, [field.key]: event.currentTarget.value })
                  }
                />
              </label>
            )}
          </For>
        </div>
        <div class="ticket-design-card">
          <For each={listFields}>
            {(field) => (
              <label>
                {field.label} · one per line
                <textarea
                  rows={3}
                  value={props.draft[field.key].join("\n")}
                  onInput={(event) =>
                    props.onChange({
                      ...props.draft,
                      [field.key]: event.currentTarget.value
                        .split("\n")
                        .filter((line) => line.trim()),
                    })
                  }
                />
              </label>
            )}
          </For>
        </div>
        <Show when={props.draft.validation.length}>
          <div class="ticket-design-card">
            <For each={props.draft.validation.map((_, index) => index)}>
              {(index) => (
                <label>
                  Validation for criterion {props.draft.validation[index]?.criterion}
                  <textarea
                    rows={2}
                    value={props.draft.validation[index]?.check}
                    onInput={(event) =>
                      props.onChange(
                        updateValidationCheck(props.draft, index, event.currentTarget.value),
                      )
                    }
                  />
                </label>
              )}
            </For>
          </div>
        </Show>
        <For each={props.draft.diagrams.map((_, index) => index)}>
          {(index) => (
            <div class="ticket-design-card ticket-diagram-editor">
              <label>
                Diagram {index + 1} title
                <input
                  value={props.draft.diagrams[index]?.title}
                  onInput={(event) =>
                    props.onChange(
                      updateDiagramAt(props.draft, index, { title: event.currentTarget.value }),
                    )
                  }
                />
              </label>
              <label>
                Diagram explanation
                <textarea
                  rows={2}
                  value={props.draft.diagrams[index]?.description}
                  onInput={(event) =>
                    props.onChange(
                      updateDiagramAt(props.draft, index, {
                        description: event.currentTarget.value,
                      }),
                    )
                  }
                />
              </label>
              <label>
                PlantUML source
                <textarea
                  class="ticket-plantuml-editor"
                  rows={8}
                  spellcheck={false}
                  value={props.draft.diagrams[index]?.source}
                  onInput={(event) =>
                    props.onChange(
                      updateDiagramAt(props.draft, index, { source: event.currentTarget.value }),
                    )
                  }
                />
              </label>
              <button
                type="button"
                class="workspace-action"
                onClick={() => props.onChange(removeDiagramAt(props.draft, index))}
              >
                Remove diagram
              </button>
            </div>
          )}
        </For>
        <Show when={props.draft.diagrams.length < 2}>
          <button
            type="button"
            class="workspace-action"
            onClick={() => props.onChange(appendEmptyDiagram(props.draft))}
          >
            Add diagram
          </button>
        </Show>
      </fieldset>
    </form>
  );
}
