import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { z } from "zod";
import { interviewAnswerInput } from "../../../packages/conversation-domain/src/conversation";
import {
  type EpicProposal,
  epicProposalInput,
} from "../../../packages/conversation-domain/src/epic-proposal";
import {
  type CodingReasoning,
  codingReasoningInput,
} from "../../../packages/conversation-domain/src/model-settings";
import type { DesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import {
  type FactoryZeroContext,
  type FactoryZeroSchema,
  zeroMutators,
  zeroQueries,
  zeroSchema,
} from "../../../packages/zero-schema/src";
import { useZero, useZeroQuery, ZeroProvider } from "../../../packages/zero-solid/src";
import { takeSettingsReturn } from "./access/settings-return";
import { createAgentCommandIds } from "./agent-command-ids";
import { type AgentSnapshot, createAgentReadFence, retainAgentActivity } from "./agent-view-state";
import type {
  AgentView,
  AppPreview,
  Bootstrap,
  Change,
  ConversationView,
  DeliveryView,
  RuntimeAttempt,
  RuntimeDockTarget,
  Session,
  WriterView,
} from "./api-contracts";
import { orderedDesktopBackgrounds } from "./artworks";
import type { followConversation } from "./assistant-interaction";
import { AttachmentProvider } from "./attachments/ui";
import { AssistantPanel, type AssistantPanelModel } from "./desktop/assistant-panel";
import { createAssistantPresentation } from "./desktop/assistant-presentation";
import { createBoardProjection } from "./desktop/board-projection";
import { createCodingCommands } from "./desktop/coding-commands";
import { createComposerState } from "./desktop/composer-state";
import type { FactoryDesktopProps, TicketDetail } from "./desktop/contracts";
import { createConversationCommands } from "./desktop/conversation-commands";
import { createConversationState } from "./desktop/conversation-state";
import { DocumentWindow, type DocumentWindowModel } from "./desktop/document-window";
import { ProjectBoard, type ProjectBoardModel } from "./desktop/project-board";
import { createProjectCommands } from "./desktop/project-commands";
import { createDesktopReads } from "./desktop/reads";
import { createRuntimeNavigation } from "./desktop/runtime-navigation";
import { createTicketCommands } from "./desktop/ticket-commands";
import { DesktopTopbar, type DesktopTopbarModel } from "./desktop/topbar";
import type { ActivityNavigationRequest } from "./ide-messages";
import { createInboxClient, revealInboxSource } from "./inbox/client";
import type { InboxItem } from "./inbox/contracts";
import { MentionSupport } from "./inbox/mentions";
import { type InboxQueue, initialInboxPosition, nextInboxQueueItem } from "./inbox/navigation";
import { repositoryBrowserURL } from "./knowledge/source-link";
import { createKnowledgeState } from "./knowledge/state";
import { createDesktopNavigation, unavailableLink } from "./navigation/desktop";
import { type FactoryLocation, factoryPath } from "./navigation/location";
import { useFactoryNavigation } from "./navigation/router";
import { bindPopoverKeyboard } from "./popover-keyboard";
import { createConversationSelection } from "./project-agent/selection";
import { createProjectPlanning } from "./projects/planning";
import { ticketReference } from "./projects/ticket-content";
import { getModelAvailability } from "./server-functions/bootstrap";
import { serverCall } from "./server-functions/result";
import { createProjectSetupInteraction } from "./setup/panel";
import type { PersonalTicketDraft } from "./ticket-draft-workspace";
import type { TicketDraft } from "./ticket-workspace";
import { createWindowPresence } from "./window-presence";
import { createWorkspaceState } from "./workspace/state";
import { ProjectRegistration } from "./workspace-chrome";
import { workspacePanelID, workspaceTabElementID } from "./workspace-tabbar";
import { selectedWorkspaceTab, type WorkspaceTab } from "./workspace-tabs";
import { FactoryReadProvider } from "./zero/reads";
import { PlanningSyncStatus } from "./zero/sync-status";

const _KnowledgeWorkspace = lazy(async () => ({
  default: (await import("./knowledge-workspace")).KnowledgeWorkspace,
}));
const _RuntimeWorkspaceTabs = lazy(async () => ({
  default: (await import("./runtime-workspace")).RuntimeWorkspaceTabs,
}));
const _DeveloperIDEWorkspace = lazy(async () => ({
  default: (await import("./developer-ide-workspace")).DeveloperIDEWorkspace,
}));
const _SettingsWorkspace = lazy(async () => ({
  default: (await import("./settings-workspace")).SettingsWorkspace,
}));

export function AuthenticatedFactory(props: Bootstrap & { session: Session }) {
  return (
    <ZeroProvider
      identity={{ userId: props.session.user.id, schemaVersion: "factory-read-projections-v1" }}
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
  let publishLocation: ReturnType<typeof createDesktopNavigation>["publish"] = () => {};
  const inbox = createInboxClient();
  const [inboxPosition, setInboxPosition] = createSignal(initialInboxPosition());
  const [inboxRestoreKey, setInboxRestoreKey] = createSignal(0);
  const [inboxQueue, setInboxQueue] = createSignal<InboxQueue>();
  const [inboxSourceOpening, setInboxSourceOpening] = createSignal(false);
  const [inboxFeedbackID, setInboxFeedbackID] = createSignal<string>();
  let inboxNavigation: AbortController | undefined;
  onCleanup(() => inboxNavigation?.abort());
  const [modelRelayConfigured, setModelRelayConfigured] = createSignal(
    untrack(() => props.modelRelayConfigured),
  );
  const zero = useZero<FactoryZeroSchema, undefined, FactoryZeroContext>();
  const [selectedProjectID, setSelectedProjectID] = createSignal<string>();
  const planning = createProjectPlanning(selectedProjectID);
  const {
    projects,
    memberships,
    tickets,
    history,
    prerequisiteTickets,
    foundTickets,
    epics,
    dependencies,
    ticketLimit,
    setTicketLimit,
    historyLimit,
    setHistoryLimit,
    trashLimit,
    setTrashLimit,
    setFind,
    setPreloadProjectID,
    projectMenuOpen,
    setProjectMenuOpen,
    selectedEpicID,
    setSelectedEpicID,
  } = planning;
  const workspaces = createWorkspaceState(selectedProjectID);
  const projectWorkspaces = workspaces.states;
  const currentWorkspaceState = workspaces.current;
  const workspaceTabs = workspaces.tabs;
  const browserRepository = () =>
    repositoryBrowserURL(selectedProject()?.repositoryUrl ?? "", props.forgeOrigins);
  const securityReturn = takeSettingsReturn(initialSession.user.id);
  let securityReturnRestored = false;
  const [selectedTicketID, setSelectedTicketID] = createSignal<string>();
  const [epicProposals, setEpicProposals] = createSignal<Record<string, EpicProposal>>({});
  const clarificationOrigins = new Set<string>();
  const assistantTicketID = () => {
    const tab = selectedWorkspaceTab(currentWorkspaceState());
    return tab?.view === "ticket" || tab?.view === "ide" || tab?.view === "epic-proposal"
      ? tab.ticketID
      : undefined;
  };
  const conversationSelection = createConversationSelection(
    initialSession.user.id,
    selectedProjectID,
    assistantTicketID,
  );
  const {
    scope: conversationScope,
    selected: selectedConversation,
    key: assistantKey,
    readyKey: conversationReadyKey,
    setSelections: setConversationSelections,
    paused: clarificationPaused,
    pause: pauseClarification,
  } = conversationSelection;
  const assistantContextLoading = () =>
    Boolean(selectedProjectID() && conversationReadyKey() !== assistantKey());
  const [ideNavigation, setIDENavigation] = createSignal<ActivityNavigationRequest>();
  const [codingWriter, setCodingWriter] = createSignal<{
    changeID: string;
    view: WriterView | undefined;
  }>();
  const assistantPending = () =>
    (pendingContexts()[assistantKey()] ?? 0) > 0 ||
    ["pending", "dispatching", "running"].includes(conversation()?.turn?.state ?? "");
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
  const [error, setError] = createSignal("");
  const [pendingContexts, setPendingContexts] = createSignal<Record<string, number>>({});
  const contextKey = () => `${selectedProjectID() ?? "none"}:${selectedTicketID() ?? "none"}`;
  const pending = () => (pendingContexts()[contextKey()] ?? 0) > 0;
  const [syncError, setSyncError] = createSignal("");
  const ticketDrafts = new Map<string, TicketDraft>();
  const personalDrafts = new Map<string, PersonalTicketDraft>();
  const personalDraftKey = () => `ticket-draft:${props.session.user.id}:${selectedProjectID()}`;
  const workspaceWindow = createWindowPresence();
  const { visible: workspaceVisible } = workspaceWindow;
  const [workspaceFocusTarget, setWorkspaceFocusTarget] = createSignal<string>();
  let workspaceElement: HTMLElement | undefined;
  let workspaceOpener: HTMLElement | undefined;
  function setWorkspaceVisible(value: boolean) {
    const restore =
      !value &&
      untrack(workspaceVisible) &&
      (workspaceElement?.contains(document.activeElement) ||
        document.activeElement === document.body);
    workspaceWindow.setVisible(value);
    if (!value) setWorkspaceFocusTarget(undefined);
    if (restore)
      requestAnimationFrame(() => {
        if (workspaceVisible()) return;
        const available = (element: HTMLElement | undefined) =>
          element?.isConnected &&
          !element.closest("[inert]") &&
          element.getClientRects().length > 0;
        // Cached Board updates and responsive navigation can replace the original button.
        const label = workspaceOpener?.getAttribute("aria-label");
        const replacement = label
          ? Array.from(
              document.querySelectorAll<HTMLElement>(`button[aria-label="${CSS.escape(label)}"]`),
            ).find(available)
          : undefined;
        const target = available(workspaceOpener)
          ? workspaceOpener
          : (replacement ??
            document.querySelector<HTMLElement>('.workspace-dock button[aria-label="Desktop"]'));
        target?.focus({ preventScroll: true });
      });
  }
  const agentPresence = createWindowPresence();
  const { visible: agentOpen, setVisible: setAgentOpen } = agentPresence;
  const projectSetup = initialSession.systemManager
    ? createProjectSetupInteraction(initialSession.user.id, () => setAgentOpen(true))
    : undefined;
  const setupVisible = () => projectSetup?.visible() === true;
  const [narrowViewport, setNarrowViewport] = createSignal(false);
  const agentOverlay = () => agentOpen() && narrowViewport();
  const [projectSearchQuery, setProjectSearchQuery] = createSignal("");
  const [registrationOpen, setRegistrationOpen] = createSignal(false);
  const [boardHistoryOpen, setBoardHistoryOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [correctionTarget, setCorrectionTarget] = createSignal<string>();
  const [implementationPreparation, setImplementationPreparation] = createSignal<{
    projectID: string;
    ticketID: string;
    revisionID: string;
    reasoning: CodingReasoning | undefined;
    failure: string | undefined;
  }>();
  const canManageProject = () =>
    props.session.systemManager ||
    memberships
      .data()
      ?.some((member) => member.projectId === selectedProjectID() && member.manageProject) === true;
  const canDevelopProject = () =>
    props.session.systemManager ||
    memberships
      .data()
      ?.some(
        (member) => member.projectId === selectedProjectID() && member.role === "developer",
      ) === true;
  const desktopBackgroundKey = () =>
    selectedProject()?.desktopBackgroundKey ?? props.uiPreference.desktopBackgroundKey;
  const [backgroundSaves, setBackgroundSaves] = createSignal<Record<string, boolean>>({});
  const [backgroundPickerExpanded, setBackgroundPickerExpanded] = createSignal(false);
  const [backgroundPickerFirstKey, setBackgroundPickerFirstKey] =
    createSignal<DesktopBackgroundKey>(untrack(() => props.uiPreference.desktopBackgroundKey));
  const backgroundChoices = createMemo(() => orderedDesktopBackgrounds(backgroundPickerFirstKey()));
  createEffect(
    () => [settingsOpen(), selectedProjectID()] as const,
    ([open]) => {
      if (!open) return;
      // Snapshot on open, not on selection, so saving never moves the focused choice.
      setBackgroundPickerFirstKey(untrack(desktopBackgroundKey));
      setBackgroundPickerExpanded(false);
    },
  );
  const [codingReasoningChoices, setCodingReasoningChoices] = createSignal<
    Record<string, CodingReasoning | undefined>
  >({});
  const [agent, setAgent] = createSignal<AgentView>({
    state: "idle",
    messages: [],
    messagesAvailable: true,
    sessionAvailable: false,
    runtimeConnected: false,
    stopPending: false,
    stopId: null,
  });
  let lastAgentSnapshot: AgentSnapshot | undefined;
  const [observedAgentChangeID, setObservedAgentChangeID] = createSignal<string>();
  const agentReadFence = createAgentReadFence();
  const [agentActivityRevision, setAgentActivityRevision] = createSignal(0);
  function publishAgentView(
    changeID: string,
    view: AgentView,
    read?: ReturnType<typeof agentReadFence.beginRead>,
    historyRequested = true,
  ) {
    if (read && !agentReadFence.current(read)) return;
    if (!read) {
      agentReadFence.commandPublished();
      setAgentActivityRevision((revision) => revision + 1);
    }
    try {
      if (view.turn) {
        acknowledgeCommand(agentCommandScope("change-start", changeID), view.turn.commandId);
        acknowledgeCommand(agentCommandScope("change-prompt", changeID), view.turn.commandId);
        acknowledgeCommand(agentCommandScope("retry-review", changeID), view.turn.commandId);
        const prepared = implementationPreparation();
        if (
          prepared &&
          prepared.projectID === selectedProjectID() &&
          prepared.ticketID === selectedTicketID() &&
          prepared.ticketID === assistantTicketID() &&
          prepared.revisionID === detail()?.revisions[0]?.id &&
          selectedChange()?.id === changeID &&
          canDevelopProject() &&
          view.turn.engine === "opencode"
        ) {
          const scope = `implement:${prepared.ticketID}`;
          if (agentCommandIds.latest(scope)?.commandId === view.turn.commandId) {
            acknowledgeCommand(scope, view.turn.commandId);
            setCorrectionTarget(changeID);
            setImplementationPreparation(undefined);
          }
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser recovery is unavailable.");
    }
    lastAgentSnapshot = retainAgentActivity(lastAgentSnapshot, changeID, view, historyRequested);
    setAgent(lastAgentSnapshot.view);
    setObservedAgentChangeID(changeID);
  }
  function resetAgentView() {
    agentReadFence.commandPublished();
    setAgentActivityRevision((revision) => revision + 1);
    lastAgentSnapshot = undefined;
    setObservedAgentChangeID(undefined);
    setAgent({
      state: "idle",
      messages: [],
      messagesAvailable: true,
      sessionAvailable: false,
      runtimeConnected: false,
      stopPending: false,
      stopId: null,
    });
  }
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
  const conversation = conversationState.current;
  const setConversation = conversationState.replace;
  const publishConversation = conversationState.publish;
  const streamedAnswer = conversationState.provisional;
  let ticketReadGeneration = 0;
  let workspaceDisposed = false;
  let modelAvailabilityReadGeneration = 0;
  async function refreshModelAvailability() {
    const generation = ++modelAvailabilityReadGeneration;
    const value = await serverCall(getModelAvailability({ data: [] }));
    if (!workspaceDisposed && generation === modelAvailabilityReadGeneration)
      setModelRelayConfigured(value.modelRelayConfigured);
  }
  onCleanup(() => {
    workspaceDisposed = true;
  });
  const agentCommandIds = createAgentCommandIds({
    userId: initialSession.user.id,
    storage: {
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
    },
  });
  const [commandAcknowledgements, setCommandAcknowledgements] = createSignal(0);
  const {
    drafts: messageDrafts,
    restored: restoredMessageScope,
    bind: restoreMessageDraft,
    acknowledge: acknowledgeMessageDraft,
  } = createComposerState({
    userID: initialSession.user.id,
    commands: agentCommandIds,
    acknowledgements: commandAcknowledgements,
    onError: setError,
  });
  function agentCommandScope(
    kind: string,
    identity: string | null | undefined = assistantTicketID(),
    projectID = selectedProjectID(),
  ) {
    const context = selectedConversation();
    return JSON.stringify([
      projectID,
      kind,
      identity ?? null,
      ...(context && context !== "original" ? [context] : []),
    ]);
  }
  function acknowledgeCommand(scope: string, ...commandIds: string[]) {
    acknowledgeMessageDraft(scope, ...commandIds);
    if (agentCommandIds.forget(scope, ...commandIds))
      setCommandAcknowledgements((value) => value + 1);
  }
  function chosenCodingReasoning() {
    commandAcknowledgements();
    const changeID = selectedChange()?.id;
    if (!changeID) return undefined;
    const choices = codingReasoningChoices();
    if (Object.hasOwn(choices, changeID)) return choices[changeID];
    try {
      const pending = agentCommandIds.latest(agentCommandScope("change-start", changeID));
      if (!pending) return undefined;
      const saved = z
        .object({
          changeID: z.literal(changeID),
          codingReasoning: codingReasoningInput.optional(),
        })
        .safeParse(JSON.parse(pending.input));
      return saved.success ? saved.data.codingReasoning : undefined;
    } catch {
      // Unreadable recovery storage still blocks admission in forInput.
      return undefined;
    }
  }
  function acknowledgeConversation(value: ConversationView) {
    const messages: string[] = [];
    for (const entry of value.entries) {
      const commandId = entry.payload["commandId"];
      if (typeof commandId !== "string") continue;
      if (entry.kind === "user-message") messages.push(commandId);
      else if (entry.kind === "answer" && entry.inReplyToEntryId) {
        acknowledgeCommand(
          agentCommandScope("project-answer", entry.inReplyToEntryId, value.projectId),
          commandId,
        );
      }
    }
    if (messages.length)
      acknowledgeCommand(
        agentCommandScope("project-message", value.ticketId ?? null, value.projectId),
        ...messages,
      );
  }
  function restoredInterviewAnswer(questionEntryID: string) {
    try {
      const pending = agentCommandIds.latest(agentCommandScope("project-answer", questionEntryID));
      if (!pending) return undefined;
      const input: unknown = JSON.parse(pending.input);
      if (!input || typeof input !== "object" || !("answer" in input)) return undefined;
      const parsed = interviewAnswerInput.safeParse(input.answer);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  const [delivery, setDelivery] = createSignal<DeliveryView>();
  const knowledge = createKnowledgeState({
    projectID: selectedProjectID,
    canDevelop: canDevelopProject,
    tabs: workspaces.tabs,
    openTab: openWorkspaceTab,
    mutate,
    onError: setError,
  });
  const {
    drafts: knowledgeDrafts,
    pages: knowledgePages,
    page: knowledgePage,
    selectedPageID: selectedKnowledgePageID,
    documents: repositoryDocuments,
    document: openRepositoryDocument,
    generation: knowledgeGeneration,
    history: knowledgeHistory,
    results: knowledgeSearch,
    query: knowledgeSearchQuery,
    refresh: refreshKnowledge,
    loadDocuments: loadRepositoryDocuments,
    open: openKnowledge,
    generate: generateKnowledge,
    save: editKnowledgePage,
    loadHistory: loadKnowledgeHistory,
    search: searchProjectKnowledge,
  } = knowledge;
  let projectControlElement: HTMLDivElement | undefined;
  let settingsControlElement: HTMLDivElement | undefined;
  let projectPopover: HTMLElement | undefined;
  let settingsPopover: HTMLElement | undefined;
  let agentPanelElement: HTMLElement | undefined;
  let agentToggleElement: HTMLButtonElement | undefined;
  let agentOverlayOpener: HTMLElement | undefined;
  const rememberAgentOpener = () => {
    const active = document.activeElement;
    agentOverlayOpener =
      active instanceof HTMLElement && !agentPanelElement?.contains(active)
        ? active
        : agentToggleElement;
  };
  const dismissAgent = () => {
    const opener = agentOverlayOpener ?? agentToggleElement;
    setAgentOpen(false);
    requestAnimationFrame(() => {
      if (!agentOpen() && opener?.isConnected) opener.focus({ preventScroll: true });
    });
  };
  const projectMenuOpener = (): HTMLButtonElement | undefined => {
    const button = projectControlElement?.querySelector<HTMLButtonElement>(".project-selector");
    return button?.getClientRects().length
      ? button
      : (settingsControlElement?.querySelector<HTMLButtonElement>("button") ?? undefined);
  };
  onSettled(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => {
      if (query.matches && agentOpen()) rememberAgentOpener();
      setProjectMenuOpen(false);
      setSettingsOpen(false);
      setNarrowViewport(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });
  createEffect(
    () => agentOverlay(),
    (overlay) => {
      if (!overlay) return;
      setProjectMenuOpen(false);
      setSettingsOpen(false);
      let cancelled = false;
      let element: HTMLElement | undefined;
      const keydown = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          !(event.target instanceof Node) ||
          !element?.contains(event.target)
        )
          return;
        event.preventDefault();
        dismissAgent();
      };
      queueMicrotask(() => {
        if (cancelled) return;
        element = agentPanelElement;
        // Let Solid's delegated help/menu handlers consume Escape before dismissing the panel.
        document.addEventListener("keydown", keydown);
        if (!element || element.contains(document.activeElement)) return;
        const inputs = element.querySelectorAll<HTMLElement>(
          'textarea:not(:disabled), input:not(:disabled):not([type="file"]):not([type="hidden"])',
        );
        (
          [...inputs].find((input) => input.getClientRects().length) ??
          element.querySelector<HTMLElement>("button:not(:disabled)")
        )?.focus({ preventScroll: true });
      });
      return () => {
        cancelled = true;
        document.removeEventListener("keydown", keydown);
      };
    },
  );
  let conversationScroll: ReturnType<typeof followConversation> | undefined;
  onCleanup(() => conversationScroll?.dispose());

  onSettled(() => {
    const closeTransientMenus = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (projectMenuOpen() && target && !projectControlElement?.contains(target)) {
        setProjectMenuOpen(false);
      }
      if (settingsOpen() && target && !settingsControlElement?.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const opener = projectMenuOpen()
        ? projectMenuOpener()
        : settingsOpen()
          ? settingsControlElement?.querySelector<HTMLButtonElement>("button")
          : undefined;
      if (!opener) return;
      event.preventDefault();
      setProjectMenuOpen(false);
      setSettingsOpen(false);
      opener.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeTransientMenus, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeTransientMenus, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  });

  createEffect(
    () => [projectMenuOpen(), settingsOpen()] as const,
    ([projectOpen, settingsVisible]) => {
      let disposed = false;
      let cleanup: (() => void) | undefined;
      queueMicrotask(() => {
        if (disposed) return;
        const element = projectOpen
          ? projectPopover
          : settingsVisible
            ? settingsPopover
            : undefined;
        if (element)
          cleanup = bindPopoverKeyboard(
            element,
            projectOpen
              ? projectMenuOpener()
              : (settingsControlElement?.querySelector<HTMLButtonElement>("button") ?? undefined),
            () => {
              setProjectMenuOpen(false);
              setSettingsOpen(false);
            },
          );
      });
      return () => {
        disposed = true;
        cleanup?.();
      };
    },
  );

  const trashTickets = useZeroQuery(
    () => {
      const projectId = selectedProjectID();
      return projectId && workspaceTabs().some((tab) => tab.view === "trash")
        ? zeroQueries.tickets.trash({ projectId, limit: trashLimit() + 1 })
        : null;
    },
    { ttl: "none" },
  );
  const activeWorkspaceTab = () => {
    if (!workspaceWindow.present()) return undefined;
    return selectedWorkspaceTab(currentWorkspaceState());
  };
  const workspaceView = () => activeWorkspaceTab()?.view;
  createEffect(
    () => [workspaceVisible(), activeWorkspaceTab()?.id, workspaceFocusTarget()] as const,
    ([visible, id, requested]) => {
      if (!visible || !id || requested !== id) return;
      let disposed = false;
      let observer: MutationObserver | undefined;
      onSettled(() => {
        const panel = document.getElementById(workspacePanelID);
        if (disposed || !panel) return;
        const handoff = () => {
          if (disposed || !workspaceVisible() || activeWorkspaceTab()?.id !== id) return;
          const active = document.activeElement;
          // A late document read must not steal a later control's focus.
          if (
            panel.contains(active) ||
            projectMenuOpen() ||
            settingsOpen() ||
            (active instanceof HTMLElement &&
              active !== document.body &&
              active !== workspaceOpener)
          ) {
            setWorkspaceFocusTarget(undefined);
            return;
          }
          const view = activeWorkspaceTab()?.view;
          const target =
            view === "ticket-draft"
              ? panel.querySelector<HTMLElement>('[aria-label="Ticket title"]')
              : view === "ticket"
                ? panel.querySelector<HTMLElement>("article.ticket-document:not([hidden])")
                : panel;
          if (!target || target.closest("[inert]")) return;
          target.focus({ preventScroll: true });
          setWorkspaceFocusTarget(undefined);
        };
        observer = new MutationObserver(handoff);
        observer.observe(panel, { childList: true, subtree: true });
        handoff();
      });
      return () => {
        disposed = true;
        observer?.disconnect();
      };
    },
  );
  createEffect(
    () => activeWorkspaceTab()?.proposalID,
    (proposalID) => {
      if (proposalID && !epicProposals()[proposalID]) void refreshConversation();
    },
  );
  const activeWorkspaceLabelID = () => {
    const tab = activeWorkspaceTab();
    return tab ? workspaceTabElementID(tab.id) : undefined;
  };

  function openWorkspaceTab(tab: WorkspaceTab, publish = true) {
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !workspaceElement?.contains(document.activeElement)
    )
      workspaceOpener = document.activeElement;
    workspaces.open(tab);
    setWorkspaceVisible(true);
    setWorkspaceFocusTarget(tab.id);
    if (publish) publishWorkspaceLocation(tab);
  }

  function openSettings() {
    if (settingsControlElement?.contains(document.activeElement))
      workspaceOpener =
        settingsControlElement.querySelector<HTMLButtonElement>("button") ?? workspaceOpener;
    setSettingsOpen(false);
    if (narrowViewport()) setAgentOpen(false);
    const setupProject = projectSetup?.draft();
    const project = setupVisible()
      ? setupProject?.projectID
        ? { id: setupProject.projectID, name: setupProject.name }
        : undefined
      : selectedProject();
    const tab = workspaceTabs().find(
      (candidate) => candidate.view === "settings" && candidate.settingsProject?.id === project?.id,
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

  function canManageSettingsProject(projectID: string | undefined) {
    return (
      props.session.systemManager ||
      Boolean(
        projectID &&
          memberships
            .data()
            ?.some((member) => member.projectId === projectID && member.manageProject),
      )
    );
  }

  const updateWorkspaceTab = workspaces.update;

  function activateWorkspaceTab(tab: WorkspaceTab) {
    const reopening = !workspaceVisible();
    if (reopening && document.activeElement instanceof HTMLElement)
      workspaceOpener = document.activeElement;
    inboxNavigation?.abort();
    setInboxQueue(undefined);
    setInboxSourceOpening(false);
    workspaces.activate(tab);
    setWorkspaceVisible(true);
    if (reopening) setWorkspaceFocusTarget(tab.id);
    if (tab.ticketID && tab.ticketID !== selectedTicketID()) {
      loadTicketContext(tab.ticketID);
    }
    publishWorkspaceLocation(tab);
  }

  function closeWorkspaceTab(tabID: string) {
    const result = workspaces.close(tabID);
    if (!result?.closed) return;
    if (!result.state.tabs.length) setWorkspaceVisible(false);
    if (result.next) activateWorkspaceTab(result.next);
    else publishWorkspaceLocation();
  }

  createEffect(
    () => ({
      list: projects.data()?.map((project) => ({ ...project })),
      completeness: projects.completeness(),
      // Reconcile external availability, not an optimistic local selection.
      selected: untrack(selectedProjectID),
      home: untrack(() => !navigation || navigation.location().view === "home"),
      factoryTabs: untrack(() => Boolean(projectWorkspaces()["factory"]?.tabs.length)),
      manager: initialSession.systemManager,
    }),
    ({ list, completeness, selected, home, factoryTabs, manager }) => {
      if (
        completeness === "complete" &&
        selected &&
        !list?.some((project) => project.id === selected)
      ) {
        ticketReadGeneration++;
        conversationState.invalidate();
        setSelectedProjectID(undefined);
        setSelectedTicketID(undefined);
        setDetail(undefined);
        setConversation(undefined);
        setChanges([]);
        setAttempts([]);
        setAppPreviews([]);
        setDelivery(undefined);
        resetAgentView();
        setWorkspaceVisible(false);
      }
      if (list && securityReturn && !securityReturnRestored) {
        securityReturnRestored = true;
        const project =
          securityReturn.project && list.find((item) => item.id === securityReturn.project?.id);
        if (
          (!securityReturn.project || project) &&
          (securityReturn.scope !== "system" || manager)
        ) {
          setSelectedProjectID(project?.id);
          openWorkspaceTab({
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
      if (home && !selected && !factoryTabs && list?.[0]) setSelectedProjectID(list[0].id);
    },
  );

  const {
    selectedProject,
    ticketList,
    changeFor,
    stagingRuntimeFor,
    epicList,
    prerequisitesFor,
    dependencyCandidates,
    blockersFor,
    historyTickets,
    boardHasMore,
    boardPageLoading,
    boardPageLabel,
    boardStatus,
    scopedTickets,
    lane,
    filteredProjects,
  } = createBoardProjection({
    changes,
    dependencies,
    attempts,
    projects,
    selectedProjectID,
    projectSearchQuery,
    tickets,
    ticketLimit,
    history,
    historyLimit,
    prerequisiteTickets,
    foundTickets,
    trashTickets,
    detail,
    epics,
    boardHistoryOpen,
  });

  const {
    selectedChange,
    latestRevision,
    preparingImplementation,
    codingWriterBlocked,
    conversationMode,
    historicalCoding,
    canPromptBuild,
    pendingInterview,
    ticketClarificationAction,
    latestRequirement,
    agentTurnBusy,
    agentViewLoaded,
    agentCanRun,
    agentNeedsResolution,
    ticketWorkspaceReady,
    ticketWorkspaceStatus,
    visibleConversation,
    answeredQuestionIDs,
    answerSummary,
    currentInterviewQuestion,
    retainedCodingDraft,
    interviewOwnsComposer,
    conversationPlaceholder,
  } = createAssistantPresentation({
    selectedTicketID,
    changeFor,
    observedAgentChangeID,
    implementationPreparation,
    selectedProjectID,
    assistantTicketID,
    detail,
    canDevelopProject,
    conversation,
    correctionTarget,
    workspaceView,
    activeWorkspaceTab,
    pendingInterviewAnswer,
    assistantKey,
    clarificationPaused,
    assistantPending,
    clarificationOrigins,
    agentOpen,
    agent,
    codingWriter,
    agentCommandScope,
    messageDrafts,
    props,
    agentCommandIds,
  });

  const { refreshConversation, refreshTicketDetail, refreshServerState, refreshLifecycleState } =
    createDesktopReads({
      selectedProjectID,
      setChanges,
      setAttempts,
      setAppPreviews,
      workspaces,
      setLifecycleProjectID,
      detail,
      selectedTicketID,
      get selectedChange() {
        return selectedChange;
      },
      agentOpen,
      agentReadFence,
      publishAgentView,
      setDelivery,
      resetAgentView,
      setSyncError,
      assistantTicketID,
      workspaceTabs,
      refreshKnowledge,
      agentActivityRevision,
      setAgent,
      get ticketReadGeneration() {
        return ticketReadGeneration;
      },
      set ticketReadGeneration(value) {
        ticketReadGeneration = value;
      },
      get workspaceDisposed() {
        return workspaceDisposed;
      },
      set workspaceDisposed(value) {
        workspaceDisposed = value;
      },
      setDetail,
      conversationReadFence: conversationState,
      selectedConversation,
      setConversation,
      acknowledgeConversation,
      setError,
      publishConversation,
    });

  async function mutate<T>(
    operation: () => Promise<T>,
    contextIsCurrent?: () => boolean,
    key = contextKey(),
  ) {
    const isCurrent = contextIsCurrent ?? (() => contextKey() === key);
    setPendingContexts((contexts) => ({ ...contexts, [key]: (contexts[key] ?? 0) + 1 }));
    setError("");
    try {
      return { ok: true as const, value: await operation() };
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Factory command failed");
      }
      return { ok: false as const };
    } finally {
      setPendingContexts((contexts) => ({
        ...contexts,
        [key]: Math.max(0, (contexts[key] ?? 1) - 1),
      }));
    }
  }

  async function chooseDesktopBackground(key: DesktopBackgroundKey) {
    const project = selectedProject();
    const client = zero();
    if (!project || !client || !canManageProject() || backgroundSaves()[project.id]) return;
    if (key === project.desktopBackgroundKey) return;
    setBackgroundSaves((current) => ({ ...current, [project.id]: true }));
    try {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.projects.setBackground({
            projectId: project.id,
            desktopBackgroundKey: key,
          }),
        ).server,
      );
    } catch (cause) {
      setError(
        `Background for ${project.name} could not be saved. ${
          cause instanceof Error ? cause.message : "Try again."
        }`,
      );
    } finally {
      setBackgroundSaves((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
    }
  }

  async function commitZeroMutation(operation: Promise<unknown>) {
    const result = await operation;
    if (
      result &&
      typeof result === "object" &&
      "type" in result &&
      result.type === "error" &&
      "error" in result &&
      result.error &&
      typeof result.error === "object" &&
      "message" in result.error
    ) {
      throw new Error(String(result.error.message));
    }
  }

  const {
    register,
    saveEpic,
    assignTicketEpic,
    editDependency,
    openTicketDraft,
    publishTicketDraft,
    moveTicket,
  } = createProjectCommands({
    mutate,
    setSelectedProjectID,
    setProjectMenuOpen,
    setRegistrationOpen,
    zero,
    selectedProjectID,
    commitZeroMutation,
    setSelectedEpicID,
    error,
    detail,
    refreshTicketDetail,
    personalDrafts,
    personalDraftKey,
    setSelectedTicketID,
    setDetail,
    openWorkspaceTab,
    props,
    workspaces,
    selectTicket,
  });

  const {
    saveTicketDocument,
    confirmRequirements,
    saveTechnicalDesign,
    confirmEpicWork,
    createFollowUp,
    ticketTrashCommand,
    openCodingOptions,
    implementTicket,
    approveDelivery,
    retryReview,
    retryPromotion,
    resumeChecks,
  } = createTicketCommands({
    detail,
    get latestRevision() {
      return latestRevision;
    },
    mutate,
    agentCommandIds,
    acknowledgeCommand,
    refreshTicketDetail,
    setAgentOpen,
    refreshConversation,
    canDevelopProject,
    selectedProjectID,
    setSelectedEpicID,
    closeWorkspaceTab,
    selectTicket,
    refreshServerState,
    selectedTicketID,
    setSelectedTicketID,
    setDetail,
    openWorkspaceTab,
    ticketList,
    get selectedChange() {
      return selectedChange;
    },
    implementationPreparation,
    setError,
    setImplementationPreparation,
    get preparingImplementation() {
      return preparingImplementation;
    },
    assistantTicketID,
    changeFor,
    setCorrectionTarget,
    setDelivery,
    refreshLifecycleState,
    delivery,
    agentCommandScope,
  });

  const {
    newConversation,
    startAgent,
    resumeCoding,
    stopAgent,
    checkStopStatus,
    recheckStopConfirmation,
    promptAgent,
  } = createCodingCommands({
    assistantContextLoading,
    selectedProjectID,
    assistantTicketID,
    get selectedChange() {
      return selectedChange;
    },
    assistantKey,
    agentCommandScope,
    mutate,
    agentCommandIds,
    conversation,
    acknowledgeCommand,
    setConversationSelections,
    conversationScope,
    refreshServerState,
    publishConversation,
    get codingWriterBlocked() {
      return codingWriterBlocked;
    },
    setError,
    agent,
    chosenCodingReasoning,
    publishAgentView,
    refreshLifecycleState,
    delivery,
    retryReview,
    selectedTicketID,
    selectedConversation,
    get conversationMode() {
      return conversationMode;
    },
    setConversation,
    agentReadFence,
    get historicalCoding() {
      return historicalCoding;
    },
    correctionTarget,
  });

  const { sendConversationMessage, beginRequirementsInterview, answerInterview } =
    createConversationCommands({
      assistantContextLoading,
      assistantPending,
      get canPromptBuild() {
        return canPromptBuild;
      },
      promptAgent,
      selectedProjectID,
      assistantTicketID,
      detail,
      setAgentOpen,
      pauseClarification,
      get pendingInterview() {
        return pendingInterview;
      },
      clarificationOrigins,
      assistantKey,
      get selectedChange() {
        return selectedChange;
      },
      moveTicket,
      conversation,
      clarificationPaused,
      agentCommandScope,
      publishProvisionalAnswer: conversationState.publishProvisional,
      clearProvisionalAnswer: conversationState.clearProvisional,
      get workspaceDisposed() {
        return workspaceDisposed;
      },
      set workspaceDisposed(value) {
        workspaceDisposed = value;
      },
      acknowledgeCommand,
      mutate,
      publishConversation,
      agentCommandIds,
      trackConversationStream: conversationState.trackStream,
      refreshConversation,
      selectedTicketID,
      setSelectedTicketID,
      refreshTicketDetail,
      setError,
      setPendingInterviewAnswer,
      pendingInterviewAnswer,
    });

  function loadTicketContext(ticketID: string, read = true) {
    const projectID = selectedProjectID();
    ticketReadGeneration++;
    setSelectedTicketID(ticketID);
    setDetail(undefined);
    resetAgentView();
    setDelivery(undefined);
    setConversation(undefined);
    if (!read) return;
    onSettled(() => {
      if (selectedProjectID() !== projectID || selectedTicketID() !== ticketID) return;
      void refreshTicketDetail(ticketID).catch((cause) =>
        setSyncError(cause instanceof Error ? cause.message : "The Ticket could not load"),
      );
      void refreshConversation(projectID, ticketID).catch((cause) =>
        setSyncError(cause instanceof Error ? cause.message : "The conversation could not load"),
      );
    });
  }

  function selectTicket(ticketID: string, fromInbox = false, read = true, publish = true) {
    inboxNavigation?.abort();
    if (!fromInbox) {
      setInboxQueue(undefined);
      setInboxSourceOpening(false);
    }
    setInboxFeedbackID(undefined);
    const ticket = ticketList().find((candidate) => candidate.id === ticketID);
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
    inboxNavigation?.abort();
    if (!fromInbox) {
      setInboxQueue(undefined);
      setInboxSourceOpening(false);
    }
    if (publish || fromInbox) projectSetup?.show(false);
    resetAgentView();
    setSelectedProjectID(projectID);
    setSelectedTicketID(undefined);
    setDetail(undefined);
    setWorkspaceVisible(false);
    knowledge.reset();
    setConversation(undefined);
    onSettled(() => {
      if (selectedProjectID() !== projectID) return;
      void refreshConversation(projectID, undefined).catch((cause) =>
        setSyncError(cause instanceof Error ? cause.message : "The conversation could not load"),
      );
    });
    setProjectMenuOpen(false);
    if (publish) publishLocation({ view: "project", projectID });
  }

  function returnToInbox(publish = true) {
    inboxNavigation?.abort();
    setInboxQueue(undefined);
    setInboxSourceOpening(false);
    setInboxRestoreKey((key) => key + 1);
    if (narrowViewport()) setAgentOpen(false);
    openWorkspaceTab({ id: "inbox", view: "inbox", label: "Inbox" }, publish);
  }

  const inboxSourceActive = () => {
    const item = inboxQueue()?.current;
    if (!item || item.projectId !== selectedProjectID()) return false;
    const tabID =
      item.target === "inputs"
        ? `inbox-inputs:${item.projectId}:${item.targetId}`
        : item.ticketId
          ? `ticket:${item.ticketId}`
          : "inbox";
    return activeWorkspaceTab()?.id === tabID;
  };
  const nextInboxItem = () => {
    const queue = inboxQueue();
    return queue ? nextInboxQueueItem(queue, inbox.view()?.items ?? []) : undefined;
  };
  async function startInboxItem(item: InboxItem, ids?: readonly string[]) {
    if (inboxSourceOpening()) return;
    const previous = inboxQueue();
    const queue: InboxQueue = {
      ids: ids ?? previous?.ids ?? [item.id],
      current: item,
      section: ids ? inboxPosition().section : (previous?.section ?? inboxPosition().section),
      project: ids ? inboxPosition().project : (previous?.project ?? inboxPosition().project),
    };
    setInboxQueue(queue);
    setInboxSourceOpening(true);
    setInboxPosition((position) => ({
      ...position,
      selectedId: item.id,
      index: queue.ids.indexOf(item.id),
    }));
    try {
      await openInboxItem(item);
    } finally {
      if (inboxQueue() === queue) setInboxSourceOpening(false);
    }
  }

  async function openInboxItem(item: InboxItem) {
    inboxNavigation?.abort();
    if (narrowViewport() && item.target !== "conversation" && item.target !== "coding")
      setAgentOpen(false);
    if (selectedProjectID() !== item.projectId) {
      selectProject(item.projectId, true, false);
      const switching = new AbortController();
      inboxNavigation = switching;
      // Solid 2 event handlers read the pre-write snapshot until the switch settles.
      // Otherwise the Ticket tab can be added to the previous Project's workspace.
      await new Promise<void>((resolve) => onSettled(resolve));
      if (switching.signal.aborted || selectedProjectID() !== item.projectId) return;
    }
    if (item.target === "inputs")
      openWorkspaceTab({
        id: `inbox-inputs:${item.projectId}:${item.targetId}`,
        view: "settings",
        label: "Inputs",
        settingsProject: { id: item.projectId, name: item.projectName },
        settingsSelection: { scope: "project", category: "monitoring" },
      });
    else if (item.ticketId) selectTicket(item.ticketId, true);
    else openWorkspaceTab({ id: "inbox", view: "inbox", label: "Inbox" });
    const navigation = new AbortController();
    inboxNavigation = navigation;
    try {
      const conversationTarget = item.target === "conversation" || item.target === "coding";
      if (conversationTarget) {
        setConversationSelections((previous) => ({
          ...previous,
          [`${item.projectId}:${item.ticketId ?? "none"}`]: item.contextId ?? "original",
        }));
        setAgentOpen(true);
      }
      await new Promise<void>((resolve) => onSettled(resolve));
      if (navigation.signal.aborted || selectedProjectID() !== item.projectId) return;
      if (conversationTarget) {
        pauseClarification(false);
        await refreshConversation(item.projectId, item.ticketId ?? undefined);
      } else if (item.target === "review") {
        setInboxFeedbackID(item.targetId ?? undefined);
      }
      if (item.ticketId && item.target !== "inputs") await refreshTicketDetail(item.ticketId);
      if (navigation.signal.aborted) return;
      // Inbox navigation owns focus, including sources in the Assistant.
      // A late document mount must not steal it back into the workspace.
      setWorkspaceFocusTarget(undefined);
      await new Promise<void>((resolve) => onSettled(resolve));
      if (navigation.signal.aborted) return;
      const selector =
        item.target === "inputs"
          ? `#input-event-${item.targetId}`
          : item.target === "coding" && item.targetId
            ? `#coding-message-${CSS.escape(item.targetId)}`
            : item.target === "conversation"
              ? item.targetId
                ? `#conversation-entry-${item.targetId}`
                : ".agent-panel"
              : item.target === "review" && item.targetId
                ? `#review-feedback-${item.targetId}`
                : ".ticket-document:not([hidden])";
      await revealInboxSource(selector, navigation.signal);
      if (item.unread) await inbox.mark(item, "read");
    } catch (cause) {
      if (!navigation.signal.aborted)
        setError(cause instanceof Error ? cause.message : "The Inbox source could not be opened.");
    }
  }

  const knowledgePageList = () => knowledgePages.data() ?? [];
  const selectedKnowledgePage = () => knowledgePage.data();
  function workspaceLocation(
    tab?: WorkspaceTab,
  ): Exclude<FactoryLocation, { view: "unavailable" }> {
    const projectID = selectedProjectID();
    if (tab?.view === "inbox") return { view: "inbox" };
    if (tab?.view === "settings")
      return {
        view: "settings",
        ...(tab.settingsProject ? { projectID: tab.settingsProject.id } : {}),
      };
    if (projectID && tab?.view === "ticket" && tab.ticketID)
      return { view: "ticket", projectID, ticketID: tab.ticketID };
    if (projectID && tab?.view === "knowledge") {
      const pageID = selectedKnowledgePageID();
      return { view: "knowledge", projectID, ...(pageID ? { pageID } : {}) };
    }
    return projectID ? { view: "project", projectID } : { view: "home" };
  }
  function publishWorkspaceLocation(tab?: WorkspaceTab) {
    publishLocation(workspaceLocation(tab));
  }
  function selectKnowledgePage(pageID: string) {
    const projectID = selectedProjectID();
    if (!projectID) return;
    knowledge.select(pageID);
    publishLocation({
      view: "knowledge",
      projectID,
      pageID,
    });
  }
  async function archiveKnowledgePage() {
    const projectID = selectedProjectID();
    if (
      (await knowledge.archive()) &&
      projectID &&
      selectedProjectID() === projectID &&
      workspaceView() === "knowledge"
    )
      publishLocation({ view: "knowledge", projectID });
  }
  async function openDocument(path: string) {
    const projectID = selectedProjectID();
    if (
      (await knowledge.openDocument(path)) &&
      projectID &&
      selectedProjectID() === projectID &&
      workspaceView() === "knowledge"
    )
      publishLocation({ view: "knowledge", projectID });
  }
  let restoredLocation = false;
  const desktopNavigation = createDesktopNavigation({
    navigation,
    ready: () =>
      projects.completeness() === "complete" && (!securityReturn || securityReturnRestored),
    accessKey: () => {
      const destination = navigation?.location();
      return destination && "projectID" in destination && destination.projectID
        ? String(projects.data()?.some((project) => project.id === destination.projectID))
        : "personal";
    },
    async apply(destination, current) {
      if (destination.view === "unavailable") throw new Error(unavailableLink);
      // Initial Board hydration is not a human decision to leave retained
      // setup. Explicit resource links and later history navigation are.
      if (restoredLocation || !["home", "project"].includes(destination.view))
        projectSetup?.show(false);
      restoredLocation = true;
      if ("projectID" in destination && destination.projectID) {
        if (!projects.data()?.some((project) => project.id === destination.projectID))
          throw new Error(unavailableLink);
        if (selectedProjectID() !== destination.projectID) {
          selectProject(destination.projectID, false, false);
          // Solid 2 batches writes. Commit the Project before reading scoped
          // state or opening a tab, without publishing an intermediate URL.
          await Promise.resolve();
          if (!current()) return;
        }
      }
      if (destination.view === "ticket") {
        if (
          selectedTicketID() === destination.ticketID &&
          detail()?.ticket.id === destination.ticketID &&
          workspaceView() === "ticket"
        ) {
          setWorkspaceVisible(true);
          return;
        }
        selectTicket(destination.ticketID, false, false, false);
        await Promise.resolve();
        if (!current()) return;
        const loaded = await refreshTicketDetail(destination.ticketID);
        if (!current()) return;
        if (!loaded) throw new Error(unavailableLink);
        updateWorkspaceTab({
          id: `ticket:${destination.ticketID}`,
          view: "ticket",
          label: loaded.ticket.title,
          ticketID: destination.ticketID,
        });
        await refreshConversation(destination.projectID, destination.ticketID);
      } else if (destination.view === "knowledge") {
        knowledge.select(destination.pageID);
        await openKnowledge(false);
      } else if (destination.view === "settings") {
        const project = destination.projectID
          ? projects.data()?.find((project) => project.id === destination.projectID)
          : undefined;
        openWorkspaceTab(
          {
            id: `settings:${destination.projectID ?? "factory"}`,
            view: "settings",
            label: "Settings",
            ...(project ? { settingsProject: { id: project.id, name: project.name } } : {}),
          },
          false,
        );
      } else if (destination.view === "inbox") returnToInbox(false);
      else {
        // Home uses the normal default-Project selection. Do not replay a
        // Project switch when its initial projection completes under an open
        // menu, or discard the retained tabs when returning to the Board.
        setWorkspaceVisible(false);
      }
    },
  });
  publishLocation = desktopNavigation.publish;
  const missingWikiLink = () => {
    const destination = navigation?.location();
    return (
      destination?.view === "knowledge" &&
      destination.pageID &&
      selectedKnowledgePageID() === destination.pageID &&
      knowledgePage.completeness() === "complete" &&
      !knowledgePage.data()
    );
  };
  const shareableURL = () => {
    const tab = activeWorkspaceTab();
    return navigation &&
      tab &&
      ["ticket", "knowledge", "settings", "inbox"].includes(tab.view) &&
      !(tab.view === "knowledge" && openRepositoryDocument()) &&
      !desktopNavigation.pending() &&
      !desktopNavigation.failure() &&
      !navigation.failure() &&
      !missingWikiLink()
      ? new URL(factoryPath(workspaceLocation(tab)), location.origin).href
      : undefined;
  };

  const ideTargets = (): RuntimeDockTarget[] => {
    const project = selectedProject();
    if (!project || !canDevelopProject() || lifecycleProjectID() !== project.id) return [];
    const liveAttempts = attempts().filter(
      (attempt) =>
        attempt.projectId === project.id &&
        ["personal", "ticket"].includes(attempt.runtimeKind ?? "") &&
        (attempt.workspaceKind !== "personal" || attempt.ownerUserId === props.session.user.id) &&
        ["create-intended", "starting", "ready"].includes(attempt.state),
    );
    const targets: RuntimeDockTarget[] = liveAttempts.map((attempt) => {
      const change = attempt.changeId
        ? changes().find((candidate) => candidate.id === attempt.changeId)
        : undefined;
      const ticket = change
        ? ticketList().find((candidate) => candidate.id === change.ticketId)
        : undefined;
      return {
        id:
          attempt.workspaceKind === "personal"
            ? `personal:${project.id}`
            : `change:${attempt.changeId}`,
        label: attempt.workspaceKind === "personal" ? "My workspace" : (ticket?.title ?? "Ticket"),
        detail: attempt.state,
        attemptId: attempt.id,
        ...(attempt.changeId ? { changeId: attempt.changeId } : {}),
      };
    });
    if (!liveAttempts.some((attempt) => attempt.workspaceKind === "personal")) {
      targets.unshift({
        id: `personal:${project.id}`,
        label: "My workspace",
        detail: "Edit without starting compute",
        projectId: project.id,
      });
    }
    for (const change of changes().filter(
      (candidate) =>
        candidate.projectId === project.id &&
        !["cancelled", "cancelling", "delivering", "delivered"].includes(candidate.state) &&
        !liveAttempts.some((attempt) => attempt.changeId === candidate.id),
    )) {
      const ticket = ticketList().find((candidate) => candidate.id === change.ticketId);
      targets.push({
        id: `change:${change.id}`,
        label: ticket?.title ?? "Ticket",
        detail: "Open source",
        changeId: change.id,
      });
    }
    return targets;
  };
  const previewTargets = (): RuntimeDockTarget[] => {
    const project = selectedProject();
    if (!project || lifecycleProjectID() !== project.id) return [];
    const staging = stagingRuntimeFor(project.id);
    const stagedApps = appPreviews().filter(
      (preview) =>
        preview.projectID === project.id &&
        (!preview.attemptID || preview.attemptID === staging?.id),
    );
    const targets: RuntimeDockTarget[] = stagedApps.length
      ? []
      : staging
        ? [
            {
              id: `staging:${project.id}`,
              label: "Staging",
              detail: staging.state,
              attemptId: staging.id,
            },
          ]
        : [
            {
              id: `staging:${project.id}`,
              label: "Staging",
              detail: "Opens when selected",
              projectId: project.id,
            },
          ];
    for (const preview of appPreviews().filter((item) => item.projectID === project.id)) {
      const staged = !preview.attemptID || preview.attemptID === staging?.id;
      targets.push({
        id: staged
          ? `staging:${project.id}:${preview.channel}`
          : `app:${preview.attemptID}:${preview.channel}`,
        label: preview.label,
        detail: !preview.attemptID
          ? "Starts when selected"
          : staged
            ? (staging?.state ?? preview.state ?? "Preparing")
            : "Development",
        ...(preview.attemptID ? { attemptId: preview.attemptID } : { projectId: project.id }),
        appChannel: preview.channel,
      });
    }
    return targets.length
      ? targets
      : [
          {
            id: `staging:${project.id}`,
            label: "Staging",
            detail: "Opens when selected",
            projectId: project.id,
          },
        ];
  };
  const {
    openIDETarget,
    openChatActivity,
    openPreviewTarget,
    retryMainPreview,
    ticketPreviewTarget,
    openDevelopmentPreview,
  } = createRuntimeNavigation({
    canDevelopProject,
    selectedProjectID,
    changes,
    loadTicketContext,
    setSelectedTicketID,
    setDetail,
    resetAgentView,
    setConversation,
    openWorkspaceTab,
    mutate,
    updateWorkspaceTab,
    refreshServerState,
    selectedChange,
    ideTargets,
    activeWorkspaceTab,
    setIDENavigation,
    workspaceTabs,
    activateWorkspaceTab,
    attempts,
    previewTargets,
  });

  createEffect(assistantKey, () => conversationScroll?.reset());

  let observedProposalContext = "";
  let observedProposalID: string | undefined;
  createEffect(
    () => ({ key: assistantKey(), proposal: detail()?.proposal?.id }),
    ({ key, proposal }) => {
      if (key !== observedProposalContext) {
        observedProposalContext = key;
        observedProposalID = proposal;
        return;
      }
      if (
        proposal &&
        proposal !== observedProposalID &&
        clarificationOrigins.has(key) &&
        workspaceView() === "ticket"
      ) {
        setAgentOpen(false);
        clarificationOrigins.delete(key);
      }
      observedProposalID = proposal;
    },
  );

  const documentWindowModel: DocumentWindowModel = {
    get workspaceElement() {
      return workspaceElement;
    },
    set workspaceElement(value) {
      workspaceElement = value;
    },
    workspaceView,
    workspaceWindow,
    workspaceVisible,
    workspaceTabs,
    agentOverlay,
    registrationOpen,
    activeWorkspaceTab,
    shareableURL,
    activateWorkspaceTab,
    closeWorkspaceTab,
    setWorkspaceVisible,
    inboxSourceActive,
    nextInboxItem,
    inboxSourceOpening,
    inbox,
    returnToInbox,
    startInboxItem,
    activeWorkspaceLabelID,
    epicProposals,
    bootstrap: props,
    pending,
    confirmEpicWork,
    personalDraftKey,
    personalDrafts,
    selectedProjectID,
    publishTicketDraft,
    updateWorkspaceTab,
    detail,
    inboxFeedbackID,
    ticketDrafts,
    confirmRequirements,
    ticketClarificationAction,
    selectedChange,
    delivery,
    latestRevision,
    latestRequirement,
    agentTurnBusy,
    epicList,
    prerequisitesFor,
    dependencyCandidates,
    selectTicket,
    editDependency,
    assignTicketEpic,
    beginRequirementsInterview,
    saveTechnicalDesign,
    assistantPending,
    assistantTicketID,
    moveTicket,
    saveTicketDocument,
    createFollowUp,
    setSelectedEpicID,
    ticketTrashCommand,
    implementTicket,
    preparingImplementation,
    openCodingOptions,
    agentOpen,
    modelRelayConfigured,
    agent,
    resumeCoding,
    stopAgent,
    ideTargets,
    openIDETarget,
    ticketPreviewTarget,
    openPreviewTarget,
    retryMainPreview,
    approveDelivery,
    retryReview,
    retryPromotion,
    resumeChecks,
    canDevelopProject,
    browserRepository,
    knowledgeDrafts,
    knowledgeLoading: knowledge.loading,
    knowledgePageList,
    selectedKnowledgePage,
    repositoryDocuments,
    loadRepositoryDocuments,
    openRepositoryDocument,
    knowledgeGeneration,
    knowledgeHistory,
    knowledgeSearch,
    knowledgeSearchQuery,
    selectKnowledgePage,
    openDocument,
    mutate,
    generateKnowledge,
    searchProjectKnowledge,
    editKnowledgePage,
    loadKnowledgeHistory,
    archiveKnowledgePage,
    zero,
    commitZeroMutation,
    inboxPosition,
    inboxRestoreKey,
    setInboxPosition,
    trashTickets,
    trashLimit,
    setTrashLimit,
    canManageSettingsProject,
    refreshModelAvailability,
    selectProject,
    memberships,
    attempts,
    appPreviews,
    changes,
    projectMenuOpen,
    ideNavigation,
    setIDENavigation,
    setError,
    refreshServerState,
    openDevelopmentPreview,
  };

  const assistantPanelModel: AssistantPanelModel = {
    agentPresence,
    agentOpen,
    agentOverlay,
    registrationOpen,
    get agentPanelElement() {
      return agentPanelElement;
    },
    set agentPanelElement(value) {
      agentPanelElement = value;
    },
    inboxSourceActive,
    nextInboxItem,
    inboxSourceOpening,
    inbox,
    returnToInbox,
    startInboxItem,
    setupVisible,
    preparingImplementation,
    detail,
    dismissAgent,
    projectSetup,
    openSettings,
    selectProject,
    conversationScope,
    assistantTicketID,
    ticketList,
    selectedProject,
    conversation,
    canDevelopProject,
    conversationMode,
    assistantPending,
    assistantContextLoading,
    codingWriterBlocked,
    agentViewLoaded,
    agentCanRun,
    agentTurnBusy,
    agent,
    agentNeedsResolution,
    setConversationSelections,
    newConversation,
    setImplementationPreparation,
    selectedChange,
    ticketWorkspaceReady,
    ticketWorkspaceStatus,
    pending,
    recheckStopConfirmation,
    checkStopStatus,
    get conversationScroll() {
      return conversationScroll;
    },
    set conversationScroll(value) {
      conversationScroll = value;
    },
    visibleConversation,
    openChatActivity,
    answeredQuestionIDs,
    answerSummary,
    latestRevision,
    workspaceView,
    restoredInterviewAnswer,
    bootstrap: props,
    pendingInterview,
    currentInterviewQuestion,
    pauseClarification,
    setAgentOpen,
    answerInterview,
    epicProposals,
    openWorkspaceTab,
    selectTicket,
    setError,
    openTicketDraft,
    setSelectedEpicID,
    browserRepository,
    selectKnowledgePage,
    openKnowledge,
    streamedAnswer,
    setCodingWriter,
    historicalCoding,
    retainedCodingDraft,
    assistantKey,
    selectedProjectID,
    stopAgent,
    restoredMessageScope,
    agentCommandScope,
    implementTicket,
    canPromptBuild,
    startAgent,
    promptAgent,
    restoreMessageDraft,
    chosenCodingReasoning,
    setCodingReasoningChoices,
    modelRelayConfigured,
    blockersFor,
    selectedTicketID,
    interviewOwnsComposer,
    sendConversationMessage,
    conversationPlaceholder,
  };

  const projectBoardModel: ProjectBoardModel = {
    workspaceVisible,
    agentOverlay,
    registrationOpen,
    setupVisible,
    selectedProject,
    setProjectMenuOpen,
    narrowViewport,
    historyTickets,
    boardHasMore,
    ticketLimit,
    boardHistoryOpen,
    setBoardHistoryOpen,
    history,
    historyLimit,
    boardPageLoading,
    setHistoryLimit,
    setTicketLimit,
    boardPageLabel,
    foundTickets,
    setFind,
    boardStatus,
    selectTicket,
    pending,
    openTicketDraft,
    scopedTickets,
    epicList,
    lane,
    selectedTicketID,
    blockersFor,
    selectedEpicID,
    setSelectedEpicID,
    saveEpic,
    tickets,
  };

  const desktopTopbarModel: DesktopTopbarModel = {
    registrationOpen,
    agentOpen,
    get agentToggleElement() {
      return agentToggleElement;
    },
    set agentToggleElement(value) {
      agentToggleElement = value;
    },
    rememberAgentOpener,
    setAgentOpen,
    get projectControlElement() {
      return projectControlElement;
    },
    set projectControlElement(value) {
      projectControlElement = value;
    },
    narrowViewport,
    projectMenuOpen,
    selectedProject,
    setSettingsOpen,
    setProjectMenuOpen,
    get projectPopover() {
      return projectPopover;
    },
    set projectPopover(value) {
      projectPopover = value;
    },
    bootstrap: props,
    setError,
    setWorkspaceVisible,
    projectSetup,
    projects,
    projectSearchQuery,
    setProjectSearchQuery,
    filteredProjects,
    selectedProjectID,
    setPreloadProjectID,
    selectProject,
    workspaceVisible,
    setupVisible,
    workspaceView,
    workspaceTabs,
    openKnowledge,
    detail,
    selectedTicketID,
    activateWorkspaceTab,
    selectTicket,
    ideTargets,
    activeWorkspaceTab,
    selectedChange,
    openIDETarget,
    previewTargets,
    openPreviewTarget,
    inbox,
    returnToInbox,
    agentOverlay,
    foundTickets,
    setFind,
    boardStatus,
    pending,
    openTicketDraft,
    get settingsControlElement() {
      return settingsControlElement;
    },
    set settingsControlElement(value) {
      settingsControlElement = value;
    },
    settingsOpen,
    get settingsPopover() {
      return settingsPopover;
    },
    set settingsPopover(value) {
      settingsPopover = value;
    },
    openSettings,
    openWorkspaceTab,
    backgroundSaves,
    canManageProject,
    backgroundChoices,
    backgroundPickerExpanded,
    desktopBackgroundKey,
    chooseDesktopBackground,
    setBackgroundPickerExpanded,
  };

  return (
    <AttachmentProvider
      projectId={selectedProjectID()}
      scopeKey={`${contextKey()}:${assistantKey()}:${selectedKnowledgePageID() ?? ""}:${activeWorkspaceTab()?.id ?? ""}`}
    >
      <main
        class={`factory-desktop${agentOpen() ? " agent-is-open" : ""}${agentOverlay() ? " agent-is-overlay" : ""}`}
        data-background={desktopBackgroundKey()}
      >
        <h1 class="sr-only">Delivery floor</h1>
        <MentionSupport
          projectID={selectedProjectID()}
          sharedTicket={Boolean(assistantTicketID())}
        />

        <Show when={projectMenuOpen() || settingsOpen()}>
          <button
            type="button"
            class="popover-backdrop"
            aria-label="Close menu"
            tabindex={-1}
            onClick={() => {
              setProjectMenuOpen(false);
              setSettingsOpen(false);
            }}
          />
        </Show>

        <DesktopTopbar model={desktopTopbarModel} />

        <div class="desktop-notices">
          <Show when={desktopNavigation.pending()}>
            <div class="sync-notice" role="status">
              <span>Opening linked view…</span>
            </div>
          </Show>
          <Show when={desktopNavigation.failure() || navigation?.failure() || missingWikiLink()}>
            <div class="sync-notice" role="alert">
              <span>{desktopNavigation.failure() || navigation?.failure() || unavailableLink}</span>
              <button type="button" class="quiet-button" onClick={() => desktopNavigation.retry()}>
                Retry link
              </button>
            </div>
          </Show>
          <Show when={error() && !registrationOpen()}>
            <p class="error-toast" role="alert">
              {error()}
            </p>
          </Show>
          <PlanningSyncStatus
            queries={[
              projects,
              memberships,
              ...(selectedProjectID()
                ? [tickets, history, epics, dependencies, prerequisiteTickets]
                : []),
              ...(workspaceTabs().some((tab) => tab.view === "knowledge") ? [knowledgePages] : []),
              ...(workspaceTabs().some((tab) => tab.view === "trash") ? [trashTickets] : []),
              ...(selectedKnowledgePageID() &&
              workspaceTabs().some((tab) => tab.view === "knowledge")
                ? [knowledgePage]
                : []),
            ]}
            readError={syncError()}
            onRetry={refreshServerState}
          />
        </div>

        <ProjectBoard model={projectBoardModel} />

        <Show when={registrationOpen()}>
          <ProjectRegistration
            pending={pending()}
            error={error()}
            opener={projectMenuOpener()}
            onSubmit={register}
            onClose={() => setRegistrationOpen(false)}
          />
        </Show>
        <Show when={agentOverlay()}>
          <button
            type="button"
            class="agent-overlay-backdrop"
            aria-label="Dismiss Agent overlay"
            tabindex={-1}
            onClick={dismissAgent}
          />
        </Show>
        <AssistantPanel model={assistantPanelModel} />

        <DocumentWindow model={documentWindowModel} />
      </main>
    </AttachmentProvider>
  );
}
