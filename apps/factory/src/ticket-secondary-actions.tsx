import { createEffect, createSignal, For, Show } from "solid-js";
import type { Epic } from "./api-contracts";
import { Icon } from "./icon";
import { bindPopoverKeyboard } from "./popover-keyboard";
import type { TicketDependenciesProps } from "./ticket-dependencies";

type ActionView = "actions" | "epic" | "dependency" | "diagnostics";

export function TicketSecondaryActions(props: {
  epics: readonly Epic[];
  epicID: string | null | undefined;
  pending: boolean;
  pullRequestUrl: string | undefined;
  failure: string | undefined;
  cleanupError: string | undefined;
  canStop: boolean;
  onAssignEpic(id: string | null): void;
  onStop(): void;
  dependencies: TicketDependenciesProps;
  trashed: boolean;
  onTrash(): void;
  historyAvailable: boolean;
  historyOpen: boolean;
  onHistory(): void;
  converted: boolean;
  onCodingOptions?: (() => void) | undefined;
  codingOptionsDisabled?: boolean | undefined;
}) {
  const [view, setView] = createSignal<ActionView | undefined>();
  const [query, setQuery] = createSignal("");
  let root: HTMLDivElement | undefined;
  let opener: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const panelID = `ticket-actions-${crypto.randomUUID()}`;
  const matches = (title: string) =>
    query()
      .toLocaleLowerCase()
      .trim()
      .split(/\s+/)
      .every((term) => title.toLocaleLowerCase().includes(term));
  const epics = () => props.epics.filter((candidate) => matches(candidate.title));
  const dependencies = () =>
    props.dependencies.candidates.filter((candidate) => matches(candidate.title));
  const show = (next: ActionView) => {
    setQuery("");
    setView(next);
  };
  const close = () => setView(undefined);
  const finish = () => {
    close();
    opener?.focus({ preventScroll: true });
  };
  createEffect(view, (shown) => {
    if (!shown) return;
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    const dispose = panel ? bindPopoverKeyboard(panel, opener, close) : undefined;
    return () => {
      window.removeEventListener("pointerdown", outside);
      dispose?.();
    };
  });
  return (
    <div class="ticket-secondary-actions" ref={root}>
      <button
        type="button"
        class="bare-icon"
        ref={opener}
        aria-label="Ticket actions"
        aria-haspopup="menu"
        aria-expanded={view() ? "true" : "false"}
        aria-controls={panelID}
        onClick={() => (view() ? close() : show("actions"))}
      >
        <Icon name="more" />
      </button>
      <Show when={view()}>
        <section
          class="ticket-action-menu"
          ref={panel}
          id={panelID}
          role={view() === "actions" ? "menu" : "dialog"}
          aria-label={
            view() === "actions"
              ? "Ticket actions"
              : view() === "epic"
                ? "Assign to Epic"
                : view() === "dependency"
                  ? "Add dependency"
                  : "Diagnostics"
          }
        >
          <Show when={view() === "actions"}>
            <Show when={props.historyAvailable}>
              <button
                type="button"
                role="menuitem"
                class="quiet-button history-trigger"
                aria-expanded={props.historyOpen ? "true" : "false"}
                onClick={() => {
                  props.onHistory();
                  close();
                }}
              >
                <Icon name="history" />
                <span>History</span>
              </button>
            </Show>
            <Show when={!props.converted}>
              <Show when={props.onCodingOptions}>
                <button
                  type="button"
                  role="menuitem"
                  class="quiet-button"
                  disabled={props.pending || props.codingOptionsDisabled}
                  onClick={() => {
                    finish();
                    props.onCodingOptions?.();
                  }}
                >
                  <Icon name="agent" />
                  <span>Coding options…</span>
                </button>
              </Show>
              <button
                type="button"
                role="menuitem"
                class="quiet-button"
                disabled={props.pending || props.trashed}
                onClick={() => show("epic")}
              >
                <Icon name="epic" />
                <span>Assign to Epic…</span>
                <Icon name="chevron" />
              </button>
              <Show
                when={
                  !props.trashed &&
                  !props.dependencies.admitted &&
                  props.dependencies.candidates.length
                }
              >
                <button
                  type="button"
                  role="menuitem"
                  class="quiet-button"
                  disabled={props.pending || props.dependencies.pending}
                  onClick={() => show("dependency")}
                >
                  <Icon name="link" />
                  <span>Add dependency…</span>
                  <Icon name="chevron" />
                </button>
              </Show>
              <Show when={props.pullRequestUrl}>
                <a role="menuitem" href={props.pullRequestUrl} target="_blank" rel="noreferrer">
                  <Icon name="external" />
                  <span>Open in Git</span>
                </a>
              </Show>
              <Show when={props.canStop}>
                <button
                  type="button"
                  role="menuitem"
                  class="quiet-button"
                  disabled={props.pending}
                  onClick={() => {
                    props.onStop();
                    finish();
                  }}
                >
                  <Icon name="stop" />
                  <span>Stop implementation</span>
                </button>
              </Show>
              <Show when={props.failure || props.cleanupError}>
                <button
                  type="button"
                  role="menuitem"
                  class="quiet-button"
                  onClick={() => show("diagnostics")}
                >
                  <Icon name="settings" />
                  <span>Diagnostics</span>
                </button>
              </Show>
              <Show when={!props.trashed}>
                <hr class="ticket-menu-separator" />
                <button
                  type="button"
                  role="menuitem"
                  class="danger-link"
                  disabled={props.pending}
                  onClick={() => {
                    props.onTrash();
                    finish();
                  }}
                >
                  <Icon name="trash" />
                  <span>Move to Trash</span>
                </button>
              </Show>
            </Show>
          </Show>
          <Show when={view() !== "actions"}>
            <header class="ticket-picker-header">
              <button
                type="button"
                class="bare-icon"
                aria-label="Back to Ticket actions"
                onClick={() => show("actions")}
              >
                <Icon name="chevron" />
              </button>
              <span>
                {view() === "epic"
                  ? "Assign to Epic"
                  : view() === "dependency"
                    ? "Add dependency"
                    : "Diagnostics"}
              </span>
            </header>
            <Show when={view() === "epic" || view() === "dependency"}>
              <div class="ticket-picker-search">
                <Icon name="search" />
                <input
                  type="search"
                  aria-label={view() === "epic" ? "Search Epics" : "Search Tickets"}
                  placeholder={view() === "epic" ? "Search Epics…" : "Search Tickets…"}
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </div>
              <div class="ticket-picker-options">
                <Show when={view() === "epic"}>
                  <Show when={!query().trim()}>
                    <button
                      type="button"
                      class="quiet-button"
                      data-popover-option
                      aria-pressed={!props.epicID ? "true" : "false"}
                      disabled={props.pending || props.trashed}
                      onClick={() => {
                        props.onAssignEpic(null);
                        finish();
                      }}
                    >
                      <span>No Epic</span>
                      <Show when={!props.epicID}>
                        <Icon name="check" />
                      </Show>
                    </button>
                  </Show>
                  <For each={epics()}>
                    {(candidate) => (
                      <button
                        type="button"
                        class="quiet-button"
                        data-popover-option
                        aria-pressed={props.epicID === candidate.id ? "true" : "false"}
                        disabled={props.pending || props.trashed}
                        onClick={() => {
                          props.onAssignEpic(candidate.id);
                          finish();
                        }}
                      >
                        <span>{candidate.title}</span>
                        <Show when={props.epicID === candidate.id}>
                          <Icon name="check" />
                        </Show>
                      </button>
                    )}
                  </For>
                  <Show when={query().trim() && !epics().length}>
                    <p class="ticket-picker-empty">No matching Epics</p>
                  </Show>
                </Show>
                <Show when={view() === "dependency"}>
                  <For each={dependencies()}>
                    {(candidate) => (
                      <button
                        type="button"
                        class="quiet-button"
                        data-popover-option
                        disabled={
                          props.pending ||
                          props.dependencies.pending ||
                          props.trashed ||
                          props.dependencies.admitted
                        }
                        onClick={async () => {
                          if (await props.dependencies.onAdd(candidate.id)) finish();
                        }}
                      >
                        <span>{candidate.title}</span>
                      </button>
                    )}
                  </For>
                  <Show when={!dependencies().length}>
                    <p class="ticket-picker-empty">No matching Tickets</p>
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={view() === "diagnostics"}>
              <div class="ticket-diagnostics">
                <Show when={props.failure}>
                  <p>{props.failure}</p>
                </Show>
                <Show when={props.cleanupError}>
                  <p>Resource cleanup: {props.cleanupError}</p>
                </Show>
              </div>
            </Show>
          </Show>
        </section>
      </Show>
    </div>
  );
}
