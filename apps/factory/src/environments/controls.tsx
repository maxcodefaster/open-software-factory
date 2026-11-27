import type { JSX } from "@solidjs/web";
import { createEffect, For, Show } from "solid-js";
import type { EnvironmentSettingsView, ProjectEnvironment } from "#project-domain/environment";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import {
  activeFilterCount,
  type EnvironmentGrant,
  grantLabels,
  grants,
  type VariableFilters,
} from "./settings-state";

export function EnvironmentHeader(props: {
  navigation?: JSX.Element;
  environment: ProjectEnvironment;
  canManage: boolean;
  canEditDraft: boolean;
  busy: boolean;
  importID: string;
  importOpen: boolean;
  importButtonRef(button: HTMLButtonElement): void;
  addButtonRef(button: HTMLButtonElement): void;
  onOpenImport(): void;
  onAddVariable(): void;
  onEnvironmentChange(scope: ProjectEnvironment): void;
}) {
  return (
    <>
      <header class="environment-heading workspace-heading">
        <div class="workspace-heading-title">
          <h2 class="environment-wide-title">Environments</h2>
          <Show when={props.navigation}>
            <div class="workspace-action-leading">{props.navigation}</div>
          </Show>
        </div>
        <WorkspaceActionBar label="Environment actions">
          <Show when={props.canManage}>
            <button
              ref={props.importButtonRef}
              type="button"
              class="workspace-action"
              aria-controls={props.importID}
              aria-expanded={props.importOpen ? "true" : "false"}
              disabled={!props.canEditDraft}
              onClick={props.onOpenImport}
            >
              Import .env
            </button>
            <button
              ref={props.addButtonRef}
              type="button"
              class="workspace-action"
              data-primary="true"
              disabled={!props.canEditDraft}
              onClick={props.onAddVariable}
            >
              Add variable
            </button>
          </Show>
        </WorkspaceActionBar>
        <div class="workspace-heading-meta">
          <p class="model-settings-note">
            Variables are separate for each environment. Saved values stay hidden.
          </p>
        </div>
      </header>
      <nav class="environment-tabs" aria-label="Environment">
        <For each={["development", "main-preview"] as const}>
          {(item) => (
            <button
              type="button"
              disabled={props.busy}
              aria-pressed={props.environment === item ? "true" : "false"}
              onClick={() => props.onEnvironmentChange(item)}
            >
              {item === "development" ? "Development" : "Main-Preview"}
            </button>
          )}
        </For>
      </nav>
    </>
  );
}

export function EnvironmentStatusNotices(props: {
  current: EnvironmentSettingsView;
  hasRetry: boolean;
  busy: boolean;
  onDiscardPending(): void;
}) {
  return (
    <>
      <Show when={!props.current.canManage}>
        <p class="model-settings-note">
          Only Project managers can change variables. You can see names and kinds; values stay
          hidden.
        </p>
      </Show>
      <Show when={!props.current.storeConfigured}>
        <p role="status">
          Connect OpenBao to manage protected values. Existing editing remains available.
        </p>
      </Show>
      <Show when={props.current.pending || props.hasRetry}>
        <p role="status">
          A save is unconfirmed. Retry the same save, or discard it to keep existing settings.
        </p>
        <Show when={props.current.canManage}>
          <button
            type="button"
            class="quiet-button"
            disabled={props.busy}
            onClick={props.onDiscardPending}
          >
            Discard pending save
          </button>
        </Show>
      </Show>
    </>
  );
}

export function EnvironmentFilterToolbar(props: {
  filtersID: string;
  filters: VariableFilters;
  sort: string;
  onFiltersChange(update: (current: VariableFilters) => VariableFilters): void;
  onSortChange(value: string): void;
}) {
  const activeOptions = () => activeFilterCount(props.filters, props.sort);
  return (
    <search class="environment-toolbar" aria-label="Filter environment variables">
      <label class="environment-search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search variables"
          placeholder="Search variables…"
          value={props.filters.search}
          onInput={(event) =>
            props.onFiltersChange((f) => ({ ...f, search: event.currentTarget.value }))
          }
        />
      </label>
      <button
        type="button"
        class="workspace-action"
        aria-controls={props.filtersID}
        aria-expanded={props.filters.open ? "true" : "false"}
        onClick={() => props.onFiltersChange((f) => ({ ...f, open: !f.open }))}
      >
        Filter & sort
        <Show when={activeOptions() > 0}> · {activeOptions()}</Show>
      </button>
      <fieldset
        id={props.filtersID}
        class="environment-filter-fields"
        aria-label="Variable filters"
        hidden={!props.filters.open}
      >
        <select
          aria-label="Filter by usage"
          value={props.filters.usage}
          onChange={(event) =>
            props.onFiltersChange((f) => ({
              ...f,
              usage: event.currentTarget.value as "all" | EnvironmentGrant,
            }))
          }
        >
          <option value="all">All uses</option>
          <For each={grants}>{(grant) => <option value={grant}>{grantLabels[grant]}</option>}</For>
        </select>
        <select
          aria-label="Filter by saved state"
          value={props.filters.state}
          onChange={(event) =>
            props.onFiltersChange((f) => ({
              ...f,
              state: event.currentTarget.value as "all" | "saved" | "draft",
            }))
          }
        >
          <option value="all">All variables</option>
          <option value="saved">Saved variables</option>
          <option value="draft">Unsaved changes</option>
        </select>
        <select
          aria-label="Sort variables"
          value={props.sort}
          onChange={(event) => props.onSortChange(event.currentTarget.value)}
        >
          <option value="name-asc">Name A to Z</option>
          <option value="name-desc">Name Z to A</option>
          <option value="draft-first">Unsaved first</option>
        </select>
      </fieldset>
    </search>
  );
}

export function EnvironmentSaveBar(props: {
  visible: boolean;
  unconfirmed: boolean;
  editable: boolean;
  busy: boolean;
  hasRetry: boolean;
}) {
  return (
    <Show when={props.visible}>
      <footer class="environment-savebar">
        <span class="model-settings-note">
          {props.unconfirmed ? "Save unconfirmed" : "Unsaved changes"}
        </span>
        <button type="submit" class="primary-button" disabled={!props.editable}>
          {props.busy ? "Saving…" : props.hasRetry ? "Retry save" : "Save environment"}
        </button>
      </footer>
    </Show>
  );
}

export type EnvironmentActionsMenuHandle = {
  open(opener: HTMLButtonElement): void;
  close(): void;
};

export function EnvironmentActionsMenu(props: {
  open: boolean;
  canEditDraft: boolean;
  ref(handle: EnvironmentActionsMenuHandle): void;
  onToggle(open: boolean): void;
  onEdit(): void;
  onRemove(): void;
}) {
  let menu!: HTMLDivElement;
  let opener: HTMLButtonElement | undefined;

  function positionMenu() {
    if (!opener || !menu) return;
    const anchor = opener.getBoundingClientRect();
    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    Object.assign(menu.style, {
      left: `${Math.max(gap, Math.min(anchor.right - width, innerWidth - width - gap))}px`,
      top: `${Math.max(gap, anchor.bottom + height + gap > innerHeight ? anchor.top - height - gap : anchor.bottom + gap)}px`,
    });
  }

  props.ref({
    open(button) {
      opener = button;
      menu?.showPopover();
      positionMenu();
    },
    close() {
      menu?.hidePopover();
    },
  });

  createEffect(
    () => props.open,
    (open) => {
      if (!open || !menu) return;
      positionMenu();
      const dispose = bindPopoverKeyboard(menu, opener, () => menu.hidePopover());
      window.addEventListener("resize", positionMenu);
      window.addEventListener("scroll", positionMenu, true);
      return () => {
        dispose();
        window.removeEventListener("resize", positionMenu);
        window.removeEventListener("scroll", positionMenu, true);
      };
    },
  );

  return (
    <div
      ref={menu}
      class="environment-actions-menu"
      popover="auto"
      role="menu"
      aria-label="Variable actions"
      onToggle={(event) => props.onToggle(event.newState === "open")}
    >
      <button
        type="button"
        role="menuitem"
        disabled={!props.canEditDraft}
        onClick={() => {
          menu.hidePopover();
          props.onEdit();
        }}
      >
        Edit variable
      </button>
      <button
        type="button"
        role="menuitem"
        class="danger-link"
        disabled={!props.canEditDraft}
        onClick={props.onRemove}
      >
        Remove variable
      </button>
    </div>
  );
}
