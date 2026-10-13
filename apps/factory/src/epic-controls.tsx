import { createEffect, createSignal, For, Show } from "solid-js";
import { epicFamilyIds } from "../../../packages/ticket-domain/src/epic";
import type { Epic, Ticket } from "./api-contracts";
import { WindowHeading } from "./workspace-chrome";

export type EpicEdit = { title: string; description: string; parentId: string | null };

export function EpicControls(props: {
  projectId: string;
  projectName: string;
  epics: readonly Epic[];
  tickets: readonly Ticket[];
  selectedId: string;
  pending: boolean;
  onSelect(id: string): void;
  onSave(input: EpicEdit, current?: Epic): Promise<boolean>;
}) {
  const [editor, setEditor] = createSignal<{ current?: Epic }>();
  const selected = () => props.epics.find((epic) => epic.id === props.selectedId);
  const stats = () => {
    const family = epicFamilyIds(props.epics, props.selectedId);
    const tickets = props.tickets.filter((ticket) => ticket.epicId && family.has(ticket.epicId));
    return {
      total: tickets.length,
      done: tickets.filter((ticket) => ticket.state === "done").length,
      cancelled: tickets.filter((ticket) => ticket.state === "cancelled").length,
    };
  };
  createEffect(
    () => props.projectId,
    () => setEditor(undefined),
  );
  return (
    <div class="epic-controls">
      <label class="epic-filter">
        <span class="sr-only">Filter by Epic</span>
        <select
          value={props.selectedId}
          onChange={(event) => props.onSelect(event.currentTarget.value)}
        >
          <option value="">{props.projectName} · All tickets</option>
          <option value="ungrouped">No Epic</option>
          <For each={props.epics}>
            {(epic) => (
              <option value={epic.id}>
                {props.epics.find((parent) => parent.id === epic.parentId)?.title
                  ? `${props.epics.find((parent) => parent.id === epic.parentId)?.title} / `
                  : ""}
                {epic.title}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={selected()}>
        {(epic) => (
          <>
            <span class="epic-progress">
              {stats().done}/{stats().total} done
              <Show when={stats().cancelled}> · {stats().cancelled} cancelled</Show>
            </span>
            <button
              type="button"
              class="quiet-button"
              aria-label="Edit Epic"
              disabled={props.pending}
              onClick={() => setEditor({ current: epic() })}
            >
              Edit
            </button>
          </>
        )}
      </Show>
      <Show when={editor()}>
        {(value) => (
          <EpicEditor
            current={value().current}
            epics={props.epics}
            pending={props.pending}
            onClose={() => setEditor(undefined)}
            onSave={async (input) => {
              if (await props.onSave(input, value().current)) setEditor(undefined);
            }}
          />
        )}
      </Show>
    </div>
  );
}

function EpicEditor(props: {
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
