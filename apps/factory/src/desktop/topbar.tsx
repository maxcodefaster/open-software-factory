import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { For, Show, untrack } from "solid-js";
import type { DesktopBackgroundKey } from "../../../../packages/interface-domain/src/background";
import type { Change, RuntimeDockTarget, Ticket } from "../api-contracts";
import type { DesktopBackground } from "../artworks";
import { DockAppButton, DockButton } from "../dock";
import { Icon } from "../icon";
import type { InboxItem } from "../inbox/contracts";
import type { createKnowledgeState } from "../knowledge/state";
import type { createProjectPlanning } from "../projects/planning";
import { ticketReference } from "../projects/ticket-content";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { PersonalTicketDraft } from "../ticket-draft-workspace";
import { TicketQuickFind } from "../ticket-quick-find";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import type { DesktopProject, FactoryDesktopProps, TicketDetail } from "./contracts";

export interface DesktopTopbarModel {
  registrationOpen: SourceAccessor<boolean>;
  agentOpen: SourceAccessor<boolean>;
  agentToggleElement: HTMLButtonElement | undefined;
  rememberAgentOpener: () => void;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  projectControlElement: HTMLDivElement | undefined;
  narrowViewport: SourceAccessor<boolean>;
  projectMenuOpen: ReturnType<typeof createProjectPlanning>["projectMenuOpen"];
  selectedProject: Accessor<DesktopProject | undefined>;
  setSettingsOpen: Setter<boolean>;
  setProjectMenuOpen: ReturnType<typeof createProjectPlanning>["setProjectMenuOpen"];
  projectPopover: HTMLElement | undefined;
  bootstrap: FactoryDesktopProps;
  setError: Setter<string>;
  setWorkspaceVisible: (value: boolean) => void;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  projects: ReturnType<typeof createProjectPlanning>["projects"];
  projectSearchQuery: SourceAccessor<string>;
  setProjectSearchQuery: Setter<string>;
  filteredProjects: Accessor<DesktopProject[]>;
  selectedProjectID: SourceAccessor<string | undefined>;
  setPreloadProjectID: ReturnType<typeof createProjectPlanning>["setPreloadProjectID"];
  selectProject: (projectID: string, fromInbox?: boolean, publish?: boolean) => void;
  workspaceVisible: SourceAccessor<boolean>;
  setupVisible: () => boolean;
  workspaceView: () => WorkspaceView | undefined;
  workspaceTabs: () => WorkspaceTab[];
  openKnowledge: ReturnType<typeof createKnowledgeState>["open"];
  detail: Accessor<TicketDetail | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  activateWorkspaceTab: (tab: WorkspaceTab) => void;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  ideTargets: () => RuntimeDockTarget[];
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  selectedChange: Accessor<Change | undefined>;
  openIDETarget: (target: RuntimeDockTarget) => Promise<void>;
  previewTargets: () => RuntimeDockTarget[];
  openPreviewTarget: (target: RuntimeDockTarget) => Promise<void>;
  inbox: {
    view: SourceAccessor<
      | {
          items: {
            id: string;
            eventId: string;
            projectId: string;
            projectName: string;
            ticketId: string | null;
            ticketTitle: string;
            title: string;
            preview: string;
            createdAt: string;
            needsAction: boolean;
            unread: boolean;
            archived: boolean;
            updates: number;
            target: "ticket" | "conversation" | "review" | "coding" | "inputs";
            targetId: string | null;
            contextId: string | null;
          }[];
          count: number;
        }
      | undefined
    >;
    loading: SourceAccessor<boolean>;
    busy: SourceAccessor<boolean>;
    error: SourceAccessor<string>;
    refresh: () => Promise<void>;
    mark: (item: InboxItem, action: "read" | "unread" | "archive") => Promise<void>;
  };
  returnToInbox: (publish?: boolean) => void;
  agentOverlay: () => boolean;
  foundTickets: ReturnType<typeof createProjectPlanning>["foundTickets"];
  setFind: ReturnType<typeof createProjectPlanning>["setFind"];
  boardStatus: (ticket: Ticket) => string;
  pending: () => boolean;
  openTicketDraft: (proposed?: PersonalTicketDraft, stage?: "inbox" | "ready") => void;
  settingsControlElement: HTMLDivElement | undefined;
  settingsOpen: SourceAccessor<boolean>;
  settingsPopover: HTMLElement | undefined;
  openSettings: () => void;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  backgroundSaves: SourceAccessor<Record<string, boolean>>;
  canManageProject: () => boolean;
  backgroundChoices: SourceAccessor<DesktopBackground[]>;
  backgroundPickerExpanded: SourceAccessor<boolean>;
  desktopBackgroundKey: () =>
    | "river-landscape"
    | "the-harvesters"
    | "mountainous-landscape"
    | "gulf-of-marseille"
    | "scene-on-the-ice"
    | "moonlit-landscape";
  chooseDesktopBackground: (key: DesktopBackgroundKey) => Promise<void>;
  setBackgroundPickerExpanded: Setter<boolean>;
}

export function DesktopTopbar(props: { model: DesktopTopbarModel }) {
  // The model identity is stable; its accessors retain live state.
  const model = untrack(() => props.model);
  return (
    <header class="factory-topbar" inert={model.registrationOpen()}>
      <div class="topbar-start">
        <button
          type="button"
          class={model.agentOpen() ? "icon-button agent-toggle open" : "icon-button agent-toggle"}
          aria-label="Toggle Agent panel"
          ref={model.agentToggleElement}
          aria-expanded={model.agentOpen() ? "true" : "false"}
          data-state={model.agentOpen() ? "open" : "closed"}
          data-tooltip="Agent"
          onPointerDown={() => {
            if (!model.agentOpen()) model.rememberAgentOpener();
          }}
          onClick={(event) => {
            if (!model.agentOpen() && event.detail === 0) model.rememberAgentOpener();
            model.setAgentOpen((open) => !open);
          }}
        >
          <Icon name={model.agentOpen() ? "agent-panel" : "agent"} />
        </button>
        <div class="context-control" ref={model.projectControlElement}>
          <Show when={!model.narrowViewport()}>
            <button
              type="button"
              class="context-button project-selector"
              aria-label="Open project menu"
              aria-expanded={model.projectMenuOpen() ? "true" : "false"}
              aria-controls="project-popover"
              title={model.selectedProject()?.name ?? "Choose project"}
              onClick={() => {
                model.setSettingsOpen(false);
                model.setProjectMenuOpen((open) => !open);
              }}
            >
              <span>{model.selectedProject()?.name ?? "Choose project"}</span>
              <Icon name="chevron" />
            </button>
          </Show>
          <Show when={model.projectMenuOpen()}>
            <section
              class="floating-menu project-menu"
              id="project-popover"
              aria-label="Projects"
              ref={model.projectPopover}
            >
              <div class="menu-heading">
                <strong>Projects</strong>
                <Show when={model.bootstrap.session.systemManager}>
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => {
                      model.setProjectMenuOpen(false);
                      model.setError("");
                      model.setWorkspaceVisible(false);
                      void model.projectSetup?.open();
                    }}
                  >
                    {model.projectSetup?.draft() && model.projectSetup.draft()?.state !== "created"
                      ? "Continue setup"
                      : "Create project"}
                  </button>
                </Show>
              </div>
              <Show when={(model.projects.data() ?? []).length > 6}>
                <div class="project-search">
                  <input
                    type="search"
                    aria-label="Search projects"
                    placeholder="Find a project"
                    value={model.projectSearchQuery()}
                    onInput={(event) => model.setProjectSearchQuery(event.currentTarget.value)}
                  />
                </div>
              </Show>
              <div class="project-list">
                <For each={model.filteredProjects()} keyed={(project) => project.id}>
                  {(project) => (
                    <article
                      class={
                        model.selectedProjectID() === project().id
                          ? "project-row selected"
                          : "project-row"
                      }
                    >
                      <button
                        type="button"
                        class="project-choice"
                        aria-current={
                          model.selectedProjectID() === project().id ? "true" : undefined
                        }
                        onPointerEnter={() => model.setPreloadProjectID(project().id)}
                        onFocus={() => model.setPreloadProjectID(project().id)}
                        onClick={() => model.selectProject(project().id)}
                      >
                        <span>
                          <strong>{project().name}</strong>
                          <small>{project().slug}</small>
                        </span>
                        <Show when={model.selectedProjectID() === project().id}>
                          <span class="selection-dot" />
                        </Show>
                      </button>
                    </article>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </div>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Native dock buttons also delegate keyboard-generated clicks to this navigation handler. */}
      <nav
        class="workspace-dock"
        aria-label="Workspace dock"
        onClick={(event) => {
          if (
            model.narrowViewport() &&
            event.target instanceof Element &&
            event.target.closest("button")
          )
            model.setAgentOpen(false);
        }}
      >
        <DockButton
          label="Desktop"
          icon="home"
          active={!model.workspaceVisible()}
          onClick={() => model.setWorkspaceVisible(false)}
        />
        <Show when={!model.setupVisible() && model.selectedProject()}>
          <DockButton
            label="Knowledge"
            icon="knowledge"
            active={model.workspaceVisible() && model.workspaceView() === "knowledge"}
            open={model.workspaceTabs().some((tab) => tab.view === "knowledge")}
            onClick={() => void model.openKnowledge()}
            onMinimize={() => model.setWorkspaceVisible(false)}
          />
        </Show>
        <Show when={!model.setupVisible() && model.detail()}>
          <DockButton
            label="Ticket"
            icon="ticket"
            active={model.workspaceVisible() && model.workspaceView() === "ticket"}
            open={model.workspaceTabs().some((tab) => tab.view === "ticket")}
            onMinimize={() => model.setWorkspaceVisible(false)}
            onClick={() => {
              const openTicket = props.model
                .workspaceTabs()
                .find((tab) => tab.view === "ticket" && tab.ticketID === model.selectedTicketID());
              if (openTicket) model.activateWorkspaceTab(openTicket);
              else {
                const ticketID = model.selectedTicketID();
                if (ticketID) model.selectTicket(ticketID);
              }
            }}
          />
        </Show>
        <Show when={!model.setupVisible() && model.ideTargets().length > 0}>
          <DockAppButton
            label="IDE"
            icon="ide"
            active={model.workspaceVisible() && model.workspaceView() === "ide"}
            open={model.workspaceTabs().some((tab) => tab.view === "ide")}
            targets={model.ideTargets()}
            selectedID={
              model.activeWorkspaceTab()?.view === "ide"
                ? model.activeWorkspaceTab()?.id.slice(4)
                : undefined
            }
            preferredID={
              props.model
                .ideTargets()
                .find((target) => target.changeId === model.selectedChange()?.id)?.id
            }
            onSelect={(target) => void model.openIDETarget(target)}
            onMinimize={() => model.setWorkspaceVisible(false)}
          />
        </Show>
        <Show when={!model.setupVisible() && model.previewTargets().length > 0}>
          <DockAppButton
            label="Preview"
            icon="preview"
            active={model.workspaceVisible() && model.workspaceView() === "preview"}
            open={model.workspaceTabs().some((tab) => tab.view === "preview")}
            targets={model.previewTargets()}
            selectedID={
              model.activeWorkspaceTab()?.view === "preview"
                ? model.activeWorkspaceTab()?.appChannel
                  ? model.activeWorkspaceTab()?.id
                  : model.activeWorkspaceTab()?.id.slice(8)
                : undefined
            }
            onSelect={(target) => void model.openPreviewTarget(target)}
            onMinimize={() => model.setWorkspaceVisible(false)}
          />
        </Show>
        <DockButton
          label="Inbox"
          icon="inbox"
          count={model.inbox.view()?.count}
          active={model.workspaceVisible() && model.workspaceView() === "inbox"}
          open={model.workspaceTabs().some((tab) => tab.view === "inbox")}
          onClick={() => {
            model.returnToInbox();
          }}
          onMinimize={() => {
            if (model.agentOverlay()) model.setAgentOpen(false);
            else model.setWorkspaceVisible(false);
          }}
        />
      </nav>

      <div class="topbar-end">
        <Show when={!model.narrowViewport() && !model.setupVisible() && model.selectedProject()}>
          <TicketQuickFind
            tickets={(model.foundTickets.data() as Ticket[] | undefined) ?? []}
            onQueryChange={model.setFind}
            loading={model.foundTickets.completeness() === "unknown"}
            failed={Boolean(model.foundTickets.error())}
            reference={ticketReference}
            status={model.boardStatus}
            onSelect={model.selectTicket}
            disabled={model.pending()}
          />
        </Show>
        <Show when={!model.narrowViewport() && !model.setupVisible() && model.selectedProject()}>
          <button
            type="button"
            class="new-ticket-button topbar-new-ticket"
            aria-label="New Ticket"
            onClick={() => model.openTicketDraft(undefined, "ready")}
          >
            New ticket
          </button>
        </Show>
        <div class="settings-control" ref={model.settingsControlElement}>
          <button
            type="button"
            class="icon-button"
            aria-label="Settings"
            aria-expanded={model.settingsOpen() ? "true" : "false"}
            aria-controls="settings-popover"
            data-tooltip="Settings"
            onClick={() => {
              model.setSettingsOpen((open) => !open);
              model.setProjectMenuOpen(false);
            }}
          >
            <Icon name="settings" />
          </button>
          <Show when={model.settingsOpen()}>
            <section
              class="floating-menu settings-menu"
              id="settings-popover"
              aria-label="Settings"
              ref={model.settingsPopover}
            >
              <div class="settings-identity">
                <small>Signed in as</small>
                <strong>{model.bootstrap.session.user.name}</strong>
                <span>{model.bootstrap.session.user.email}</span>
              </div>
              <Show when={model.narrowViewport()}>
                <button
                  type="button"
                  class="settings-model-link settings-project-link"
                  aria-label="Open project menu"
                  aria-controls="project-popover"
                  onClick={() => {
                    model.setSettingsOpen(false);
                    model.setProjectMenuOpen(true);
                  }}
                >
                  <Icon name="home" />
                  <span>{model.selectedProject()?.name ?? "Choose project"}</span>
                  <small>Switch project</small>
                </button>
              </Show>
              <button
                type="button"
                class="settings-model-link"
                aria-label="Open settings"
                onClick={model.openSettings}
              >
                <Icon name="settings" />
                <span>Open settings</span>
                <small>
                  Account{model.selectedProject() ? ", Project" : ""}
                  {model.bootstrap.session.systemManager ? ", Factory" : ""}
                </small>
              </button>
              <Show when={model.selectedProject()}>
                <button
                  type="button"
                  class="settings-model-link"
                  onClick={() => {
                    model.setSettingsOpen(false);
                    model.openWorkspaceTab({ id: "trash", view: "trash", label: "Trash" });
                  }}
                >
                  <Icon name="inbox" />
                  <span>Trash</span>
                </button>
              </Show>
              <Show when={!model.setupVisible() && model.selectedProject()}>
                <fieldset
                  class="background-picker"
                  aria-busy={
                    model.backgroundSaves()[model.selectedProjectID() ?? ""] ? "true" : "false"
                  }
                >
                  <legend>Project background</legend>
                  <p class="background-hint">
                    Shared with everyone in {model.selectedProject()?.name}.
                    <Show when={!model.canManageProject()}>
                      {" "}
                      Only project managers can change it.
                    </Show>
                  </p>
                  <div class="background-options" id="background-options">
                    <For each={model.backgroundChoices()}>
                      {(background, index) => (
                        <button
                          type="button"
                          class={`background-option background-${background.key}`}
                          hidden={!model.backgroundPickerExpanded() && index() >= 2}
                          aria-pressed={
                            model.desktopBackgroundKey() === background.key ? "true" : "false"
                          }
                          disabled={!model.canManageProject()}
                          aria-disabled={
                            model.backgroundSaves()[model.selectedProjectID() ?? ""]
                              ? "true"
                              : undefined
                          }
                          onClick={() => void model.chooseDesktopBackground(background.key)}
                        >
                          <span class="background-preview" aria-hidden="true" />
                          <span class="background-copy">
                            <strong>{background.title}</strong>
                            <small>
                              {background.artist}, {background.date}
                            </small>
                          </span>
                          <span class="background-selection" aria-hidden="true" />
                        </button>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    class="background-expand"
                    aria-expanded={model.backgroundPickerExpanded() ? "true" : "false"}
                    aria-controls="background-options"
                    onClick={() => model.setBackgroundPickerExpanded((expanded) => !expanded)}
                  >
                    <Show when={!model.backgroundPickerExpanded()}>
                      <span class="background-peek" aria-hidden="true">
                        <span
                          class={`background-option background-${model.backgroundChoices()[2]?.key}`}
                        >
                          <span class="background-preview" />
                          <span class="background-copy">
                            <strong>{model.backgroundChoices()[2]?.title}</strong>
                            <small>
                              {model.backgroundChoices()[2]?.artist},{" "}
                              {model.backgroundChoices()[2]?.date}
                            </small>
                          </span>
                        </span>
                      </span>
                    </Show>
                    <span class="background-expand-label">
                      {model.backgroundPickerExpanded()
                        ? "Show fewer backgrounds"
                        : `Show all ${model.backgroundChoices().length} backgrounds`}
                      <Icon name="chevron" />
                    </span>
                  </button>
                  <Show when={model.backgroundSaves()[model.selectedProjectID() ?? ""]}>
                    <p class="background-hint" role="status">
                      Saving project background…
                    </p>
                  </Show>
                </fieldset>
              </Show>
            </section>
          </Show>
        </div>
      </div>
    </header>
  );
}
