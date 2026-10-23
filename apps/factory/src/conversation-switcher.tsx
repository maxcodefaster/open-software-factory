import { createEffect, createSignal, For, Show } from "solid-js";
import type { ConversationView } from "./api-contracts";
import { Icon } from "./icon";
import { bindPopoverKeyboard } from "./popover-keyboard";
import "./conversation-switcher.css";

export function ConversationSwitcher(props: {
  conversation: ConversationView | undefined;
  title?: string;
  scopeKey?: string;
  ticket: boolean;
  coding: boolean;
  canRestart: boolean;
  restartReason?: string | undefined;
  busy: boolean;
  onSelect(id: string): void;
  onResearch(): void;
  onCoding(): void;
  onMinimize?: (() => void) | undefined;
}) {
  const [confirm, setConfirm] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const id = `conversation-history-${crypto.randomUUID()}`;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const selected = () => props.conversation?.contextId ?? "original";
  const options = () => [
    {
      id: "original",
      title: props.title ?? "Original conversation",
      kind: "Original",
      active: false,
    },
    ...(props.conversation?.contexts
      .filter((context) => !context.original)
      .map((context) => ({
        id: context.id,
        title: ["New conversation", "New Coding conversation"].includes(context.title)
          ? `${context.kind === "coding" ? "Coding" : "Chat"} ${context.ordinal}`
          : context.title,
        kind: context.kind === "coding" ? "Coding" : "Research",
        active: context.id === props.conversation?.activeCodingContextId,
      })) ?? []),
  ];
  const current = () => options().find((option) => option.id === selected());
  const dismiss = () => menu?.hidePopover();
  const position = () => {
    if (!menu || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(352, innerWidth - 24);
    const top = bounds.bottom + 8;
    Object.assign(menu.style, {
      width: `${width}px`,
      top: `${top}px`,
      left: `${Math.max(12, Math.min(bounds.left, innerWidth - width - 12))}px`,
      maxHeight: `${Math.max(44, innerHeight - top - 12)}px`,
    });
  };
  const showHistory = () => {
    position();
    menu?.showPopover();
  };
  createEffect(
    () => props.conversation?.contextId,
    () => {
      setConfirm(false);
    },
  );
  createEffect(
    () => props.scopeKey ?? props.title,
    () => {
      setConfirm(false);
      dismiss();
    },
  );
  createEffect(open, (shown) => {
    if (!shown || !menu || !trigger) return;
    const panel = menu;
    const anchor = trigger;
    const revealFocus = () => {
      if (panel.contains(document.activeElement))
        document.activeElement?.scrollIntoView({ block: "nearest" });
    };
    position();
    const dispose = bindPopoverKeyboard(panel, anchor, dismiss);
    panel.addEventListener("focusin", revealFocus);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      dispose();
      panel.removeEventListener("focusin", revealFocus);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  });
  return (
    <section
      class="conversation-switcher"
      aria-label={props.ticket ? "Ticket conversations" : "Personal Project conversations"}
    >
      <div class="conversation-switcher-row">
        <button
          ref={trigger}
          type="button"
          class="conversation-title"
          aria-label="Conversation"
          aria-haspopup="menu"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          data-context-id={selected()}
          title={current()?.title}
          onClick={() => (menu?.matches(":popover-open") ? dismiss() : showHistory())}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && !open()) {
              event.preventDefault();
              showHistory();
            }
          }}
        >
          <span>{current()?.title ?? "Conversation"}</span>
          <Icon name="chevron" />
        </button>
        <Show when={props.onMinimize}>
          <button
            type="button"
            class="bare-icon window-minimize-control conversation-minimize"
            aria-label="Minimize Agent panel"
            onClick={() => {
              dismiss();
              props.onMinimize?.();
            }}
          >
            <Icon name="minimize" />
          </button>
        </Show>
      </div>
      <div
        ref={menu}
        id={id}
        class="conversation-menu"
        popover="auto"
        role="menu"
        aria-label="Conversation history"
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <button
          type="button"
          role="menuitem"
          class="conversation-new"
          disabled={props.busy}
          onClick={() => {
            dismiss();
            trigger?.focus({ preventScroll: true });
            if (props.coding) setConfirm(true);
            else props.onResearch();
          }}
        >
          New chat
        </button>
        <p class="conversation-menu-label">
          {props.ticket ? "Ticket chats" : "Your Project chats"}
        </p>
        <Show when={!props.conversation && props.busy}>
          <p class="conversation-visibility" role="status">
            Loading chats…
          </p>
        </Show>
        <For each={options()} keyed={(option) => option.id}>
          {(option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option().id === selected() ? "true" : "false"}
              aria-current={option().id === selected() ? "true" : undefined}
              data-conversation-id={option().id}
              onClick={() => {
                props.onSelect(option().id);
                dismiss();
                trigger?.focus({ preventScroll: true });
              }}
            >
              <span>{option().title}</span>
              <small>{option().active ? "Active Coding" : option().kind}</small>
            </button>
          )}
        </For>
        <Show when={props.coding}>
          <button
            type="button"
            role="menuitem"
            class="conversation-research"
            disabled={props.busy}
            onClick={() => {
              dismiss();
              props.onResearch();
            }}
          >
            Ask about this Project
          </button>
        </Show>
        <p class="conversation-visibility">
          {props.ticket
            ? "Conversation history is shared with this Ticket."
            : "Project conversations are private to you."}
        </p>
      </div>
      <Show when={confirm()}>
        <fieldset class="conversation-restart-confirmation" aria-label="Fresh Coding conversation">
          <p>
            A fresh Coding conversation uses this same shared Workspace and keeps the previous
            history. Files and approvals stay unchanged.
          </p>
          <Show when={!props.canRestart}>
            <p role="status">
              {props.restartReason ??
                "Finish the current work or use Stop and wait for confirmation first."}
            </p>
          </Show>
          <div class="conversation-confirm-actions">
            <button
              type="button"
              class="conversation-action"
              onClick={() => {
                setConfirm(false);
                trigger?.focus({ preventScroll: true });
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              class="conversation-action"
              data-primary="true"
              disabled={props.busy || !props.canRestart}
              onClick={() => {
                setConfirm(false);
                trigger?.focus({ preventScroll: true });
                props.onCoding();
              }}
            >
              Start fresh conversation
            </button>
          </div>
        </fieldset>
      </Show>
    </section>
  );
}
