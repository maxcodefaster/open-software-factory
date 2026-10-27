import { createEffect, createSignal, For, Show } from "solid-js";
import { Icon } from "./icon";
import { CopyButton } from "./ui/feedback";
import { type WorkspaceTab, workspaceTabRuntimeURL } from "./workspace-tabs";

export const workspacePanelID = "workspace-view-panel";
export const workspaceTabElementID = (id: string) => `workspace-tab-${encodeURIComponent(id)}`;

export function WorkspaceTabbar(props: {
  tabs: readonly WorkspaceTab[];
  activeTabID: string | undefined;
  shareURL?: string | undefined;
  onActivate: (tab: WorkspaceTab) => void;
  onClose: (id: string) => void;
  onMinimize: () => void;
}) {
  const [overflow, setOverflow] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let tablist: HTMLDivElement | undefined;
  let chooser: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  function focusTab(id: string | undefined) {
    if (!id) return;
    const button = document.getElementById(workspaceTabElementID(id));
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }

  function activate(tab: WorkspaceTab) {
    props.onActivate(tab);
    setMenuOpen(false);
    queueMicrotask(() => focusTab(tab.id));
  }

  function close(tab: WorkspaceTab) {
    const index = props.tabs.findIndex((candidate) => candidate.id === tab.id);
    const nextID =
      props.activeTabID !== tab.id
        ? props.activeTabID
        : (props.tabs[index + 1]?.id ?? props.tabs[index - 1]?.id);
    props.onClose(tab.id);
    queueMicrotask(() => focusTab(nextID));
  }

  function navigate(event: KeyboardEvent, tab: WorkspaceTab) {
    const index = props.tabs.findIndex((candidate) => candidate.id === tab.id);
    let next: WorkspaceTab | undefined;
    switch (event.key) {
      case "ArrowLeft":
        next = props.tabs[(index - 1 + props.tabs.length) % props.tabs.length];
        break;
      case "ArrowRight":
        next = props.tabs[(index + 1) % props.tabs.length];
        break;
      case "Home":
        next = props.tabs[0];
        break;
      case "End":
        next = props.tabs.at(-1);
        break;
      case "Delete":
        event.preventDefault();
        close(tab);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next) activate(next);
  }

  createEffect(
    () => true,
    () => {
      if (!tablist) return;
      const measure = () => {
        if (tablist) setOverflow(tablist.scrollWidth > tablist.clientWidth + 1);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(tablist);
      measure();
      return () => observer.disconnect();
    },
  );
  createEffect(
    () => [props.tabs, props.activeTabID] as const,
    () => {
      queueMicrotask(() => {
        if (tablist) setOverflow(tablist.scrollWidth > tablist.clientWidth + 1);
        const active = props.activeTabID
          ? document.getElementById(workspaceTabElementID(props.activeTabID))
          : undefined;
        active?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      });
    },
  );
  createEffect(menuOpen, (open) => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const selected = menu?.querySelector<HTMLElement>('[aria-checked="true"]');
      (selected ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menu?.contains(target) && !chooser?.contains(target)) setMenuOpen(false);
    };
    const dismissOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        chooser?.focus({ preventScroll: true });
      } else if (event.key === "Tab") {
        setMenuOpen(false);
        chooser?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismissOnKey);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismissOnKey);
    };
  });

  function navigateMenu(event: KeyboardEvent) {
    const buttons = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    const index = event.target instanceof HTMLButtonElement ? buttons.indexOf(event.target) : -1;
    const next =
      event.key === "ArrowDown"
        ? buttons[(index + 1) % buttons.length]
        : event.key === "ArrowUp"
          ? buttons[(index - 1 + buttons.length) % buttons.length]
          : event.key === "Home"
            ? buttons[0]
            : event.key === "End"
              ? buttons.at(-1)
              : undefined;
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <div class="workspace-tabbar">
      <div class="workspace-tabs" role="tablist" aria-label="Open workspace views" ref={tablist}>
        <For each={props.tabs}>
          {(tab) => {
            const active = () => props.activeTabID === tab.id;
            return (
              <div class={`workspace-tab${active() ? " active" : ""}`} role="presentation">
                <button
                  type="button"
                  role="tab"
                  id={workspaceTabElementID(tab.id)}
                  class="workspace-tab-label"
                  title={tab.label}
                  aria-selected={active() ? "true" : "false"}
                  aria-controls={workspacePanelID}
                  tabindex={active() ? 0 : -1}
                  onClick={() => props.onActivate(tab)}
                  onKeyDown={(event) => navigate(event, tab)}
                >
                  {tab.label}
                </button>
                <Show when={workspaceTabRuntimeURL(tab)}>
                  {(url) => (
                    <a
                      class="workspace-tab-action workspace-tab-external"
                      aria-label={`Open ${tab.label} in new tab`}
                      title="Open in new tab"
                      href={url()}
                      target="_blank"
                      rel="noopener"
                      tabindex={active() ? 0 : -1}
                    >
                      <Icon name="external" />
                    </a>
                  )}
                </Show>
                <button
                  type="button"
                  class="workspace-tab-action workspace-tab-close"
                  aria-label={`Close ${tab.label}`}
                  title={`Close ${tab.label}`}
                  tabindex={active() ? 0 : -1}
                  onClick={() => close(tab)}
                >
                  <Icon name="close" />
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <div class="workspace-tabbar-actions">
        <Show when={props.shareURL}>
          {(url) => (
            <CopyButton
              value={url()}
              label="Copy link"
              class="workspace-action"
              iconOnly
              errorMessage="Could not copy link. Copy the URL from your browser's address bar."
            />
          )}
        </Show>
        <Show when={overflow()}>
          <button
            type="button"
            class="bare-icon workspace-tab-chooser"
            aria-label="Choose an open tab"
            title="Choose an open tab"
            aria-expanded={menuOpen() ? "true" : "false"}
            aria-haspopup="menu"
            ref={chooser}
            onClick={() => setMenuOpen(!menuOpen())}
          >
            <Icon name="chevron" />
          </button>
        </Show>
        <button
          type="button"
          class="bare-icon window-minimize-control"
          aria-label="Minimize workspace"
          title="Minimize workspace"
          onClick={props.onMinimize}
        >
          <Icon name="minimize" />
        </button>
      </div>
      <Show when={menuOpen() && overflow()}>
        <div
          class="workspace-tab-menu"
          role="menu"
          aria-label="Open tabs"
          ref={menu}
          onKeyDown={navigateMenu}
        >
          <For each={props.tabs}>
            {(tab) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={props.activeTabID === tab.id ? "true" : "false"}
                onClick={() => activate(tab)}
              >
                <span>{tab.label}</span>
                <Show when={props.activeTabID === tab.id}>
                  <span class="selection-dot" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
