import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type { EpicProposal } from "#conversation-domain/epic-proposal";
import type { FactoryZeroContext, FactoryZeroSchema } from "#zero-schema";
import type { useZero } from "#zero-solid";
import type { Change, PersonalTicketDraft, TicketDraft } from "../change/contracts";
import type { DeliveryView } from "../delivery/contracts";
import type { ActivityNavigationRequest } from "../ide-messages";
import { createKnowledgeState } from "../knowledge/state";
import type { FactoryNavigation } from "../navigation/router";
import type { createConversationSelection } from "../project-agent/selection";
import type { createProjectPlanning } from "../projects/planning";
import type { AppPreview, RuntimeAttempt } from "../runtime/contracts";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { createWorkspaceState } from "../workspace/state";
import type { createAssistantPresentation } from "./assistant-presentation";
import type { createBoardProjection } from "./board-projection";
import type { DesktopMutation, TicketDetail } from "./contracts";
import type { createConversationState } from "./conversation-state";
import type { createFactoryAgentState, ImplementationPreparation } from "./factory-agent-state";
import { createFactoryCommands } from "./factory-commands";
import { createFactoryInboxState } from "./factory-inbox-state";
import { createFactoryUrlSync } from "./factory-url-sync";
import type { createFactoryWindowState } from "./factory-window-state";
import { createFactoryWorkspaceActions } from "./factory-workspace-actions";
import { createDesktopReads } from "./reads";
import type { DesktopLifecycleGuard } from "./window-state-machine";

export interface FactoryDesktopWiringDependencies {
  userID: string;
  systemManager: boolean;
  navigation: FactoryNavigation | undefined;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  lifecycle: DesktopLifecycleGuard;
  planning: ReturnType<typeof createProjectPlanning>;
  workspaces: ReturnType<typeof createWorkspaceState>;
  board: ReturnType<typeof createBoardProjection>;
  windowState: ReturnType<typeof createFactoryWindowState>;
  agentState: ReturnType<typeof createFactoryAgentState>;
  presentation: ReturnType<typeof createAssistantPresentation>;
  conversationSelection: ReturnType<typeof createConversationSelection>;
  conversationState: ReturnType<typeof createConversationState>;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  setupVisible: () => boolean;
  selectedProjectID: SourceAccessor<string | undefined>;
  setSelectedProjectID: Setter<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  assistantTicketID: () => string | undefined;
  assistantContextLoading: () => boolean;
  assistantPending: () => boolean;
  canDevelopProject: () => boolean;
  epicProposals: SourceAccessor<Record<string, EpicProposal>>;
  detail: Accessor<TicketDetail | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  delivery: Accessor<DeliveryView | undefined>;
  setDelivery: Setter<DeliveryView | undefined>;
  changes: Accessor<Change[]>;
  setChanges: Setter<Change[]>;
  attempts: Accessor<RuntimeAttempt[]>;
  setAttempts: Setter<RuntimeAttempt[]>;
  setAppPreviews: Setter<AppPreview[]>;
  setLifecycleProjectID: Setter<string | undefined>;
  error: SourceAccessor<string>;
  setError: Setter<string>;
  setSyncError: Setter<string>;
  mutate: DesktopMutation;
  personalDrafts: Map<string, PersonalTicketDraft>;
  personalDraftKey: () => string;
  ticketDrafts: Map<string, TicketDraft>;
  clarificationOrigins: Set<string>;
  correctionTarget: SourceAccessor<string | undefined>;
  setCorrectionTarget: Setter<string | undefined>;
  implementationPreparation: SourceAccessor<ImplementationPreparation | undefined>;
  setImplementationPreparation: Setter<ImplementationPreparation | undefined>;
  pendingInterviewAnswer: SourceAccessor<
    { key: string; questionID: string; text: string } | undefined
  >;
  setPendingInterviewAnswer: Setter<{ key: string; questionID: string; text: string } | undefined>;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
}

export function createFactoryDesktopWiring(dependencies: FactoryDesktopWiringDependencies) {
  const {
    userID,
    systemManager,
    navigation,
    zero,
    lifecycle,
    planning,
    workspaces,
    board,
    windowState,
    agentState,
    presentation,
    conversationSelection,
    conversationState,
    projectSetup,
    setupVisible,
  } = dependencies;

  const workspaceActions = createFactoryWorkspaceActions({
    workspaces,
    workspaceTabs: workspaces.tabs,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    workspaceVisible: windowState.workspaceVisible,
    setWorkspaceVisible: windowState.setWorkspaceVisible,
    setWorkspaceFocusTarget: windowState.setWorkspaceFocusTarget,
    captureWorkspaceOpener: windowState.captureWorkspaceOpener,
    captureSettingsOpener: windowState.captureSettingsOpener,
    captureReopenOpener: windowState.captureReopenOpener,
    closeMenus: windowState.closeMenus,
    narrowViewport: windowState.narrowViewport,
    setAgentOpen: windowState.setAgentOpen,
    projectSetup,
    setupVisible,
    selectedProject: board.selectedProject,
    selectedProjectID: dependencies.selectedProjectID,
    setSelectedProjectID: dependencies.setSelectedProjectID,
    selectedTicketID: dependencies.selectedTicketID,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    setDetail: dependencies.setDetail,
    setDelivery: dependencies.setDelivery,
    setConversation: conversationState.replace,
    resetAgentView: agentState.resetAgentView,
    resetKnowledge: () => knowledge.reset(),
    epicProposals: dependencies.epicProposals,
    ticketList: board.ticketList,
    setSyncError: dependencies.setSyncError,
    bumpTicketReadGeneration: () => lifecycle.bumpTicketReadGeneration(),
    clearInboxNavigation: (resetQueue) => inboxState.clearNavigation(resetQueue),
    setInboxFeedbackID: (value) => inboxState.setInboxFeedbackID(value),
    refreshTicketDetail: (ticketID) => reads.refreshTicketDetail(ticketID),
    refreshConversation: (projectID, ticketID) => reads.refreshConversation(projectID, ticketID),
    publishWorkspaceLocation: (tab) => urlSync.publishWorkspaceLocation(tab),
    publishLocation: (destination, replace) => urlSync.publishLocation(destination, replace),
  });

  const knowledge = createKnowledgeState({
    projectID: dependencies.selectedProjectID,
    canDevelop: dependencies.canDevelopProject,
    tabs: workspaces.tabs,
    openTab: workspaceActions.openWorkspaceTab,
    mutate: dependencies.mutate,
    onError: dependencies.setError,
  });

  const reads = createDesktopReads({
    selectedProjectID: dependencies.selectedProjectID,
    setChanges: dependencies.setChanges,
    setAttempts: dependencies.setAttempts,
    setAppPreviews: dependencies.setAppPreviews,
    workspaces,
    setLifecycleProjectID: dependencies.setLifecycleProjectID,
    detail: dependencies.detail,
    selectedTicketID: dependencies.selectedTicketID,
    selectedChange: presentation.selectedChange,
    agentOpen: windowState.agentOpen,
    agentReadFence: agentState.agentReadFence,
    publishAgentView: agentState.publishAgentView,
    setDelivery: dependencies.setDelivery,
    resetAgentView: agentState.resetAgentView,
    setSyncError: dependencies.setSyncError,
    assistantTicketID: dependencies.assistantTicketID,
    workspaceTabs: workspaces.tabs,
    refreshKnowledge: knowledge.refresh,
    agentActivityRevision: agentState.agentActivityRevision,
    setAgent: agentState.setAgent,
    get ticketReadGeneration() {
      return lifecycle.ticketReadGeneration;
    },
    set ticketReadGeneration(value) {
      lifecycle.ticketReadGeneration = value;
    },
    get workspaceDisposed() {
      return lifecycle.disposed;
    },
    set workspaceDisposed(value) {
      lifecycle.disposed = value;
    },
    setDetail: dependencies.setDetail,
    conversationReadFence: conversationState,
    selectedConversation: conversationSelection.selected,
    setConversation: conversationState.replace,
    acknowledgeConversation: agentState.acknowledgeConversation,
    setError: dependencies.setError,
    publishConversation: conversationState.publish,
  });

  const inboxState = createFactoryInboxState({
    selectedProjectID: dependencies.selectedProjectID,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    narrowViewport: windowState.narrowViewport,
    setAgentOpen: windowState.setAgentOpen,
    setConversationSelections: conversationSelection.setSelections,
    pauseClarification: conversationSelection.pause,
    setWorkspaceFocusTarget: windowState.setWorkspaceFocusTarget,
    setError: dependencies.setError,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    selectProject: workspaceActions.selectProject,
    selectTicket: workspaceActions.selectTicket,
    refreshConversation: reads.refreshConversation,
    refreshTicketDetail: reads.refreshTicketDetail,
  });

  const urlSync = createFactoryUrlSync({
    userID,
    systemManager,
    navigation,
    projects: planning.projects,
    projectWorkspaces: workspaces.states,
    selectedProjectID: dependencies.selectedProjectID,
    setSelectedProjectID: dependencies.setSelectedProjectID,
    selectedTicketID: dependencies.selectedTicketID,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    detail: dependencies.detail,
    setDetail: dependencies.setDetail,
    setConversation: conversationState.replace,
    setChanges: dependencies.setChanges,
    setAttempts: dependencies.setAttempts,
    setAppPreviews: dependencies.setAppPreviews,
    setDelivery: dependencies.setDelivery,
    resetAgentView: agentState.resetAgentView,
    invalidateConversation: () => conversationState.invalidate(),
    bumpTicketReadGeneration: () => lifecycle.bumpTicketReadGeneration(),
    setWorkspaceVisible: windowState.setWorkspaceVisible,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    workspaceView: windowState.workspaceView,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    updateWorkspaceTab: workspaces.update,
    discardUnavailableTicket: workspaceActions.discardUnavailableTicket,
    selectProject: workspaceActions.selectProject,
    selectTicket: workspaceActions.selectTicket,
    returnToInbox: inboxState.returnToInbox,
    refreshTicketDetail: reads.refreshTicketDetail,
    refreshConversation: reads.refreshConversation,
    projectSetup,
    knowledge,
  });

  const commands = createFactoryCommands({
    userID,
    zero,
    lifecycle,
    planning,
    workspaces,
    board,
    windowState,
    agentState,
    presentation,
    workspaceActions,
    reads,
    conversationSelection,
    conversationState,
    selectedProjectID: dependencies.selectedProjectID,
    selectedTicketID: dependencies.selectedTicketID,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    assistantTicketID: dependencies.assistantTicketID,
    assistantContextLoading: dependencies.assistantContextLoading,
    assistantPending: dependencies.assistantPending,
    canDevelopProject: dependencies.canDevelopProject,
    detail: dependencies.detail,
    setDetail: dependencies.setDetail,
    delivery: dependencies.delivery,
    setDelivery: dependencies.setDelivery,
    changes: dependencies.changes,
    attempts: dependencies.attempts,
    error: dependencies.error,
    setError: dependencies.setError,
    mutate: dependencies.mutate,
    personalDrafts: dependencies.personalDrafts,
    personalDraftKey: dependencies.personalDraftKey,
    ticketDrafts: dependencies.ticketDrafts,
    clarificationOrigins: dependencies.clarificationOrigins,
    correctionTarget: dependencies.correctionTarget,
    setCorrectionTarget: dependencies.setCorrectionTarget,
    implementationPreparation: dependencies.implementationPreparation,
    setImplementationPreparation: dependencies.setImplementationPreparation,
    pendingInterviewAnswer: dependencies.pendingInterviewAnswer,
    setPendingInterviewAnswer: dependencies.setPendingInterviewAnswer,
    setIDENavigation: dependencies.setIDENavigation,
  });

  return {
    workspaceActions,
    knowledge,
    reads,
    inboxState,
    urlSync,
    ...commands,
  };
}
