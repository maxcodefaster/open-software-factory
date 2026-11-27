import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { z } from "zod";
import { interviewAnswerInput } from "#conversation-domain/conversation";
import { type CodingReasoning, codingReasoningInput } from "#conversation-domain/model-settings";
import { deliveryBlocker } from "#interface-domain/ticket-progress";
import type { AgentView } from "../agent/contracts";
import { createAgentFollower } from "../agent/follow-agent";
import { createAgentCommandIds } from "../agent-command-ids";
import { type AgentSnapshot, createAgentReadFence, retainAgentActivity } from "../agent-view-state";
import type { followConversation } from "../assistant-interaction";
import type { Change, Ticket } from "../change/contracts";
import { plainErrorMessage } from "../command-error";
import type { ActivityNavigationRequest } from "../ide-messages";
import type { ConversationView } from "../project-agent/contracts";
import { ticketReference } from "../projects/ticket-content";
import type { AppPreview, RuntimeAttempt, RuntimeDockTarget } from "../runtime/contracts";
import { runtimeStateLabel } from "../runtime-workspace-state";
import type { WorkspaceTab, WorkspaceView } from "../workspace-tabs";
import { createComposerState } from "./composer-state";
import type { DesktopProject, TicketDetail } from "./contracts";

export interface ImplementationPreparation {
  projectID: string;
  ticketID: string;
  revisionID: string;
  reasoning: CodingReasoning | undefined;
  failure: string | undefined;
}

export interface FactoryAgentStateDependencies {
  initialUserID: string;
  sessionUserID: () => string;
  selectedProjectID: SourceAccessor<string | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  assistantTicketID: () => string | undefined;
  selectedConversation: () => string | undefined;
  assistantKey: () => string;
  detail: Accessor<TicketDetail | undefined>;
  canDevelopProject: () => boolean;
  selectedChange: () => Change | undefined;
  selectedProject: Accessor<DesktopProject | undefined>;
  ticketList: Accessor<Ticket[]>;
  changes: Accessor<Change[]>;
  attempts: Accessor<RuntimeAttempt[]>;
  appPreviews: Accessor<AppPreview[]>;
  lifecycleProjectID: SourceAccessor<string | undefined>;
  stagingRuntimeFor: (projectID: string) => RuntimeAttempt | undefined;
  implementationPreparation: SourceAccessor<ImplementationPreparation | undefined>;
  setImplementationPreparation: Setter<ImplementationPreparation | undefined>;
  setCorrectionTarget: Setter<string | undefined>;
  setError: Setter<string>;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  workspaceView: () => WorkspaceView | undefined;
  ideNavigation: SourceAccessor<ActivityNavigationRequest | undefined>;
  setIDENavigation: Setter<ActivityNavigationRequest | undefined>;
  clarificationOrigins: Set<string>;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
}

const idleAgentView: AgentView = {
  state: "idle",
  messages: [],
  messagesAvailable: true,
  sessionAvailable: false,
  runtimeConnected: false,
  stopPending: false,
  stopId: null,
};

export function createFactoryAgentState(dependencies: FactoryAgentStateDependencies) {
  const [codingReasoningChoices, setCodingReasoningChoices] = createSignal<
    Record<string, CodingReasoning | undefined>
  >({});
  const [agent, setAgent] = createSignal<AgentView>({ ...idleAgentView });
  let lastAgentSnapshot: AgentSnapshot | undefined;
  const [observedAgentChangeID, setObservedAgentChangeID] = createSignal<string>();
  const agentReadFence = createAgentReadFence();
  const [agentActivityRevision, setAgentActivityRevision] = createSignal(0);

  const agentCommandIds = createAgentCommandIds({
    userId: dependencies.initialUserID,
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
    userID: dependencies.initialUserID,
    commands: agentCommandIds,
    acknowledgements: commandAcknowledgements,
    onError: dependencies.setError,
  });

  function agentCommandScope(
    kind: string,
    identity: string | null | undefined = dependencies.assistantTicketID(),
    projectID = dependencies.selectedProjectID(),
  ) {
    const context = dependencies.selectedConversation();
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
        const prepared = dependencies.implementationPreparation();
        if (
          prepared &&
          prepared.projectID === dependencies.selectedProjectID() &&
          prepared.ticketID === dependencies.selectedTicketID() &&
          prepared.ticketID === dependencies.assistantTicketID() &&
          prepared.revisionID === dependencies.detail()?.revisions[0]?.id &&
          dependencies.selectedChange()?.id === changeID &&
          dependencies.canDevelopProject() &&
          view.turn.engine === "opencode"
        ) {
          const scope = `implement:${prepared.ticketID}`;
          if (agentCommandIds.latest(scope)?.commandId === view.turn.commandId) {
            acknowledgeCommand(scope, view.turn.commandId);
            dependencies.setCorrectionTarget(changeID);
            dependencies.setImplementationPreparation(undefined);
          }
        }
      }
    } catch (cause) {
      dependencies.setError(
        cause instanceof Error
          ? plainErrorMessage(cause.message)
          : "Browser recovery is unavailable.",
      );
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
    setAgent({ ...idleAgentView });
  }

  function chosenCodingReasoning() {
    commandAcknowledgements();
    const changeID = dependencies.selectedChange()?.id;
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

  // The Project's saved Change list already carries every merge and Promotion, so a queued
  // Delivery names its blocker without another read.
  const deliveryBlockFor = (change: Change | undefined) => {
    if (!change || !["delivering", "active"].includes(change.state)) return undefined;
    const block = deliveryBlocker(
      change,
      dependencies.changes().filter((candidate) => candidate.projectId === change.projectId),
    );
    if (!block) return undefined;
    const ticket = dependencies.ticketList().find((candidate) => candidate.id === block.ticketId);
    return { reason: block.reason, title: ticket?.title ?? ticketReference(block.ticketId) };
  };

  const ideTargets = (): RuntimeDockTarget[] => {
    const project = dependencies.selectedProject();
    if (
      !project ||
      !dependencies.canDevelopProject() ||
      dependencies.lifecycleProjectID() !== project.id
    )
      return [];
    const userId = dependencies.sessionUserID();
    const liveAttempts = dependencies
      .attempts()
      .filter(
        (attempt) =>
          attempt.projectId === project.id &&
          ["personal", "ticket"].includes(attempt.runtimeKind ?? "") &&
          (attempt.workspaceKind !== "personal" || attempt.ownerUserId === userId) &&
          ["create-intended", "starting", "ready"].includes(attempt.state),
      );
    const targets: RuntimeDockTarget[] = liveAttempts.map((attempt) => {
      const change = attempt.changeId
        ? dependencies.changes().find((candidate) => candidate.id === attempt.changeId)
        : undefined;
      const ticket = change
        ? dependencies.ticketList().find((candidate) => candidate.id === change.ticketId)
        : undefined;
      return {
        id:
          attempt.workspaceKind === "personal"
            ? `personal:${project.id}`
            : `change:${attempt.changeId}`,
        label:
          attempt.workspaceKind === "personal"
            ? "My workspace"
            : (ticket?.title ?? (change ? ticketReference(change.ticketId) : "Ticket")),
        detail: runtimeStateLabel(attempt.state),
        attemptId: attempt.id,
        ...(attempt.changeId ? { changeId: attempt.changeId } : {}),
      };
    });
    if (!liveAttempts.some((attempt) => attempt.workspaceKind === "personal")) {
      targets.unshift({
        id: `personal:${project.id}`,
        label: "My workspace",
        detail: "Starts or resumes compute",
        projectId: project.id,
      });
    }
    for (const change of dependencies
      .changes()
      .filter(
        (candidate) =>
          candidate.projectId === project.id &&
          !["cancelled", "cancelling", "delivering", "delivered"].includes(candidate.state) &&
          !liveAttempts.some((attempt) => attempt.changeId === candidate.id),
      )) {
      const ticket = dependencies
        .ticketList()
        .find((candidate) => candidate.id === change.ticketId);
      targets.push({
        id: `change:${change.id}`,
        label: ticket?.title ?? ticketReference(change.ticketId),
        detail: "Open source",
        changeId: change.id,
      });
    }
    return targets;
  };

  const previewTargets = (): RuntimeDockTarget[] => {
    const project = dependencies.selectedProject();
    if (!project || dependencies.lifecycleProjectID() !== project.id) return [];
    const staging = dependencies.stagingRuntimeFor(project.id);
    const stagedApps = dependencies
      .appPreviews()
      .filter(
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
              detail: runtimeStateLabel(staging.state),
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
    for (const preview of dependencies
      .appPreviews()
      .filter((item) => item.projectID === project.id)) {
      const staged = !preview.attemptID || preview.attemptID === staging?.id;
      targets.push({
        id: staged
          ? `staging:${project.id}:${preview.channel}`
          : `app:${preview.attemptID}:${preview.channel}`,
        label: preview.label,
        detail: !preview.attemptID
          ? "Starts when selected"
          : staged
            ? runtimeStateLabel(staging?.state ?? preview.state)
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

  let conversationScroll: ReturnType<typeof followConversation> | undefined;
  onCleanup(() => conversationScroll?.dispose());
  createEffect(dependencies.assistantKey, () => conversationScroll?.reset());

  // While the IDE of a Ticket's Change is on screen, the editor follows the agent's file edits.
  // The editor decides when to hold back, for example while the person is typing or scrolling.
  const agentFollower = createAgentFollower();
  createEffect(
    () => ({ changeID: observedAgentChangeID(), messages: agent().messages }),
    ({ changeID, messages }) => {
      const target = agentFollower.next(changeID, messages);
      const tab = untrack(dependencies.activeWorkspaceTab);
      if (
        !target ||
        !changeID ||
        !untrack(dependencies.canDevelopProject) ||
        tab?.view !== "ide" ||
        tab.changeID !== changeID ||
        !tab.workspaceID ||
        untrack(dependencies.ideNavigation)
      )
        return;
      dependencies.setIDENavigation({
        id: crypto.randomUUID(),
        workspaceID: tab.workspaceID,
        path: target.path,
        kind: "follow",
        ...(target.line ? { line: target.line } : {}),
      });
    },
  );

  let observedProposalContext = "";
  let observedProposalID: string | undefined;
  createEffect(
    () => ({ key: dependencies.assistantKey(), proposal: dependencies.detail()?.proposal?.id }),
    ({ key, proposal }) => {
      if (key !== observedProposalContext) {
        observedProposalContext = key;
        observedProposalID = proposal;
        return;
      }
      if (
        proposal &&
        proposal !== observedProposalID &&
        dependencies.clarificationOrigins.has(key) &&
        dependencies.workspaceView() === "ticket"
      ) {
        dependencies.setAgentOpen(false);
        dependencies.clarificationOrigins.delete(key);
      }
      observedProposalID = proposal;
    },
  );

  return {
    codingReasoningChoices,
    setCodingReasoningChoices,
    agent,
    setAgent,
    observedAgentChangeID,
    agentReadFence,
    agentActivityRevision,
    agentCommandIds,
    messageDrafts,
    restoredMessageScope,
    restoreMessageDraft,
    agentCommandScope,
    acknowledgeCommand,
    publishAgentView,
    resetAgentView,
    chosenCodingReasoning,
    acknowledgeConversation,
    restoredInterviewAnswer,
    deliveryBlockFor,
    ideTargets,
    previewTargets,
    get conversationScroll() {
      return conversationScroll;
    },
    set conversationScroll(value: ReturnType<typeof followConversation> | undefined) {
      conversationScroll = value;
    },
  };
}
