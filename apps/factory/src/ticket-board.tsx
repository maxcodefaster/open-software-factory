import { createEffect, createSignal, For, Show } from "solid-js";
import { boardStages, type BoardStage } from "../../../packages/interface-domain/src/ticket-board";
import { boardGroups } from "../../../packages/interface-domain/src/board-groups";
import { epicFamilyIds } from "../../../packages/ticket-domain/src/epic";
import type { PrerequisiteView } from "../../../packages/ticket-domain/src/dependency";
import type { Epic, Ticket } from "./api-contracts";
import { EpicEditor, type EpicEdit } from "./epic-controls";
import { Icon } from "./icon";

export function TicketBoardContents(props: {
  tickets: readonly Ticket[];
  epics: readonly Epic[];
  archivedTickets: readonly Ticket[];
  historyOpen: boolean;
  pending: boolean;
  selectedTicketID: string | undefined;
  stage: (ticket: Ticket) => BoardStage | "history";
  status: (ticket: Ticket) => string;
  blockers: (ticketID: string) => readonly PrerequisiteView[];
  reference: (ticketID: string) => string;
  onSelect(ticketID: string): void;
  epicID: string;
  onEpic(id: string): void;
  onSaveEpic(input: EpicEdit, current?: Epic): Promise<boolean>;
}) {
  const [editing, setEditing] = createSignal(false);
  const selected = () => props.epics.find((epic) => epic.id === props.epicID);
  const family = () => epicFamilyIds(props.epics, props.epicID);
  const members = () =>
    props.tickets.filter((ticket) => ticket.epicId && family().has(ticket.epicId));
  let board: HTMLDivElement | undefined;
  let dialog: HTMLDialogElement | undefined;
  let opener: HTMLElement | undefined;
  let openerEpicID = "";
  const close = () => props.onEpic("");
  const open = (id: string, element: HTMLElement) => {
    if (!selected()) {
      opener = element;
      openerEpicID = id;
    }
    props.onEpic(id);
  };
  createEffect(
    () => selected()?.id,
    (id) => {
      setEditing(false);
      if (id) {
        openerEpicID ||= id;
        opener ??=
          document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        if (dialog && !dialog.open) dialog.showModal();
        queueMicrotask(() => {
          if (selected()?.id !== id || !dialog?.open) return;
          dialog.scrollTop = 0;
          (
            dialog.querySelector<HTMLElement>(".epic-folder-content button") ??
            dialog.querySelector<HTMLElement>(".epic-folder-actions button:last-child")
          )?.focus({ preventScroll: true });
        });
      } else {
        dialog?.close();
        const target = opener?.isConnected
          ? opener
          : board?.querySelector<HTMLButtonElement>(`[data-epic-id="${CSS.escape(openerEpicID)}"]`);
        target?.focus({ preventScroll: true });
        opener = undefined;
        openerEpicID = "";
      }
    },
  );
  const Card = (input: { ticket: Ticket; showStatus?: boolean }) => (
    <article
      class={props.selectedTicketID === input.ticket.id ? "ticket-card selected" : "ticket-card"}
    >
      <button
        type="button"
        class="ticket-card-body"
        disabled={props.pending}
        onClick={() => {
          close();
          props.onSelect(input.ticket.id);
        }}
      >
        <small>{props.reference(input.ticket.id)}</small>
        <strong>{input.ticket.title}</strong>
        <Show
          when={
            input.showStatus ||
            !["Idea", "Requirements", "Implementation"].includes(props.status(input.ticket))
          }
        >
          <span>{props.status(input.ticket)}</span>
        </Show>
      </button>
      <Show when={props.blockers(input.ticket.id).length}>
        <div class="ticket-card-blockers">
          <small>Blocked by</small>
          <For each={props.blockers(input.ticket.id)}>
            {(prerequisite) => (
              <button
                type="button"
                class="dependency-link"
                disabled={props.pending}
                onClick={() => {
                  close();
                  props.onSelect(prerequisite.id);
                }}
              >
                {prerequisite.title}
              </button>
            )}
          </For>
        </div>
      </Show>
    </article>
  );
  const Folder = (input: { epic: { id: string; title: string }; tickets: readonly Ticket[] }) => (
    <article class="epic-stack">
      <button
        type="button"
        class="epic-stack-open"
        data-epic-id={input.epic.id}
        aria-label={`Open Epic ${input.epic.title}`}
        aria-haspopup="dialog"
        onClick={(event) => open(input.epic.id, event.currentTarget)}
      >
        <Icon name="folder" />
        <span class="epic-stack-label">
          <strong>{input.epic.title}</strong>
          <Show when={input.tickets[0]}>
            <span class="epic-stack-preview">{input.tickets[0]?.title}</span>
          </Show>
        </span>
        <small>{input.tickets.length}</small>
      </button>
    </article>
  );
  const emptyRoots = () =>
    props.epics.filter((epic) => {
      if (epic.parentId && props.epics.some((parent) => parent.id === epic.parentId)) return false;
      const ids = epicFamilyIds(props.epics, epic.id);
      return !props.tickets.some((ticket) => ticket.epicId && ids.has(ticket.epicId));
    });
  return (
    <>
      <Show
        when={!props.historyOpen}
        fallback={
          <div class="board board-history board-enter">
            <section class="ticket-archive" aria-label="history">
              <header class="ticket-archive-heading">
                <span>Completed &amp; cancelled</span>
                <span>{props.archivedTickets.length} tickets</span>
              </header>
              <For each={props.archivedTickets}>
                {(ticket) => (
                  <button
                    type="button"
                    class="ticket-archive-row"
                    disabled={props.pending}
                    onClick={() => props.onSelect(ticket.id)}
                  >
                    <small class="ticket-archive-reference">{props.reference(ticket.id)}</small>
                    <strong class="ticket-archive-title">{ticket.title}</strong>
                    <span class="ticket-archive-status">{props.status(ticket)}</span>
                  </button>
                )}
              </For>
            </section>
          </div>
        }
      >
        <div
          ref={board}
          class="board board-enter"
          style={{ "--board-stage-count": boardStages.length }}
        >
          <For each={boardStages}>
            {(stage) => {
              const tickets = () =>
                props.tickets.filter((ticket) => props.stage(ticket) === stage.id);
              return (
                <section
                  class="lane"
                  aria-label={stage.id}
                  aria-describedby={`lane-count-${stage.id}`}
                >
                  <header class="lane-heading">
                    <h2>{stage.label}</h2>
                  </header>
                  <span class="sr-only" id={`lane-count-${stage.id}`}>
                    {tickets().length} {tickets().length === 1 ? "ticket" : "tickets"}
                  </span>
                  <div class="lane-tickets">
                    <For
                      each={boardGroups(tickets(), props.epics)}
                      keyed={(group) =>
                        group.kind === "epic"
                          ? `epic:${group.epic.id}`
                          : `ticket:${group.ticket.id}`
                      }
                    >
                      {(group) => {
                        const epic = () => {
                          const value = group();
                          return value.kind === "epic" ? value : undefined;
                        };
                        const ticket = () => {
                          const value = group();
                          return value.kind === "ticket" ? value.ticket : undefined;
                        };
                        return (
                          <Show
                            when={epic()}
                            fallback={
                              <Show when={ticket()}>{(value) => <Card ticket={value()} />}</Show>
                            }
                          >
                            {(value) => <Folder epic={value().epic} tickets={value().tickets} />}
                          </Show>
                        );
                      }}
                    </For>
                    <Show when={stage.id === "ideas"}>
                      <For each={emptyRoots()} keyed={(epic) => epic.id}>
                        {(epic) => <Folder epic={epic()} tickets={[]} />}
                      </For>
                    </Show>
                  </div>
                </section>
              );
            }}
          </For>
        </div>
      </Show>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Native Escape/onCancel and the Close button handle keyboard dismissal; this click handles only the backdrop. */}
      <dialog
        ref={dialog}
        class="epic-folder"
        aria-labelledby="epic-folder-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
      >
        <Show when={selected()}>
          {(epic) => (
            <>
              <header class="epic-folder-heading">
                <div class="epic-folder-parent">
                  <Show when={props.epics.find((parent) => parent.id === epic().parentId)}>
                    {(parent) => (
                      <button
                        type="button"
                        class="workspace-action"
                        onClick={() => props.onEpic(parent().id)}
                      >
                        {parent().title}
                      </button>
                    )}
                  </Show>
                </div>
                <div class="epic-folder-title">
                  <h2 id="epic-folder-title">{epic().title}</h2>
                  <span class="epic-progress">
                    {members().filter((ticket) => ticket.state === "done").length}/
                    {members().length} done
                    <Show when={members().some((ticket) => ticket.state === "cancelled")}>
                      {" · "}
                      {members().filter((ticket) => ticket.state === "cancelled").length} cancelled
                    </Show>
                  </span>
                </div>
                <div class="epic-folder-actions">
                  <button
                    type="button"
                    class="workspace-action"
                    aria-label="Edit Epic"
                    disabled={props.pending}
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </button>
                  <button type="button" class="bare-icon" aria-label="Close Epic" onClick={close}>
                    <Icon name="close" />
                  </button>
                </div>
              </header>
              <Show when={epic().description}>
                <p class="epic-folder-description">{epic().description}</p>
              </Show>
              <div class="epic-folder-content epic-folder-grid">
                <For
                  each={props.epics.filter((child) => child.parentId === epic().id)}
                  keyed={(child) => child.id}
                >
                  {(child) => (
                    <Folder
                      epic={child()}
                      tickets={members().filter(
                        (ticket) =>
                          ticket.epicId &&
                          epicFamilyIds(props.epics, child().id).has(ticket.epicId),
                      )}
                    />
                  )}
                </For>
                <For
                  each={[...boardStages.map((stage) => stage.id), "history"].flatMap((stage) =>
                    members().filter(
                      (ticket) => ticket.epicId === epic().id && props.stage(ticket) === stage,
                    ),
                  )}
                  keyed={(ticket) => ticket.id}
                >
                  {(ticket) => <Card ticket={ticket()} showStatus />}
                </For>
                <Show
                  when={
                    !members().length && !props.epics.some((child) => child.parentId === epic().id)
                  }
                >
                  <p class="epic-folder-empty">No tickets in this Epic yet.</p>
                </Show>
              </div>
            </>
          )}
        </Show>
      </dialog>
      <Show when={editing() && selected()}>
        <EpicEditor
          current={selected()}
          epics={props.epics}
          pending={props.pending}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            if (await props.onSaveEpic(input, selected())) setEditing(false);
          }}
        />
      </Show>
    </>
  );
}
