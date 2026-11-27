import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import {
  type MCPDefinition,
  type MCPLibraryView,
  recommendedMCPs,
} from "#conversation-domain/mcp-library";
import { Icon } from "../icon";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import {
  cover,
  endpointHost,
  type MCPEntry,
  type MCPScope,
  scopeLabel,
  stateLabel,
} from "./library-shared";

export function MCPLibraryHeader(props: {
  hidden: boolean;
  monitoringSetup: boolean;
  navigation?: JSX.Element;
  hasView: boolean;
  entryCount: number;
  canManageProject: boolean;
  canManageSystem: boolean;
  scope: MCPScope;
  busy: boolean;
  setupBlocked: boolean;
  hasDraft: boolean;
  query: string;
  owner: string;
  workType: string;
  filtersOpen: boolean;
  activeFilters: number;
  filterID: string;
  onActionMenuRef: (element: HTMLDetailsElement) => void;
  onAddButtonRef: (element: HTMLButtonElement) => void;
  onFilterRootRef: (element: HTMLDivElement) => void;
  onFilterButtonRef: (element: HTMLButtonElement) => void;
  onToggleManage: () => void;
  onAdd: () => void;
  onQueryInput: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onWorkTypeChange: (value: string) => void;
  onToggleFilters: () => void;
  onDismissFilters: (event: KeyboardEvent) => void;
  onClearFilters: () => void;
}) {
  return (
    <header class="skill-library-heading workspace-heading" hidden={props.hidden}>
      <div class="skill-library-title workspace-heading-title">
        <h2>{props.monitoringSetup ? "Choose a source" : "MCP connections"}</h2>
        <span class="skill-result-count">
          {props.hasView
            ? `${props.entryCount} ${props.entryCount === 1 ? "source" : "sources"}`
            : ""}
        </span>
      </div>
      <WorkspaceActionBar
        label="MCP library actions"
        leading={props.monitoringSetup ? undefined : props.navigation}
      >
        <Show when={!props.monitoringSetup && (props.canManageProject || props.canManageSystem)}>
          <button type="button" class="workspace-action" onClick={props.onToggleManage}>
            {props.scope === "personal" ? "Manage" : "Browse connections"}
          </button>
        </Show>
        <button
          ref={props.onAddButtonRef}
          type="button"
          class="workspace-action"
          data-primary="true"
          disabled={props.busy || props.setupBlocked}
          onClick={props.onAdd}
        >
          {props.hasDraft ? "Resume draft" : props.monitoringSetup ? "Other service" : "Add MCP"}
        </button>
      </WorkspaceActionBar>
      <Show when={!props.monitoringSetup}>
        <p class="mcp-library-subtitle workspace-heading-meta">
          Connect external tools and context to Project work.
        </p>
      </Show>
      <div class="skill-library-tools workspace-heading-meta">
        <label class="skill-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search MCP connections"
            placeholder="Find a connection"
            value={props.query}
            onInput={(event) => props.onQueryInput(event.currentTarget.value)}
          />
        </label>
        <div class="skill-filter-control" ref={props.onFilterRootRef}>
          <button
            ref={props.onFilterButtonRef}
            type="button"
            class="workspace-action skill-filter-toggle"
            aria-expanded={props.filtersOpen ? "true" : "false"}
            aria-controls={props.filterID}
            onKeyDown={props.onDismissFilters}
            onClick={props.onToggleFilters}
          >
            Filter{props.activeFilters ? ` · ${props.activeFilters}` : ""}
          </button>
          <div class="skill-filter-options" id={props.filterID} hidden={!props.filtersOpen}>
            <label>
              Ownership
              <select
                value={props.owner}
                onChange={(event) => props.onOwnerChange(event.currentTarget.value)}
                onKeyDown={props.onDismissFilters}
              >
                <option value="all">All owners</option>
                <Show when={!props.monitoringSetup}>
                  <option value="personal">Only me</option>
                </Show>
                <option value="project">Project</option>
                <option value="system">Factory</option>
              </select>
            </label>
            <label>
              Work type
              <select
                value={props.workType}
                onChange={(event) => props.onWorkTypeChange(event.currentTarget.value)}
                onKeyDown={props.onDismissFilters}
              >
                <option value="all">All work types</option>
                <option value="planning">Investigate &amp; Plan</option>
                <option value="build">Build</option>
              </select>
            </label>
            <Show when={props.query || props.activeFilters}>
              <button
                type="button"
                class="quiet-button"
                onKeyDown={props.onDismissFilters}
                onClick={props.onClearFilters}
              >
                Clear filters
              </button>
            </Show>
          </div>
        </div>
      </div>
    </header>
  );
}

export function MCPLibraryScopeContext(props: {
  scope: MCPScope;
  projectName: string | undefined;
  canManageProject: boolean;
  canManageSystem: boolean;
  onChangeScope: (scope: MCPScope) => void;
}) {
  return (
    <div class="skill-library-context">
      <button type="button" class="quiet-button" onClick={() => props.onChangeScope("personal")}>
        Browse connections
      </button>
      <label>
        Manage defaults for
        <select
          value={props.scope}
          onChange={(event) => props.onChangeScope(event.currentTarget.value as MCPScope)}
        >
          <Show when={props.canManageProject}>
            <option value="project">{props.projectName ?? "Project"}</option>
          </Show>
          <Show when={props.canManageSystem}>
            <option value="system">Everyone in Factory</option>
          </Show>
        </select>
      </label>
      <p>Shared defaults, not personal choices.</p>
    </div>
  );
}

export function MCPLibraryGallery(props: {
  hidden: boolean;
  monitoringSetup: boolean;
  scope: MCPScope;
  hasView: boolean;
  proposals: MCPLibraryView["proposals"];
  entries: MCPEntry[];
  hasActiveSearchOrFilters: boolean;
  busy: boolean;
  setupBlocked: boolean;
  hasDraft: boolean;
  onGalleryRef: (element: HTMLDivElement) => void;
  onAcceptProposal: (proposalId: string) => void;
  onOpenEntry: (item: MCPEntry) => void;
  onClearFilters: () => void;
  onSelectRecommendation: (suggestion: MCPDefinition) => void;
}) {
  return (
    <div class="skill-gallery-scroll" hidden={props.hidden} ref={props.onGalleryRef}>
      <Show when={!props.monitoringSetup && props.scope !== "personal"}>
        <section class="skill-proposals" aria-label="MCP sharing review queue">
          <h3>Sharing review</h3>
          <For each={props.proposals.filter((proposal) => proposal.target === props.scope)}>
            {(proposal) => (
              <section class="skill-proposal">
                <h4>
                  {proposal.revision.content.name} · v{proposal.revision.revision}
                </h4>
                <p>{proposal.revision.content.description}</p>
                <p class="mcp-endpoint">{proposal.revision.content.endpoint}</p>
                <p>
                  Acceptance copies only this definition. No credentials, connection or enabled
                  defaults are shared.
                </p>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={props.busy || props.setupBlocked}
                  onClick={() => props.onAcceptProposal(proposal.id)}
                >
                  Add to shared library
                </button>
              </section>
            )}
          </For>
          <Show when={!props.proposals.some((proposal) => proposal.target === props.scope)}>
            <p>No sharing proposals awaiting review.</p>
          </Show>
        </section>
      </Show>
      <section class="skill-gallery mcp-gallery" aria-label="MCP gallery">
        <For each={props.entries}>
          {(item) => (
            <article
              class="skill-gallery-card mcp-gallery-card"
              aria-label={item.revisions[0]?.content.name}
            >
              <button
                id={`mcp-open-${item.id}`}
                type="button"
                class="skill-tile"
                onClick={() => props.onOpenEntry(item)}
              >
                <img
                  class="mcp-cover"
                  src={cover(item.revisions[0]?.content.provider ?? "custom", item.cover)}
                  width="768"
                  height="512"
                  alt=""
                  loading="lazy"
                />
                <span class="skill-tile-caption">
                  <span class="skill-tile-title">{item.revisions[0]?.content.name}</span>
                  <span class="mcp-service-endpoint">
                    {endpointHost(item.revisions[0]?.content.endpoint)}
                  </span>
                  <span class="skill-tile-description">
                    {item.revisions[0]?.content.description}
                  </span>
                </span>
              </button>
              <div class="mcp-card-meta">
                <span
                  class="mcp-connection-state"
                  data-state={item.connection?.state ?? "disconnected"}
                >
                  <Icon name="link" />
                  {stateLabel(item.connection?.state)}
                </span>
                <span>{scopeLabel(item.scope)}</span>
              </div>
            </article>
          )}
        </For>
      </section>
      <Show when={props.hasView && !props.entries.length && props.hasActiveSearchOrFilters}>
        <div class="skill-library-empty">
          <h3>No matching connections</h3>
          <p>Try another search or clear the filters.</p>
          <button type="button" class="quiet-button" onClick={props.onClearFilters}>
            Clear filters
          </button>
        </div>
      </Show>
      <section class="mcp-recommendations" aria-label="Recommended MCP connections">
        <Show when={props.monitoringSetup || props.entries.length}>
          <h3>{props.monitoringSetup ? "Connect a service" : "Recommended starting points"}</h3>
        </Show>
        <Show when={props.monitoringSetup}>
          <p>Choose a service below, or use Other service for a different remote MCP endpoint.</p>
        </Show>
        <div class="skill-gallery mcp-gallery">
          <For each={recommendedMCPs}>
            {(suggestion) => (
              <article class="skill-gallery-card">
                <button
                  type="button"
                  class="skill-tile"
                  disabled={props.hasDraft || props.setupBlocked}
                  onClick={() => props.onSelectRecommendation(suggestion)}
                >
                  <img
                    class="mcp-cover"
                    src={cover(suggestion.provider)}
                    width="768"
                    height="512"
                    alt=""
                    loading="lazy"
                  />
                  <span class="skill-tile-caption">
                    <span class="skill-tile-title">{suggestion.name}</span>
                    <span class="mcp-service-endpoint">{endpointHost(suggestion.endpoint)}</span>
                    <span class="skill-tile-description">{suggestion.description}</span>
                  </span>
                </button>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}
