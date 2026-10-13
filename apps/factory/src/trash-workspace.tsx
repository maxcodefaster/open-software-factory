import { For, Show } from "solid-js";
import type { Ticket } from "./api-contracts";

export function TrashWorkspace(props: {
  tickets: readonly Ticket[];
  pending: boolean;
  onOpen(id: string): void;
  onRestore(id: string): void;
  onRetry(id: string): void;
}) {
  return (
    <section class="trash-workspace" aria-label="Trash">
      <header class="model-settings-heading">
        <div>
          <h2>Trash</h2>
          <small>
            Restore Tickets without restarting work. Workspace files and history are retained.
          </small>
        </div>
      </header>
      <Show
        when={props.tickets.length}
        fallback={<p class="model-settings-body">Trash is empty.</p>}
      >
        <div class="model-settings-body">
          <For each={props.tickets}>
            {(ticket) => (
              <div class="trash-ticket-row">
                <button
                  type="button"
                  class="trash-ticket-title"
                  onClick={() => props.onOpen(ticket.id)}
                >
                  {ticket.title}
                </button>
                <Show when={ticket.trashStopPending}>
                  <small role="status">Stopping work…</small>
                </Show>
                <Show when={ticket.trashError}>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={props.pending}
                    onClick={() => props.onRetry(ticket.id)}
                  >
                    Retry stop
                  </button>
                </Show>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.pending || Boolean(ticket.trashStopPending)}
                  onClick={() => props.onRestore(ticket.id)}
                >
                  Restore
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
