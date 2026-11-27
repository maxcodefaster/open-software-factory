import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createEffect, untrack } from "solid-js";
import { takeSettingsReturn } from "../access/settings-return";
import type { Change } from "../change/contracts";
import type { DeliveryView } from "../delivery/contracts";
import type { createKnowledgeState } from "../knowledge/state";
import { createDesktopNavigation, unavailableLink } from "../navigation/desktop";
import { type FactoryLocation, factoryPath } from "../navigation/location";
import type { FactoryNavigation } from "../navigation/router";
import type { ConversationView } from "../project-agent/contracts";
import type { createProjectPlanning } from "../projects/planning";
import type { AppPreview, RuntimeAttempt } from "../runtime/contracts";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { ProjectWorkspaceState, WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import type { ReadTicketDetail, TicketDetail } from "./contracts";

export interface FactoryUrlSyncDependencies {
  userID: string;
  systemManager: boolean;
  navigation: FactoryNavigation | undefined;
  projects: ReturnType<typeof createProjectPlanning>["projects"];
  projectWorkspaces: Accessor<Record<string, ProjectWorkspaceState>>;
  selectedProjectID: SourceAccessor<string | undefined>;
  setSelectedProjectID: Setter<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  detail: Accessor<TicketDetail | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  setConversation: (value: ConversationView | undefined) => void;
  setChanges: Setter<Change[]>;
  setAttempts: Setter<RuntimeAttempt[]>;
  setAppPreviews: Setter<AppPreview[]>;
  setDelivery: Setter<DeliveryView | undefined>;
  resetAgentView: () => void;
  invalidateConversation: () => void;
  bumpTicketReadGeneration: () => void;
  setWorkspaceVisible: (value: boolean) => void;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  workspaceView: () => WorkspaceView | undefined;
  openWorkspaceTab: (tab: WorkspaceTab, publish?: boolean) => void;
  updateWorkspaceTab: (tab: WorkspaceTab, key?: string | undefined) => void;
  discardUnavailableTicket: (ticketID: string) => void;
  selectProject: (projectID: string, fromInbox?: boolean, publish?: boolean) => void;
  selectTicket: (ticketID: string, fromInbox?: boolean, read?: boolean, publish?: boolean) => void;
  returnToInbox: (publish?: boolean) => void;
  refreshTicketDetail: ReadTicketDetail;
  refreshConversation: (projectID?: string, ticketID?: string) => Promise<unknown>;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  knowledge: ReturnType<typeof createKnowledgeState>;
}

export function createFactoryUrlSync(dependencies: FactoryUrlSyncDependencies) {
  const securityReturn = takeSettingsReturn(dependencies.userID);
  let securityReturnRestored = false;
  let restoredLocation = false;

  createEffect(
    () => ({
      list: dependencies.projects.data()?.map((project) => ({ ...project })),
      completeness: dependencies.projects.completeness(),
      // Reconcile external availability, not an optimistic local selection.
      selected: untrack(dependencies.selectedProjectID),
      home: untrack(
        () => !dependencies.navigation || dependencies.navigation.location().view === "home",
      ),
      factoryTabs: untrack(() => Boolean(dependencies.projectWorkspaces()["factory"]?.tabs.length)),
      manager: dependencies.systemManager,
    }),
    ({ list, completeness, selected, home, factoryTabs, manager }) => {
      if (
        completeness === "complete" &&
        selected &&
        !list?.some((project) => project.id === selected)
      ) {
        dependencies.bumpTicketReadGeneration();
        dependencies.invalidateConversation();
        dependencies.setSelectedProjectID(undefined);
        dependencies.setSelectedTicketID(undefined);
        dependencies.setDetail(undefined);
        dependencies.setConversation(undefined);
        dependencies.setChanges([]);
        dependencies.setAttempts([]);
        dependencies.setAppPreviews([]);
        dependencies.setDelivery(undefined);
        dependencies.resetAgentView();
        dependencies.setWorkspaceVisible(false);
      }
      if (list && securityReturn && !securityReturnRestored) {
        securityReturnRestored = true;
        const project =
          securityReturn.project && list.find((item) => item.id === securityReturn.project?.id);
        if (
          (!securityReturn.project || project) &&
          (securityReturn.scope !== "system" || manager)
        ) {
          dependencies.setSelectedProjectID(project?.id);
          dependencies.openWorkspaceTab({
            id: `settings:${project?.id ?? "factory"}`,
            view: "settings",
            label: "Settings",
            ...(project ? { settingsProject: { id: project.id, name: project.name } } : {}),
            settingsSelection: { scope: securityReturn.scope, category: securityReturn.category },
          });
          return;
        }
      }
      // A slow planning projection must not replace Settings already opened at Factory scope.
      if (home && !selected && !factoryTabs && list?.[0])
        dependencies.setSelectedProjectID(list[0].id);
    },
  );

  function workspaceLocation(
    tab?: WorkspaceTab,
  ): Exclude<FactoryLocation, { view: "unavailable" }> {
    const projectID = dependencies.selectedProjectID();
    if (tab?.view === "inbox") return { view: "inbox" };
    if (tab?.view === "settings")
      return {
        view: "settings",
        ...(tab.settingsProject ? { projectID: tab.settingsProject.id } : {}),
      };
    if (projectID && tab?.view === "ticket" && tab.ticketID)
      return { view: "ticket", projectID, ticketID: tab.ticketID };
    if (projectID && tab?.view === "knowledge") {
      const pageID = dependencies.knowledge.selectedPageID();
      return { view: "knowledge", projectID, ...(pageID ? { pageID } : {}) };
    }
    return projectID ? { view: "project", projectID } : { view: "home" };
  }

  const desktopNavigation = createDesktopNavigation({
    navigation: dependencies.navigation,
    ready: () =>
      dependencies.projects.completeness() === "complete" &&
      (!securityReturn || securityReturnRestored),
    accessKey: () => {
      const destination = dependencies.navigation?.location();
      return destination && "projectID" in destination && destination.projectID
        ? String(
            dependencies.projects.data()?.some((project) => project.id === destination.projectID),
          )
        : "personal";
    },
    async apply(destination, current) {
      if (destination.view === "unavailable") throw new Error(unavailableLink);
      const initialRestoration = !restoredLocation;
      // Initial Board hydration is not a human decision to leave retained
      // setup. Explicit resource links and later history navigation are.
      if (restoredLocation || !["home", "project"].includes(destination.view))
        dependencies.projectSetup?.show(false);
      restoredLocation = true;
      if ("projectID" in destination && destination.projectID) {
        if (!dependencies.projects.data()?.some((project) => project.id === destination.projectID))
          throw new Error(unavailableLink);
        if (dependencies.selectedProjectID() !== destination.projectID) {
          // Initial binding can finish under a user-open menu. It is not a
          // manual switch that dismisses controls and resets local work.
          if (initialRestoration) dependencies.setSelectedProjectID(destination.projectID);
          else dependencies.selectProject(destination.projectID, false, false);
          // Solid 2 batches writes. Commit the Project before reading scoped
          // state or opening a tab, without publishing an intermediate URL.
          await Promise.resolve();
          if (!current()) return;
        }
      }
      if (destination.view === "ticket") {
        if (
          dependencies.selectedTicketID() === destination.ticketID &&
          dependencies.detail()?.ticket.id === destination.ticketID &&
          dependencies.workspaceView() === "ticket"
        ) {
          dependencies.setWorkspaceVisible(true);
          return;
        }
        dependencies.selectTicket(destination.ticketID, false, false, false);
        await Promise.resolve();
        if (!current()) return;
        const loaded = await dependencies
          .refreshTicketDetail(destination.ticketID)
          .catch((cause) => {
            if (current()) dependencies.discardUnavailableTicket(destination.ticketID);
            throw cause;
          });
        if (!current()) return;
        if (!loaded) {
          dependencies.discardUnavailableTicket(destination.ticketID);
          throw new Error(unavailableLink);
        }
        dependencies.updateWorkspaceTab({
          id: `ticket:${destination.ticketID}`,
          view: "ticket",
          label: loaded.ticket.title,
          ticketID: destination.ticketID,
        });
        await dependencies.refreshConversation(destination.projectID, destination.ticketID);
      } else if (destination.view === "knowledge") {
        dependencies.knowledge.select(destination.pageID);
        await dependencies.knowledge.open(false);
      } else if (destination.view === "settings") {
        const project = destination.projectID
          ? dependencies.projects
              .data()
              ?.find((candidate) => candidate.id === destination.projectID)
          : undefined;
        dependencies.openWorkspaceTab(
          {
            id: `settings:${destination.projectID ?? "factory"}`,
            view: "settings",
            label: "Settings",
            ...(project ? { settingsProject: { id: project.id, name: project.name } } : {}),
          },
          false,
        );
      } else if (destination.view === "inbox") dependencies.returnToInbox(false);
      else {
        // Home uses the normal default-Project selection. Do not replay a
        // Project switch when its initial projection completes under an open
        // menu, or discard the retained tabs when returning to the Board.
        dependencies.setWorkspaceVisible(false);
      }
    },
  });

  function publishLocation(
    destination: Exclude<FactoryLocation, { view: "unavailable" }>,
    replace = false,
  ) {
    restoredLocation = true;
    desktopNavigation.publish(destination, replace);
  }

  function publishWorkspaceLocation(tab?: WorkspaceTab) {
    publishLocation(workspaceLocation(tab));
  }

  function selectKnowledgePage(pageID: string) {
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    dependencies.knowledge.select(pageID);
    publishLocation({
      view: "knowledge",
      projectID,
      pageID,
    });
  }

  async function archiveKnowledgePage() {
    const projectID = dependencies.selectedProjectID();
    if (
      (await dependencies.knowledge.archive()) &&
      projectID &&
      dependencies.selectedProjectID() === projectID &&
      dependencies.workspaceView() === "knowledge"
    )
      publishLocation({ view: "knowledge", projectID });
  }

  async function openDocument(path: string) {
    const projectID = dependencies.selectedProjectID();
    if (
      (await dependencies.knowledge.openDocument(path)) &&
      projectID &&
      dependencies.selectedProjectID() === projectID &&
      dependencies.workspaceView() === "knowledge"
    )
      publishLocation({ view: "knowledge", projectID });
  }

  const missingWikiLink = () => {
    const destination = dependencies.navigation?.location();
    return (
      destination?.view === "knowledge" &&
      destination.pageID &&
      dependencies.knowledge.selectedPageID() === destination.pageID &&
      dependencies.knowledge.page.completeness() === "complete" &&
      !dependencies.knowledge.page.data()
    );
  };

  const shareableURL = () => {
    const tab = dependencies.activeWorkspaceTab();
    return dependencies.navigation &&
      tab &&
      ["ticket", "knowledge", "settings", "inbox"].includes(tab.view) &&
      !(tab.view === "knowledge" && dependencies.knowledge.document()) &&
      !desktopNavigation.pending() &&
      !desktopNavigation.failure() &&
      !dependencies.navigation.failure() &&
      !missingWikiLink()
      ? new URL(factoryPath(workspaceLocation(tab)), location.origin).href
      : undefined;
  };

  return {
    desktopNavigation,
    publishLocation,
    publishWorkspaceLocation,
    selectKnowledgePage,
    archiveKnowledgePage,
    openDocument,
    missingWikiLink,
    shareableURL,
  };
}
