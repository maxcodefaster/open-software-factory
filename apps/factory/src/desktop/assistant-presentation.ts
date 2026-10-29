import type { Accessor, SourceAccessor } from "solid-js";
import { createMemo } from "solid-js";
import {
  clarificationAction,
  unansweredClarification,
} from "../../../../packages/conversation-domain/src/clarification";
import type { ConversationMode } from "../../../../packages/conversation-domain/src/conversation";
import type { CodingReasoning } from "../../../../packages/conversation-domain/src/model-settings";
import { assistantContext } from "../../../../packages/interface-domain/src/assistant-context";
import { workspacePresence } from "../../../../packages/interface-domain/src/workspace-presence";
import { buildAgentNeedsStart } from "../agent-view-state";
import type { AgentView, ConversationView, WriterView } from "../api-contracts";
import { groupConversationActivities } from "../conversation-activity";
import { conversationTimeline } from "../conversation-timeline";
import { requirementContent } from "../projects/ticket-content";
import type { WorkspaceView } from "../workspace-tabs";
import type { WorkspaceTab } from "../workspace-tabs";
import type { FactoryDesktopProps, TicketDetail } from "./contracts";

interface AssistantPresentationDependencies {
  selectedTicketID: SourceAccessor<string | undefined>;
  changeFor: (ticketID: string) =>
    | {
        id: string;
        projectId: string;
        ticketId: string;
        branchName: string;
        baseSha: string;
        state: string;
        branchState: string;
        requirementApprovalId?: string | undefined;
        version?: number | undefined;
        branchHeadSha?: string | undefined;
        runtimeAttemptId?: string | undefined;
        runtimeState?: string | undefined;
        verificationState?: string | undefined;
        buildTurnState?: string | undefined;
        buildTurnPurpose?: string | undefined;
        implementationState?: string | undefined;
        deliveryApprovedAt?: string | undefined;
        mergeState?: string | undefined;
        promotionState?: string | undefined;
        failure?: string | undefined;
      }
    | undefined;
  observedAgentChangeID: SourceAccessor<string | undefined>;
  implementationPreparation: SourceAccessor<
    | {
        projectID: string;
        ticketID: string;
        revisionID: string;
        reasoning: CodingReasoning | undefined;
        failure: string | undefined;
      }
    | undefined
  >;
  selectedProjectID: SourceAccessor<string | undefined>;
  assistantTicketID: () => string | undefined;
  detail: Accessor<TicketDetail | undefined>;
  canDevelopProject: () => boolean;
  conversation: Accessor<ConversationView | undefined>;
  correctionTarget: SourceAccessor<string | undefined>;
  workspaceView: () => WorkspaceView | undefined;
  activeWorkspaceTab: () => WorkspaceTab | undefined;
  pendingInterviewAnswer: SourceAccessor<
    { key: string; questionID: string; text: string } | undefined
  >;
  assistantKey: () => string;
  clarificationPaused: () => boolean;
  assistantPending: () => boolean;
  clarificationOrigins: Set<string>;
  agentOpen: SourceAccessor<boolean>;
  agent: Accessor<AgentView>;
  codingWriter: SourceAccessor<{ changeID: string; view: WriterView | undefined } | undefined>;
  agentCommandScope: (
    kind: string,
    identity?: string | null | undefined,
    projectID?: string | undefined,
  ) => string;
  messageDrafts: ReadonlyMap<string, string>;
  props: FactoryDesktopProps;
  agentCommandIds: {
    forInput(scope: string, input: string, draft?: string): string;
    latest(
      scope: string,
    ): { scope: string; input: string; commandId: string; draft?: string | undefined } | undefined;
    forget(scope: string, ...commandIds: string[]): boolean;
  };
}

export function createAssistantPresentation(dependencies: AssistantPresentationDependencies) {
  function selectedChange() {
    const ticketID = dependencies.selectedTicketID();
    return ticketID ? dependencies.changeFor(ticketID) : undefined;
  }

  const agentViewLoaded = () =>
    Boolean(selectedChange()?.id && dependencies.observedAgentChangeID() === selectedChange()?.id);

  const preparingImplementation = () => {
    const prepared = dependencies.implementationPreparation();
    return prepared &&
      prepared.projectID === dependencies.selectedProjectID() &&
      prepared.ticketID === dependencies.selectedTicketID() &&
      prepared.ticketID === dependencies.assistantTicketID() &&
      prepared.revisionID === dependencies.detail()?.revisions[0]?.id &&
      dependencies.detail()?.ticket.state === "ready" &&
      !dependencies.detail()?.ticket.trashedAt &&
      !dependencies.detail()?.ticket.convertedToEpicId &&
      dependencies.canDevelopProject() &&
      !selectedChange()
      ? prepared
      : undefined;
  };

  const conversationMode = (): ConversationMode =>
    dependencies
      .conversation()
      ?.contexts.find((context) => context.id === dependencies.conversation()?.contextId)?.kind ===
    "research"
      ? (dependencies.conversation()?.mode ?? "investigate")
      : dependencies.conversation()?.mode === "build" ||
          preparingImplementation() ||
          (dependencies.correctionTarget() &&
            dependencies.assistantTicketID() &&
            dependencies.correctionTarget() === selectedChange()?.id)
        ? "build"
        : assistantContext({
            view: dependencies.workspaceView(),
            ideChangeId:
              dependencies.activeWorkspaceTab()?.view === "ide"
                ? dependencies.activeWorkspaceTab()?.changeID
                : undefined,
            ticketChangeId: dependencies.assistantTicketID() ? selectedChange()?.id : undefined,
          });

  const interviewAnswers = createMemo(() => {
    const answers = new Map<string, string>();
    for (const entry of dependencies.conversation()?.entries ?? [])
      if (entry.kind === "answer" && entry.inReplyToEntryId && !answers.has(entry.inReplyToEntryId))
        answers.set(entry.inReplyToEntryId, entry.body);
    return answers;
  });

  const answeredQuestionIDs = () => interviewAnswers();

  const currentInterviewQuestion = createMemo(() =>
    unansweredClarification(dependencies.conversation()?.entries ?? []),
  );

  const pendingInterview = () =>
    dependencies.pendingInterviewAnswer()?.key !== dependencies.assistantKey() &&
    conversationMode() === "plan" &&
    !dependencies.clarificationPaused() &&
    !!currentInterviewQuestion();

  const interviewOwnsComposer = () =>
    !dependencies.clarificationPaused() &&
    conversationMode() === "plan" &&
    (pendingInterview() ||
      (dependencies.assistantPending() &&
        dependencies.clarificationOrigins.has(dependencies.assistantKey())));

  const ticketClarificationAction = () =>
    clarificationAction({
      question: !!currentInterviewQuestion(),
      working: dependencies.assistantPending(),
      open: dependencies.agentOpen(),
      paused: dependencies.clarificationPaused(),
      started: Boolean(
        dependencies
          .conversation()
          ?.entries.some((entry) => entry.kind === "question" || entry.kind === "requirement"),
      ),
    });

  const conversationPlaceholder = () =>
    conversationMode() === "plan"
      ? dependencies.assistantTicketID()
        ? "Clarify this Ticket's requirements…"
        : "Describe the change you want to plan…"
      : dependencies.assistantTicketID()
        ? "Ask about this Ticket…"
        : "Ask about this Project…";

  const answerSummary = (questionID: string) => {
    const pendingAnswer = dependencies.pendingInterviewAnswer();
    return (
      interviewAnswers().get(questionID) ??
      (pendingAnswer?.key === dependencies.assistantKey() && pendingAnswer.questionID === questionID
        ? pendingAnswer.text
        : undefined)
    );
  };

  const ticketWorkspaceReady = () =>
    selectedChange()?.runtimeState === "ready" &&
    !(dependencies.agent().state === "working" && !dependencies.agent().runtimeConnected);

  const ticketWorkspaceStatus = () =>
    workspacePresence({
      changeState: selectedChange()?.state,
      runtimeState: dependencies.agent().runtimeState ?? selectedChange()?.runtimeState,
      implementationState: dependencies.agent().state,
      connectionInterrupted:
        dependencies.agent().state === "working" && !dependencies.agent().runtimeConnected,
    });

  const agentCanRun = () =>
    !dependencies.detail()?.ticket.trashedAt &&
    (["active", "starting"].includes(selectedChange()?.state ?? "") ||
      (selectedChange()?.state === "failed" &&
        ["failed", "stopped"].includes(selectedChange()?.runtimeState ?? "") &&
        ["failed", "stopped"].includes(dependencies.agent().state)));

  const canPromptBuild = () => {
    const conversation = dependencies.conversation();
    const separateCodingContext =
      conversation?.contexts.some(
        (context) =>
          context.id === conversation.contextId && context.kind === "coding" && !context.original,
      ) ?? false;
    // The original Build already has an approved initial request. Its context
    // does not replace Start/Retry when native startup failed before a session.
    return (
      conversationMode() === "build" &&
      agentCanRun() &&
      !historicalCoding() &&
      (separateCodingContext ||
        dependencies.correctionTarget() === selectedChange()?.id ||
        !buildAgentNeedsStart(dependencies.agent()))
    );
  };

  const codingWriterBlocked = () => {
    const current = dependencies.codingWriter();
    return (
      current?.changeID === selectedChange()?.id &&
      (current?.view?.state === "handoff" ||
        (current?.view?.state === "human" && !current.view.canWrite))
    );
  };

  const historicalCoding = () =>
    dependencies.conversation()?.mode === "build" && !dependencies.conversation()?.isActiveCoding;

  const retainedCodingDraft = () => {
    if (!historicalCoding()) return "";
    const scope = dependencies.agentCommandScope("change-prompt", selectedChange()?.id);
    try {
      return (
        dependencies.messageDrafts.get(scope) ??
        sessionStorage.getItem(`chat-draft:${dependencies.props.session.user.id}:${scope}`) ??
        dependencies.agentCommandIds.latest(scope)?.draft ??
        ""
      );
    } catch {
      return dependencies.messageDrafts.get(scope) ?? "";
    }
  };

  const agentTurnBusy = () =>
    ["starting", "working"].includes(dependencies.agent().state) ||
    ["pending", "dispatching", "running"].includes(dependencies.agent().turn?.state ?? "");

  const agentNeedsResolution = () => dependencies.agent().turn?.state === "uncertain";

  const latestRevision = () => dependencies.detail()?.revisions[0];

  const latestRequirement = () =>
    requirementContent(dependencies.detail()?.documentRevisions[0] ?? latestRevision());

  const visibleConversation = createMemo(() =>
    groupConversationActivities(
      conversationTimeline(
        dependencies.conversation()?.entries ?? [],
        dependencies.assistantTicketID() && selectedChange() && conversationMode() === "build"
          ? historicalCoding()
            ? [
                ...(dependencies.conversation()?.codingHistory?.messages ?? []),
                ...(dependencies.conversation()?.codingHistory?.admittedMessages ?? []),
              ]
            : [...dependencies.agent().messages, ...(dependencies.agent().admittedMessages ?? [])]
          : [],
      ),
    ),
  );

  return {
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
  };
}
