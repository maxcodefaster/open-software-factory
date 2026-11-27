import { createSignal, onCleanup, untrack } from "solid-js";
import { type EpicProposal, epicProposalInput } from "#conversation-domain/epic-proposal";
import {
  type FactoryZeroContext,
  type FactoryZeroSchema,
  zeroMutators,
  zeroQueries,
  zeroSchema,
} from "#zero-schema";
import { useZero, useZeroQuery, ZeroProvider } from "#zero-solid";
import type { Session } from "./access/contracts";
import type { WriterView } from "./agent/contracts";
import type { Bootstrap } from "./bootstrap/contracts";
import type { Change, PersonalTicketDraft, TicketDraft } from "./change/contracts";
import type { DeliveryView } from "./delivery/contracts";
import { createAssistantPresentation } from "./desktop/assistant-presentation";
import { createBoardProjection } from "./desktop/board-projection";
import { createDesktopCommandState } from "./desktop/command-state";
import type { FactoryDesktopProps, TicketDetail } from "./desktop/contracts";
import { createConversationState } from "./desktop/conversation-state";
import {
  createFactoryAgentState,
  type ImplementationPreparation,
} from "./desktop/factory-agent-state";
import { FactoryDesktopShell } from "./desktop/factory-desktop-shell";
import { createFactoryDesktopWiring } from "./desktop/factory-desktop-wiring";
import { createFactoryViewModels } from "./desktop/factory-view-models";
import { createFactoryWindowState } from "./desktop/factory-window-state";
import { createDesktopLifecycleGuard } from "./desktop/window-state-machine";
import type { ActivityNavigationRequest } from "./ide-messages";
import { repositoryBrowserURL } from "./knowledge/source-link";
import { useFactoryNavigation } from "./navigation/router";
import { createConversationSelection } from "./project-agent/selection";
import { createProjectPlanning } from "./projects/planning";
import type { AppPreview, RuntimeAttempt } from "./runtime/contracts";
import { getModelAvailability } from "./server-functions/bootstrap";
import { serverCall } from "./server-functions/result";
import { createProjectSetupInteraction } from "./setup/panel";
import { isActiveTurnState } from "./tickets/client";
import { createWorkspaceState } from "./workspace/state";
import { selectedWorkspaceTab } from "./workspace-tabs";
import { FactoryReadProvider } from "./zero/reads";

export function AuthenticatedFactory(props: Bootstrap & { session: Session }) {
  return (
    <ZeroProvider
      identity={{ userId: props.session.user.id, schemaVersion: "factory-read-projections-v1" }}
      storageKey={props.planningCacheScope}
      cacheURL={props.zeroCacheURL}
      schema={zeroSchema}
      mutators={zeroMutators}
      context={{
        userId: props.session.user.id,
        systemManager: props.session.systemManager,
      }}
    >
      <FactoryReadProvider>
        <FactoryWorkspace
          session={props.session}
          uiPreference={props.uiPreference}
          modelRelayConfigured={props.modelRelayConfigured}
          forgeOrigins={props.forgeOrigins}
        />
      </FactoryReadProvider>
    </ZeroProvider>
  );
}

function FactoryWorkspace(props: FactoryDesktopProps) {
  // Session-bound recovery identities are fixed for this authenticated desktop.
  const initialSession = untrack(() => props.session);
  const navigation = useFactoryNavigation();
  const [modelRelayConfigured, setModelRelayConfigured] = createSignal(
    untrack(() => props.modelRelayConfigured),
  );
  const zero = useZero<FactoryZeroSchema, undefined, FactoryZeroContext>();
  const [selectedProjectID, setSelectedProjectID] = createSignal<string>();
  const planning = createProjectPlanning(selectedProjectID);
  const workspaces = createWorkspaceState(selectedProjectID);

  const [selectedTicketID, setSelectedTicketID] = createSignal<string>();
  const [epicProposals, setEpicProposals] = createSignal<Record<string, EpicProposal>>({});
  const clarificationOrigins = new Set<string>();
  const assistantTicketID = () => {
    const tab = selectedWorkspaceTab(workspaces.current());
    return tab?.view === "ticket" || tab?.view === "ide" || tab?.view === "epic-proposal"
      ? tab.ticketID
      : undefined;
  };
  const conversationSelection = createConversationSelection(
    initialSession.user.id,
    selectedProjectID,
    assistantTicketID,
  );
  const assistantContextLoading = () =>
    Boolean(
      selectedProjectID() && conversationSelection.readyKey() !== conversationSelection.key(),
    );
  const [ideNavigation, setIDENavigation] = createSignal<ActivityNavigationRequest>();
  const [codingWriter, setCodingWriter] = createSignal<{
    changeID: string;
    view: WriterView | undefined;
  }>();
  const [pendingInterviewAnswer, setPendingInterviewAnswer] = createSignal<{
    key: string;
    questionID: string;
    text: string;
  }>();
  const [detail, setDetail] = createSignal<TicketDetail>();
  const [changes, setChanges] = createSignal<Change[]>([]);
  const [attempts, setAttempts] = createSignal<RuntimeAttempt[]>([]);
  const [appPreviews, setAppPreviews] = createSignal<AppPreview[]>([]);
  const [lifecycleProjectID, setLifecycleProjectID] = createSignal<string>();
  const [delivery, setDelivery] = createSignal<DeliveryView>();
  const contextKey = () => `${selectedProjectID() ?? "none"}:${selectedTicketID() ?? "none"}`;
  const { error, setError, pendingContexts, mutate } = createDesktopCommandState(contextKey);
  const pending = () => (pendingContexts()[contextKey()] ?? 0) > 0;
  const [syncError, setSyncError] = createSignal("");
  const ticketDrafts = new Map<string, TicketDraft>();
  const personalDrafts = new Map<string, PersonalTicketDraft>();
  const personalDraftKey = () => `ticket-draft:${props.session.user.id}:${selectedProjectID()}`;
  const [projectSearchQuery, setProjectSearchQuery] = createSignal("");
  const [boardHistoryOpen, setBoardHistoryOpen] = createSignal(false);
  const [correctionTarget, setCorrectionTarget] = createSignal<string>();
  const [implementationPreparation, setImplementationPreparation] =
    createSignal<ImplementationPreparation>();

  const hasProjectPermission = (
    projectID: string | undefined,
    predicate: (member: { projectId: string; role: string; manageProject: boolean }) => boolean,
  ) =>
    props.session.systemManager ||
    Boolean(
      projectID &&
        planning.memberships
          .data()
          ?.some((member) => member.projectId === projectID && predicate(member)),
    );
  const canManageProject = () =>
    hasProjectPermission(selectedProjectID(), (member) => member.manageProject);
  const canDevelopProject = () =>
    hasProjectPermission(selectedProjectID(), (member) => member.role === "developer");
  const canManageSettingsProject = (projectID: string | undefined) =>
    hasProjectPermission(projectID, (member) => member.manageProject);

  const conversationState = createConversationState({
    projectID: selectedProjectID,
    ticketID: assistantTicketID,
    selection: conversationSelection,
    onEntry(entry) {
      const parsed = epicProposalInput.safeParse(entry.payload["epicProposal"]);
      if (parsed.success && !epicProposals()[entry.id])
        setEpicProposals((current) => ({ ...current, [entry.id]: parsed.data }));
    },
  });
  const assistantPending = () =>
    (pendingContexts()[conversationSelection.key()] ?? 0) > 0 ||
    isActiveTurnState(conversationState.current()?.turn?.state);

  const lifecycle = createDesktopLifecycleGuard();
  onCleanup(() => lifecycle.dispose());
  async function refreshModelAvailability() {
    const generation = lifecycle.beginModelAvailabilityRead();
    const value = await serverCall(getModelAvailability({ data: [] }));
    if (lifecycle.isCurrentModelAvailabilityRead(generation))
      setModelRelayConfigured(value.modelRelayConfigured);
  }

  const trashTickets = useZeroQuery(
    () => {
      const projectId = selectedProjectID();
      return projectId && workspaces.tabs().some((tab) => tab.view === "trash")
        ? zeroQueries.tickets.trash({ projectId, limit: planning.trashLimit() + 1 })
        : null;
    },
    { ttl: "none" },
  );

  const board = createBoardProjection({
    changes,
    dependencies: planning.dependencies,
    attempts,
    projects: planning.projects,
    selectedProjectID,
    projectSearchQuery,
    tickets: planning.tickets,
    ticketLimit: planning.ticketLimit,
    history: planning.history,
    historyLimit: planning.historyLimit,
    prerequisiteTickets: planning.prerequisiteTickets,
    foundTickets: planning.foundTickets,
    trashTickets,
    detail,
    epics: planning.epics,
    boardHistoryOpen,
  });

  const browserRepository = () =>
    repositoryBrowserURL(board.selectedProject()?.repositoryUrl ?? "", props.forgeOrigins);

  const windowState = createFactoryWindowState({
    currentWorkspaceState: workspaces.current,
    selectedProjectID,
    selectedProject: board.selectedProject,
    projectMenuOpen: planning.projectMenuOpen,
    setProjectMenuOpen: planning.setProjectMenuOpen,
    canManageProject,
    defaultBackgroundKey: () => props.uiPreference.desktopBackgroundKey,
    zero,
    setError,
  });

  const projectSetup = initialSession.systemManager
    ? createProjectSetupInteraction(initialSession.user.id, () => windowState.setAgentOpen(true))
    : undefined;
  const setupVisible = () => projectSetup?.visible() === true;

  const agentState = createFactoryAgentState({
    initialUserID: initialSession.user.id,
    sessionUserID: () => props.session.user.id,
    selectedProjectID,
    selectedTicketID,
    assistantTicketID,
    selectedConversation: conversationSelection.selected,
    assistantKey: conversationSelection.key,
    detail,
    canDevelopProject,
    selectedChange: () => presentation.selectedChange(),
    selectedProject: board.selectedProject,
    ticketList: board.ticketList,
    changes,
    attempts,
    appPreviews,
    lifecycleProjectID,
    stagingRuntimeFor: board.stagingRuntimeFor,
    implementationPreparation,
    setImplementationPreparation,
    setCorrectionTarget,
    setError,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    workspaceView: windowState.workspaceView,
    ideNavigation,
    setIDENavigation,
    clarificationOrigins,
    setAgentOpen: windowState.setAgentOpen,
  });

  const presentation = createAssistantPresentation({
    selectedTicketID,
    changeFor: board.changeFor,
    observedAgentChangeID: agentState.observedAgentChangeID,
    implementationPreparation,
    selectedProjectID,
    assistantTicketID,
    detail,
    canDevelopProject,
    conversation: conversationState.current,
    correctionTarget,
    workspaceView: windowState.workspaceView,
    activeWorkspaceTab: windowState.activeWorkspaceTab,
    pendingInterviewAnswer,
    assistantKey: conversationSelection.key,
    clarificationPaused: conversationSelection.paused,
    assistantPending,
    clarificationOrigins,
    agentOpen: windowState.agentOpen,
    agent: agentState.agent,
    codingWriter,
    agentCommandScope: agentState.agentCommandScope,
    messageDrafts: agentState.messageDrafts,
    userID: initialSession.user.id,
    agentCommandIds: agentState.agentCommandIds,
  });

  const wiring = createFactoryDesktopWiring({
    userID: initialSession.user.id,
    systemManager: initialSession.systemManager,
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
    selectedProjectID,
    setSelectedProjectID,
    selectedTicketID,
    setSelectedTicketID,
    assistantTicketID,
    assistantContextLoading,
    assistantPending,
    canDevelopProject,
    epicProposals,
    detail,
    setDetail,
    delivery,
    setDelivery,
    changes,
    setChanges,
    attempts,
    setAttempts,
    setAppPreviews,
    setLifecycleProjectID,
    error,
    setError,
    setSyncError,
    mutate,
    personalDrafts,
    personalDraftKey,
    ticketDrafts,
    clarificationOrigins,
    correctionTarget,
    setCorrectionTarget,
    implementationPreparation,
    setImplementationPreparation,
    pendingInterviewAnswer,
    setPendingInterviewAnswer,
    setIDENavigation,
  });

  const viewModels = createFactoryViewModels({
    bootstrap: props,
    navigation,
    zero,
    planning,
    workspaces,
    board,
    windowState,
    agentState,
    presentation,
    ...wiring,
    conversationSelection,
    conversationState,
    projectSetup,
    setupVisible,
    selectedProjectID,
    selectedTicketID,
    assistantTicketID,
    assistantContextLoading,
    assistantPending,
    epicProposals,
    detail,
    delivery,
    changes,
    attempts,
    appPreviews,
    modelRelayConfigured,
    refreshModelAvailability,
    browserRepository,
    canDevelopProject,
    canManageProject,
    canManageSettingsProject,
    pending,
    mutate,
    setError,
    personalDraftKey,
    personalDrafts,
    ticketDrafts,
    trashTickets,
    projectSearchQuery,
    setProjectSearchQuery,
    boardHistoryOpen,
    setBoardHistoryOpen,
    ideNavigation,
    setIDENavigation,
    setCodingWriter,
    setImplementationPreparation,
  });

  return (
    <FactoryDesktopShell
      selectedProjectID={selectedProjectID}
      assistantTicketID={assistantTicketID}
      attachmentScopeKey={() =>
        `${contextKey()}:${conversationSelection.key()}:${wiring.knowledge.selectedPageID() ?? ""}:${windowState.activeWorkspaceTab()?.id ?? ""}`
      }
      windowState={windowState}
      navigation={navigation}
      urlSync={wiring.urlSync}
      planning={planning}
      workspaces={workspaces}
      knowledge={wiring.knowledge}
      trashTickets={trashTickets}
      error={error}
      syncError={syncError}
      refreshServerState={wiring.reads.refreshServerState}
      {...viewModels}
    />
  );
}
