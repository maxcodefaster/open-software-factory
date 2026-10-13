import { For, Show } from "solid-js";
import type { PrerequisiteView } from "../../../packages/ticket-domain/src/dependency";
import { Icon } from "./icon";

export type TicketDependenciesProps = {
  prerequisites: readonly PrerequisiteView[];
  candidates: readonly { id: string; title: string }[];
  admitted: boolean;
  pending: boolean;
  onOpen(ticketId: string): void;
  onAdd(ticketId: string): Promise<boolean>;
  onRemove(ticketId: string): void;
};

export function TicketDependencies(props: TicketDependenciesProps) {
  const blockers = () => props.prerequisites.filter((prerequisite) => !prerequisite.delivered);
  return (
    <Show when={props.prerequisites.length}>
      <section class="ticket-dependencies" aria-label="Blocked by">
        <header>
          <span>Blocked by</span>
          <Show when={blockers().length}>
            <small role="status">Awaiting linked work</small>
          </Show>
        </header>
        <Show when={props.prerequisites.length}>
          <ul>
            <For each={props.prerequisites}>
              {(prerequisite) => (
                <li>
                  <div>
                    <button
                      type="button"
                      class="dependency-link"
                      onClick={() => props.onOpen(prerequisite.id)}
                    >
                      {prerequisite.title}
                    </button>
                    <small>
                      {prerequisite.delivered
                        ? "Delivered"
                        : prerequisite.state === "cancelled"
                          ? "Cancelled · still blocking"
                          : "Awaiting delivery"}
                    </small>
                  </div>
                  <button
                    type="button"
                    class="bare-icon"
                    aria-label={`Remove prerequisite ${prerequisite.title}`}
                    disabled={props.pending}
                    onClick={() => props.onRemove(prerequisite.id)}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}
