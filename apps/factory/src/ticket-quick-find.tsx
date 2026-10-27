import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import type { Ticket } from "./api-contracts";
import { Icon } from "./icon";
import { bindPopoverKeyboard } from "./popover-keyboard";
import "./ticket-quick-find.css";

export function TicketQuickFind(props: {
  tickets: readonly Ticket[];
  reference(id: string): string;
  status(ticket: Ticket): string;
  onSelect(id: string): void;
  disabled?: boolean;
  onQueryChange?(state: { open: boolean; query: string }): void;
  loading?: boolean;
  failed?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const id = `ticket-quick-find-${crypto.randomUUID()}`;
  createEffect(
    () => ({ open: open(), query: query() }),
    (value) => {
      props.onQueryChange?.(value);
    },
  );
  onCleanup(() => props.onQueryChange?.({ open: false, query: "" }));
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const results = createMemo(() => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return props.tickets.filter((ticket) => {
      const text = `${props.reference(ticket.id)} ${ticket.title}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  });
  const dismiss = () => panel?.hidePopover();
  const position = () => {
    if (!panel || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(416, innerWidth - 24);
    const top = bounds.bottom + 8;
    Object.assign(panel.style, {
      width: `${width}px`,
      top: `${top}px`,
      left: `${Math.max(12, Math.min(bounds.right - width, innerWidth - width - 12))}px`,
      maxHeight: `${Math.max(44, innerHeight - top - 12)}px`,
    });
  };
  const show = () => {
    setQuery("");
    position();
    panel?.showPopover();
  };
  createEffect(open, (shown) => {
    if (!shown || !panel || !trigger) return;
    const current = panel;
    const dispose = bindPopoverKeyboard(current, trigger, dismiss);
    const reveal = () => {
      if (current.contains(document.activeElement))
        document.activeElement?.scrollIntoView({ block: "nearest" });
    };
    current.addEventListener("focusin", reveal);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      dispose();
      current.removeEventListener("focusin", reveal);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="icon-button ticket-find-trigger"
        aria-label="Find Ticket"
        title="Find Ticket"
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        disabled={props.disabled}
        onClick={() => (open() ? dismiss() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open()) {
            event.preventDefault();
            show();
          }
        }}
      >
        <Icon name="search" />
      </button>
      <div
        ref={panel}
        id={id}
        class="ticket-find-popover"
        popover="auto"
        role="dialog"
        aria-label="Find Ticket"
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <label class="ticket-find-search">
          <Icon name="search" />
          <input
            type="search"
            data-popover-search
            aria-label="Find Ticket by title or reference"
            placeholder="Title or reference…"
            maxlength={200}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <p class="ticket-find-summary" role="status">
          {props.failed
            ? "Ticket search could not load. Retry shared sync, then search again."
            : props.loading && !results().length
              ? "Finding Tickets…"
              : results().length
                ? results().length > 50
                  ? "50 Tickets shown. Refine your search for more."
                  : `${results().length} ${results().length === 1 ? "Ticket" : "Tickets"} in this Project`
                : query().trim()
                  ? "No matching Tickets. Try another title or reference."
                  : "No Tickets in this Project yet."}
        </p>
        <div class="ticket-find-results">
          <For each={results().slice(0, 50)} keyed={(ticket) => ticket.id}>
            {(ticket) => (
              <button
                type="button"
                data-popover-option
                disabled={props.disabled}
                onClick={() => {
                  dismiss();
                  trigger?.focus({ preventScroll: true });
                  props.onSelect(ticket().id);
                }}
              >
                <span>
                  <small>{props.reference(ticket().id)}</small>
                  <strong>{ticket().title}</strong>
                </span>
                <Show when={props.status(ticket())}>
                  <small>{props.status(ticket())}</small>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </>
  );
}
