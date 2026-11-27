import type { Accessor, SourceAccessor } from "solid-js";
import { Show, untrack } from "solid-js";
import { AttachmentProvider } from "../attachments/ui";
import { MentionSupport } from "../inbox/mentions";
import type { createKnowledgeState } from "../knowledge/state";
import { unavailableLink } from "../navigation/desktop";
import type { FactoryNavigation } from "../navigation/router";
import type { createProjectPlanning } from "../projects/planning";
import type { createWorkspaceState } from "../workspace/state";
import { AssistantPanel, type AssistantPanelModel } from "./assistant-panel";
import { DocumentWindow, type DocumentWindowModel } from "./document-window";
import { AgentOverlayBackdrop, DesktopMenuBackdrop, DesktopNotices } from "./factory-modals";
import type { createFactoryUrlSync } from "./factory-url-sync";
import type { createFactoryWindowState } from "./factory-window-state";
import { ProjectBoard, type ProjectBoardModel } from "./project-board";
import { SkipToBoard } from "./skip-to-board";
import { DesktopTopbar, type DesktopTopbarModel } from "./topbar";

export interface FactoryDesktopShellProps {
  selectedProjectID: SourceAccessor<string | undefined>;
  assistantTicketID: Accessor<string | undefined>;
  attachmentScopeKey: Accessor<string>;
  windowState: ReturnType<typeof createFactoryWindowState>;
  navigation: FactoryNavigation | undefined;
  urlSync: ReturnType<typeof createFactoryUrlSync>;
  planning: ReturnType<typeof createProjectPlanning>;
  workspaces: ReturnType<typeof createWorkspaceState>;
  knowledge: ReturnType<typeof createKnowledgeState>;
  trashTickets: DocumentWindowModel["trashTickets"];
  error: SourceAccessor<string>;
  syncError: SourceAccessor<string>;
  refreshServerState: () => Promise<void>;
  desktopTopbarModel: DesktopTopbarModel;
  projectBoardModel: ProjectBoardModel;
  assistantPanelModel: AssistantPanelModel;
  documentWindowModel: DocumentWindowModel;
}

export function FactoryDesktopShell(props: FactoryDesktopShellProps) {
  const shell = untrack(() => props);
  const { windowState, urlSync, planning, workspaces, knowledge } = shell;

  const syncQueries = () => {
    const knowledgeOpen = workspaces.tabs().some((tab) => tab.view === "knowledge");
    return [
      planning.projects,
      planning.memberships,
      ...(shell.selectedProjectID()
        ? [
            planning.tickets,
            planning.history,
            planning.epics,
            planning.dependencies,
            planning.prerequisiteTickets,
          ]
        : []),
      ...(knowledgeOpen ? [knowledge.pages] : []),
      ...(workspaces.tabs().some((tab) => tab.view === "trash") ? [shell.trashTickets] : []),
      ...(knowledge.selectedPageID() && knowledgeOpen ? [knowledge.page] : []),
    ];
  };

  const navigationFailure = () =>
    urlSync.desktopNavigation.failure() ||
    shell.navigation?.failure() ||
    (urlSync.missingWikiLink() ? unavailableLink : undefined);

  return (
    <AttachmentProvider projectId={shell.selectedProjectID()} scopeKey={shell.attachmentScopeKey()}>
      <main
        ref={(element) => {
          windowState.refs.desktopElement = element;
        }}
        class={`factory-desktop${windowState.agentOpen() ? " agent-is-open" : ""}${windowState.agentOverlay() ? " agent-is-overlay" : ""}`}
        data-background={windowState.desktopBackgroundKey()}
      >
        <h1 class="sr-only">Delivery floor</h1>
        <Show when={!windowState.workspaceVisible()}>
          <SkipToBoard />
        </Show>
        <MentionSupport
          projectID={shell.selectedProjectID()}
          sharedTicket={Boolean(shell.assistantTicketID())}
        />

        <DesktopMenuBackdrop
          open={() => windowState.activeMenu() !== "none"}
          onClose={windowState.closeMenus}
        />

        <DesktopTopbar model={shell.desktopTopbarModel} />

        <DesktopNotices
          onNoticesRef={(element) => {
            windowState.refs.noticesElement = element;
          }}
          pendingNavigation={() => urlSync.desktopNavigation.pending()}
          navigationFailure={navigationFailure}
          onRetryNavigation={() => urlSync.desktopNavigation.retry()}
          error={shell.error}
          syncQueries={syncQueries}
          syncError={shell.syncError}
          onRetrySync={shell.refreshServerState}
        />

        <ProjectBoard model={shell.projectBoardModel} />

        <AgentOverlayBackdrop
          visible={windowState.agentOverlay}
          onDismiss={windowState.dismissAgent}
        />
        <AssistantPanel model={shell.assistantPanelModel} />

        <DocumentWindow model={shell.documentWindowModel} />
      </main>
    </AttachmentProvider>
  );
}
