import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { InboxItem, InboxView } from "./contracts";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { inboxSectionItems, type InboxPosition, type InboxSection } from "./navigation";
import "../ui/workspace-actions.css";
import "./inbox.css";

type ReceiptAction = "read" | "unread" | "archive";

export function InboxWorkspace(props: {
  position: InboxPosition;
  onPosition(patch: Partial<InboxPosition>): void;
  restoreKey: number;
  view?: InboxView | undefined;
  loading?: boolean;
  error?: string;
  busy?: boolean;
  onRefresh?(): void;
  onOpen?(item: InboxItem, queue: readonly string[]): void;
  onMark?(item: InboxItem, action: ReceiptAction): void | Promise<void>;
}) {
  const section = () => props.position.section;
  const project = () => props.position.project;
  const [optionsOpen, setOptionsOpen] = createSignal(false);
  const [pending, setPending] = createSignal<string>();
  const [writeError, setWriteError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let root: HTMLElement | undefined;
  let list: HTMLUListElement | undefined;
  let options: HTMLDetailsElement | undefined;
  let optionsOpener: HTMLElement | undefined;
  let optionsPanel: HTMLDivElement | undefined;
  const items = () => props.view?.items ?? [];
  const scoped = createMemo(() =>
    items().filter((item) => !project() || item.projectId === project()),
  );
  const projectOptions = createMemo(() => {
    const projects = new Map(items().map((item) => [item.projectId, item.projectName]));
    // Keep a selected Project named even when its last request has been resolved.
    if (project() && !projects.has(project())) projects.set(project(), props.position.projectName);
    return [...projects.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  const visible = createMemo(() => inboxSectionItems(items(), props.position));
  const count = (name: "action" | "activity") =>
    scoped().filter((item) =>
      name === "action" ? item.needsAction : !item.needsAction && !item.archived && item.unread,
    ).length;
  const working = () => props.busy || !!pending();
  const error = () => writeError() || props.error;
  const description = () =>
    section() === "action"
      ? "Open a request to respond at its source. Reading does not complete it."
      : section() === "activity"
        ? "Opening an update marks it as read. Archiving only changes your Inbox."
        : "Archived updates stay accessible. Move one back to Activity when you need it.";
  function closeOptions() {
    if (options) options.open = false;
  }
  createEffect(optionsOpen, (open) => {
    if (!open || !optionsPanel) return;
    const outside = (event: Event) => {
      if (!options?.contains(event.target as Node)) closeOptions();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    const dispose = bindPopoverKeyboard(optionsPanel, optionsOpener, closeOptions);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      dispose();
    };
  });
  let restored: number | undefined;
  createEffect(
    () => ({ loaded: !!props.view, key: props.restoreKey }),
    ({ loaded, key }) => {
      if (!loaded || restored === key) return;
      restored = key;
      const remembered = untrack(() => props.position);
      onSettled(() => {
        if (!root?.isConnected || root.contains(document.activeElement)) return;
        if (!list) {
          if (remembered.selectedId)
            root
              .querySelector<HTMLElement>(".inbox-sections .is-current")
              ?.focus({ preventScroll: true });
          return;
        }
        list.scrollTop = remembered.scrollTop;
        if (!remembered.selectedId) return;
        const item =
          visible().find((item) => item.id === remembered.selectedId) ??
          visible()[Math.min(remembered.index, visible().length - 1)];
        if (item) focusItem(item.id, true);
      });
    },
  );
  function focusItem(id: string, preserveScroll = false) {
    const button = list?.querySelector<HTMLButtonElement>(
      `[data-inbox-id="${CSS.escape(id)}"] .inbox-open`,
    );
    if (!button) return;
    button.focus({ preventScroll: true });
    const bounds = button.getBoundingClientRect();
    const viewport = list?.getBoundingClientRect();
    if (
      !preserveScroll ||
      (viewport && (bounds.top < viewport.top || bounds.bottom > viewport.bottom))
    )
      button.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  function setSection(section: InboxSection) {
    props.onPosition({ section, selectedId: undefined, index: 0, scrollTop: 0 });
    if (list) list.scrollTop = 0;
  }
  function setProject(project: string) {
    props.onPosition({
      project,
      projectName: projectOptions().find((item) => item.id === project)?.name ?? "",
      selectedId: undefined,
      index: 0,
      scrollTop: 0,
    });
    if (list) list.scrollTop = 0;
  }
  function open(item: InboxItem) {
    props.onPosition({
      selectedId: item.id,
      index: visible().findIndex((value) => value.id === item.id),
      scrollTop: list?.scrollTop ?? 0,
    });
    props.onOpen?.(
      item,
      visible().map((item) => item.id),
    );
  }
  function keydown(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !(event.target instanceof HTMLElement) ||
      event.target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
      )
    )
      return;
    const row = event.target.closest<HTMLElement>("[data-inbox-id]");
    const index = visible().findIndex((item) => item.id === row?.dataset["inboxId"]);
    const item = visible()[index];
    if (!item) return;
    const key = event.key.toLowerCase();
    if (key === "j" || key === "k" || key === "arrowdown" || key === "arrowup") {
      event.preventDefault();
      const next =
        visible()[
          Math.max(
            0,
            Math.min(visible().length - 1, index + (key === "j" || key === "arrowdown" ? 1 : -1)),
          )
        ];
      if (next) focusItem(next.id);
    } else if (!event.repeat && !working() && !item.needsAction && (key === "e" || key === "u")) {
      if (item.archived) return;
      const button = row?.querySelector<HTMLButtonElement>(
        key === "e" ? ".inbox-archive" : ".inbox-read",
      );
      if (!button || button.disabled) return;
      event.preventDefault();
      void mark(item, key === "e" ? "archive" : item.unread ? "read" : "unread", button);
    }
  }
  function refresh() {
    setWriteError("");
    const wasOpen = options?.open;
    closeOptions();
    if (wasOpen) optionsOpener?.focus({ preventScroll: true });
    props.onRefresh?.();
  }
  async function mark(item: InboxItem, action: ReceiptAction, opener: HTMLButtonElement) {
    if (working() || !props.onMark) return;
    const scope = `${section()}:${project()}`;
    const index = visible().findIndex((value) => value.id === item.id);
    setPending(item.id);
    setNotice("");
    setWriteError("");
    try {
      await props.onMark(item, action);
      const current = items().find((value) => value.id === item.id);
      // Only acknowledge an outcome reflected in the caller's retained view.
      if (current?.eventId === item.eventId) {
        if (action === "archive" && current.archived) setNotice("Activity archived.");
        else if (action === "unread" && current.unread) setNotice("Marked as unread.");
        else if (action === "read" && !current.unread && !current.archived)
          setNotice(item.archived ? "Moved to Activity." : "Marked as read.");
      }
    } catch (cause) {
      setWriteError(
        cause instanceof Error
          ? cause.message
          : "Your change was not saved. Refresh the Inbox, then repeat the action.",
      );
    } finally {
      setPending(undefined);
      requestAnimationFrame(() => {
        if (
          !root?.isConnected ||
          !root.getClientRects().length ||
          scope !== `${section()}:${project()}` ||
          (document.activeElement !== document.body && document.activeElement?.isConnected)
        )
          return;
        const next = visible()[Math.min(index, visible().length - 1)];
        const target = opener.isConnected
          ? opener
          : next
            ? root.querySelector<HTMLElement>(
                `[data-inbox-id="${CSS.escape(next.id)}"] .inbox-open`,
              )
            : root.querySelector<HTMLElement>(".inbox-sections .is-current");
        target?.focus({ preventScroll: true });
      });
    }
  }
  return (
    <section
      class="inbox-workspace"
      ref={root}
      aria-label="Personal Inbox"
      aria-busy={props.loading || working() ? "true" : "false"}
    >
      <header class="inbox-heading">
        <h2>Inbox</h2>
        <label class="inbox-project-filter">
          <span class="sr-only">Filter Inbox by Project</span>
          <select
            aria-label="Filter Inbox by Project"
            value={project()}
            onChange={(event) => setProject(event.currentTarget.value)}
          >
            <option value="">All Projects</option>
            <For each={projectOptions()} keyed={(item) => item.id}>
              {(item) => <option value={item().id}>{item().name}</option>}
            </For>
          </select>
        </label>
        <details
          class="inbox-options"
          ref={options}
          onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !options?.open) return;
            event.preventDefault();
            event.stopPropagation();
            closeOptions();
            optionsOpener?.focus({ preventScroll: true });
          }}
        >
          <summary
            class="workspace-action workspace-menu-trigger"
            aria-label="Inbox options and shortcuts"
            ref={optionsOpener}
          >
            <Icon name="more" />
          </summary>
          <div class="inbox-options-panel" ref={optionsPanel}>
            <button
              type="button"
              class="workspace-action"
              aria-label="Refresh Inbox"
              onClick={refresh}
              disabled={props.loading || working() || !props.onRefresh}
            >
              <Icon name="refresh" />
              Refresh Inbox
            </button>
            <p>{description()}</p>
            <dl class="inbox-shortcuts">
              <div>
                <dt>
                  <kbd>J</kbd> / <kbd>K</kbd>
                </dt>
                <dd>Next / previous item</dd>
              </div>
              <div>
                <dt>
                  <kbd>Enter</kbd>
                </dt>
                <dd>Open focused item</dd>
              </div>
              <div>
                <dt>
                  <kbd>E</kbd>
                </dt>
                <dd>Archive activity</dd>
              </div>
              <div>
                <dt>
                  <kbd>U</kbd>
                </dt>
                <dd>Toggle read / unread</dd>
              </div>
            </dl>
            <p>
              Shortcuts work while the list has focus. Requests must be resolved at their source.
            </p>
          </div>
        </details>
      </header>
      <nav class="inbox-sections" aria-label="Inbox sections">
        <button
          type="button"
          class={section() === "action" ? "is-current" : ""}
          aria-current={section() === "action" ? "page" : "false"}
          onClick={() => setSection("action")}
        >
          Needs you <span>{props.view ? count("action") : "…"}</span>
        </button>
        <button
          type="button"
          class={section() === "activity" ? "is-current" : ""}
          aria-current={section() === "activity" ? "page" : "false"}
          onClick={() => setSection("activity")}
        >
          Activity <span>{props.view ? count("activity") : "…"} unread</span>
        </button>
        <button
          type="button"
          class={section() === "archive" ? "is-current" : ""}
          aria-current={section() === "archive" ? "page" : "false"}
          onClick={() => setSection("archive")}
        >
          Archived
        </button>
      </nav>
      <Show when={error()}>
        <div class="inbox-error form-error" role="alert">
          <Icon name="info" />
          <p>{error()}</p>
          <button
            type="button"
            class="workspace-action"
            onClick={refresh}
            disabled={props.loading || working()}
          >
            Refresh Inbox
          </button>
        </div>
      </Show>
      <Show when={notice()}>
        <p class="sr-only" role="status">
          {notice()}
        </p>
      </Show>
      <Show
        when={!props.loading || props.view}
        fallback={
          <div class="inbox-loading" role="status">
            <span>Loading your Inbox…</span>
            <For each={[0, 1, 2]}>
              {() => (
                <div aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              )}
            </For>
          </div>
        }
      >
        <Show
          when={visible().length}
          fallback={
            <div class="inbox-empty empty-workspace">
              <Icon name="inbox" />
              <h3>
                {error()
                  ? "Your Inbox is unavailable. Try again to check for requests."
                  : project()
                    ? "No matching items in this Project."
                    : section() === "action"
                      ? "No decisions need your attention."
                      : section() === "archive"
                        ? "No archived activity."
                        : "No activity yet."}
              </h3>
              <Show when={!error()}>
                <p>
                  {project()
                    ? "Choose another Project or return to all Projects."
                    : section() === "action"
                      ? "Questions and approvals will appear here when they need you."
                      : section() === "archive"
                        ? "Archive activity to put it aside without losing its source."
                        : "Follow Tickets or join a discussion to receive updates."}
                </p>
                <Show when={project()}>
                  <button type="button" class="workspace-action" onClick={() => setProject("")}>
                    Show all Projects
                  </button>
                </Show>
              </Show>
            </div>
          }
        >
          <ul
            class="inbox-items"
            ref={list}
            onScroll={(event) => props.onPosition({ scrollTop: event.currentTarget.scrollTop })}
            onKeyDown={keydown}
            aria-keyshortcuts="j k ArrowDown ArrowUp"
            aria-label={section() === "action" ? "Requests needing you" : "Inbox activity"}
          >
            <For each={visible()} keyed={(item) => item.id}>
              {(item) => (
                <li
                  class="inbox-item"
                  data-inbox-id={item().id}
                  data-unread={item().unread ? "true" : "false"}
                  data-needs-action={item().needsAction ? "true" : "false"}
                  data-pending={pending() === item().id ? "true" : "false"}
                  aria-busy={pending() === item().id ? "true" : "false"}
                >
                  <button
                    type="button"
                    class="inbox-open"
                    onFocus={() =>
                      props.onPosition({
                        selectedId: item().id,
                        index: visible().findIndex((value) => value.id === item().id),
                      })
                    }
                    onClick={() => open(item())}
                  >
                    <span class="inbox-item-mark" aria-hidden="true">
                      <Icon
                        name={
                          item().target === "conversation"
                            ? "agent"
                            : item().target === "review"
                              ? "comment"
                              : item().target === "coding"
                                ? "ide"
                                : item().target === "inputs"
                                  ? "inbox"
                                  : "ticket"
                        }
                      />
                    </span>
                    <span class="inbox-item-content">
                      <span class="inbox-item-topline">
                        <strong title={item().ticketTitle}>{item().ticketTitle}</strong>
                        <time
                          datetime={item().createdAt}
                          title={new Date(item().createdAt).toLocaleString()}
                        >
                          {new Date(item().createdAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </span>
                      <span class="inbox-preview">
                        {item().preview.replace(/\[@([^\]]+)\]\(factory-person:[^)]+\)/g, "@$1")}
                      </span>
                      <span class="inbox-item-meta">
                        <span
                          class="inbox-item-context"
                          title={`${item().projectName} · ${item().title}`}
                        >
                          {item().projectName} · {item().title}
                        </span>
                        <Show when={item().updates > 1}>
                          <span>{item().updates} updates</span>
                        </Show>
                        <Show when={pending() === item().id}>
                          <span role="status">Saving…</span>
                        </Show>
                        <Show when={item().unread}>
                          <span class="sr-only">Unread</span>
                        </Show>
                        <Show when={item().needsAction}>
                          <span class="inbox-request-hint">
                            <span class="sr-only">Open request</span>
                            <Icon name="chevron" />
                          </span>
                        </Show>
                      </span>
                    </span>
                  </button>
                  <Show when={!item().needsAction}>
                    <fieldset class="inbox-item-actions" aria-label={`Actions for ${item().title}`}>
                      <Show when={!item().archived}>
                        <button
                          type="button"
                          class="workspace-action inbox-item-action inbox-read"
                          disabled={working() || !props.onMark}
                          data-tooltip={item().unread ? "Mark as read" : "Mark as unread"}
                          aria-label={`${item().unread ? "Mark read" : "Mark unread"}: ${item().title}`}
                          aria-keyshortcuts="u"
                          onClick={(event) =>
                            void mark(
                              item(),
                              item().unread ? "read" : "unread",
                              event.currentTarget,
                            )
                          }
                        >
                          <Icon name={item().unread ? "mail-open" : "mail"} />
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="workspace-action inbox-item-action inbox-archive"
                        disabled={working() || !props.onMark}
                        data-tooltip={item().archived ? "Move to Activity" : "Archive"}
                        aria-label={`${item().archived ? "Move to Activity" : "Archive"}: ${item().title}`}
                        aria-keyshortcuts={item().archived ? undefined : "e"}
                        onClick={(event) =>
                          void mark(
                            item(),
                            item().archived ? "read" : "archive",
                            event.currentTarget,
                          )
                        }
                      >
                        <Icon name={item().archived ? "unarchive" : "archive"} />
                      </button>
                    </fieldset>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
