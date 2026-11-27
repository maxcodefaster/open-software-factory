import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type { FactoryZeroContext, FactoryZeroSchema } from "#zero-schema";
import type { useZero } from "#zero-solid";
import type { Change, PersonalTicketDraft, TicketDraft } from "../change/contracts";
import type { DeliveryView } from "../delivery/contracts";
import type { ActivityNavigationRequest } from "../ide-messages";
import type { createConversationSelection } from "../project-agent/selection";
import type { createProjectPlanning } from "../projects/planning";
import type { RuntimeAttempt } from "../runtime/contracts";
import type { createWorkspaceState } from "../workspace/state";
import type { createAssistantPresentation } from "./assistant-presentation";
import type { createBoardProjection } from "./board-projection";
import { createCodingCommands } from "./coding-commands";
import type { DesktopMutation, TicketDetail } from "./contracts";
import { createConversationCommands } from "./conversation-commands";
import type { createConversationState } from "./conversation-state";
import type { createFactoryAgentState, ImplementationPreparation } from "./factory-agent-state";
import { commitZeroMutation, type createFactoryWindowState } from "./factory-window-state";
import type { createFactoryWorkspaceActions } from "./factory-workspace-actions";
import { createProjectCommands } from "./project-commands";
import type { createDesktopReads } from "./reads";
import { createRuntimeNavigation } from "./runtime-navigation";
import { createTicketCommands } from "./ticket-commands";
import type { DesktopLifecycleGuard } from "./window-state-machine";

export interface FactoryCommandsDependencies {
  userID: string;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  lifecycle: DesktopLifecycleGuard;
  planning: ReturnType<typeof createProjectPlanning>;
  workspaces: ReturnType<typeof createWorkspaceState>;
  board: ReturnType<typeof createBoardProjection>;
  windowState: ReturnType<typeof createFactoryWindowState>;
  agentState: ReturnType<typeof createFactoryAgentState>;
  presentation: ReturnType<typeof createAssistantPresentation>;
  workspaceActions: ReturnType<typeof createFactoryWorkspaceActions>;
  reads: ReturnType<typeof createDesktopReads>;
  conversationSelection: ReturnType<typeof createConversationSelection>;
  conversationState: ReturnType<typeof createConversationState>;
  selectedProjectID: SourceAccessor<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  assistantTicketID: () => string | undefined;
  assistantContextLoading: () => boolean;
  assistantPending: () => boolean;
  canDevelopProject: () => boolean;
  detail: Accessor<TicketDetail | undefined>;
  setDetail: Setter<TicketDetail | undefined>;
  delivery: Accessor<DeliveryView | undefined>;
  setDelivery: Setter<DeliveryView | undefined>;
  changes: Accessor<Change[]>;
  attempts: Accessor<RuntimeAttempt[]>;
  error: SourceAccessor<string>;
  setError: Setter<string>;
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

export function createFactoryCommands(dependencies: FactoryCommandsDependencies) {
  const {
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
  } = dependencies;

  const projectCommands = createProjectCommands({
    mutate: dependencies.mutate,
    zero,
    selectedProjectID: dependencies.selectedProjectID,
    commitZeroMutation,
    setSelectedEpicID: planning.setSelectedEpicID,
    error: dependencies.error,
    detail: dependencies.detail,
    refreshTicketDetail: reads.refreshTicketDetail,
    personalDrafts: dependencies.personalDrafts,
    personalDraftKey: dependencies.personalDraftKey,
    ticketDrafts: dependencies.ticketDrafts,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    setDetail: dependencies.setDetail,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    userID,
    workspaces,
    workspaceVisible: windowState.workspaceVisible,
    selectTicket: workspaceActions.selectTicket,
  });

  const ticketCommands = createTicketCommands({
    detail: dependencies.detail,
    latestRevision: presentation.latestRevision,
    mutate: dependencies.mutate,
    agentCommandIds: agentState.agentCommandIds,
    acknowledgeCommand: agentState.acknowledgeCommand,
    refreshTicketDetail: reads.refreshTicketDetail,
    setAgentOpen: windowState.setAgentOpen,
    refreshConversation: reads.refreshConversation,
    canDevelopProject: dependencies.canDevelopProject,
    selectedProjectID: dependencies.selectedProjectID,
    setSelectedEpicID: planning.setSelectedEpicID,
    closeWorkspaceTab: workspaceActions.closeWorkspaceTab,
    selectTicket: workspaceActions.selectTicket,
    refreshServerState: reads.refreshServerState,
    selectedTicketID: dependencies.selectedTicketID,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    setDetail: dependencies.setDetail,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    ticketList: board.ticketList,
    selectedChange: presentation.selectedChange,
    implementationPreparation: dependencies.implementationPreparation,
    setError: dependencies.setError,
    setImplementationPreparation: dependencies.setImplementationPreparation,
    preparingImplementation: presentation.preparingImplementation,
    assistantTicketID: dependencies.assistantTicketID,
    changeFor: board.changeFor,
    setCorrectionTarget: dependencies.setCorrectionTarget,
    setDelivery: dependencies.setDelivery,
    refreshLifecycleState: reads.refreshLifecycleState,
    delivery: dependencies.delivery,
    agentCommandScope: agentState.agentCommandScope,
  });

  const codingCommands = createCodingCommands({
    assistantContextLoading: dependencies.assistantContextLoading,
    selectedProjectID: dependencies.selectedProjectID,
    assistantTicketID: dependencies.assistantTicketID,
    selectedChange: presentation.selectedChange,
    assistantKey: conversationSelection.key,
    agentCommandScope: agentState.agentCommandScope,
    mutate: dependencies.mutate,
    agentCommandIds: agentState.agentCommandIds,
    conversation: conversationState.current,
    acknowledgeCommand: agentState.acknowledgeCommand,
    setConversationSelections: conversationSelection.setSelections,
    conversationScope: conversationSelection.scope,
    refreshServerState: reads.refreshServerState,
    publishConversation: conversationState.publish,
    codingWriterBlocked: presentation.codingWriterBlocked,
    setError: dependencies.setError,
    agent: agentState.agent,
    chosenCodingReasoning: agentState.chosenCodingReasoning,
    publishAgentView: agentState.publishAgentView,
    refreshLifecycleState: reads.refreshLifecycleState,
    delivery: dependencies.delivery,
    retryReview: ticketCommands.retryReview,
    conversationMode: presentation.conversationMode,
    agentReadFence: agentState.agentReadFence,
    historicalCoding: presentation.historicalCoding,
    correctionTarget: dependencies.correctionTarget,
  });

  const conversationCommands = createConversationCommands({
    assistantContextLoading: dependencies.assistantContextLoading,
    assistantPending: dependencies.assistantPending,
    canPromptBuild: presentation.canPromptBuild,
    promptAgent: codingCommands.promptAgent,
    selectedProjectID: dependencies.selectedProjectID,
    assistantTicketID: dependencies.assistantTicketID,
    detail: dependencies.detail,
    setAgentOpen: windowState.setAgentOpen,
    pauseClarification: conversationSelection.pause,
    pendingInterview: presentation.pendingInterview,
    clarificationOrigins: dependencies.clarificationOrigins,
    assistantKey: conversationSelection.key,
    selectedChange: presentation.selectedChange,
    moveTicket: projectCommands.moveTicket,
    conversation: conversationState.current,
    clarificationPaused: conversationSelection.paused,
    agentCommandScope: agentState.agentCommandScope,
    publishProvisionalAnswer: conversationState.publishProvisional,
    clearProvisionalAnswer: conversationState.clearProvisional,
    get workspaceDisposed() {
      return lifecycle.disposed;
    },
    set workspaceDisposed(value) {
      lifecycle.disposed = value;
    },
    acknowledgeCommand: agentState.acknowledgeCommand,
    mutate: dependencies.mutate,
    publishConversation: conversationState.publish,
    agentCommandIds: agentState.agentCommandIds,
    trackConversationStream: conversationState.trackStream,
    refreshConversation: reads.refreshConversation,
    selectedTicketID: dependencies.selectedTicketID,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    refreshTicketDetail: reads.refreshTicketDetail,
    setError: dependencies.setError,
    setPendingInterviewAnswer: dependencies.setPendingInterviewAnswer,
    pendingInterviewAnswer: dependencies.pendingInterviewAnswer,
  });

  const runtimeNavigation = createRuntimeNavigation({
    canDevelopProject: dependencies.canDevelopProject,
    selectedProjectID: dependencies.selectedProjectID,
    changes: dependencies.changes,
    loadTicketContext: workspaceActions.loadTicketContext,
    setSelectedTicketID: dependencies.setSelectedTicketID,
    setDetail: dependencies.setDetail,
    resetAgentView: agentState.resetAgentView,
    setConversation: conversationState.replace,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    mutate: dependencies.mutate,
    updateWorkspaceTab: workspaces.update,
    refreshServerState: reads.refreshServerState,
    selectedChange: presentation.selectedChange,
    ideTargets: agentState.ideTargets,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    setIDENavigation: dependencies.setIDENavigation,
    workspaceTabs: workspaces.tabs,
    activateWorkspaceTab: workspaceActions.activateWorkspaceTab,
    attempts: dependencies.attempts,
    previewTargets: agentState.previewTargets,
  });

  return {
    projectCommands,
    ticketCommands,
    codingCommands,
    conversationCommands,
    runtimeNavigation,
  };
}
