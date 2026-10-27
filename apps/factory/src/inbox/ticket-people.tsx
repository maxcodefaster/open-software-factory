import { Portal } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import {
  getTicketAttention,
  setTicketFollowing,
  setTicketResponsibility,
} from "../server-functions/inbox";
import { serverCall } from "../server-functions/result";
import { observeFactoryRead } from "../zero/reads";
import type { TicketAttention } from "./contracts";
import "./inbox.css";

export function TicketPeople(props: {
  value: TicketAttention;
  busy: boolean;
  onAssign(id: string | null): Promise<void>;
  onFollow(following: boolean): Promise<void>;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const panelID = `ticket-people-${crypto.randomUUID()}`;
  let opener: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  const responsible = () =>
    props.value.people.find((person) => person.id === props.value.responsibleId);
  const name = () => responsible()?.name ?? "Unavailable member";
  const people = () => {
    const terms = query().trim().toLocaleLowerCase().split(/\s+/);
    return props.value.people.filter((person) =>
      terms.every((term) => person.name.toLocaleLowerCase().includes(term)),
    );
  };
  const close = () => setOpen(false);
  function assign(id: string | null) {
    if (props.busy) return;
    close();
    opener?.focus({ preventScroll: true });
    if (id !== props.value.responsibleId) void props.onAssign(id);
  }
  createEffect(open, (shown) => {
    if (!shown) return;
    const position = () => {
      if (!opener || !panel) return;
      const anchor = opener.getBoundingClientRect();
      const above = Math.max(0, anchor.top - 12);
      const below = Math.max(0, innerHeight - anchor.bottom - 12);
      const height = Math.min(384, panel.scrollHeight);
      const opensAbove = below < height && above > below;
      panel.style.maxHeight = `${Math.min(384, opensAbove ? above : below)}px`;
      panel.style.left = `${Math.max(8, Math.min(anchor.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${opensAbove ? anchor.top - Math.min(height, above) - 4 : anchor.bottom + 4}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (panel) observer.observe(panel);
    const outside = (event: PointerEvent) => {
      if (!opener?.contains(event.target as Node) && !panel?.contains(event.target as Node))
        close();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.addEventListener("pointerdown", outside);
    const dispose = panel ? bindPopoverKeyboard(panel, opener, close) : undefined;
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("pointerdown", outside);
      dispose?.();
    };
  });
  return (
    <div class="ticket-people">
      <button
        type="button"
        class="quiet-button ticket-person-trigger"
        ref={opener}
        aria-label={props.value.responsibleId ? `Responsible: ${name()}` : "Add person"}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={panelID}
        aria-disabled={props.busy ? "true" : "false"}
        aria-busy={props.busy ? "true" : "false"}
        title="Coordinates this Ticket. Does not change who is working or grant permissions."
        onClick={() => {
          if (props.busy) return;
          if (open()) close();
          else {
            setQuery("");
            setOpen(true);
          }
        }}
      >
        <Show when={props.value.responsibleId} fallback={<Icon name="plus" />}>
          <span class="ticket-person-initial" aria-hidden="true">
            {name().trim().slice(0, 1).toLocaleUpperCase()}
          </span>
        </Show>
        <span class="ticket-person-name">{props.value.responsibleId ? name() : "Add person"}</span>
      </button>
      <Show when={open()}>
        <Portal>
          <section
            class="ticket-action-menu ticket-person-picker"
            ref={panel}
            id={panelID}
            role="dialog"
            aria-label="Assign responsibility"
          >
            <div class="ticket-person-picker-heading">Responsible</div>
            <div class="ticket-picker-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Search Project members"
                placeholder="Type a name…"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <div class="ticket-picker-options">
              <Show when={!query().trim()}>
                <button
                  type="button"
                  class="quiet-button"
                  data-popover-option
                  aria-pressed={!props.value.responsibleId ? "true" : "false"}
                  disabled={props.busy}
                  onClick={() => assign(null)}
                >
                  <span>Not assigned</span>
                  <Show when={!props.value.responsibleId}>
                    <Icon name="check" />
                  </Show>
                </button>
              </Show>
              <For each={people()} keyed={(person) => person.id}>
                {(person) => (
                  <button
                    type="button"
                    class="quiet-button"
                    data-popover-option
                    aria-pressed={props.value.responsibleId === person().id ? "true" : "false"}
                    disabled={props.busy}
                    onClick={() => assign(person().id)}
                  >
                    <span>{person().name}</span>
                    <Show when={props.value.responsibleId === person().id}>
                      <Icon name="check" />
                    </Show>
                  </button>
                )}
              </For>
              <Show when={!people().length}>
                <p class="ticket-picker-empty" role="status">
                  {query().trim() ? "No matching Project members" : "No Project members available"}
                </p>
              </Show>
            </div>
          </section>
        </Portal>
      </Show>
      <button
        type="button"
        class="quiet-button"
        disabled={props.busy}
        aria-pressed={props.value.following ? "true" : "false"}
        onClick={() => void props.onFollow(!props.value.following)}
      >
        {props.value.following ? "Following" : "Follow"}
      </button>
    </div>
  );
}

export function TicketAttentionControls(props: { ticketID: string; projectID?: string }) {
  const [value, setValue] = createSignal<TicketAttention>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let generation = 0;
  async function refresh(ticketID = props.ticketID) {
    const read = ++generation;
    try {
      const result = await serverCall(getTicketAttention({ data: [ticketID] }));
      if (read === generation && props.ticketID === ticketID) {
        setValue(result);
        setError("");
      }
    } catch (cause) {
      if (read === generation)
        setError(cause instanceof Error ? cause.message : "Ticket people could not be loaded.");
    }
  }
  createEffect(
    () => props.ticketID,
    (ticketID) => {
      setValue(undefined);
      void refresh(ticketID);
      return () => {
        generation++;
      };
    },
  );
  observeFactoryRead(
    () =>
      props.projectID
        ? { projectId: props.projectID, scope: "ticket", resourceId: props.ticketID }
        : null,
    () => refresh(),
  );
  async function change(run: () => Promise<TicketAttention>) {
    if (busy()) return;
    const ticketID = props.ticketID;
    setBusy(true);
    ++generation;
    try {
      const result = await run();
      if (props.ticketID === ticketID) {
        setValue(result);
        setError("");
      }
    } catch (cause) {
      if (props.ticketID === ticketID)
        setError(cause instanceof Error ? cause.message : "Your change was not saved. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="ticket-attention-controls">
      <Show when={value()}>
        {(current) => (
          <TicketPeople
            value={current()}
            busy={busy()}
            onAssign={(responsibleId) =>
              change(() =>
                serverCall(
                  setTicketResponsibility({
                    data: [
                      props.ticketID,
                      {
                        commandId: crypto.randomUUID(),
                        expectedVersion: current().version,
                        responsibleId,
                      },
                    ],
                  }),
                ),
              )
            }
            onFollow={(following) =>
              change(() => serverCall(setTicketFollowing({ data: [props.ticketID, following] })))
            }
          />
        )}
      </Show>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}{" "}
          <button type="button" class="quiet-button" onClick={() => void refresh()}>
            Reload people
          </button>
        </p>
      </Show>
    </div>
  );
}
