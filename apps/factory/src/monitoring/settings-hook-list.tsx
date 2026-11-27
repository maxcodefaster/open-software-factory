import type { JSX } from "@solidjs/web";
import { type Accessor, children, createEffect, createSignal, For, Show } from "solid-js";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import type { MonitoringSettingsState } from "./settings-state";
import {
  formatMonitoringTime,
  incidentStateLabel,
  type MonitoringView,
  payloadExample,
} from "./settings-types";

function InputActions(props: { name: string; children: JSX.Element }) {
  const content = children(() => props.children);
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDetailsElement;
  let opener!: HTMLElement;
  let panel!: HTMLDivElement;
  const close = () => {
    root.open = false;
    setOpen(false);
  };
  createEffect(
    () => undefined,
    () => {
      const keydown = (event: KeyboardEvent) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          root.open = true;
          setOpen(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      };
      opener.addEventListener("keydown", keydown);
      return () => opener.removeEventListener("keydown", keydown);
    },
  );
  createEffect(open, (shown) => {
    if (!shown) return;
    const position = () => {
      const bounds = root.closest(".settings-content")?.getBoundingClientRect();
      const anchor = opener.getBoundingClientRect();
      const below = (bounds?.bottom ?? innerHeight) - anchor.bottom - 8;
      const above = anchor.top - (bounds?.top ?? 0) - 8;
      const opensAbove = below < panel.scrollHeight && above > below;
      panel.style.top = opensAbove ? "auto" : "calc(100% + 4px)";
      panel.style.bottom = opensAbove ? "calc(100% + 4px)" : "auto";
      panel.style.maxHeight = `${Math.max(44, opensAbove ? above : below)}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const outside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) close();
    };
    const choose = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("button:not(:disabled)")) {
        close();
        opener.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    panel.addEventListener("click", choose);
    const dispose = bindPopoverKeyboard(panel, opener, close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      panel.removeEventListener("click", choose);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      dispose();
    };
  });
  return (
    <details
      class="input-row-menu"
      ref={root}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        class="workspace-action workspace-menu-trigger"
        ref={opener}
        aria-label={`Actions for ${props.name}`}
      >
        <Icon name="more" />
      </summary>
      <div ref={panel}>{content()}</div>
    </details>
  );
}

export function MonitoringHookList(props: {
  view: Accessor<MonitoringView>;
  projectId: string | undefined;
  state: MonitoringSettingsState;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  const receivedLabel = (id: string) => {
    const event = props.view().incidents.find((item) => item.hookId === id);
    return event
      ? `Last received ${formatMonitoringTime(event.lastSeenAt)}`
      : "Waiting for the first request";
  };
  const rotatingId = () => {
    const current = props.state.screen();
    return current.kind === "list" ? current.rotatingHook?.id : undefined;
  };

  return (
    <>
      <Show when={!props.view().canManage}>
        <p class="input-help">
          Project managers configure Inputs. You can inspect received requests and prepared Tickets.
        </p>
      </Show>
      <section class="input-list" aria-label="Configured inputs">
        <Show when={!props.view().hooks.length}>
          <div class="input-empty">
            <h3>Give external requests a place to land</h3>
            <p>
              Create a named webhook for feedback, monitoring alerts or your own agent. Factory
              clarifies requests; implementation still requires approval unless explicitly
              delegated.
            </p>
          </div>
        </Show>
        <For each={props.view().hooks} keyed={(hook) => hook.id}>
          {(hook) => (
            <article class="input-row" aria-label={`${hook().name} input`}>
              <div class="input-row-main">
                <div>
                  <div class="input-row-title">
                    <h3>{hook().name}</h3>
                    <span
                      class="input-state"
                      data-state={
                        !hook().enabled
                          ? "disabled"
                          : hook().delegationCurrent
                            ? "enabled"
                            : "attention"
                      }
                    >
                      {!hook().enabled
                        ? "Disabled"
                        : hook().delegationCurrent
                          ? "Enabled"
                          : "Needs attention"}
                    </span>
                  </div>
                  <p class="input-help">
                    {hook().sourceIds.length
                      ? hook().sourceIds.map(props.state.sourceName).join(" · ")
                      : "Project context"}
                    {" · "}
                    {hook().delegation === "prepare-ticket"
                      ? "Human approval to implement"
                      : "Autofix & Delivery delegated"}
                  </p>
                  <p class="input-help">{receivedLabel(hook().id)}</p>
                </div>
                <Show when={props.view().canDisable}>
                  <InputActions name={hook().name}>
                    <Show when={props.view().canManage}>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={props.state.blocked()}
                        onClick={() => props.state.edit(hook())}
                      >
                        Edit input
                      </button>
                    </Show>
                    <Show when={hook().enabled}>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={props.state.blocked()}
                        onClick={() => props.state.act(hook(), "disable")}
                      >
                        Disable input
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="quiet-button"
                      disabled={props.state.blocked()}
                      onClick={() => props.state.openRotation(hook())}
                    >
                      Rotate key…
                    </button>
                  </InputActions>
                </Show>
              </div>
              <Show when={hook().enabled && !hook().delegationCurrent}>
                <p class="input-error">
                  Source access or authority changed. Review this Input before enabling new work.
                </p>
              </Show>
              <details class="input-row-details">
                <summary>
                  <Icon name="chevron" />
                  Task & webhook details
                </summary>
                <div class="input-detail-content">
                  <section>
                    <h4>Task</h4>
                    <p class="input-task">{hook().instructions}</p>
                    <p class="input-help">
                      {hook().delegation === "prepare-ticket"
                        ? "Prepared Tickets require human implementation approval."
                        : "Bounded Autofix and Delivery are explicitly delegated."}
                    </p>
                  </section>
                  <section class="input-payload">
                    <h4>What to send</h4>
                    <p>
                      POST a JSON object to the private URL. Use a stable id or fingerprint for
                      repeated deliveries. Remove secrets and personal data before sending.
                    </p>
                    <pre>
                      <code>{payloadExample}</code>
                    </pre>
                    <p>
                      Native alert JSON is also accepted. This receives requests, not an
                      OpenTelemetry stream. URL keys authorize work and must stay out of logs and
                      repositories.
                    </p>
                  </section>
                </div>
              </details>
              <Show when={rotatingId() === hook().id}>
                <div class="input-confirmation">
                  <h4
                    tabindex="-1"
                    ref={(element) => {
                      props.state.refs.rotationHeading = element;
                    }}
                  >
                    Rotate key for {hook().name}?
                  </h4>
                  <p>
                    The old URL will stop working. Rotation disables this Input and stops pending
                    automatic work. Retained Tickets and accepted merges are not undone.
                  </p>
                  <div class="input-actions">
                    <button
                      type="button"
                      class="workspace-action"
                      disabled={props.state.running()}
                      onClick={(event) => {
                        const opener = event.currentTarget
                          .closest(".input-row")
                          ?.querySelector<HTMLElement>(".input-row-menu > summary");
                        props.state.closeRotation();
                        opener?.focus({ preventScroll: true });
                      }}
                    >
                      Cancel rotation
                    </button>
                    <button
                      type="button"
                      class="danger-button"
                      disabled={props.state.blocked()}
                      onClick={() => props.state.act(hook(), "rotate")}
                    >
                      Rotate key and disable
                    </button>
                  </div>
                </div>
              </Show>
            </article>
          )}
        </For>
      </section>
      <section class="input-events" aria-label="Recent input activity">
        <header class="input-section-heading">
          <h3>Recent requests</h3>
        </header>
        <Show when={!props.view().incidents.length}>
          <p class="input-help">Received requests and their outcomes will appear here.</p>
        </Show>
        <For each={props.view().incidents} keyed={(event) => event.id}>
          {(event) => (
            <details class="input-event" id={`input-event-${event().id}`} tabindex="-1">
              <summary>
                <Icon name="chevron" />
                <span>
                  <strong>{event().title}</strong>
                  <small>
                    {props.view().hooks.find((hook) => hook.id === event().hookId)?.name ?? "Input"}{" "}
                    · {event().occurrences} {event().occurrences === 1 ? "delivery" : "deliveries"}
                  </small>
                </span>
                <span class="input-state" data-state={event().state}>
                  {incidentStateLabel[event().state]}
                </span>
                <time datetime={event().lastSeenAt}>
                  {formatMonitoringTime(event().lastSeenAt)}
                </time>
              </summary>
              <div class="input-event-content">
                <Show when={event().reason}>
                  <p>{event().reason}</p>
                </Show>
                <Show when={event().ticketId && props.onOpenTicket}>
                  <button
                    type="button"
                    class="workspace-action"
                    onClick={() => {
                      const ticketId = event().ticketId;
                      if (ticketId && props.projectId)
                        props.onOpenTicket?.(ticketId, props.projectId);
                    }}
                  >
                    Open Ticket
                  </button>
                </Show>
                <Show when={event().state === "uncertain"}>
                  <p class="input-help">No automatic model retry was started.</p>
                </Show>
              </div>
            </details>
          )}
        </For>
      </section>
    </>
  );
}
