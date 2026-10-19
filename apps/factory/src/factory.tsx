import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Loading,
  lazy,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { z } from "zod";
import {
  clarificationAction,
  unansweredClarification,
} from "../../../packages/conversation-domain/src/clarification";
import type {
  ConversationMode,
  InterviewQuestion,
} from "../../../packages/conversation-domain/src/conversation";
import {
  interviewAnswerInput,
  normalizeInterviewAnswer,
} from "../../../packages/conversation-domain/src/conversation";
import {
  type EpicProposal,
  epicProposalInput,
} from "../../../packages/conversation-domain/src/epic-proposal";
import { assistantContext } from "../../../packages/interface-domain/src/assistant-context";
import type { DesktopBackgroundKey } from "../../../packages/interface-domain/src/background";
import {
  type BoardStage,
  ticketBoardStage,
  ticketBoardStatus,
} from "../../../packages/interface-domain/src/ticket-board";
import { workspacePresence } from "../../../packages/interface-domain/src/workspace-presence";
import {
  type RequirementContent,
  requirementContentInput,
} from "../../../packages/requirement-domain/src/content";
import {
  dependencyWouldCycle,
  type PrerequisiteView,
  prerequisiteIsDelivered,
} from "../../../packages/ticket-domain/src/dependency";
import { epicFamilyIds } from "../../../packages/ticket-domain/src/epic";
import {
  type FactoryZeroContext,
  type FactoryZeroSchema,
  zeroMutators,
  zeroQueries,
  zeroSchema,
} from "../../../packages/zero-schema/src";
import { useZero, useZeroQuery, ZeroProvider } from "../../../packages/zero-solid/src";
import { takeSettingsReturn } from "./access/settings-return";
import { AgentBlockers } from "./agent/configuration";
import { BuildModelControls } from "./agent/build-model-controls";
import {
  codingReasoningInput,
  type CodingReasoning,
} from "../../../packages/conversation-domain/src/model-settings";
import { createAgentCommandIds } from "./agent-command-ids";
import {
  type AgentSnapshot,
  buildAgentHint,
  buildAgentEmptyMessage,
  buildAgentActivityNotice,
  buildAgentNeedsStart,
  buildAgentStatus,
  createAgentReadFence,
  retainAgentActivity,
} from "./agent-view-state";
import { apiRequest, emptyResponseSchema } from "./api-client";
import type { Epic } from "./api-contracts";
import {
  type AgentView,
  type AppPreview,
  agentViewSchema,
  appPreviewsSchema,
  attemptsResponseSchema,
  type Bootstrap,
  type Change,
  type ConversationView,
  changesResponseSchema,
  conversationViewSchema,
  type DeliveryView,
  deliveryViewSchema,
  type KnowledgeGeneration,
  type KnowledgeRevision,
  knowledgeGenerationSchema,
  knowledgeHistorySchema,
  knowledgeSaveSchema,
  knowledgeSearchSchema,
  knowledgeSourcesSchema,
  type OpenRepositoryDocument,
  openRepositoryDocumentSchema,
  projectSchema,
  type RepositoryDocument,
  type RequirementRevision,
  type RuntimeAttempt,
  type RuntimeDockTarget,
  repositoryDocumentsSchema,
  runtimeAttemptSchema,
  type Session,
  sourceWorkspaceViewSchema,
  type Ticket,
  type TicketDocumentRevision,
  ticketDetailSchema,
  type UIPreference,
  uiPreferenceSchema,
} from "./api-contracts";
import { desktopBackgrounds } from "./artworks";
import { composerKeyDown, followConversation, resizeComposer } from "./assistant-interaction";
import {
  ChangeAgentMessage,
  ConversationEntryCard,
  conversationQuestion,
} from "./conversation-components";
import { streamConversation } from "./conversation-stream";
import { conversationTimeline } from "./conversation-timeline";
import { bindDialogKeyboard } from "./dialog-keyboard";
import { DockAppButton, DockButton } from "./dock";
import { EpicControls, type EpicEdit } from "./epic-controls";
import { EpicProposalWorkspace } from "./epic-proposal-workspace";
import { Icon } from "./icon";
import type { KnowledgeDraft } from "./knowledge-workspace";
import { createLifecyclePoller } from "./lifecycle-poller";
import { markdownHTML } from "./markdown";
import { bindPopoverKeyboard } from "./popover-keyboard";
import { createProjectSetupInteraction, ProjectSetupPanel, SetupEmptyBoard } from "./setup/panel";
import { TicketBoardContents } from "./ticket-board";
import {
  type PersonalTicketDraft,
  readPersonalTicketDraft,
  TicketDraftWorkspace,
} from "./ticket-draft-workspace";
import type { TicketDraft } from "./ticket-workspace";
import { TicketWorkspace } from "./ticket-workspace";
import { TrashWorkspace } from "./trash-workspace";
import { createWindowPresence } from "./window-presence";
import {
  DesktopEmpty,
  InboxWorkspace,
  ProjectRegistration,
  WindowHeading,
} from "./workspace-chrome";
import { WorkspaceTabbar, workspacePanelID, workspaceTabElementID } from "./workspace-tabbar";
import {
  closeWorkspaceTabState,
  followStagingPromotion,
  openWorkspaceTabState,
  type ProjectWorkspaceState,
  selectedWorkspaceTab,
  updateWorkspaceTabState,
  type WorkspaceTab,
} from "./workspace-tabs";

const KnowledgeWorkspace = lazy(async () => ({
  default: (await import("./knowledge-workspace")).KnowledgeWorkspace,
}));
const RuntimeWorkspaceTabs = lazy(async () => ({
  default: (await import("./runtime-workspace")).RuntimeWorkspaceTabs,
}));
const DeveloperIDEWorkspace = lazy(async () => ({
  default: (await import("./developer-ide-workspace")).DeveloperIDEWorkspace,
}));
const SettingsWorkspace = lazy(async () => ({
  default: (await import("./settings-workspace")).SettingsWorkspace,
}));

function requirementContent(revision?: RequirementRevision): RequirementContent | undefined {
  if (!revision) return undefined;
  try {
    const parsed = requirementContentInput.safeParse(JSON.parse(revision.canonicalContent));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function ticketReference(ticketID: string) {
  return `TCK-${ticketID.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

export function AuthenticatedFactory(props: Bootstrap & { session: Session }) {
  return (
    <ZeroProvider
      identity={{ userId: props.session.user.id, schemaVersion: "slice-11b-access" }}
      cacheURL={props.zeroCacheURL}
      schema={zeroSchema}
      mutators={zeroMutators}
      context={{
        userId: props.session.user.id,
        systemManager: props.session.systemManager,
      }}
    >
      <FactoryWorkspace
        session={props.session}
        uiPreference={props.uiPreference}
        modelRelayConfigured={props.modelRelayConfigured}
      />
    </ZeroProvider>
  );
}

function FactoryWorkspace(props: {
  session: Session;
  uiPreference: UIPreference;
  modelRelayConfigured: boolean;
}) {
  const zero = useZero<FactoryZeroSchema, undefined, FactoryZeroContext>();
  const projects = useZeroQuery(() => zeroQueries.projects.list());
  const memberships = useZeroQuery(() => zeroQueries.memberships.list());
  const [selectedProjectID, setSelectedProjectID] = createSignal<string>();
  const securityReturn = takeSettingsReturn(props.session.user.id);
  let securityReturnRestored = false;
  const tickets = useZeroQuery(() => {
    const projectId = selectedProjectID();
    return projectId ? zeroQueries.tickets.list({ projectId }) : null;
  });
  const epics = useZeroQuery(() => {
    const projectId = selectedProjectID();
    return projectId ? zeroQueries.epics.list({ projectId }) : null;
  });
  const dependencies = useZeroQuery(() => {
    const projectId = selectedProjectID();
    return projectId ? zeroQueries.dependencies.list({ projectId }) : null;
  });
  const [selectedEpicID, setSelectedEpicID] = createSignal("");
  createEffect(selectedProjectID, () => {
    setSelectedEpicID("");
  });
  const [selectedTicketID, setSelectedTicketID] = createSignal<string>();
  const [epicProposals, setEpicProposals] = createSignal<Record<string, EpicProposal>>({});
  const clarificationOrigins = new Set<string>();
  const assistantTicketID = () => {
    const tab = selectedWorkspaceTab(currentWorkspaceState());
    return tab?.view === "ticket" || tab?.view === "ide" || tab?.view === "epic-proposal"
      ? tab.ticketID
      : undefined;
  };
  const [pausedClarifications, setPausedClarifications] = createSignal<Record<string, boolean>>({});
  const clarificationPaused = () => pausedClarifications()[assistantKey()] ?? false;
  function pauseClarification(paused: boolean) {
    const key = assistantKey();
    setPausedClarifications((current) => ({ ...current, [key]: paused }));
    try {
      sessionStorage.setItem(`clarification-paused:${key}`, String(paused));
    } catch {
      /* Visible state remains usable. */
    }
  }
  const assistantKey = () =>
    `assistant:${selectedProjectID() ?? "none"}:${assistantTicketID() ?? "none"}`;
  const assistantPending = () =>
    (pendingContexts()[assistantKey()] ?? 0) > 0 ||
    ["pending", "dispatching", "running"].includes(conversation()?.turn?.state ?? "") ||
    Boolean(assistantTicketID() && detail()?.requirementsEntry?.state === "pending");
  const [pendingInterviewAnswer, setPendingInterviewAnswer] = createSignal<{
    key: string;
    questionID: string;
    text: string;
  }>();
  const [detail, setDetail] = createSignal<{
    ticket: Ticket;
    revisions: RequirementRevision[];
    documentRevisions: TicketDocumentRevision[];
    proposal?: import("./api-contracts").RequirementProposal | null;
    requirementsEntry?:
      | { state: "pending" | "admitted" | "failed"; failure: string | null }
      | null
      | undefined;
    origin: { id: string; title: string } | null;
    followUps: Array<{ id: string; title: string }>;
  }>();
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
  const knowledgeDrafts = new Map<string, KnowledgeDraft>();
  const [projectWorkspaces, setProjectWorkspaces] = createSignal<
    Record<string, ProjectWorkspaceState>
  >({});
  const workspaceWindow = createWindowPresence();
  const { visible: workspaceVisible, setVisible: setWorkspaceVisible } = workspaceWindow;
  const agentPresence = createWindowPresence();
  const { visible: agentOpen, setVisible: setAgentOpen } = agentPresence;
  const projectSetup = props.session.systemManager
    ? createProjectSetupInteraction(props.session.user.id, () => setAgentOpen(true))
    : undefined;
  const setupVisible = () => projectSetup?.visible() === true;
  const [narrowViewport, setNarrowViewport] = createSignal(false);
  const agentOverlay = () => agentOpen() && narrowViewport();
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [projectSearchQuery, setProjectSearchQuery] = createSignal("");
  const [registrationOpen, setRegistrationOpen] = createSignal(false);
  const [boardHistoryOpen, setBoardHistoryOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [correctionTarget, setCorrectionTarget] = createSignal<string>();
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
  const [desktopBackgroundKey, setDesktopBackgroundKey] = createSignal(
    props.uiPreference.desktopBackgroundKey,
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
  let lastAgentHistory = { changeID: "", at: 0 };
  function publishAgentView(
    changeID: string,
    view: AgentView,
    read?: ReturnType<typeof agentReadFence.beginRead>,
    historyRequested = true,
  ) {
    if (read && !agentReadFence.current(read)) return;
    if (!read) agentReadFence.commandPublished();
    try {
      if (view.turn) {
        acknowledgeCommand(agentCommandScope("change-start", changeID), view.turn.commandId);
        acknowledgeCommand(agentCommandScope("change-prompt", changeID), view.turn.commandId);
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
    lastAgentHistory = { changeID: "", at: 0 };
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
  const [storedConversation, setConversation] = createSignal<ConversationView>();
  let conversationReadGeneration = 0;
  let ticketReadGeneration = 0;
  let workspaceDisposed = false;
  const projectStreams = new Set<AbortController>();
  onCleanup(() => {
    workspaceDisposed = true;
    for (const controller of projectStreams) controller.abort();
    projectStreams.clear();
  });
  const [streamedAnswers, setStreamedAnswers] = createSignal<
    Record<string, { turnId: string; text: string }>
  >({});
  const streamedAnswer = () => {
    const answer = streamedAnswers()[assistantKey()];
    if (!answer?.text) return undefined;
    const turn = conversation()?.turn;
    if (turn?.id === answer.turnId && !["pending", "dispatching", "running"].includes(turn.state))
      return undefined;
    return answer;
  };
  const conversation = () => {
    const value = storedConversation();
    return value &&
      value.projectId === selectedProjectID() &&
      (value.ticketId ?? undefined) === assistantTicketID()
      ? value
      : undefined;
  };
  function publishConversation(value: ConversationView | undefined) {
    // A command result supersedes GETs already in flight, even when their
    // captured turn state has the same document version.
    conversationReadGeneration++;
    setConversation(value);
    for (const entry of value?.entries ?? []) {
      const parsed = epicProposalInput.safeParse(entry.payload["epicProposal"]);
      if (parsed.success && !epicProposals()[entry.id])
        setEpicProposals((current) => ({ ...current, [entry.id]: parsed.data }));
    }
  }
  const agentCommandIds = createAgentCommandIds({
    userId: props.session.user.id,
    storage: {
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
    },
  });
  const [commandAcknowledgements, setCommandAcknowledgements] = createSignal(0);
  const [restoredMessageScope, setRestoredMessageScope] = createSignal<string>();
  function agentCommandScope(
    kind: string,
    identity: string | null | undefined = assistantTicketID(),
    projectID = selectedProjectID(),
  ) {
    return JSON.stringify([projectID, kind, identity ?? null]);
  }
  function acknowledgeCommand(scope: string, ...commandIds: string[]) {
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
  const messageDrafts = new Map<string, string>();
  function restoreMessageDraft(element: HTMLTextAreaElement, scope: () => string) {
    let previousScope: string | undefined;
    let restoredCommand: ReturnType<typeof agentCommandIds.latest>;
    const retain = () => {
      const key = previousScope ?? scope();
      if (element.value) messageDrafts.set(key, element.value);
      else messageDrafts.delete(key);
    };
    const reset = () => queueMicrotask(retain);
    element.addEventListener("input", retain);
    element.form?.addEventListener("reset", reset);
    onCleanup(() => {
      retain();
      element.removeEventListener("input", retain);
      element.form?.removeEventListener("reset", reset);
    });
    createEffect(
      () => [scope(), commandAcknowledgements()] as const,
      ([key]) => {
        try {
          if (previousScope === key) {
            if (
              restoredCommand &&
              agentCommandIds.latest(key)?.commandId !== restoredCommand.commandId
            ) {
              if (element.value === restoredCommand.draft) {
                element.value = "";
                messageDrafts.delete(key);
              }
              restoredCommand = undefined;
              setRestoredMessageScope(undefined);
            }
            return;
          }
          if (previousScope) retain();
          previousScope = key;
          restoredCommand = agentCommandIds.latest(key);
          element.value = messageDrafts.get(key) ?? restoredCommand?.draft ?? "";
          queueMicrotask(() => resizeComposer(element));
          setRestoredMessageScope(restoredCommand?.draft ? key : undefined);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Browser recovery is unavailable.");
        }
      },
    );
  }
  const [delivery, setDelivery] = createSignal<DeliveryView>();
  const [selectedKnowledgePageID, setSelectedKnowledgePageID] = createSignal<string>();
  const [repositoryDocuments, setRepositoryDocuments] = createSignal<RepositoryDocument[]>([]);
  const [openRepositoryDocument, setOpenRepositoryDocument] =
    createSignal<OpenRepositoryDocument>();
  const [knowledgeGeneration, setKnowledgeGeneration] = createSignal<KnowledgeGeneration>();
  const [knowledgeHistory, setKnowledgeHistory] = createSignal<KnowledgeRevision[]>([]);
  const [knowledgeSearch, setKnowledgeSearch] = createSignal<
    typeof knowledgeSearchSchema._output.results
  >([]);
  const [knowledgeSearchQuery, setKnowledgeSearchQuery] = createSignal("");
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
  createEffect(
    () => true,
    () => {
      const query = window.matchMedia("(max-width: 900px)");
      const update = () => {
        if (query.matches && agentOpen()) agentOverlayOpener = agentToggleElement;
        setNarrowViewport(query.matches);
      };
      update();
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    },
  );
  createEffect(
    () => agentOverlay(),
    (overlay) => {
      if (!overlay) return;
      setProjectMenuOpen(false);
      setSettingsOpen(false);
      let cancelled = false;
      let cleanup: (() => void) | undefined;
      queueMicrotask(() => {
        if (!cancelled && agentPanelElement) {
          cleanup = bindDialogKeyboard(
            agentPanelElement,
            () => setAgentOpen(false),
            agentOverlayOpener,
            () => !agentOpen(),
          );
        }
      });
      return () => {
        cancelled = true;
        cleanup?.();
      };
    },
  );
  let knowledgeSearchRequest = 0;
  let documentRequest = 0;
  let knowledgeAccessEpoch = 0;
  let knowledgeAccessKey: string | undefined;
  createEffect(
    () => `${selectedProjectID()}:${canDevelopProject()}`,
    (key) => {
      if (knowledgeAccessKey === key) return;
      knowledgeAccessKey = key;
      const develop = canDevelopProject();
      knowledgeAccessEpoch += 1;
      documentRequest += 1;
      knowledgeSearchRequest += 1;
      setKnowledgeHistory([]);
      setKnowledgeSearch([]);
      if (!develop) {
        setRepositoryDocuments([]);
        setOpenRepositoryDocument(undefined);
      }
    },
  );
  let conversationScroll: ReturnType<typeof followConversation> | undefined;
  onCleanup(() => conversationScroll?.dispose());

  createEffect(
    () => true,
    () => {
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
          ? projectControlElement?.querySelector<HTMLButtonElement>("button")
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
    },
  );

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
        const container = projectOpen ? projectControlElement : settingsControlElement;
        if (element)
          cleanup = bindPopoverKeyboard(
            element,
            container?.querySelector<HTMLButtonElement>("button") ?? undefined,
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

  const currentWorkspaceState = () => {
    return projectWorkspaces()[selectedProjectID() ?? "factory"];
  };
  const workspaceTabs = () => currentWorkspaceState()?.tabs ?? [];
  const knowledgePages = useZeroQuery(() => {
    const projectId = selectedProjectID();
    return projectId && workspaceTabs().some((tab) => tab.view === "knowledge")
      ? zeroQueries.knowledge.list({ projectId })
      : null;
  });
  const activeWorkspaceTab = () => {
    if (!workspaceWindow.present()) return undefined;
    return selectedWorkspaceTab(currentWorkspaceState());
  };
  const workspaceView = () => activeWorkspaceTab()?.view;
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

  function updateCurrentWorkspace(update: (state: ProjectWorkspaceState) => ProjectWorkspaceState) {
    const projectID = selectedProjectID() ?? "factory";
    setProjectWorkspaces((states) => ({
      ...states,
      [projectID]: update(states[projectID] ?? { tabs: [] }),
    }));
  }

  function openWorkspaceTab(tab: WorkspaceTab) {
    updateCurrentWorkspace((state) => openWorkspaceTabState(state, tab));
    setWorkspaceVisible(true);
  }

  function openSettings() {
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

  function updateWorkspaceTab(tab: WorkspaceTab, projectID = selectedProjectID()) {
    if (!projectID) return;
    setProjectWorkspaces((states) => ({
      ...states,
      [projectID]: updateWorkspaceTabState(states[projectID] ?? { tabs: [] }, tab),
    }));
  }

  function activateWorkspaceTab(tab: WorkspaceTab) {
    updateCurrentWorkspace((state) => ({ ...state, activeTabID: tab.id }));
    setWorkspaceVisible(true);
    if (tab.ticketID && tab.ticketID !== selectedTicketID()) {
      loadTicketContext(tab.ticketID);
    }
  }

  function closeWorkspaceTab(tabID: string) {
    const state = currentWorkspaceState();
    if (!state) return;
    const result = closeWorkspaceTabState(state, tabID);
    if (!result.closed) return;
    updateCurrentWorkspace(() => result.state);
    if (!result.state.tabs.length) setWorkspaceVisible(false);
    if (result.next) activateWorkspaceTab(result.next);
  }

  createEffect(
    () => projects.data(),
    (list) => {
      if (list && securityReturn && !securityReturnRestored) {
        securityReturnRestored = true;
        const project =
          securityReturn.project && list.find((item) => item.id === securityReturn.project?.id);
        if (
          (!securityReturn.project || project) &&
          (securityReturn.scope !== "system" || props.session.systemManager)
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
      if (!selectedProjectID() && !projectWorkspaces()["factory"]?.tabs.length && list?.[0])
        setSelectedProjectID(list[0].id);
    },
  );

  createEffect(
    () => ({
      pages: knowledgePages.data() ?? [],
      selectedID: selectedKnowledgePageID(),
      document: openRepositoryDocument(),
    }),
    ({ pages, selectedID, document }) => {
      if (!document && pages[0] && !pages.some((page) => page.id === selectedID)) {
        setSelectedKnowledgePageID(pages[0].id);
      }
    },
  );

  async function readLifecycleState(signal: AbortSignal) {
    const projectID = selectedProjectID();
    if (!projectID) return;
    const query = `?projectId=${encodeURIComponent(projectID)}`;
    const [changeBody, attemptBody, previewBody] = await Promise.all([
      apiRequest(changesResponseSchema, `/api/changes${query}`, { signal }),
      apiRequest(attemptsResponseSchema, `/api/runtime-attempts${query}`, { signal }),
      apiRequest(appPreviewsSchema, `/api/projects/${projectID}/app-previews`, { signal }),
    ]);
    if (selectedProjectID() !== projectID) return;
    setChanges(changeBody.changes);
    setAttempts(attemptBody.attempts);
    setAppPreviews(previewBody.previews);
    const staging = attemptBody.attempts.find(
      (attempt) =>
        attempt.projectId === projectID &&
        attempt.runtimeKind === "staging" &&
        attempt.currentStaging &&
        attempt.state === "ready",
    );
    setProjectWorkspaces((states) => {
      const state = states[projectID];
      if (!state) return states;
      const next = followStagingPromotion(state, projectID, staging?.id);
      return next === state ? states : { ...states, [projectID]: next };
    });
    setLifecycleProjectID(projectID);
    if (detail()?.ticket.trashedAt && detail()?.ticket.id === selectedTicketID()) {
      await refreshTicketDetail();
    }
    const changeID = selectedChange()?.id;
    if (changeID) {
      const read = agentReadFence.beginRead();
      const historyInterval = ["starting", "working"].includes(agent().state) ? 2_000 : 10_000;
      const history =
        agentOpen() &&
        (lastAgentHistory.changeID !== changeID ||
          Date.now() - lastAgentHistory.at >= historyInterval);
      const [agentView, deliveryView] = await Promise.all([
        apiRequest(
          agentViewSchema,
          `/api/changes/${changeID}/agent${history ? "" : "?history=0"}`,
          { signal },
        ),
        apiRequest(deliveryViewSchema, `/api/changes/${changeID}/delivery`, { signal }),
      ]);
      if (selectedChange()?.id !== changeID) return;
      if (agentView && agentReadFence.current(read)) {
        if (history && agentView.messagesAvailable) lastAgentHistory = { changeID, at: Date.now() };
        publishAgentView(changeID, agentView, read, history);
      }
      setDelivery(deliveryView);
    } else if (!changeID) {
      resetAgentView();
      setDelivery(undefined);
    }
    if (projectID && workspaceView() === "knowledge") {
      await refreshKnowledge(signal);
    }
  }
  const lifecyclePoller = createLifecyclePoller({
    read: readLifecycleState,
    visible: () => !document.hidden,
    onError: setSyncError,
  });
  const refreshLifecycleState = lifecyclePoller.refresh;

  async function refreshTicketDetail(ticketID = selectedTicketID()) {
    const generation = ++ticketReadGeneration;
    const projectID = selectedProjectID();
    if (ticketID) {
      const body = await apiRequest(ticketDetailSchema, `/api/tickets/${ticketID}`);
      if (
        workspaceDisposed ||
        generation !== ticketReadGeneration ||
        selectedProjectID() !== projectID ||
        selectedTicketID() !== ticketID ||
        (detail()?.ticket.id === ticketID && body.ticket.version < (detail()?.ticket.version ?? 0))
      )
        return;
      setDetail(body);
    }
  }
  async function refreshConversation(
    projectID = selectedProjectID(),
    ticketID = assistantTicketID(),
  ) {
    const generation = ++conversationReadGeneration;
    if (!projectID) {
      setConversation(undefined);
      return;
    }
    const query = ticketID ? `?ticketId=${encodeURIComponent(ticketID)}` : "";
    const value = await apiRequest(
      conversationViewSchema.nullable(),
      `/api/projects/${projectID}/conversation${query}`,
    );
    if (
      workspaceDisposed ||
      generation !== conversationReadGeneration ||
      selectedProjectID() !== projectID ||
      assistantTicketID() !== ticketID
    )
      return;
    try {
      if (value) acknowledgeConversation(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser recovery is unavailable.");
    }
    publishConversation(value ?? undefined);
  }
  async function refreshServerState() {
    await Promise.all([refreshLifecycleState(), refreshTicketDetail(), refreshConversation()]);
  }
  createEffect(
    () => [agentOpen(), selectedProjectID(), assistantTicketID()] as const,
    ([open, projectID, ticketID]) => {
      if (!open || !projectID) return;
      lastAgentHistory = { changeID: "", at: 0 };
      void refreshLifecycleState();
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      async function refresh() {
        try {
          if (!document.hidden)
            await Promise.all([
              refreshConversation(projectID, ticketID),
              ticketID ? refreshTicketDetail(ticketID) : Promise.resolve(),
            ]);
        } catch {
          /* Existing input remains visible while connectivity returns. */
        }
        if (!stopped) timer = setTimeout(() => void refresh(), 1500);
      }
      void refresh();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  );
  void refreshServerState().catch(() => undefined);
  const visibleAgain = () => {
    if (!document.hidden) void refreshLifecycleState();
  };
  document.addEventListener("visibilitychange", visibleAgain);
  onCleanup(() => {
    lifecyclePoller.stop();
    document.removeEventListener("visibilitychange", visibleAgain);
  });

  const changesByTicket = createMemo(
    () => new Map(changes().map((change) => [change.ticketId, change])),
  );
  function changeFor(ticketID: string) {
    return changesByTicket().get(ticketID);
  }
  const prerequisitesByTicket = createMemo(() => {
    const byId = new Map(ticketList().map((ticket) => [ticket.id, ticket]));
    const result = new Map<string, PrerequisiteView[]>();
    for (const edge of dependencies.data() ?? []) {
      const ticket = byId.get(edge.prerequisiteId);
      if (!ticket) continue;
      const change = changeFor(ticket.id);
      const prerequisite = {
        id: ticket.id,
        title: ticket.title,
        state: ticket.state,
        delivered: prerequisiteIsDelivered({
          ticketState: ticket.state,
          changeState: change?.state,
          verificationState: change?.verificationState,
          mergeState: change?.mergeState,
          promotionState: change?.promotionState,
        }),
      };
      result.set(edge.ticketId, [...(result.get(edge.ticketId) ?? []), prerequisite]);
    }
    return result;
  });
  function prerequisitesFor(ticketID: string) {
    return prerequisitesByTicket().get(ticketID) ?? [];
  }
  function blockersFor(ticketID: string) {
    return prerequisitesFor(ticketID).filter((prerequisite) => !prerequisite.delivered);
  }
  function dependencyCandidates(ticketID: string) {
    const edges = dependencies.data() ?? [];
    const linked = new Set(prerequisitesFor(ticketID).map((prerequisite) => prerequisite.id));
    return ticketList()
      .filter(
        (ticket) =>
          ticket.id !== ticketID &&
          !linked.has(ticket.id) &&
          !dependencyWouldCycle(edges, ticketID, ticket.id),
      )
      .sort((a, b) => a.title.localeCompare(b.title));
  }
  function stagingRuntimeFor(projectID: string) {
    return attempts().find(
      (attempt) =>
        attempt.projectId === projectID &&
        attempt.runtimeKind === "staging" &&
        attempt.currentStaging === true &&
        !["stopped", "failed"].includes(attempt.state),
    );
  }
  function lane(ticket: Ticket): BoardStage | "history" {
    const change = changeFor(ticket.id);
    return ticketBoardStage({
      ticketState: ticket.state,
      changeState: change?.state,
      verificationState: change?.verificationState,
      buildTurnState: change?.buildTurnState,
      implementationState: change?.implementationState,
    });
  }

  function boardStatus(ticket: Ticket) {
    const change = changeFor(ticket.id);
    return ticketBoardStatus({
      ticketState: ticket.state,
      changeState: change?.state,
      verificationState: change?.verificationState,
      buildTurnState: change?.buildTurnState,
      implementationState: change?.implementationState,
    });
  }

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
    const previous = desktopBackgroundKey();
    setDesktopBackgroundKey(key);
    try {
      await apiRequest(uiPreferenceSchema, "/api/ui-preference", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ desktopBackgroundKey: key }),
      });
    } catch (cause) {
      setDesktopBackgroundKey(previous);
      setError(cause instanceof Error ? cause.message : "Background could not be saved");
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

  async function register(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    await mutate(async () => {
      const project = await apiRequest(projectSchema, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          slug: data.get("slug"),
          repositoryUrl: data.get("repositoryUrl"),
          defaultBranch: data.get("defaultBranch"),
          devcontainerPath: data.get("devcontainerPath"),
        }),
      });
      setSelectedProjectID(project.id);
      setProjectMenuOpen(false);
      setRegistrationOpen(false);
      form.reset();
    });
  }

  async function saveEpic(input: EpicEdit, current?: Epic) {
    const client = zero();
    const projectId = selectedProjectID();
    if (!client || !projectId) return false;
    const id = current?.id ?? crypto.randomUUID();
    const result = await mutate(async () => {
      await commitZeroMutation(
        client.mutate(
          current
            ? zeroMutators.epics.update({
                projectId,
                epicId: id,
                expectedVersion: current.version,
                ...input,
              })
            : zeroMutators.epics.create({ projectId, id, ...input }),
        ).server,
      );
      if (selectedProjectID() === projectId) setSelectedEpicID(id);
    });
    if (!result.ok)
      throw new Error(
        error() || "Epic could not be saved. Check Project access and refresh before retrying.",
      );
    return true;
  }

  async function assignTicketEpic(epicId: string | null) {
    const client = zero();
    const current = detail()?.ticket;
    if (!client || !current) return;
    await mutate(async () => {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.assignEpic({
            projectId: current.projectId,
            ticketId: current.id,
            expectedVersion: current.version,
            epicId,
          }),
        ).server,
      );
      await refreshTicketDetail(current.id);
    });
  }

  async function editDependency(kind: "add" | "remove", prerequisiteId: string) {
    const client = zero();
    const current = detail()?.ticket;
    if (!client || !current) return false;
    const result = await mutate(async () => {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.dependencies[kind]({
            projectId: current.projectId,
            ticketId: current.id,
            prerequisiteId,
            expectedVersion: current.version,
          }),
        ).server,
      );
      await refreshTicketDetail(current.id);
    });
    return result.ok;
  }

  function openTicketDraft(proposed?: PersonalTicketDraft) {
    const projectID = selectedProjectID();
    if (!projectID) return;
    const retained = personalDrafts.get(projectID) ?? readPersonalTicketDraft(personalDraftKey());
    const draft =
      retained.title.trim() || retained.description.trim() ? retained : (proposed ?? retained);
    personalDrafts.set(projectID, draft);
    if (proposed && draft === proposed) {
      try {
        localStorage.setItem(personalDraftKey(), JSON.stringify(draft));
      } catch {
        /* Memory retains the proposed draft. */
      }
    }
    setSelectedTicketID(undefined);
    setDetail(undefined);
    openWorkspaceTab({
      id: `ticket-draft:${projectID}`,
      view: "ticket-draft",
      label: draft.title || "New ticket",
    });
  }

  async function publishTicketDraft(draft: PersonalTicketDraft, state: "inbox" | "ready") {
    const projectID = selectedProjectID();
    const client = zero();
    if (!projectID || !client) return false;
    const result = await mutate(async () => {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.create({
            id: draft.id,
            projectId: projectID,
            title: draft.title,
            description: draft.description,
            state,
          }),
        ).server,
      );
      personalDrafts.delete(projectID);
      try {
        localStorage.removeItem(`ticket-draft:${props.session.user.id}:${projectID}`);
      } catch {
        /* Created work is authoritative even without browser storage. */
      }
      updateCurrentWorkspace(
        (current) => closeWorkspaceTabState(current, `ticket-draft:${projectID}`).state,
      );
      selectTicket(draft.id);
      await refreshTicketDetail(draft.id);
      if (state === "ready") {
        clarificationOrigins.add(assistantKey());
        setAgentOpen(true);
        await refreshConversation();
      }
    });
    return result.ok;
  }

  async function moveTicket(ticket: Ticket, state: "inbox" | "ready") {
    const client = zero();
    if (!client) return;
    await mutate(async () => {
      await commitZeroMutation(
        client.mutate(
          zeroMutators.tickets.move({
            projectId: ticket.projectId,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            state,
          }),
        ).server,
      );
      await refreshTicketDetail(ticket.id);
      if (state === "ready") {
        setAgentOpen(true);
        selectTicket(ticket.id);
        clarificationOrigins.add(assistantKey());
        await refreshConversation();
      }
    });
  }

  async function saveTicketDocument(input: TicketDraft) {
    const current = detail();
    const revision = latestRevision();
    if (!current) return false;
    const scope = `document:${current.ticket.id}`;
    const payload = {
      expectedVersion: input.expectedVersion ?? current.ticket.version,
      expectedDocumentId:
        input.expectedDocumentId === undefined
          ? (current.documentRevisions[0]?.id ?? null)
          : input.expectedDocumentId,
      requirementRevisionId: revision?.id ?? null,
      title: input.title,
      description: input.description,
      requirement: input.requirement,
    };
    const result = await mutate(async () => {
      const commandId = agentCommandIds.forInput(scope, JSON.stringify(payload));
      await apiRequest(emptyResponseSchema, `/api/tickets/${current.ticket.id}/document`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, ...payload }),
      });
      acknowledgeCommand(scope, commandId);
      await refreshTicketDetail(current.ticket.id);
    });
    return result.ok;
  }

  async function confirmRequirements(draft: TicketDraft) {
    const current = detail();
    const proposal = current?.proposal;
    if (!current || !proposal) return false;
    const result = await mutate(async () => {
      const payload = {
        expectedVersion: proposal.base.version,
        expectedDocumentId: proposal.base.documentId,
        requirementRevisionId: proposal.base.revisionId,
        proposalEntryId: proposal.id,
        title: draft.title,
        description: draft.description,
        requirement: draft.requirement,
      };
      const scope = `confirm:${current.ticket.id}`;
      const commandId = agentCommandIds.forInput(scope, JSON.stringify(payload));
      await apiRequest(emptyResponseSchema, `/api/tickets/${current.ticket.id}/document`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, ...payload }),
      });
      acknowledgeCommand(scope, commandId);
      await refreshTicketDetail(current.ticket.id);
    });
    return result.ok;
  }

  async function confirmEpicWork(entryID: string, proposal: EpicProposal) {
    const projectID = selectedProjectID();
    if (!projectID) return false;
    const result = await mutate(async () => {
      const scope = `epic-confirm:${entryID}`;
      const commandId = agentCommandIds.forInput(scope, JSON.stringify(proposal));
      const value = await apiRequest(
        z.object({ epicId: z.uuid(), ticketIds: z.array(z.uuid()) }),
        `/api/projects/${projectID}/epic-proposals/${entryID}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId, proposal }),
        },
      );
      acknowledgeCommand(scope, commandId);
      if (selectedProjectID() !== projectID) return;
      setSelectedEpicID(value.epicId);
      setAgentOpen(false);
      closeWorkspaceTab(`epic-proposal:${entryID}`);
      const first = value.ticketIds[0];
      if (first) selectTicket(first);
      await refreshServerState();
    });
    return result.ok;
  }

  async function createFollowUp() {
    const current = detail();
    const revision = latestRevision();
    if (!current || !revision) return;
    const projectID = selectedProjectID();
    const stillSelected = () =>
      selectedProjectID() === projectID && selectedTicketID() === current.ticket.id;
    const scope = `follow-up:${current.ticket.id}`;
    const input = {
      requirementRevisionId: revision.id,
      expectedDocumentId: current.documentRevisions[0]?.id ?? null,
    };
    await mutate(async () => {
      const commandId = agentCommandIds.forInput(scope, JSON.stringify(input));
      const result = await apiRequest(
        z.object({ ticketId: z.uuid() }),
        `/api/tickets/${current.ticket.id}/follow-up`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId, ...input }),
        },
      );
      acknowledgeCommand(scope, commandId);
      if (!stillSelected()) return;
      await refreshTicketDetail(current.ticket.id);
      const next = await apiRequest(ticketDetailSchema, `/api/tickets/${result.ticketId}`);
      if (!stillSelected()) return;
      setSelectedTicketID(result.ticketId);
      setDetail(next);
      openWorkspaceTab({
        id: `ticket:${result.ticketId}`,
        view: "ticket",
        label: next.ticket.title,
        ticketID: result.ticketId,
      });
    });
  }

  async function ticketTrashCommand(ticketID: string, action: "trash" | "restore") {
    const ticket =
      detail()?.ticket.id === ticketID
        ? detail()?.ticket
        : ticketList().find((item) => item.id === ticketID);
    if (action === "restore" && !ticket) return;
    await mutate(async () => {
      await apiRequest(emptyResponseSchema, `/api/tickets/${ticketID}/${action}`, {
        method: "POST",
        ...(action === "restore"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedVersion: ticket?.version }),
            }
          : {}),
      });
      await refreshServerState();
    });
  }

  async function implementTicket(revisionID: string) {
    const ticket = detail()?.ticket;
    if (!ticket) return;
    const scope = `implement:${ticket.id}`;
    await mutate(async () => {
      const commandId = agentCommandIds.forInput(
        scope,
        JSON.stringify({ ticketID: ticket.id, revisionID }),
      );
      await apiRequest(emptyResponseSchema, `/api/tickets/${ticket.id}/implement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, revisionId: revisionID }),
      });
      acknowledgeCommand(scope, commandId);
      await refreshServerState();
    });
  }

  async function approveDelivery(changeID: string) {
    await mutate(async () => {
      const value = await apiRequest(
        deliveryViewSchema,
        `/api/changes/${changeID}/delivery/approve`,
        {
          method: "POST",
        },
      );
      if (selectedChange()?.id === changeID) setDelivery(value);
      await refreshLifecycleState();
    });
  }

  async function startAgent() {
    const change = selectedChange();
    if (!change) return;
    const scope = agentCommandScope("change-start", change.id);
    await mutate(async () => {
      if (!(await prepareBuildConversation(change.id))) return;
      const codingReasoning = agent().turn ? undefined : chosenCodingReasoning();
      const input = { ...(codingReasoning ? { codingReasoning } : {}) };
      const commandId = agentCommandIds.forInput(
        scope,
        codingReasoning ? JSON.stringify({ changeID: change.id, ...input }) : change.id,
      );
      const value = await apiRequest(agentViewSchema, `/api/changes/${change.id}/agent/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, ...input }),
      });
      acknowledgeCommand(scope, commandId);
      if (selectedChange()?.id === change.id) publishAgentView(change.id, value);
      await refreshLifecycleState();
    });
  }
  async function resumeCoding() {
    const change = selectedChange(),
      pause = agent().codingPause;
    if (!change || !pause) return;
    const scope = `coding-resume:${change.id}:${pause.turnID}`;
    await mutate(async () => {
      const commandId = agentCommandIds.forInput(scope, pause.turnID);
      const result = await apiRequest(agentViewSchema, `/api/changes/${change.id}/agent/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, pausedTurnId: pause.turnID }),
      });
      acknowledgeCommand(scope, commandId);
      if (selectedChange()?.id === change.id) publishAgentView(change.id, result);
      await refreshLifecycleState();
    });
  }

  async function prepareBuildConversation(changeID: string) {
    const projectID = selectedProjectID();
    const ticketID = selectedTicketID();
    const current = () =>
      selectedProjectID() === projectID &&
      selectedTicketID() === ticketID &&
      selectedChange()?.id === changeID &&
      conversationMode() === "build";
    if (!projectID || !ticketID || !current()) return false;
    if (conversation()?.mode !== "build") {
      const value = await apiRequest(
        conversationViewSchema,
        `/api/projects/${projectID}/conversation/mode`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticketId: ticketID, mode: "build" }),
        },
      );
      if (!current()) return false;
      setConversation(value);
    }
    return current();
  }

  async function stopAgent() {
    const change = selectedChange();
    if (!change) return;
    await mutate(async () => {
      const value = await apiRequest(agentViewSchema, `/api/changes/${change.id}/agent/stop`, {
        method: "POST",
      });
      if (selectedChange()?.id === change.id) publishAgentView(change.id, value);
    });
  }

  async function checkStopStatus() {
    const change = selectedChange();
    if (!change) return;
    const read = agentReadFence.beginRead();
    await mutate(async () => {
      const value = await apiRequest(agentViewSchema, `/api/changes/${change.id}/agent`);
      if (selectedChange()?.id === change.id) publishAgentView(change.id, value, read);
    });
  }

  async function recheckStopConfirmation() {
    const change = selectedChange();
    const stopId = agent().stopId;
    if (!change || !stopId) return;
    await mutate(async () => {
      const value = await apiRequest(
        agentViewSchema,
        `/api/changes/${change.id}/agent/check-stop`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stopId }),
        },
      );
      if (selectedChange()?.id === change.id) publishAgentView(change.id, value);
    });
  }

  async function promptAgent(event: SubmitEvent) {
    event.preventDefault();
    const change = selectedChange();
    if (!change) return;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const text = String(data.get("message") ?? "").trim();
    if (!text) return;
    const scope = agentCommandScope("change-prompt", change.id);
    await mutate(async () => {
      if (!(await prepareBuildConversation(change.id))) return;
      const commandId = agentCommandIds.forInput(
        scope,
        JSON.stringify({ changeID: change.id, text }),
        text,
      );
      const action = correctionTarget() === change.id ? "request-changes" : "prompt";
      const value = await apiRequest(agentViewSchema, `/api/changes/${change.id}/agent/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, text }),
      });
      acknowledgeCommand(scope, commandId);
      if (selectedChange()?.id === change.id) {
        publishAgentView(change.id, value);
        // Pending disables the composer, so FormData omits its submitted value.
        const input = form.elements.namedItem("message") as HTMLTextAreaElement | null;
        if (input?.value.trim() === text) form.reset();
      }
    });
  }

  function requestCorrections() {
    const change = selectedChange();
    if (!change || change.state !== "active") return;
    setCorrectionTarget(change.id);
    setAgentOpen(true);
    void refreshLifecycleState();
    queueMicrotask(() =>
      agentPanelElement?.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus(),
    );
  }

  async function sendConversationMessage(event: SubmitEvent) {
    event.preventDefault();
    if (assistantPending()) return;
    if (canPromptBuild()) {
      await promptAgent(event);
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const text = String(data.get("message") ?? "").trim();
    if (!text) return;
    await sendProjectMessage(text, form);
  }

  async function beginRequirementsInterview() {
    setAgentOpen(true);
    if (assistantPending()) return;
    pauseClarification(false);
    if (!assistantTicketID() || assistantPending()) return;
    if (pendingInterview()) return;
    clarificationOrigins.add(assistantKey());
    const ticket = detail()?.ticket;
    if (ticket && ticket.state !== "ready" && !selectedChange()) {
      await moveTicket(ticket, "ready");
      return;
    }
    await sendProjectMessage(
      "Start a requirements interview for this Ticket.",
      undefined,
      "requirements-interview",
    );
  }

  async function sendProjectMessage(
    text: string,
    form?: HTMLFormElement,
    intent?: "requirements-interview" | "project-research",
  ) {
    const projectID = selectedProjectID();
    if (!projectID) return;
    const ticketID = assistantTicketID();
    if (!intent && clarificationPaused() && unansweredClarification(conversation()?.entries ?? []))
      intent = "project-research";
    const query = ticketID ? `?ticketId=${encodeURIComponent(ticketID)}` : "";
    const scope = agentCommandScope("project-message");
    const streamKey = assistantKey();
    let streamTurnId: string | undefined;
    const clearStreamedAnswer = () =>
      setStreamedAnswers((current) => {
        if (current[streamKey]?.turnId !== streamTurnId) return current;
        const next = { ...current };
        delete next[streamKey];
        return next;
      });
    let commandId: string | undefined;
    const contextIsCurrent = () =>
      !workspaceDisposed && selectedProjectID() === projectID && assistantTicketID() === ticketID;
    const clearSubmittedDraft = () => {
      if (commandId) acknowledgeCommand(scope, commandId);
      if (
        form &&
        contextIsCurrent() &&
        (form.elements.namedItem("message") as HTMLTextAreaElement | null)?.value.trim() === text
      )
        form.reset();
    };
    const result = await mutate(
      async () => {
        if (!contextIsCurrent()) return;
        const mode = ticketID && selectedChange() ? "investigate" : "plan";
        if (conversation()?.mode !== mode) {
          const contextualConversation = await apiRequest(
            conversationViewSchema,
            `/api/projects/${projectID}/conversation/mode`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...(ticketID ? { ticketId: ticketID } : {}), mode }),
            },
          );
          if (!contextIsCurrent()) return;
          publishConversation(contextualConversation);
        }
        commandId = agentCommandIds.forInput(
          scope,
          JSON.stringify({ projectID, ticketID, text, intent }),
          text,
        );
        const streamController = new AbortController();
        projectStreams.add(streamController);
        const value = await streamConversation(
          `/api/projects/${projectID}/conversation/message`,
          {
            method: "POST",
            signal: streamController.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(ticketID ? { ticketId: ticketID } : {}),
              text,
              commandId,
              ...(intent ? { intent } : {}),
            }),
          },
          (event) => {
            if (workspaceDisposed) return;
            if (event.type === "admitted") {
              streamTurnId = event.turnId;
              clearSubmittedDraft();
              if (contextIsCurrent()) void refreshConversation().catch(() => {});
            } else if (event.type === "answer" && event.turnId === streamTurnId) {
              setStreamedAnswers((current) => ({
                ...current,
                [streamKey]: { turnId: event.turnId, text: event.text },
              }));
            } else if (event.type === "complete") {
              clearStreamedAnswer();
            }
          },
        ).finally(() => projectStreams.delete(streamController));
        clearSubmittedDraft();
        if (!contextIsCurrent()) return;
        publishConversation(value);
        if (value.ticketId) {
          if (value.ticketId !== selectedTicketID()) setSelectedTicketID(value.ticketId);
          await refreshTicketDetail(value.ticketId);
        }
      },
      contextIsCurrent,
      assistantKey(),
    );
    clearStreamedAnswer();
    if (result.ok || !contextIsCurrent()) return;

    const refreshed = await apiRequest(
      conversationViewSchema.nullable(),
      `/api/projects/${projectID}/conversation${query}`,
    ).catch(() => null);
    if (!refreshed || !contextIsCurrent()) return;
    publishConversation(refreshed);
    const admitted =
      commandId &&
      refreshed.entries.some(
        (entry) => entry.kind === "user-message" && entry.payload["commandId"] === commandId,
      );
    if (!admitted) return;
    try {
      clearSubmittedDraft();
      setError("Your message was saved, but the Project Agent could not finish its response.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser recovery is unavailable.");
    }
  }

  async function answerInterview(
    event: SubmitEvent,
    questionEntryID: string,
    question: InterviewQuestion,
  ) {
    event.preventDefault();
    clarificationOrigins.add(assistantKey());
    if (assistantPending()) return;
    const projectID = selectedProjectID();
    if (!projectID) return;
    const ticketID = assistantTicketID();
    const contextIsCurrent = () =>
      selectedProjectID() === projectID && assistantTicketID() === ticketID;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const customText = String(data.get("custom") ?? "").trim();
    const answer = {
      selectedOptionIds:
        question.type === "single-select" && customText ? [] : data.getAll("option").map(String),
      customText,
    };
    const scope = agentCommandScope("project-answer", questionEntryID);
    const pendingAnswer = {
      key: assistantKey(),
      questionID: questionEntryID,
      text: normalizeInterviewAnswer(question, answer).labels.join(", "),
    };
    setPendingInterviewAnswer(pendingAnswer);
    try {
      await mutate(
        async () => {
          const commandId = agentCommandIds.forInput(
            scope,
            JSON.stringify({ projectID, ticketID, questionEntryID, answer }),
          );
          const value = await apiRequest(
            conversationViewSchema,
            `/api/projects/${projectID}/conversation/answer`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...(ticketID ? { ticketId: ticketID } : {}),
                questionEntryId: questionEntryID,
                commandId,
                answer,
              }),
            },
          );
          acknowledgeCommand(scope, commandId);
          if (!contextIsCurrent()) return;
          publishConversation(value);
          if (value.ticketId) {
            if (value.ticketId !== selectedTicketID()) setSelectedTicketID(value.ticketId);
            await refreshTicketDetail(value.ticketId);
          }
        },
        contextIsCurrent,
        assistantKey(),
      );
    } finally {
      if (pendingInterviewAnswer() === pendingAnswer) setPendingInterviewAnswer(undefined);
    }
  }

  function loadTicketContext(ticketID: string) {
    const projectID = selectedProjectID();
    ticketReadGeneration++;
    setSelectedTicketID(ticketID);
    setDetail(undefined);
    resetAgentView();
    setDelivery(undefined);
    setConversation(undefined);
    onSettled(() => {
      if (selectedProjectID() !== projectID || selectedTicketID() !== ticketID) return;
      void refreshTicketDetail(ticketID);
      void refreshConversation(projectID, ticketID);
    });
  }

  function selectTicket(ticketID: string) {
    const ticket = ticketList().find((candidate) => candidate.id === ticketID);
    loadTicketContext(ticketID);
    openWorkspaceTab({
      id: `ticket:${ticketID}`,
      view: "ticket",
      label: ticket?.title ?? ticketReference(ticketID),
      ticketID,
    });
  }

  function selectProject(projectID: string) {
    projectSetup?.show(false);
    resetAgentView();
    setSelectedProjectID(projectID);
    setSelectedTicketID(undefined);
    setDetail(undefined);
    setWorkspaceVisible(false);
    setSelectedKnowledgePageID(undefined);
    setOpenRepositoryDocument(undefined);
    setRepositoryDocuments([]);
    repositoryInventory = "";
    setKnowledgeGeneration(undefined);
    setKnowledgeHistory([]);
    setKnowledgeSearch([]);
    setKnowledgeSearchQuery("");
    setConversation(undefined);
    void refreshConversation(projectID, undefined);
    setProjectMenuOpen(false);
  }

  const selectedProject = () =>
    projects.data()?.find((project) => project.id === selectedProjectID());
  const filteredProjects = () => {
    const list = projects.data() ?? [];
    const query = projectSearchQuery().trim().toLocaleLowerCase();
    if (!query) return list;
    return list.filter((project) =>
      `${project.name} ${project.slug}`.toLocaleLowerCase().includes(query),
    );
  };
  const ticketList = () => (tickets.data() as Ticket[] | undefined) ?? [];
  const epicList = () => epics.data() ?? [];
  const scopedTickets = () => {
    const active = ticketList().filter((ticket) => !ticket.trashedAt && !ticket.convertedToEpicId);
    const selected = selectedEpicID();
    if (!selected) return active;
    if (selected === "ungrouped") return active.filter((ticket) => !ticket.epicId);
    const family = epicFamilyIds(epicList(), selected);
    return active.filter((ticket) => ticket.epicId && family.has(ticket.epicId));
  };
  const historyTickets = () => scopedTickets().filter((ticket) => lane(ticket) === "history");
  const knowledgePageList = () => knowledgePages.data() ?? [];
  const selectedKnowledgePage = () =>
    knowledgePageList().find((page) => page.id === selectedKnowledgePageID());
  const selectedChange = () => {
    const ticketID = selectedTicketID();
    return ticketID ? changeFor(ticketID) : undefined;
  };
  const agentViewLoaded = () =>
    Boolean(selectedChange()?.id && observedAgentChangeID() === selectedChange()?.id);
  const conversationMode = (): ConversationMode =>
    correctionTarget() && assistantTicketID() && correctionTarget() === selectedChange()?.id
      ? "build"
      : assistantContext({
          view: workspaceView(),
          ideChangeId:
            activeWorkspaceTab()?.view === "ide" ? activeWorkspaceTab()?.changeID : undefined,
          ticketChangeId: assistantTicketID() ? selectedChange()?.id : undefined,
        });
  const interviewAnswers = createMemo(() => {
    const answers = new Map<string, string>();
    for (const entry of conversation()?.entries ?? [])
      if (entry.kind === "answer" && entry.inReplyToEntryId && !answers.has(entry.inReplyToEntryId))
        answers.set(entry.inReplyToEntryId, entry.body);
    return answers;
  });
  const answeredQuestionIDs = () => interviewAnswers();
  const currentInterviewQuestion = createMemo(() =>
    unansweredClarification(conversation()?.entries ?? []),
  );
  const pendingInterview = () =>
    pendingInterviewAnswer()?.key !== assistantKey() &&
    conversationMode() === "plan" &&
    !clarificationPaused() &&
    !!currentInterviewQuestion();
  const interviewOwnsComposer = () =>
    !clarificationPaused() &&
    conversationMode() === "plan" &&
    (pendingInterview() || (assistantPending() && clarificationOrigins.has(assistantKey())));
  const ticketClarificationAction = () =>
    clarificationAction({
      question: !!currentInterviewQuestion(),
      working: assistantPending(),
      open: agentOpen(),
      paused: clarificationPaused(),
      started: Boolean(
        conversation()?.entries.some(
          (entry) => entry.kind === "question" || entry.kind === "requirement",
        ),
      ),
    });
  const conversationPlaceholder = () =>
    conversationMode() === "plan"
      ? assistantTicketID()
        ? "Clarify this Ticket's requirements…"
        : "Describe the change you want to plan…"
      : assistantTicketID()
        ? "Ask about this Ticket…"
        : "Ask about this Project…";
  const answerSummary = (questionID: string) => {
    const pendingAnswer = pendingInterviewAnswer();
    return (
      interviewAnswers().get(questionID) ??
      (pendingAnswer?.key === assistantKey() && pendingAnswer.questionID === questionID
        ? pendingAnswer.text
        : undefined)
    );
  };
  const ticketWorkspaceReady = () =>
    selectedChange()?.runtimeState === "ready" &&
    !(agent().state === "working" && !agent().runtimeConnected);
  const ticketWorkspaceStatus = () =>
    workspacePresence({
      changeState: selectedChange()?.state,
      runtimeState: agent().runtimeState ?? selectedChange()?.runtimeState,
      implementationState: agent().state,
      connectionInterrupted: agent().state === "working" && !agent().runtimeConnected,
    });
  const agentCanRun = () =>
    !detail()?.ticket.trashedAt &&
    (["active", "starting"].includes(selectedChange()?.state ?? "") ||
      (selectedChange()?.state === "failed" &&
        ["failed", "stopped"].includes(selectedChange()?.runtimeState ?? "") &&
        ["failed", "stopped"].includes(agent().state)));
  const canPromptBuild = () =>
    conversationMode() === "build" &&
    agentCanRun() &&
    (correctionTarget() === selectedChange()?.id || !buildAgentNeedsStart(agent()));
  const agentTurnBusy = () =>
    ["starting", "working"].includes(agent().state) ||
    ["pending", "dispatching", "running"].includes(agent().turn?.state ?? "");
  const agentNeedsResolution = () => agent().turn?.state === "uncertain";
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
    const targets: RuntimeDockTarget[] = staging
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
      targets.push({
        id: `app:${preview.attemptID}:${preview.channel}`,
        label: preview.label,
        detail: "Development",
        attemptId: preview.attemptID,
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
  const selectedIDEAttempt = () => {
    const tab = activeWorkspaceTab();
    if (tab?.view !== "ide") return undefined;
    const selected = attempts().find(
      (attempt) =>
        (attempt.id === tab.attemptID || attempt.workspaceId === tab.workspaceID) &&
        attempt.state === "ready" &&
        attempt.projectId === selectedProjectID(),
    );
    if (selected) return { id: selected.id, owner: selected.workspaceKind ?? "ticket" };
    return undefined;
  };
  async function openIDETarget(target: RuntimeDockTarget) {
    if (!canDevelopProject()) return;
    const projectID = selectedProjectID();
    if (!projectID) return;
    const tabID = `ide:${target.id}`;
    const change = target.changeId
      ? changes().find((candidate) => candidate.id === target.changeId)
      : undefined;
    if (change) loadTicketContext(change.ticketId);
    else {
      setSelectedTicketID(undefined);
      setDetail(undefined);
      resetAgentView();
      setConversation(undefined);
    }
    openWorkspaceTab({
      id: tabID,
      view: "ide",
      label: `IDE · ${target.label}`,
      ...(target.attemptId ? { attemptID: target.attemptId } : {}),
      ...(target.changeId ? { changeID: target.changeId } : {}),
      ...(change ? { ticketID: change.ticketId } : {}),
    });
    await mutate(async () => {
      const source = await apiRequest(
        sourceWorkspaceViewSchema,
        target.changeId
          ? `/api/changes/${target.changeId}/source-workspace/ensure`
          : `/api/projects/${projectID}/source-workspace/ensure`,
        { method: "POST" },
      );
      updateWorkspaceTab(
        {
          id: tabID,
          view: "ide",
          label: `IDE · ${target.label}`,
          workspaceID: source.workspaceID,
          ...(target.attemptId ? { attemptID: target.attemptId } : {}),
          ...(target.changeId ? { changeID: target.changeId } : {}),
          ...(change ? { ticketID: change.ticketId } : {}),
        },
        projectID,
      );
      await refreshServerState();
    });
  }
  async function openPreviewTarget(target: RuntimeDockTarget) {
    const existing = workspaceTabs().find((tab) => tab.id === target.id && tab.view === "preview");
    if (existing?.appChannel) {
      activateWorkspaceTab(existing);
      return;
    }
    const projectID = selectedProjectID();
    const tabID = `preview:${target.id}`;
    openWorkspaceTab({
      id: tabID,
      view: "preview",
      label: `Preview · ${target.label}`,
      ...(target.attemptId ? { attemptID: target.attemptId } : {}),
      ...(target.appChannel ? { appChannel: target.appChannel } : {}),
    });
    if (target.attemptId) {
      return;
    }
    if (!target.projectId) return;
    await mutate(async () => {
      const attempt = await apiRequest(
        runtimeAttemptSchema,
        `/api/projects/${target.projectId}/staging/ensure`,
        { method: "POST" },
      );
      updateWorkspaceTab(
        {
          id: tabID,
          view: "preview",
          label: `Preview · ${target.label}`,
          attemptID: attempt.id,
        },
        projectID,
      );
      await refreshServerState();
    });
  }
  function openDevelopmentPreview(attemptID: string, process: string, label: string) {
    const attempt = attempts().find(
      (candidate) =>
        candidate.id === attemptID &&
        candidate.projectId === selectedProjectID() &&
        candidate.state === "ready" &&
        candidate.workspaceId !== null,
    );
    if (!attempt) return;
    openWorkspaceTab({
      id: `preview:workspace:${attempt.workspaceId}:${process}`,
      view: "preview",
      label: `Development · ${label}`,
      attemptID,
      appChannel: process,
    });
  }

  let repositoryInventory = "";
  async function refreshKnowledge(signal?: AbortSignal) {
    const project = selectedProject();
    if (!project) return;
    const generation = await apiRequest(
      knowledgeGenerationSchema.nullable(),
      `/api/projects/${project.id}/knowledge/generation`,
      signal ? { signal } : {},
    );
    if (selectedProjectID() !== project.id) return;
    setKnowledgeGeneration(generation ?? undefined);
    const inventory = `${project.id}:${canDevelopProject()}:${generation?.id ?? ""}:${generation?.state ?? ""}`;
    if (inventory === repositoryInventory) return;
    const documents = canDevelopProject()
      ? await apiRequest(
          repositoryDocumentsSchema,
          `/api/projects/${project.id}/knowledge/documents`,
          signal ? { signal } : {},
        )
      : { documents: [] };
    if (selectedProjectID() !== project.id) return;
    setRepositoryDocuments(canDevelopProject() ? documents.documents : []);
    repositoryInventory = inventory;
  }
  async function openKnowledge() {
    const project = selectedProject();
    if (!project) return;
    knowledgeSearchRequest += 1;
    setKnowledgeSearchQuery("");
    setKnowledgeSearch([]);
    openWorkspaceTab({
      id: `knowledge:${project.id}`,
      view: "knowledge",
      label: "Knowledge",
    });
    await mutate(async () => {
      await refreshKnowledge();
      if (!knowledgeGeneration() && knowledgePageList().length === 0) await generateKnowledge();
    });
  }
  async function generateKnowledge() {
    const project = selectedProject();
    if (!project) return;
    const generation = await apiRequest(
      knowledgeGenerationSchema,
      `/api/projects/${project.id}/knowledge/generation`,
      { method: "POST" },
    );
    if (selectedProjectID() === project.id) setKnowledgeGeneration(generation);
  }
  async function editKnowledgePage(
    pageId: string,
    expectedVersion: number,
    title: string,
    body: string,
  ) {
    const saved = await apiRequest(knowledgeSaveSchema, `/api/knowledge/pages/${pageId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion, title, body }),
    });
    if (selectedKnowledgePageID() === pageId) setKnowledgeHistory([]);
    return saved;
  }
  async function archiveKnowledgePage() {
    const page = selectedKnowledgePage();
    if (!page) return;
    await mutate(async () => {
      await apiRequest(emptyResponseSchema, `/api/knowledge/pages/${page.id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: page.version }),
      });
      if (selectedKnowledgePageID() === page.id) {
        setSelectedKnowledgePageID(undefined);
        setKnowledgeHistory([]);
      }
    });
  }
  async function loadKnowledgeHistory(pageID: string) {
    const epoch = knowledgeAccessEpoch;
    const body = await apiRequest(
      knowledgeHistorySchema,
      `/api/knowledge/pages/${pageID}/revisions`,
    );
    if (selectedKnowledgePageID() === pageID && epoch === knowledgeAccessEpoch)
      setKnowledgeHistory(body.revisions);
  }
  async function openDocument(path: string) {
    const requestID = ++documentRequest;
    const project = selectedProject();
    if (!project || !canDevelopProject()) return;
    const value = await apiRequest(
      openRepositoryDocumentSchema,
      `/api/projects/${project.id}/knowledge/documents?path=${encodeURIComponent(path)}`,
    );
    if (selectedProjectID() !== project.id || documentRequest !== requestID || !canDevelopProject())
      return;
    setOpenRepositoryDocument(value);
    setSelectedKnowledgePageID(undefined);
    setKnowledgeHistory([]);
  }
  async function searchProjectKnowledge(query: string) {
    const project = selectedProject();
    const text = query.trim();
    const requestID = ++knowledgeSearchRequest;
    setKnowledgeSearchQuery(query);
    if (!project || !text) {
      setKnowledgeSearch([]);
      return;
    }
    try {
      const body = await apiRequest(
        knowledgeSearchSchema,
        `/api/projects/${project.id}/knowledge/search?q=${encodeURIComponent(text)}`,
      );
      if (requestID === knowledgeSearchRequest && selectedProjectID() === project.id)
        setKnowledgeSearch(body.results);
    } catch (cause) {
      if (requestID === knowledgeSearchRequest && selectedProjectID() === project.id)
        setError(cause instanceof Error ? cause.message : "Knowledge search could not be loaded.");
    }
  }
  const latestRevision = () => detail()?.revisions[0];
  const latestRequirement = () =>
    requirementContent(detail()?.documentRevisions[0] ?? latestRevision());
  const visibleConversation = createMemo(() =>
    conversationTimeline(
      conversation()?.entries ?? [],
      assistantTicketID() && selectedChange() ? agent().messages : [],
    ),
  );

  createEffect(assistantKey, () => conversationScroll?.reset());

  createEffect(assistantKey, (key) => {
    try {
      setPausedClarifications((current) => ({
        ...current,
        [key]: sessionStorage.getItem(`clarification-paused:${key}`) === "true",
      }));
    } catch {
      /* Pause does not depend on storage. */
    }
  });
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

  return (
    <main
      class={`factory-desktop${agentOpen() ? " agent-is-open" : ""}${agentOverlay() ? " agent-is-overlay" : ""}`}
      data-background={desktopBackgroundKey()}
    >
      <h1 class="sr-only">Delivery floor</h1>

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

      <header class="factory-topbar" inert={agentOverlay() || registrationOpen()}>
        <div class="topbar-start">
          <button
            type="button"
            class={agentOpen() ? "icon-button agent-toggle open" : "icon-button agent-toggle"}
            aria-label="Toggle Agent panel"
            ref={agentToggleElement}
            aria-expanded={agentOpen() ? "true" : "false"}
            data-state={agentOpen() ? "open" : "closed"}
            data-tooltip="Agent"
            onPointerDown={() => {
              if (!agentOpen()) rememberAgentOpener();
            }}
            onClick={(event) => {
              if (!agentOpen() && event.detail === 0) rememberAgentOpener();
              setAgentOpen((open) => !open);
            }}
          >
            <Icon name={agentOpen() ? "agent-panel" : "agent"} />
          </button>
          <div class="context-control" ref={projectControlElement}>
            <button
              type="button"
              class="context-button"
              aria-label="Open project menu"
              aria-expanded={projectMenuOpen() ? "true" : "false"}
              aria-controls="project-popover"
              onClick={() => {
                setProjectMenuOpen((open) => !open);
                setSettingsOpen(false);
              }}
            >
              <span class="context-pair">
                <span>
                  <small>Project</small>
                  {setupVisible() ? "New project" : (selectedProject()?.name ?? "Choose project")}
                </span>
              </span>
              <Icon name="chevron" />
            </button>
            <Show when={projectMenuOpen()}>
              <section
                class="floating-menu project-menu"
                id="project-popover"
                aria-label="Projects"
                ref={projectPopover}
              >
                <div class="menu-heading">
                  <div>
                    <small>Workspace</small>
                    <strong>Projects</strong>
                  </div>
                  <Show when={props.session.systemManager}>
                    <button
                      type="button"
                      class="quiet-button"
                      onClick={() => {
                        setProjectMenuOpen(false);
                        setError("");
                        setWorkspaceVisible(false);
                        void projectSetup?.open();
                      }}
                    >
                      {projectSetup?.draft() && projectSetup.draft()?.state !== "created"
                        ? "Continue setup"
                        : "Create project"}
                    </button>
                  </Show>
                </div>
                <Show when={(projects.data() ?? []).length > 6}>
                  <div class="project-search">
                    <input
                      type="search"
                      aria-label="Search projects"
                      placeholder="Find a project"
                      value={projectSearchQuery()}
                      onInput={(event) => setProjectSearchQuery(event.currentTarget.value)}
                    />
                  </div>
                </Show>
                <div class="project-list">
                  <For each={filteredProjects()}>
                    {(project) => (
                      <article
                        class={
                          selectedProjectID() === project.id
                            ? "project-row selected"
                            : "project-row"
                        }
                      >
                        <button
                          type="button"
                          class="project-choice"
                          aria-current={selectedProjectID() === project.id ? "true" : undefined}
                          onClick={() => selectProject(project.id)}
                        >
                          <span>
                            <strong>{project.name}</strong>
                            <small>{project.slug}</small>
                          </span>
                          <Show when={selectedProjectID() === project.id}>
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

        <nav class="workspace-dock" aria-label="Workspace dock">
          <DockButton
            label="Desktop"
            icon="home"
            active={!workspaceVisible()}
            onClick={() => setWorkspaceVisible(false)}
          />
          <Show when={!setupVisible() && selectedProject()}>
            <DockButton
              label="Knowledge"
              icon="knowledge"
              active={workspaceVisible() && workspaceView() === "knowledge"}
              open={workspaceTabs().some((tab) => tab.view === "knowledge")}
              onClick={() => void openKnowledge()}
              onMinimize={() => setWorkspaceVisible(false)}
            />
          </Show>
          <Show when={!setupVisible() && detail()}>
            <DockButton
              label="Ticket"
              icon="ticket"
              active={workspaceVisible() && workspaceView() === "ticket"}
              open={workspaceTabs().some((tab) => tab.view === "ticket")}
              onMinimize={() => setWorkspaceVisible(false)}
              onClick={() => {
                const openTicket = workspaceTabs().find(
                  (tab) => tab.view === "ticket" && tab.ticketID === selectedTicketID(),
                );
                if (openTicket) activateWorkspaceTab(openTicket);
                else {
                  const ticketID = selectedTicketID();
                  if (ticketID) selectTicket(ticketID);
                }
              }}
            />
          </Show>
          <Show when={!setupVisible() && ideTargets().length > 0}>
            <DockAppButton
              label="IDE"
              icon="ide"
              active={workspaceVisible() && workspaceView() === "ide"}
              open={workspaceTabs().some((tab) => tab.view === "ide")}
              targets={ideTargets()}
              selectedID={
                activeWorkspaceTab()?.view === "ide" ? activeWorkspaceTab()?.id.slice(4) : undefined
              }
              preferredID={
                ideTargets().find((target) => target.changeId === selectedChange()?.id)?.id
              }
              onSelect={(target) => void openIDETarget(target)}
              onMinimize={() => setWorkspaceVisible(false)}
            />
          </Show>
          <Show when={!setupVisible() && previewTargets().length > 0}>
            <DockAppButton
              label="Preview"
              icon="preview"
              active={workspaceVisible() && workspaceView() === "preview"}
              open={workspaceTabs().some((tab) => tab.view === "preview")}
              targets={previewTargets()}
              selectedID={
                activeWorkspaceTab()?.view === "preview"
                  ? activeWorkspaceTab()?.appChannel
                    ? activeWorkspaceTab()?.id
                    : activeWorkspaceTab()?.id.slice(8)
                  : undefined
              }
              onSelect={(target) => void openPreviewTarget(target)}
              onMinimize={() => setWorkspaceVisible(false)}
            />
          </Show>
          <DockButton
            label="Inbox"
            icon="inbox"
            active={workspaceVisible() && workspaceView() === "inbox"}
            open={workspaceTabs().some((tab) => tab.view === "inbox")}
            onClick={() => openWorkspaceTab({ id: "inbox", view: "inbox", label: "Inbox" })}
            onMinimize={() => setWorkspaceVisible(false)}
          />
        </nav>

        <div class="topbar-end settings-control" ref={settingsControlElement}>
          <button
            type="button"
            class="icon-button"
            aria-label="Settings"
            aria-expanded={settingsOpen() ? "true" : "false"}
            aria-controls="settings-popover"
            data-tooltip="Settings"
            onClick={() => {
              setSettingsOpen((open) => !open);
              setProjectMenuOpen(false);
            }}
          >
            <Icon name="settings" />
          </button>
          <Show when={settingsOpen()}>
            <section
              class="floating-menu settings-menu"
              id="settings-popover"
              aria-label="Settings"
              ref={settingsPopover}
            >
              <div class="settings-identity">
                <small>Signed in as</small>
                <strong>{props.session.user.name}</strong>
                <span>{props.session.user.email}</span>
              </div>
              <button
                type="button"
                class="settings-model-link"
                aria-label="Open settings"
                onClick={openSettings}
              >
                <Icon name="settings" />
                <span>Open settings</span>
                <small>
                  Account{selectedProject() ? ", Project" : ""}
                  {props.session.systemManager ? ", Factory" : ""}
                </small>
              </button>
              <Show when={selectedProject()}>
                <button
                  type="button"
                  class="settings-model-link"
                  onClick={() => {
                    setSettingsOpen(false);
                    openWorkspaceTab({ id: "trash", view: "trash", label: "Trash" });
                  }}
                >
                  <Icon name="inbox" />
                  <span>Trash</span>
                </button>
              </Show>
              <fieldset class="background-picker">
                <legend>Desktop background</legend>
                <For each={desktopBackgrounds}>
                  {(background) => (
                    <button
                      type="button"
                      class={`background-option background-${background.key}`}
                      aria-pressed={desktopBackgroundKey() === background.key ? "true" : "false"}
                      onClick={() => void chooseDesktopBackground(background.key)}
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
              </fieldset>
            </section>
          </Show>
        </div>
      </header>

      <div class="desktop-notices">
        <Show when={error() && !registrationOpen()}>
          <p class="error-toast" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={syncError()}>
          <div class="sync-notice" role="status">
            Updates paused. Showing the last known state.
            <button type="button" class="quiet-button" onClick={() => void refreshLifecycleState()}>
              Retry
            </button>
          </div>
        </Show>
      </div>

      <section
        class={workspaceVisible() ? "kanban-desktop obscured" : "kanban-desktop"}
        aria-label="Ticket board"
        inert={agentOverlay() || registrationOpen()}
      >
        <Show
          when={!setupVisible() && selectedProject()}
          fallback={
            setupVisible() ? (
              <SetupEmptyBoard />
            ) : (
              <DesktopEmpty onChoose={() => setProjectMenuOpen(true)} />
            )
          }
        >
          <div class="board-toolbar">
            <EpicControls
              projectId={selectedProjectID() ?? ""}
              projectName={selectedProject()?.name ?? "Project"}
              epics={epicList()}
              tickets={ticketList()}
              selectedId={selectedEpicID()}
              pending={pending()}
              onSelect={setSelectedEpicID}
              onSave={saveEpic}
            />
            <div class="board-toolbar-actions">
              <Show when={historyTickets().length > 0}>
                <button
                  type="button"
                  class="board-history-button"
                  aria-pressed={boardHistoryOpen() ? "true" : "false"}
                  onClick={() => setBoardHistoryOpen((open) => !open)}
                >
                  <span>{boardHistoryOpen() ? "Active work" : "History"}</span>
                  <Show when={!boardHistoryOpen()}>
                    <span class="history-count">{historyTickets().length}</span>
                  </Show>
                </button>
              </Show>
              <button
                type="button"
                class="new-ticket-button"
                aria-label="New Ticket"
                onClick={() => openTicketDraft()}
              >
                <span>+</span> New ticket
              </button>
            </div>
          </div>
          <TicketBoardContents
            tickets={scopedTickets()}
            epics={epicList()}
            archivedTickets={scopedTickets().filter((ticket) => lane(ticket) === "history")}
            historyOpen={boardHistoryOpen()}
            pending={pending()}
            selectedTicketID={selectedTicketID()}
            stage={lane}
            status={boardStatus}
            blockers={blockersFor}
            reference={ticketReference}
            onSelect={selectTicket}
          />
        </Show>
      </section>

      <Show when={registrationOpen()}>
        <ProjectRegistration
          pending={pending()}
          error={error()}
          opener={projectControlElement?.querySelector<HTMLButtonElement>("button") ?? undefined}
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
          onClick={() => setAgentOpen(false)}
        />
      </Show>
      <Show when={agentPresence.present()}>
        <aside
          class="agent-panel"
          data-closing={agentPresence.closing() ? "true" : "false"}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === "panel-out")
              agentPresence.finishExit();
          }}
          aria-hidden={agentOpen() ? "false" : "true"}
          {...(agentOverlay()
            ? { role: "dialog" as const, "aria-modal": "true" as const }
            : { role: "complementary" as const })}
          aria-label="Agent panel"
          inert={!agentOpen() || registrationOpen()}
          ref={agentPanelElement}
        >
          <header>
            <span class="sr-only">Assistant</span>
            <button
              type="button"
              class="bare-icon window-minimize-control"
              aria-label="Minimize Agent panel"
              onClick={() => setAgentOpen(false)}
            >
              <Icon name="minimize" />
            </button>
          </header>
          <Show when={setupVisible() && projectSetup}>
            {(setup) => (
              <ProjectSetupPanel
                setup={setup()}
                onSettings={openSettings}
                onProject={selectProject}
              />
            )}
          </Show>
          <Show when={!setupVisible()}>
            <Show when={conversationMode() === "build" && selectedChange()}>
              <div class="agent-status">
                <span class="agent-state">
                  {!agentViewLoaded()
                    ? "Loading implementation…"
                    : agent().state === "idle" && !agentCanRun()
                      ? "Build unavailable"
                      : buildAgentStatus(agent())}
                </span>
                <span class={`runtime-presence ${ticketWorkspaceReady() ? "ready" : ""}`}>
                  <i />
                  {ticketWorkspaceStatus()}
                </span>
              </div>
            </Show>
            <Show when={conversationMode() === "build" && selectedChange() && agent().stopPending}>
              <section class="agent-stop-notice" aria-label="Stop recovery">
                <p class="agent-stop-copy" role="status">
                  Stop saved. OpenCode confirmation is still missing. New Build work is blocked.
                </p>
                <details>
                  <summary class="agent-stop-explanation">Why is Build blocked?</summary>
                  <p class="agent-stop-detail">
                    {agent().lastError?.startsWith("Stop remains unconfirmed.")
                      ? agent().lastError
                      : "Factory cannot yet prove that execution and queued input are settled."}
                  </p>
                  <p class="agent-stop-detail">
                    Factory will not resend uncertain commands. Stop does not roll back workspace
                    edits.
                  </p>
                  <Show when={agent().runtimeState !== "ready" || !agent().messagesAvailable}>
                    <p class="agent-stop-detail">
                      Live workspace status is unavailable. Queued input may survive a restart;
                      reconnecting alone does not confirm Stop.
                    </p>
                  </Show>
                  <p class="agent-stop-detail">
                    Checking status only reads the current outcome. It does not restart work.
                  </p>
                  <Show when={agent().stopId}>
                    <p class="agent-stop-detail">
                      Recheck confirmation checks OpenCode and saves confirmation only when it can
                      prove this Stop. It will not resend interruption, cancel input or start
                      compute.
                    </p>
                    <button
                      type="button"
                      class="agent-control agent-stop-check"
                      disabled={pending()}
                      onClick={() => void recheckStopConfirmation()}
                    >
                      Recheck confirmation
                    </button>
                  </Show>
                </details>
                <button
                  type="button"
                  class="agent-control agent-stop-check"
                  disabled={pending()}
                  onClick={() => void checkStopStatus()}
                >
                  Check Stop status
                </button>
              </section>
            </Show>
            <Show
              when={
                conversationMode() === "build" &&
                selectedChange() &&
                agent().commitOperation &&
                !agent().stopPending
              }
            >
              <p class="agent-activity-notice" role="status" aria-label="Commit recovery">
                {buildAgentHint(agent())}
              </p>
            </Show>
            <Show
              when={
                conversationMode() === "build" &&
                selectedChange() &&
                buildAgentActivityNotice(agent())
              }
            >
              <p class="agent-activity-notice" role="status">
                {buildAgentActivityNotice(agent())}
              </p>
            </Show>
            <Show
              when={
                conversationMode() === "build" &&
                selectedChange() &&
                agent().state === "working" &&
                !agent().runtimeConnected &&
                !agent().stopPending &&
                !agent().commitOperation
              }
            >
              <p class="agent-activity-notice" role="status" aria-label="Build connection">
                {buildAgentHint(agent())}
              </p>
            </Show>
            <div
              class="agent-messages conversation-history"
              aria-live="polite"
              ref={(element) => {
                conversationScroll?.dispose();
                conversationScroll = followConversation(element);
              }}
            >
              <For each={visibleConversation()} keyed={(item) => item.id}>
                {(item) => {
                  const conversationEntry = () => {
                    const current = item();
                    return current.kind === "conversation" ? current.entry : undefined;
                  };
                  const agentMessage = () => {
                    const current = item();
                    return current.kind === "change-agent" ? current.message : undefined;
                  };
                  return (
                    <Show
                      when={conversationEntry()}
                      fallback={
                        <Show when={agentMessage()}>
                          {(message) => <ChangeAgentMessage message={message()} />}
                        </Show>
                      }
                    >
                      {(entry) => (
                        <ConversationEntryCard
                          entry={entry()}
                          answered={
                            answeredQuestionIDs().has(entry().id) ||
                            Boolean(answerSummary(entry().id))
                          }
                          answerSummary={answerSummary(entry().id)}
                          requirementCurrent={
                            latestRevision()?.id === entry().requirementRevisionId
                          }
                          requirementApproved={Boolean(
                            detail()?.revisions.find(
                              (revision) => revision.id === entry().requirementRevisionId,
                            )?.approvalId,
                          )}
                          requirementVisible={
                            workspaceView() === "ticket" && Boolean(assistantTicketID())
                          }
                          pending={assistantPending()}
                          initialAnswer={restoredInterviewAnswer(entry().id)}
                          answerStorageKey={`interview-answer:${props.session.user.id}:${entry().id}`}
                          canAnswer={
                            pendingInterview() && currentInterviewQuestion()?.id === entry().id
                          }
                          onPause={() => pauseClarification(true)}
                          onResume={() => {
                            pauseClarification(false);
                            setAgentOpen(true);
                          }}
                          onAnswer={(event, question) =>
                            void answerInterview(event, entry().id, question)
                          }
                          onReviewRequirements={() => {
                            const epic = epicProposals()[entry().id];
                            if (epic) {
                              const ticketID = assistantTicketID();
                              openWorkspaceTab({
                                id: `epic-proposal:${entry().id}`,
                                view: "epic-proposal",
                                label: epic.epic.title,
                                proposalID: entry().id,
                                ...(ticketID ? { ticketID } : {}),
                              });
                              setAgentOpen(false);
                              return;
                            }
                            const ticketID = assistantTicketID();
                            if (ticketID) {
                              selectTicket(ticketID);
                              return;
                            }
                            const ticket = z
                              .object({
                                title: z.string().max(200),
                                description: z.string().max(10_000),
                              })
                              .safeParse(entry().payload["ticket"]);
                            const requirement = requirementContentInput.safeParse(
                              entry().payload["requirement"],
                            );
                            if (!ticket.success || !requirement.success) return;
                            const description = [
                              ticket.data.description,
                              requirement.data.summary,
                              "## Acceptance criteria",
                              ...requirement.data.acceptanceCriteria.map(
                                (value) => `- [ ] ${value}`,
                              ),
                              ...(requirement.data.nonGoals.length
                                ? [
                                    "## Out of scope",
                                    ...requirement.data.nonGoals.map((value) => `- ${value}`),
                                  ]
                                : []),
                            ].join("\n\n");
                            if (description.length > 10_000) {
                              setError(
                                "This proposal is too long for a Ticket draft. Ask for a more concise version.",
                              );
                              return;
                            }
                            openTicketDraft({
                              id: entry().id,
                              title: ticket.data.title,
                              description,
                            });
                          }}
                          onCitation={({ source, id, commitSha, path }) => {
                            if (source === "ticket") {
                              const ticket = ticketList().find((candidate) => candidate.id === id);
                              if (ticket) selectTicket(id);
                            } else if (source === "epic") {
                              setSelectedEpicID(id);
                            } else if (source === "code") {
                              const url = selectedProject()?.repositoryUrl?.replace(/\.git$/, "");
                              if (url && commitSha && path)
                                window.open(
                                  `${url}/src/commit/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                            } else {
                              setOpenRepositoryDocument(undefined);
                              setSelectedKnowledgePageID(id);
                              setKnowledgeHistory([]);
                              void openKnowledge();
                            }
                          }}
                        />
                      )}
                    </Show>
                  );
                }}
              </For>
              <Show when={streamedAnswer()}>
                <article
                  class="agent-message assistant"
                  aria-label="Assistant streaming response"
                  aria-busy="true"
                >
                  <div
                    class="markdown-body"
                    innerHTML={markdownHTML(streamedAnswer()?.text ?? "")}
                  />
                </article>
              </Show>
              <Show when={assistantPending() && !streamedAnswer()}>
                <section
                  class="assistant-reply-placeholder"
                  role="status"
                  aria-label="Assistant responding"
                  aria-busy="true"
                >
                  <span>
                    {(() => {
                      const progress = conversation()?.turn?.progress;
                      if (!progress) return "Preparing a response…";
                      const label = {
                        guidance: "Loading Project guidance…",
                        thinking: "Preparing a response…",
                        searching: "Searching the Project…",
                        reading: "Reading Project sources…",
                        validating: "Checking the response…",
                      }[progress.phase];
                      return `${label}${progress.completedLookups ? ` · ${progress.completedLookups} research steps completed` : ""}`;
                    })()}
                  </span>
                  <div class="assistant-skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                </section>
              </Show>
              <Show
                when={
                  visibleConversation().length === 0 &&
                  !assistantPending() &&
                  !["uncertain", "failed", "stopped"].includes(conversation()?.turn?.state ?? "")
                }
              >
                <div class="agent-empty compact">
                  <Icon name="agent" />
                  <p>
                    {conversationMode() === "build"
                      ? !agentViewLoaded()
                        ? "Loading implementation…"
                        : selectedChange()
                          ? buildAgentEmptyMessage(agent())
                          : "Approve the latest Requirement Revision to start Build."
                      : assistantTicketID()
                        ? "Ask about this Ticket, or tell me what needs clarifying."
                        : "Ask about the Project, or describe a change you want to work on."}
                  </p>
                </div>
              </Show>
            </div>
            <div class={`agent-input-shell${pendingInterview() ? " interview-active" : ""}`}>
              <div class="assistant-context-row">
                <AgentBlockers
                  projectID={selectedProjectID()}
                  mode={conversationMode()}
                  settingsOpen={workspaceView() === "settings"}
                  onSettings={openSettings}
                  turn={
                    conversationMode() === "build" && selectedChange()
                      ? agent().turn
                      : conversation()?.turn
                  }
                />
              </div>
              <Show when={conversationMode() !== "build" && agentTurnBusy()}>
                <div class="agent-activity-notice" role="status">
                  <span>Implementation continues in its Workspace.</span>
                  <button
                    type="button"
                    class="agent-control"
                    aria-label="Stop OpenCode"
                    onClick={() => void stopAgent()}
                  >
                    <Icon name="stop" /> Stop
                  </button>
                </div>
              </Show>
              <Show
                when={
                  restoredMessageScope() ===
                  agentCommandScope(
                    conversationMode() === "build" ? "change-prompt" : "project-message",
                    conversationMode() === "build" ? selectedChange()?.id : assistantTicketID(),
                  )
                }
              >
                <p class="agent-activity-notice" role="status" aria-label="Message recovery">
                  Previous send unconfirmed. Re-send unchanged text to check it.
                </p>
              </Show>
              <Show when={conversationMode() === "build"}>
                <Show
                  when={
                    agent().lastError &&
                    !agent().codingPause &&
                    !(
                      agent().stopPending &&
                      agent().lastError?.startsWith("Stop remains unconfirmed.")
                    )
                  }
                >
                  <p class="inline-error">{agent().lastError}</p>
                </Show>
                <Show when={agent().codingPause}>
                  <p class="agent-activity-notice" role="status">
                    Coding is paused. Existing code is retained. Resume from the Ticket after its
                    allowance is available.
                  </p>
                </Show>
                <Show when={agentViewLoaded() && !agentCanRun()}>
                  <p class="agent-unavailable">
                    {selectedChange()?.state === "branch-pending"
                      ? "Preparing the Change branch. Implementation will be available when it is ready."
                      : `This Change is ${selectedChange()?.state ?? "unavailable"}. OpenCode is read-only.`}
                  </p>
                </Show>
                <Show when={agentCanRun() && !agent().codingPause}>
                  <form
                    class="agent-composer build-composer"
                    onSubmit={(event) => {
                      if (!canPromptBuild()) {
                        event.preventDefault();
                        void startAgent();
                      } else void promptAgent(event);
                    }}
                    onReset={(event) => {
                      const input = event.currentTarget.querySelector("textarea");
                      queueMicrotask(() => {
                        if (input) resizeComposer(input);
                      });
                    }}
                  >
                    <Show when={canPromptBuild()}>
                      <textarea
                        rows={1}
                        onKeyDown={composerKeyDown}
                        onInput={(event) => resizeComposer(event.currentTarget)}
                        ref={(element) =>
                          restoreMessageDraft(element, () =>
                            agentCommandScope("change-prompt", selectedChange()?.id),
                          )
                        }
                        name="message"
                        aria-label="Message conversation"
                        placeholder={
                          agent().state === "failed"
                            ? "Describe what to fix in the retained code…"
                            : agent().state === "stopped"
                              ? "Ask a question or describe the next change…"
                              : agentTurnBusy()
                                ? "Prepare your next instructions, or Stop to change direction…"
                                : "Ask a question or describe the next change…"
                        }
                        disabled={pending()}
                      />
                    </Show>
                    <div class="agent-compose-toolbar">
                      <Show
                        when={agentViewLoaded()}
                        fallback={<span class="agent-model-controls">Loading implementation…</span>}
                      >
                        <BuildModelControls
                          projectID={selectedProjectID()}
                          changeID={selectedChange()?.id}
                          turn={agent().turn}
                          sessionAvailable={agent().sessionAvailable}
                          disabled={
                            pending() ||
                            agentTurnBusy() ||
                            agentNeedsResolution() ||
                            Boolean(agent().commitOperation) ||
                            agent().stopPending
                          }
                          reasoning={chosenCodingReasoning()}
                          onChange={(value) => {
                            const changeID = selectedChange()?.id;
                            if (changeID)
                              setCodingReasoningChoices((previous) => ({
                                ...previous,
                                [changeID]: value,
                              }));
                          }}
                        />
                      </Show>
                      <div class="composer-actions">
                        <Show
                          when={agentNeedsResolution() || agentTurnBusy()}
                          fallback={
                            <button
                              type="submit"
                              class="agent-control primary"
                              aria-label={
                                !canPromptBuild()
                                  ? agent().state === "failed"
                                    ? "Retry implementation"
                                    : "Start implementation"
                                  : "Send message"
                              }
                              disabled={
                                pending() ||
                                !agentViewLoaded() ||
                                agentNeedsResolution() ||
                                Boolean(agent().commitOperation) ||
                                agent().stopPending ||
                                (!canPromptBuild() && !props.modelRelayConfigured) ||
                                blockersFor(selectedTicketID() ?? "").length > 0
                              }
                              title={
                                !props.modelRelayConfigured
                                  ? "Connect a Factory model before starting implementation"
                                  : buildAgentHint(agent())
                              }
                            >
                              <Icon name={canPromptBuild() ? "send" : "play"} />
                              <Show
                                when={!canPromptBuild()}
                                fallback={
                                  <span class="sr-only">
                                    {agent().state === "stopped" ? "Resume" : "Send"}
                                  </span>
                                }
                              >
                                {agent().state === "failed" ? "Retry" : "Start"}
                              </Show>
                            </button>
                          }
                        >
                          <button
                            type="button"
                            class="agent-control"
                            aria-label={
                              agentNeedsResolution() ? "Stop unresolved turn" : "Stop OpenCode"
                            }
                            disabled={pending() || agent().stopPending}
                            onClick={() => void stopAgent()}
                          >
                            <Icon name="stop" />
                            <span class="sr-only">
                              {agentNeedsResolution() ? "Stop unresolved turn" : "Stop"}
                            </span>
                          </button>
                        </Show>
                      </div>
                    </div>
                  </form>
                  <Show when={!props.modelRelayConfigured}>
                    <p class="agent-configuration-note">
                      Model connection required before implementation can start.
                    </p>
                  </Show>
                </Show>
              </Show>
              <Show when={conversationMode() !== "build" && !interviewOwnsComposer()}>
                <form
                  class="agent-composer conversation-composer"
                  onSubmit={sendConversationMessage}
                  onReset={(event) => {
                    const input = event.currentTarget.querySelector("textarea");
                    queueMicrotask(() => {
                      if (input) resizeComposer(input);
                    });
                  }}
                >
                  <textarea
                    rows={1}
                    onKeyDown={composerKeyDown}
                    onInput={(event) => resizeComposer(event.currentTarget)}
                    ref={(element) =>
                      restoreMessageDraft(element, () => agentCommandScope("project-message"))
                    }
                    name="message"
                    aria-label="Message conversation"
                    placeholder={conversationPlaceholder()}
                    disabled={assistantPending() || !selectedProject()}
                  />
                  <div class="agent-compose-toolbar">
                    <button
                      type="submit"
                      class="agent-control primary"
                      aria-label="Send message"
                      disabled={assistantPending() || !selectedProject()}
                    >
                      <Icon name="send" />
                      <span class="sr-only">Send</span>
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </Show>
        </aside>
      </Show>

      <section
        class={`workspace-window workspace-window-${workspaceView() ?? "minimized"}`}
        aria-label={`${workspaceView() ?? "minimized"} workspace`}
        data-closing={workspaceWindow.closing() ? "true" : "false"}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === "window-out")
            workspaceWindow.finishExit();
        }}
        aria-hidden={workspaceVisible() ? "false" : "true"}
        hidden={!workspaceWindow.present() || workspaceTabs().length === 0}
        inert={!workspaceVisible() || agentOverlay() || registrationOpen()}
      >
        <WorkspaceTabbar
          tabs={workspaceTabs()}
          activeTabID={activeWorkspaceTab()?.id}
          onActivate={activateWorkspaceTab}
          onClose={closeWorkspaceTab}
          onMinimize={() => setWorkspaceVisible(false)}
        />
        <div
          class="workspace-view-body"
          role="tabpanel"
          id={workspacePanelID}
          aria-labelledby={activeWorkspaceLabelID()}
        >
          <Loading
            on={activeWorkspaceTab()?.id}
            fallback={
              <p class="muted" role="status">
                Opening workspace…
              </p>
            }
          >
            <Switch>
              <Match when={workspaceView() === "epic-proposal" && activeWorkspaceTab()?.proposalID}>
                <Show when={epicProposals()[activeWorkspaceTab()?.proposalID ?? ""]} keyed>
                  {(proposal) => (
                    <EpicProposalWorkspace
                      id={activeWorkspaceTab()?.proposalID ?? ""}
                      initial={proposal}
                      storageKey={`epic-proposal:${props.session.user.id}:${activeWorkspaceTab()?.proposalID}`}
                      pending={pending()}
                      onConfirm={(value) =>
                        confirmEpicWork(activeWorkspaceTab()?.proposalID ?? "", value)
                      }
                    />
                  )}
                </Show>
              </Match>
              <Match when={workspaceView() === "ticket-draft"}>
                <TicketDraftWorkspace
                  storageKey={personalDraftKey()}
                  initial={
                    personalDrafts.get(selectedProjectID() ?? "") ??
                    readPersonalTicketDraft(personalDraftKey())
                  }
                  pending={pending()}
                  onCreate={publishTicketDraft}
                  onChange={(draft) => {
                    const projectID = selectedProjectID();
                    if (projectID) personalDrafts.set(projectID, draft);
                    updateWorkspaceTab({
                      id: `ticket-draft:${projectID}`,
                      view: "ticket-draft",
                      label: draft.title || "New ticket",
                    });
                  }}
                />
              </Match>
              <Match when={workspaceView() === "ticket" && detail()}>
                <Show when={detail()}>
                  {(current) => (
                    <TicketWorkspace
                      drafts={ticketDrafts}
                      current={current()}
                      storageKey={`ticket-edit:${props.session.user.id}:${current().ticket.id}`}
                      onConfirmRequirements={confirmRequirements}
                      clarificationAction={ticketClarificationAction()}
                      ticketReference={ticketReference(current().ticket.id)}
                      change={selectedChange()}
                      delivery={delivery()}
                      latestRevision={latestRevision()}
                      latestRequirement={latestRequirement()}
                      pending={pending()}
                      buildInProgress={agentTurnBusy()}
                      epics={epicList()}
                      dependencies={{
                        prerequisites: prerequisitesFor(current().ticket.id),
                        candidates: dependencyCandidates(current().ticket.id),
                        admitted: Boolean(selectedChange()),
                        pending: pending(),
                        onOpen: selectTicket,
                        onAdd: (id) => editDependency("add", id),
                        onRemove: (id) => void editDependency("remove", id),
                      }}
                      onAssignEpic={(epicId) => void assignTicketEpic(epicId)}
                      onInterview={() => void beginRequirementsInterview()}
                      onSaveDocument={saveTicketDocument}
                      onFollowUp={() => void createFollowUp()}
                      onOpenTicket={selectTicket}
                      onOpenEpic={(id) => {
                        setSelectedEpicID(id);
                        setWorkspaceVisible(false);
                      }}
                      onTrash={() => void ticketTrashCommand(current().ticket.id, "trash")}
                      onRestore={() => void ticketTrashCommand(current().ticket.id, "restore")}
                      onImplement={(revisionID) => void implementTicket(revisionID)}
                      implementationAvailable={props.modelRelayConfigured}
                      codingPause={agent().codingPause}
                      computeWait={agent().computeWait}
                      onResumeCoding={() => void resumeCoding()}
                      onStopImplementation={() => void stopAgent()}
                      onOpenIDE={() => {
                        const target = ideTargets().find(
                          (candidate) => candidate.changeId === selectedChange()?.id,
                        );
                        if (target) void openIDETarget(target);
                      }}
                      onApproveDelivery={(changeID) => void approveDelivery(changeID)}
                      canDevelop={canDevelopProject()}
                      onRequestChanges={requestCorrections}
                    />
                  )}
                </Show>
              </Match>
              <Match when={workspaceView() === "knowledge"}>
                <KnowledgeWorkspace
                  projectID={selectedProjectID() ?? ""}
                  userID={props.session.user.id}
                  repositoryURL={selectedProject()?.repositoryUrl ?? ""}
                  canDevelop={canDevelopProject()}
                  onOpenIDE={() => {
                    const target = ideTargets().find((entry) => !entry.changeId);
                    if (target) void openIDETarget(target);
                  }}
                  onRestore={(pageID, revisionID, expectedVersion) =>
                    apiRequest(knowledgeSaveSchema, `/api/knowledge/pages/${pageID}/restore`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ revisionID, expectedVersion }),
                    })
                  }
                  drafts={knowledgeDrafts}
                  pages={knowledgePageList()}
                  selectedPage={selectedKnowledgePage()}
                  documents={repositoryDocuments()}
                  openDocument={openRepositoryDocument()}
                  generation={knowledgeGeneration()}
                  revisions={knowledgeHistory()}
                  searchResults={knowledgeSearch()}
                  searchQuery={knowledgeSearchQuery()}
                  pending={pending()}
                  onSelectPage={(pageID) => {
                    setSelectedKnowledgePageID(pageID);
                    setOpenRepositoryDocument(undefined);
                    setKnowledgeHistory([]);
                  }}
                  onOpenDocument={(path) => void openDocument(path)}
                  onGenerate={() => void mutate(generateKnowledge)}
                  onSearch={(query) => void searchProjectKnowledge(query)}
                  onSavePage={editKnowledgePage}
                  onHistory={loadKnowledgeHistory}
                  onSources={async (pageID) =>
                    (
                      await apiRequest(
                        knowledgeSourcesSchema,
                        `/api/knowledge/pages/${pageID}/sources`,
                      )
                    ).citations
                  }
                  onArchive={() => void archiveKnowledgePage()}
                  onMove={async ({ pageId, parentId, beforeId }) => {
                    const page = knowledgePageList().find((entry) => entry.id === pageId);
                    const projectId = selectedProjectID();
                    const client = zero();
                    if (!page || !projectId || !client) throw new Error("Wiki page not found");
                    await commitZeroMutation(
                      client.mutate(
                        zeroMutators.knowledge.move({
                          projectId,
                          pageId,
                          parentId,
                          beforeId,
                          expectedMetadataVersion: page.metadataVersion,
                        }),
                      ).server,
                    );
                  }}
                  onIcon={async (icon) => {
                    const page = selectedKnowledgePage();
                    const client = zero();
                    if (!page || !client) throw new Error("Wiki page not found");
                    await commitZeroMutation(
                      client.mutate(
                        zeroMutators.knowledge.setIcon({
                          projectId: page.projectId,
                          pageId: page.id,
                          expectedMetadataVersion: page.metadataVersion,
                          icon,
                        }),
                      ).server,
                    );
                  }}
                />
              </Match>
              <Match when={workspaceView() === "inbox"}>
                <InboxWorkspace />
              </Match>
              <Match when={workspaceView() === "trash"}>
                <TrashWorkspace
                  tickets={ticketList().filter((ticket) => ticket.trashedAt)}
                  pending={pending()}
                  onOpen={selectTicket}
                  onRestore={(id) => void ticketTrashCommand(id, "restore")}
                  onRetry={(id) => void ticketTrashCommand(id, "trash")}
                />
              </Match>
            </Switch>
          </Loading>
          <For each={workspaceTabs().filter((tab) => tab.view === "settings")}>
            {(tab) => (
              <div
                class="settings-tab-panel"
                hidden={workspaceView() !== "settings" || activeWorkspaceTab()?.id !== tab.id}
              >
                <SettingsWorkspace
                  active={workspaceView() === "settings" && activeWorkspaceTab()?.id === tab.id}
                  userID={props.session.user.id}
                  initialSelection={tab.settingsSelection}
                  project={tab.settingsProject}
                  systemManager={props.session.systemManager}
                  projectManager={canManageSettingsProject(tab.settingsProject?.id)}
                  developer={
                    props.session.systemManager ||
                    memberships
                      .data()
                      ?.some(
                        (member) =>
                          member.projectId === tab.settingsProject?.id &&
                          member.role === "developer",
                      ) === true
                  }
                />
              </div>
            )}
          </For>
          <RuntimeWorkspaceTabs
            projectID={selectedProjectID() ?? ""}
            tabs={workspaceTabs()}
            activeTabID={activeWorkspaceTab()?.id}
            attempts={attempts()}
            previews={appPreviews()}
            pending={pending()}
          />
          <DeveloperIDEWorkspace
            userID={props.session.user.id}
            projectID={selectedProjectID()}
            allowed={canDevelopProject()}
            preparingSelection={projectMenuOpen()}
            workspaceID={
              activeWorkspaceTab()?.view === "ide" ? activeWorkspaceTab()?.workspaceID : undefined
            }
            active={workspaceView() === "ide"}
            onDevelopmentPreview={(message) => {
              const projectID = selectedProjectID();
              void refreshServerState()
                .then(() => {
                  if (selectedProjectID() !== projectID) return;
                  if (
                    attempts().some(
                      (attempt) =>
                        attempt.id === message.attemptID &&
                        attempt.workspaceId === message.workspaceID,
                    )
                  )
                    openDevelopmentPreview(message.attemptID, message.process, message.label);
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "Preview is unavailable."),
                );
            }}
          />
        </div>
      </section>
    </main>
  );
}
