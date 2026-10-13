import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { boardStages, type BoardStage } from "../../../packages/interface-domain/src/ticket-board";
import type { Epic, Ticket } from "./api-contracts";
import { boardGroups } from "../../../packages/interface-domain/src/board-groups";
import type { PrerequisiteView } from "../../../packages/ticket-domain/src/dependency";

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
  onSelect: (ticketID: string) => void;
}) {
  const exceptionalStatus = (ticket: Ticket) => {
    const status = props.status(ticket);
    return ["Idea", "Requirements", "Implementation"].includes(status) ? undefined : status;
  };
  return (
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
      <p class="board-scroll-hint">
        Swipe through 4 stages <span aria-hidden="true">→</span>
      </p>
      <div class="board board-enter">
        <For each={boardStages}>
          {(stage) => {
            const tickets = () =>
              props.tickets.filter((ticket) => props.stage(ticket) === stage.id);
            const groups = createMemo(
              () =>
                new Map(
                  boardGroups(tickets(), props.epics).map((group) => [
                    group.kind === "epic" ? `epic:${group.epic.id}` : `ticket:${group.ticket.id}`,
                    group,
                  ]),
                ),
            );
            return (
              <section class="lane" aria-label={stage.id}>
                <header class="lane-heading">
                  <span>{stage.label}</span>
                  <span>{tickets().length}</span>
                </header>
                <For each={[...groups().keys()]}>
                  {(key) => {
                    const group = () => groups().get(key);
                    const epicTitle = () => {
                      const current = group();
                      return current?.kind === "epic" ? current.epic.title : "";
                    };
                    const members = () => {
                      const current = group();
                      return current?.kind === "epic"
                        ? current.tickets
                        : current
                          ? [current.ticket]
                          : [];
                    };
                    const [expanded, setExpanded] = createSignal(
                      members().some((ticket) => ticket.id === props.selectedTicketID),
                    );
                    createEffect(
                      () => props.selectedTicketID,
                      (ticketID) => {
                        if (ticketID && members().some((ticket) => ticket.id === ticketID))
                          setExpanded(true);
                      },
                    );
                    const cards = () => (
                      <For each={members()}>
                        {(ticket) => (
                          <article
                            class={
                              props.selectedTicketID === ticket.id
                                ? "ticket-card selected"
                                : "ticket-card"
                            }
                          >
                            <button
                              type="button"
                              class="ticket-card-body"
                              disabled={props.pending}
                              onClick={() => props.onSelect(ticket.id)}
                            >
                              <small>{props.reference(ticket.id)}</small>
                              <strong>{ticket.title}</strong>
                              <Show when={exceptionalStatus(ticket)}>
                                {(status) => <span>{status()}</span>}
                              </Show>
                            </button>
                            <Show when={props.blockers(ticket.id).length}>
                              <div class="ticket-card-blockers">
                                <small>Blocked by</small>
                                <For each={props.blockers(ticket.id)}>
                                  {(prerequisite) => (
                                    <button
                                      type="button"
                                      class="dependency-link"
                                      disabled={props.pending}
                                      onClick={() => props.onSelect(prerequisite.id)}
                                    >
                                      {prerequisite.title}
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </article>
                        )}
                      </For>
                    );
                    return key.startsWith("epic:") ? (
                      <details
                        class="epic-stack"
                        open={expanded()}
                        onToggle={(event) => setExpanded(event.currentTarget.open)}
                      >
                        <summary>
                          <span class="epic-stack-label">
                            <strong>{epicTitle()}</strong>
                            <Show when={!expanded()}>
                              <span class="epic-stack-preview">{members()[0]?.title}</span>
                            </Show>
                          </span>
                          <small>
                            {members().length} {members().length === 1 ? "ticket" : "tickets"}
                          </small>
                        </summary>
                        <div class="epic-stack-tickets">{cards()}</div>
                      </details>
                    ) : (
                      cards()
                    );
                  }}
                </For>
              </section>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
