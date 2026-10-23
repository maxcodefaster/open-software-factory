import { createEffect, createSignal, For, Show } from "solid-js";
import { epicFamilyIds } from "../../../packages/ticket-domain/src/epic";
import type { Epic } from "./api-contracts";
import { WindowHeading } from "./workspace-chrome";

export type EpicEdit = { title: string; description: string; parentId: string | null };

export function EpicEditor(props: {
  current?: Epic | undefined;
  epics: readonly Epic[];
  pending: boolean;
  onClose(): void;
  onSave(input: EpicEdit): Promise<void>;
}) {
  let dialog: HTMLDialogElement | undefined;
  const [error, setError] = createSignal("");
  const excluded = () =>
    props.current ? epicFamilyIds(props.epics, props.current.id) : new Set<string>();
  createEffect(
    () => true,
    () => {
      dialog?.showModal();
      return () => dialog?.close();
    },
  );
  return (
    <dialog
      class="ticket-create-dialog epic-editor"
      ref={dialog}
      aria-labelledby="epic-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <WindowHeading
        eyebrow="Planning"
        title={props.current ? "Edit Epic" : "New Epic"}
        titleID="epic-editor-title"
        onClose={props.onClose}
      />
      <form
        class="project-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setError("");
          void props
            .onSave({
              title: String(data.get("title") ?? ""),
              description: String(data.get("description") ?? ""),
              parentId: String(data.get("parentId") ?? "") || null,
            })
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : "Epic could not be saved"),
            );
        }}
      >
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <label>
          Epic title
          <input
            name="title"
            value={props.current?.title ?? ""}
            maxlength="200"
            autofocus
            required
          />
        </label>
        <label>
          Description
          <textarea
            name="description"
            value={props.current?.description ?? ""}
            maxlength="10000"
            rows="3"
          />
        </label>
        <label>
          Parent Epic
          <select name="parentId" value={props.current?.parentId ?? ""}>
            <option value="">No parent</option>
            <For each={props.epics.filter((epic) => !excluded().has(epic.id))}>
              {(epic) => <option value={epic.id}>{epic.title}</option>}
            </For>
          </select>
        </label>
        <button type="submit" class="primary-button" disabled={props.pending}>
          Save Epic
        </button>
      </form>
    </dialog>
  );
}
