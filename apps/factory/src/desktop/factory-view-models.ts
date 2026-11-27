import type { Accessor, Setter, SourceAccessor } from "solid-js";
import type { EpicProposal } from "#conversation-domain/epic-proposal";
import type { FactoryZeroContext, FactoryZeroSchema } from "#zero-schema";
import type { useZero } from "#zero-solid";
import type { WriterView } from "../agent/contracts";
import type { Change, PersonalTicketDraft, TicketDraft } from "../change/contracts";
import type { DeliveryView } from "../delivery/contracts";
import type { ActivityNavigationRequest } from "../ide-messages";
import type { createKnowledgeState } from "../knowledge/state";
import type { FactoryNavigation } from "../navigation/router";
import type { createConversationSelection } from "../project-agent/selection";
import type { createProjectPlanning } from "../projects/planning";
import type { AppPreview, RuntimeAttempt } from "../runtime/contracts";
import type { createProjectSetupInteraction } from "../setup/panel";
import type { createWorkspaceState } from "../workspace/state";
import type { AssistantPanelModel } from "./assistant-panel";
import type { createAssistantPresentation } from "./assistant-presentation";
import type { createBoardProjection } from "./board-projection";
import type { createCodingCommands } from "./coding-commands";
import type { DesktopMutation, FactoryDesktopProps, TicketDetail } from "./contracts";
import type { createConversationCommands } from "./conversation-commands";
import type { createConversationState } from "./conversation-state";
import type { DocumentWindowModel } from "./document-window";
import type { createFactoryAgentState, ImplementationPreparation } from "./factory-agent-state";
import type { createFactoryInboxState } from "./factory-inbox-state";
import type { createFactoryUrlSync } from "./factory-url-sync";
import { commitZeroMutation, type createFactoryWindowState } from "./factory-window-state";
import type { createFactoryWorkspaceActions } from "./factory-workspace-actions";
import type { ProjectBoardModel } from "./project-board";
import type { createProjectCommands } from "./project-commands";
import type { createDesktopReads } from "./reads";
import type { createRuntimeNavigation } from "./runtime-navigation";
import type { createTicketCommands } from "./ticket-commands";
import type { DesktopTopbarModel } from "./topbar";

export interface FactoryViewModelsDependencies {
  bootstrap: FactoryDesktopProps;
  navigation: FactoryNavigation | undefined;
  zero: ReturnType<typeof useZero<FactoryZeroSchema, undefined, FactoryZeroContext>>;
  planning: ReturnType<typeof createProjectPlanning>;
  workspaces: ReturnType<typeof createWorkspaceState>;
  board: ReturnType<typeof createBoardProjection>;
  windowState: ReturnType<typeof createFactoryWindowState>;
  agentState: ReturnType<typeof createFactoryAgentState>;
  presentation: ReturnType<typeof createAssistantPresentation>;
  workspaceActions: ReturnType<typeof createFactoryWorkspaceActions>;
  knowledge: ReturnType<typeof createKnowledgeState>;
  reads: ReturnType<typeof createDesktopReads>;
  inboxState: ReturnType<typeof createFactoryInboxState>;
  urlSync: ReturnType<typeof createFactoryUrlSync>;
  projectCommands: ReturnType<typeof createProjectCommands>;
  ticketCommands: ReturnType<typeof createTicketCommands>;
  codingCommands: ReturnType<typeof createCodingCommands>;
  conversationCommands: ReturnType<typeof createConversationCommands>;
  runtimeNavigation: ReturnType<typeof createRuntimeNavigation>;
  conversationSelection: ReturnType<typeof createConversationSelection>;
  conversationState: ReturnType<typeof createConversationState>;
  projectSetup: ReturnType<typeof createProjectSetupInteraction> | undefined;
  setupVisible: () => boolean;
  selectedProjectID: SourceAccessor<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  assistantTicketID: () => string | undefined;
  assistantContextLoading: () => boolean;
  assistantPending: () => boolean;
  epicProposals: SourceAccessor<Record<string, EpicProposal>>;
  detail: Accessor<TicketDetail | undefined>;
  delivery: Accessor<DeliveryView | undefined>;
  changes: Accessor<Change[]>;
  attempts: Accessor<RuntimeAttempt[]>;
  appPreviews: Accessor<AppPreview[]>;
  modelRelayConfigured: SourceAccessor<boolean>;
  refreshModelAvailability: () => Promise<void>;
  browserRepository: () => string | undefined;
  canDevelopProject: () => boolean;
  canManageProject: () => boolean;
  canManageSettingsProject: (projectID: string | undefined) => boolean;
  pending: () => boolean;
  mutate: DesktopMutation;
  setError: Setter<string>;
  personalDraftKey?: () => string;
  personalDrafts: Map<string, PersonalTicketDraft>;
  ticketDrafts: Map<string, TicketDraft>;
  trashTickets: DocumentWindowModel["trashTickets"];
  projectSearchQuery: SourceAccessor<string>;
  setProjectSearchQuery: Setter<string>;
  boardHistoryOpen: SourceAccessor<boolean>;
  setBoardHistoryOpen: Setter<boolean>;
  ideNavigation: SourceAccessor<ActivityNavigationRequest | undefined>;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
  setCodingWriter: Setter<{ changeID: string; view: WriterView | undefined } | undefined>;
  setImplementationPreparation: Setter<ImplementationPreparation | undefined>;
}

export function createFactoryViewModels(dependencies: FactoryViewModelsDependencies) {
  const {
    bootstrap,
    navigation,
    zero,
    planning,
    workspaces,
    board,
    windowState,
    agentState,
    presentation,
    workspaceActions,
    knowledge,
    reads,
    inboxState,
    urlSync,
    projectCommands,
    ticketCommands,
    codingCommands,
    conversationCommands,
    runtimeNavigation,
    conversationSelection,
    conversationState,
    projectSetup,
    setupVisible,
  } = dependencies;

  const knowledgePageList = () => knowledge.pages.data() ?? [];
  const selectedKnowledgePage = () => knowledge.page.data();

  const documentWindowModel: DocumentWindowModel = {
    get workspaceElement() {
      return windowState.refs.workspaceElement;
    },
    set workspaceElement(value) {
      windowState.refs.workspaceElement = value;
    },
    workspaceView: windowState.workspaceView,
    workspaceWindow: windowState.workspaceWindow,
    workspaceVisible: windowState.workspaceVisible,
    workspaceTabs: workspaces.tabs,
    agentOverlay: windowState.agentOverlay,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    shareableURL: urlSync.shareableURL,
    activateWorkspaceTab: workspaceActions.activateWorkspaceTab,
    closeWorkspaceTab: workspaceActions.closeWorkspaceTab,
    setWorkspaceVisible: windowState.setWorkspaceVisible,
    inboxSourceActive: inboxState.inboxSourceActive,
    nextInboxItem: inboxState.nextInboxItem,
    inboxSourceOpening: inboxState.inboxSourceOpening,
    inbox: inboxState.inbox,
    returnToInbox: inboxState.returnToInbox,
    startInboxItem: inboxState.startInboxItem,
    activeWorkspaceLabelID: windowState.activeWorkspaceLabelID,
    epicProposals: dependencies.epicProposals,
    bootstrap,
    pending: dependencies.pending,
    confirmEpicWork: ticketCommands.confirmEpicWork,
    personalDrafts: dependencies.personalDrafts,
    selectedProjectID: dependencies.selectedProjectID,
    publishTicketDraft: projectCommands.publishTicketDraft,
    updateWorkspaceTab: workspaces.update,
    detail: dependencies.detail,
    inboxFeedbackID: inboxState.inboxFeedbackID,
    ticketDrafts: dependencies.ticketDrafts,
    confirmRequirements: ticketCommands.confirmRequirements,
    ticketClarificationAction: presentation.ticketClarificationAction,
    selectedChange: presentation.selectedChange,
    delivery: dependencies.delivery,
    latestRevision: presentation.latestRevision,
    latestRequirement: presentation.latestRequirement,
    agentTurnBusy: presentation.agentTurnBusy,
    epicList: board.epicList,
    prerequisitesFor: board.prerequisitesFor,
    dependencyCandidates: board.dependencyCandidates,
    selectTicket: workspaceActions.selectTicket,
    editDependency: projectCommands.editDependency,
    assignTicketEpic: projectCommands.assignTicketEpic,
    beginRequirementsInterview: conversationCommands.beginRequirementsInterview,
    saveTechnicalDesign: ticketCommands.saveTechnicalDesign,
    assistantPending: dependencies.assistantPending,
    assistantTicketID: dependencies.assistantTicketID,
    saveTicketDocument: ticketCommands.saveTicketDocument,
    createFollowUp: ticketCommands.createFollowUp,
    setSelectedEpicID: planning.setSelectedEpicID,
    ticketTrashCommand: ticketCommands.ticketTrashCommand,
    implementTicket: ticketCommands.implementTicket,
    preparingImplementation: presentation.preparingImplementation,
    openCodingOptions: ticketCommands.openCodingOptions,
    agentOpen: windowState.agentOpen,
    modelRelayConfigured: dependencies.modelRelayConfigured,
    agent: agentState.agent,
    resumeCoding: codingCommands.resumeCoding,
    stopAgent: codingCommands.stopAgent,
    ideTargets: agentState.ideTargets,
    openIDETarget: runtimeNavigation.openIDETarget,
    startPersonalIDE: runtimeNavigation.startPersonalIDE,
    ticketPreviewTarget: runtimeNavigation.ticketPreviewTarget,
    openPreviewTarget: runtimeNavigation.openPreviewTarget,
    retryMainPreview: runtimeNavigation.retryMainPreview,
    approveDelivery: ticketCommands.approveDelivery,
    retryReview: ticketCommands.retryReview,
    retryPromotion: ticketCommands.retryPromotion,
    resumeChecks: ticketCommands.resumeChecks,
    canDevelopProject: dependencies.canDevelopProject,
    browserRepository: dependencies.browserRepository,
    knowledgeDrafts: knowledge.drafts,
    knowledgeLoading: knowledge.loading,
    knowledgePageList,
    selectedKnowledgePage,
    repositoryDocuments: knowledge.documents,
    loadRepositoryDocuments: knowledge.loadDocuments,
    openRepositoryDocument: knowledge.document,
    knowledgeGeneration: knowledge.generation,
    knowledgeHistory: knowledge.history,
    knowledgeSearch: knowledge.results,
    knowledgeSearchQuery: knowledge.query,
    selectKnowledgePage: urlSync.selectKnowledgePage,
    openDocument: urlSync.openDocument,
    mutate: dependencies.mutate,
    generateKnowledge: knowledge.generate,
    searchProjectKnowledge: knowledge.search,
    editKnowledgePage: knowledge.save,
    loadKnowledgeHistory: knowledge.loadHistory,
    archiveKnowledgePage: urlSync.archiveKnowledgePage,
    zero,
    commitZeroMutation,
    inboxPosition: inboxState.inboxPosition,
    inboxRestoreKey: inboxState.inboxRestoreKey,
    setInboxPosition: inboxState.setInboxPosition,
    trashTickets: dependencies.trashTickets,
    trashLimit: planning.trashLimit,
    setTrashLimit: planning.setTrashLimit,
    canManageSettingsProject: dependencies.canManageSettingsProject,
    refreshModelAvailability: dependencies.refreshModelAvailability,
    selectProject: workspaceActions.selectProject,
    memberships: planning.memberships,
    attempts: dependencies.attempts,
    appPreviews: dependencies.appPreviews,
    changes: dependencies.changes,
    deliveryBlockFor: agentState.deliveryBlockFor,
    projectMenuOpen: windowState.projectMenuOpen,
    ideNavigation: dependencies.ideNavigation,
    setIDENavigation: dependencies.setIDENavigation,
    setError: dependencies.setError,
    refreshServerState: reads.refreshServerState,
    openDevelopmentPreview: runtimeNavigation.openDevelopmentPreview,
  };

  const assistantPanelModel: AssistantPanelModel = {
    agentPresence: windowState.agentPresence,
    agentOpen: windowState.agentOpen,
    agentOverlay: windowState.agentOverlay,
    get agentPanelElement() {
      return windowState.refs.agentPanelElement;
    },
    set agentPanelElement(value) {
      windowState.refs.agentPanelElement = value;
    },
    inboxSourceActive: inboxState.inboxSourceActive,
    nextInboxItem: inboxState.nextInboxItem,
    inboxSourceOpening: inboxState.inboxSourceOpening,
    inboxBusy: inboxState.inbox.busy,
    returnToInbox: inboxState.returnToInbox,
    startInboxItem: inboxState.startInboxItem,
    setupVisible,
    preparingImplementation: presentation.preparingImplementation,
    detail: dependencies.detail,
    dismissAgent: windowState.dismissAgent,
    projectSetup,
    openSettings: workspaceActions.openSettings,
    selectProject: workspaceActions.selectProject,
    conversationScope: conversationSelection.scope,
    assistantTicketID: dependencies.assistantTicketID,
    ticketList: board.ticketList,
    selectedProject: board.selectedProject,
    conversation: conversationState.current,
    canDevelopProject: dependencies.canDevelopProject,
    conversationMode: presentation.conversationMode,
    assistantPending: dependencies.assistantPending,
    assistantContextLoading: dependencies.assistantContextLoading,
    codingWriterBlocked: presentation.codingWriterBlocked,
    agentViewLoaded: presentation.agentViewLoaded,
    agentCanRun: presentation.agentCanRun,
    agentTurnBusy: presentation.agentTurnBusy,
    agent: agentState.agent,
    agentNeedsResolution: presentation.agentNeedsResolution,
    setConversationSelections: conversationSelection.setSelections,
    newConversation: codingCommands.newConversation,
    setImplementationPreparation: dependencies.setImplementationPreparation,
    selectedChange: presentation.selectedChange,
    ticketWorkspaceReady: presentation.ticketWorkspaceReady,
    ticketWorkspaceStatus: presentation.ticketWorkspaceStatus,
    pending: dependencies.pending,
    recheckStopConfirmation: codingCommands.recheckStopConfirmation,
    checkStopStatus: codingCommands.checkStopStatus,
    get conversationScroll() {
      return agentState.conversationScroll;
    },
    set conversationScroll(value) {
      agentState.conversationScroll = value;
    },
    visibleConversation: presentation.visibleConversation,
    openChatActivity: runtimeNavigation.openChatActivity,
    answeredQuestionIDs: presentation.answeredQuestionIDs,
    answerSummary: presentation.answerSummary,
    latestRevision: presentation.latestRevision,
    workspaceView: windowState.workspaceView,
    restoredInterviewAnswer: agentState.restoredInterviewAnswer,
    bootstrap,
    pendingInterview: presentation.pendingInterview,
    currentInterviewQuestion: presentation.currentInterviewQuestion,
    pauseClarification: conversationSelection.pause,
    setAgentOpen: windowState.setAgentOpen,
    answerInterview: conversationCommands.answerInterview,
    epicProposals: dependencies.epicProposals,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    selectTicket: workspaceActions.selectTicket,
    setError: dependencies.setError,
    openTicketDraft: projectCommands.openTicketDraft,
    setSelectedEpicID: planning.setSelectedEpicID,
    browserRepository: dependencies.browserRepository,
    selectKnowledgePage: urlSync.selectKnowledgePage,
    openKnowledge: knowledge.open,
    streamedAnswer: conversationState.provisional,
    setCodingWriter: dependencies.setCodingWriter,
    historicalCoding: presentation.historicalCoding,
    retainedCodingDraft: presentation.retainedCodingDraft,
    assistantKey: conversationSelection.key,
    selectedProjectID: dependencies.selectedProjectID,
    stopAgent: codingCommands.stopAgent,
    restoredMessageScope: agentState.restoredMessageScope,
    agentCommandScope: agentState.agentCommandScope,
    implementTicket: ticketCommands.implementTicket,
    canPromptBuild: presentation.canPromptBuild,
    startAgent: codingCommands.startAgent,
    promptAgent: codingCommands.promptAgent,
    restoreMessageDraft: agentState.restoreMessageDraft,
    chosenCodingReasoning: agentState.chosenCodingReasoning,
    setCodingReasoningChoices: agentState.setCodingReasoningChoices,
    modelRelayConfigured: dependencies.modelRelayConfigured,
    blockersFor: board.blockersFor,
    selectedTicketID: dependencies.selectedTicketID,
    interviewOwnsComposer: presentation.interviewOwnsComposer,
    sendConversationMessage: conversationCommands.sendConversationMessage,
    conversationPlaceholder: presentation.conversationPlaceholder,
  };

  const projectBoardModel: ProjectBoardModel = {
    workspaceVisible: windowState.workspaceVisible,
    agentOverlay: windowState.agentOverlay,
    setupVisible,
    selectedProject: board.selectedProject,
    projectsLoading: () => {
      const destination = navigation?.location();
      // Explicit Project links use the restore/access notice, not the chooser,
      // including the batched gap between query completeness and selection.
      return (
        planning.projects.completeness() !== "complete" ||
        urlSync.desktopNavigation.pending() ||
        Boolean(destination && "projectID" in destination && destination.projectID)
      );
    },
    setProjectMenuOpen: windowState.setProjectMenuOpen,
    narrowViewport: windowState.narrowViewport,
    historyTickets: board.historyTickets,
    boardHasMore: board.boardHasMore,
    ticketLimit: planning.ticketLimit,
    boardHistoryOpen: dependencies.boardHistoryOpen,
    setBoardHistoryOpen: dependencies.setBoardHistoryOpen,
    history: planning.history,
    historyLimit: planning.historyLimit,
    boardPageLoading: board.boardPageLoading,
    setHistoryLimit: planning.setHistoryLimit,
    setTicketLimit: planning.setTicketLimit,
    boardPageLabel: board.boardPageLabel,
    foundTickets: planning.foundTickets,
    setFind: planning.setFind,
    boardStatus: board.boardStatus,
    selectTicket: workspaceActions.selectTicket,
    pending: dependencies.pending,
    openTicketDraft: projectCommands.openTicketDraft,
    scopedTickets: board.scopedTickets,
    epicList: board.epicList,
    lane: board.lane,
    selectedTicketID: dependencies.selectedTicketID,
    blockersFor: board.blockersFor,
    selectedEpicID: planning.selectedEpicID,
    setSelectedEpicID: planning.setSelectedEpicID,
    saveEpic: projectCommands.saveEpic,
    tickets: planning.tickets,
  };

  const desktopTopbarModel: DesktopTopbarModel = {
    agentOpen: windowState.agentOpen,
    get agentToggleElement() {
      return windowState.refs.agentToggleElement;
    },
    set agentToggleElement(value) {
      windowState.refs.agentToggleElement = value;
    },
    rememberAgentOpener: windowState.rememberAgentOpener,
    setAgentOpen: windowState.setAgentOpen,
    get projectControlElement() {
      return windowState.refs.projectControlElement;
    },
    set projectControlElement(value) {
      windowState.refs.projectControlElement = value;
    },
    narrowViewport: windowState.narrowViewport,
    activeMenu: windowState.activeMenu,
    setActiveMenu: windowState.setActiveMenu,
    toggleMenu: windowState.toggleMenu,
    closeMenus: windowState.closeMenus,
    selectedProject: board.selectedProject,
    get projectPopover() {
      return windowState.refs.projectPopover;
    },
    set projectPopover(value) {
      windowState.refs.projectPopover = value;
    },
    bootstrap,
    setError: dependencies.setError,
    setWorkspaceVisible: windowState.setWorkspaceVisible,
    projectSetup,
    projects: planning.projects,
    projectSearchQuery: dependencies.projectSearchQuery,
    setProjectSearchQuery: dependencies.setProjectSearchQuery,
    filteredProjects: board.filteredProjects,
    selectedProjectID: dependencies.selectedProjectID,
    setPreloadProjectID: planning.setPreloadProjectID,
    selectProject: workspaceActions.selectProject,
    workspaceVisible: windowState.workspaceVisible,
    setupVisible,
    workspaceView: windowState.workspaceView,
    workspaceTabs: workspaces.tabs,
    openKnowledge: knowledge.open,
    detail: dependencies.detail,
    selectedTicketID: dependencies.selectedTicketID,
    activateWorkspaceTab: workspaceActions.activateWorkspaceTab,
    selectTicket: workspaceActions.selectTicket,
    ideTargets: agentState.ideTargets,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    selectedChange: presentation.selectedChange,
    openIDETarget: runtimeNavigation.openIDETarget,
    previewTargets: agentState.previewTargets,
    openPreviewTarget: runtimeNavigation.openPreviewTarget,
    inboxCount: () => inboxState.inbox.view()?.count,
    returnToInbox: inboxState.returnToInbox,
    agentOverlay: windowState.agentOverlay,
    foundTickets: planning.foundTickets,
    setFind: planning.setFind,
    boardStatus: board.boardStatus,
    pending: dependencies.pending,
    openTicketDraft: projectCommands.openTicketDraft,
    get settingsControlElement() {
      return windowState.refs.settingsControlElement;
    },
    set settingsControlElement(value) {
      windowState.refs.settingsControlElement = value;
    },
    get settingsPopover() {
      return windowState.refs.settingsPopover;
    },
    set settingsPopover(value) {
      windowState.refs.settingsPopover = value;
    },
    openSettings: workspaceActions.openSettings,
    openWorkspaceTab: workspaceActions.openWorkspaceTab,
    backgroundSaves: windowState.backgroundSaves,
    canManageProject: dependencies.canManageProject,
    backgroundChoices: windowState.backgroundChoices,
    backgroundPickerExpanded: windowState.backgroundPickerExpanded,
    desktopBackgroundKey: windowState.desktopBackgroundKey,
    chooseDesktopBackground: windowState.chooseDesktopBackground,
    setBackgroundPickerExpanded: windowState.setBackgroundPickerExpanded,
  };

  return {
    documentWindowModel,
    assistantPanelModel,
    projectBoardModel,
    desktopTopbarModel,
  };
}
