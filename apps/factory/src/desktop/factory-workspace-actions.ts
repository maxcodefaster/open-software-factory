import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createEffect, onSettled } from "solid-js";
import type { EpicProposal } from "#conversation-domain/epic-proposal";
import type { Ticket } from "../change/contracts";
import { plainErrorMessage } from "../command-error";
import type { DeliveryView } from "../delivery/contracts";
import type { FactoryLocation } from "../navigation/location";
import type { ConversationView } from "../project-agent/contracts";
import { ticketReference } from "../projects/ticket-content";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { createWorkspaceState } from "../workspace/state";
import type { WorkspaceTab } from "../workspace-tabs";
import type { DesktopProject, ReadTicketDetail, TicketDetail } from "./contracts";

export interface FactoryWorkspaceActionsDependencies {
  workspaces: ReturnType<typeof createWorkspaceState>;
  workspaceTabs: () => WorkspaceTab[];
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  workspaceVisible: SourceAccessor<boolean>;
  setWorkspaceVisible: (value: boolean) => void;
  setWorkspaceFocusTarget: Setter<string | undefined>;
  captureWorkspaceOpener: () => void;
  captureSettingsOpener: () => void;
  captureReopenOpener: () => void;
  closeMenus: () => void;
  narrowViewport: Accessor<boolean>;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  setupVisible: () => boolean;
  selectedProject: Accessor<DesktopProject | undefined>;
  selectedProjectID: SourceAccessor<string | undefined>;
  setSelectedProjectID: Setter<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  setDelivery: Setter<DeliveryView | undefined>;
  setConversation: (value: ConversationView | undefined) => void;
  resetAgentView: () => void;
  resetKnowledge: () => void;
  epicProposals: SourceAccessor<Record<string, EpicProposal>>;
  ticketList: Accessor<Ticket[]>;
  setSyncError: Setter<string>;
  bumpTicketReadGeneration: () => void;
  clearInboxNavigation: (resetQueue?: boolean) => void;
  setInboxFeedbackID: (value: string | undefined) => void;
  refreshTicketDetail: ReadTicketDetail;
  refreshConversation: (projectID?: string, ticketID?: string) => Promise<unknown>;
  publishWorkspaceLocation: (tab?: WorkspaceTab) => void;
  publishLocation: (
    location: Exclude<FactoryLocation, { view: "unavailable" }>,
    replace?: boolean,
  ) => void;
}

export function createFactoryWorkspaceActions(dependencies: FactoryWorkspaceActionsDependencies) {
  createEffect(
    () => dependencies.activeWorkspaceTab()?.proposalID,
    (proposalID) => {
      if (proposalID && !dependencies.epicProposals()[proposalID])
        void dependencies.refreshConversation();
    },
  );

  function openWorkspaceTab(tab: WorkspaceTab, publish = true) {
    dependencies.captureWorkspaceOpener();
    dependencies.workspaces.open(tab);
    dependencies.setWorkspaceVisible(true);
    dependencies.setWorkspaceFocusTarget(tab.id);
    if (publish) dependencies.publishWorkspaceLocation(tab);
  }

  function openSettings() {
    dependencies.captureSettingsOpener();
    dependencies.closeMenus();
    if (dependencies.narrowViewport()) dependencies.setAgentOpen(false);
    const setupProject = dependencies.projectSetup?.draft();
    const project = dependencies.setupVisible()
      ? setupProject?.projectID
        ? { id: setupProject.projectID, name: setupProject.name }
        : undefined
      : dependencies.selectedProject();
    const tab = dependencies
      .workspaceTabs()
      .find(
        (candidate) =>
          candidate.view === "settings" && candidate.settingsProject?.id === project?.id,
      );
    openWorkspaceTab(
      tab ?? {
        id: `settings:${project?.id ?? "factory"}`,
        view: "settings",
        label: "Settings",
        ...(project ? { settingsProject: { id: project.id, name: project.name } } : {}),
      },
    );
  }

  function loadTicketContext(ticketID: string, read = true) {
    const projectID = dependencies.selectedProjectID();
    dependencies.bumpTicketReadGeneration();
    dependencies.setSelectedTicketID(ticketID);
    dependencies.setDetail(undefined);
    dependencies.resetAgentView();
    dependencies.setDelivery(undefined);
    dependencies.setConversation(undefined);
    if (!read) return;
    onSettled(() => {
      if (
        dependencies.selectedProjectID() !== projectID ||
        dependencies.selectedTicketID() !== ticketID
      )
        return;
      void dependencies
        .refreshTicketDetail(ticketID)
        .catch((cause) =>
          dependencies.setSyncError(
            cause instanceof Error ? plainErrorMessage(cause.message) : "The Ticket could not load",
          ),
        );
      void dependencies
        .refreshConversation(projectID, ticketID)
        .catch((cause) =>
          dependencies.setSyncError(
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "The conversation could not load",
          ),
        );
    });
  }

  function activateWorkspaceTab(tab: WorkspaceTab, publish = true) {
    const reopening = !dependencies.workspaceVisible();
    if (reopening) dependencies.captureReopenOpener();
    dependencies.clearInboxNavigation(true);
    dependencies.workspaces.activate(tab);
    dependencies.setWorkspaceVisible(true);
    if (reopening) dependencies.setWorkspaceFocusTarget(tab.id);
    if (tab.ticketID && tab.ticketID !== dependencies.selectedTicketID()) {
      loadTicketContext(tab.ticketID);
    }
    if (publish) dependencies.publishWorkspaceLocation(tab);
  }

  // An unavailable link keeps its URL and notice, but leaves no blank Ticket window or stray tab.
  function discardUnavailableTicket(ticketID: string) {
    const result = dependencies.workspaces.close(`ticket:${ticketID}`);
    if (dependencies.selectedTicketID() === ticketID) {
      dependencies.setSelectedTicketID(undefined);
      dependencies.setDetail(undefined);
    }
    if (!result?.closed) return;
    if (result.next) activateWorkspaceTab(result.next, false);
    else if (!result.state.tabs.length) dependencies.setWorkspaceVisible(false);
  }

  function closeWorkspaceTab(tabID: string) {
    const result = dependencies.workspaces.close(tabID);
    if (!result?.closed) return;
    if (!result.state.tabs.length) dependencies.setWorkspaceVisible(false);
    if (result.next) activateWorkspaceTab(result.next);
    else dependencies.publishWorkspaceLocation();
  }

  function selectTicket(ticketID: string, fromInbox = false, read = true, publish = true) {
    dependencies.clearInboxNavigation(!fromInbox);
    dependencies.setInboxFeedbackID(undefined);
    const ticket = dependencies.ticketList().find((candidate) => candidate.id === ticketID);
    const retained = dependencies
      .workspaceTabs()
      .find((tab) => tab.view === "ticket" && tab.ticketID === ticketID);
    if (retained && retained.id !== `ticket:${ticketID}`)
      dependencies.workspaces.close(retained.id);
    loadTicketContext(ticketID, read);
    openWorkspaceTab(
      {
        id: `ticket:${ticketID}`,
        view: "ticket",
        label: ticket?.title ?? ticketReference(ticketID),
        ticketID,
      },
      publish,
    );
  }

  function selectProject(projectID: string, fromInbox = false, publish = true) {
    dependencies.clearInboxNavigation(!fromInbox);
    if (publish || fromInbox) dependencies.projectSetup?.show(false);
    dependencies.resetAgentView();
    dependencies.setSelectedProjectID(projectID);
    dependencies.setSelectedTicketID(undefined);
    dependencies.setDetail(undefined);
    dependencies.setWorkspaceVisible(false);
    dependencies.resetKnowledge();
    dependencies.setConversation(undefined);
    onSettled(() => {
      if (dependencies.selectedProjectID() !== projectID) return;
      void dependencies
        .refreshConversation(projectID, undefined)
        .catch((cause) =>
          dependencies.setSyncError(
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "The conversation could not load",
          ),
        );
    });
    dependencies.closeMenus();
    if (publish) dependencies.publishLocation({ view: "project", projectID });
  }

  return {
    openWorkspaceTab,
    openSettings,
    loadTicketContext,
    activateWorkspaceTab,
    discardUnavailableTicket,
    closeWorkspaceTab,
    selectTicket,
    selectProject,
  };
}
