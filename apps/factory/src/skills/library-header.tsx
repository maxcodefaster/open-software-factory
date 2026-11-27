import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "../icon";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import type { SkillFilters } from "./gallery-state";
import { activeSkillFilterCount } from "./library-state";

export function SkillLibraryHeader(props: {
  hidden: boolean;
  browsing: boolean;
  editorOpen: boolean;
  importing: boolean;
  hasView: boolean;
  entryCount: number;
  navigation?: JSX.Element;
  busy: boolean;
  hasDraft: boolean;
  canManage: boolean;
  managing: boolean;
  filters: SkillFilters;
  filtersOpen: boolean;
  filterID: string;
  onActionMenuRef: (element: HTMLDetailsElement) => void;
  onActionTriggerRef: (element: HTMLElement) => void;
  onNewButtonRef: (element: HTMLButtonElement) => void;
  onFilterRootRef: (element: HTMLDivElement) => void;
  onFilterButtonRef: (element: HTMLButtonElement) => void;
  onCloseActions: () => void;
  onOpenImport: () => void;
  onEnterManage: () => void;
  onAddSkill: () => void;
  onUpdateFilters: (patch: Partial<SkillFilters>) => void;
  onToggleFilters: () => void;
  onDismissFilters: () => void;
}) {
  const filterCount = () => activeSkillFilterCount(props.filters);
  return (
    <header class="skill-library-heading workspace-heading" hidden={props.hidden}>
      <div class="skill-library-title workspace-heading-title">
        <h2>Skills library</h2>
        <Show when={props.browsing}>
          <span class="skill-result-count" aria-live="polite">
            {props.hasView
              ? `${props.entryCount} ${props.entryCount === 1 ? "skill" : "skills"}`
              : ""}
          </span>
        </Show>
      </div>
      <WorkspaceActionBar label="Skills library actions" leading={props.navigation}>
        <details
          class="skill-action-menu"
          ref={props.onActionMenuRef}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              props.onCloseActions();
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            class="workspace-action workspace-menu-trigger"
            aria-label="Library actions"
            ref={props.onActionTriggerRef}
          >
            <Icon name="more" />
          </summary>
          <div class="skill-action-options">
            <button
              type="button"
              class="quiet-button"
              disabled={props.busy || props.hasDraft || !props.browsing}
              title={props.hasDraft ? "Finish or discard your draft before importing" : undefined}
              onClick={props.onOpenImport}
            >
              Import
            </button>
            <Show when={props.canManage}>
              <button
                type="button"
                class="quiet-button"
                disabled={!props.browsing}
                onClick={props.onEnterManage}
              >
                Manage
              </button>
            </Show>
          </div>
        </details>
        <button
          ref={props.onNewButtonRef}
          type="button"
          class="workspace-action"
          data-primary="true"
          hidden={props.editorOpen}
          disabled={props.busy || props.importing}
          onClick={props.onAddSkill}
        >
          {props.hasDraft ? "Resume draft" : "Add skill"}
        </button>
      </WorkspaceActionBar>
      <div class="skill-library-tools workspace-heading-meta">
        <Show when={props.browsing}>
          <label class="skill-search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Search skills"
              placeholder="Find a skill"
              value={props.filters.query}
              onInput={(event) => props.onUpdateFilters({ query: event.currentTarget.value })}
            />
          </label>
          <div class="skill-filter-control" ref={props.onFilterRootRef}>
            <button
              ref={props.onFilterButtonRef}
              type="button"
              class="workspace-action skill-filter-toggle"
              aria-expanded={props.filtersOpen ? "true" : "false"}
              aria-controls={props.filterID}
              onClick={props.onToggleFilters}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onDismissFilters();
                }
              }}
            >
              Filter
              {filterCount() > 0 ? ` · ${filterCount()}` : ""}
            </button>
            <div class="skill-filter-options" id={props.filterID} hidden={!props.filtersOpen}>
              <label>
                Ownership
                <select
                  value={props.filters.owner}
                  onChange={(event) =>
                    props.onUpdateFilters({
                      owner: event.currentTarget.value as SkillFilters["owner"],
                    })
                  }
                >
                  <option value="all">All owners</option>
                  <Show when={!props.managing}>
                    <option value="personal">Only me</option>
                  </Show>
                  <option value="project">Project</option>
                  <option value="system">Factory</option>
                </select>
              </label>
              <label>
                Work type
                <select
                  value={props.filters.role}
                  onChange={(event) =>
                    props.onUpdateFilters({
                      role: event.currentTarget.value as SkillFilters["role"],
                    })
                  }
                >
                  <option value="all">All work types</option>
                  <option value="planning">Investigate &amp; Plan</option>
                  <option value="build">Build</option>
                </select>
              </label>
              <label>
                Availability
                <select
                  value={props.filters.availability}
                  onChange={(event) =>
                    props.onUpdateFilters({
                      availability: event.currentTarget.value as SkillFilters["availability"],
                    })
                  }
                >
                  <option value="all">Any availability</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Off</option>
                  <option value="required">Required</option>
                  <option value="updates">Updates available</option>
                </select>
              </label>
            </div>
          </div>
        </Show>
      </div>
    </header>
  );
}
