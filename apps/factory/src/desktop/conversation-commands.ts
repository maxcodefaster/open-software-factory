import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { unansweredClarification } from "../../../../packages/conversation-domain/src/clarification";
import type {
  InterviewQuestion,
  PlanningIntent,
} from "../../../../packages/conversation-domain/src/conversation";
import { normalizeInterviewAnswer } from "../../../../packages/conversation-domain/src/conversation";
import type { createAgentCommandIds } from "../agent-command-ids";
import type { Change, ConversationView, Ticket } from "../api-contracts";
import { readAttachmentContent } from "../attachments/composer";
import { streamConversation } from "../conversation-stream";
import {
  answerConversationQuestion,
  sendConversationMessage as commissionConversationMessage,
  getConversation,
  setConversationMode,
} from "../server-functions/conversations";
import { serverCall } from "../server-functions/result";
import type { DesktopMutation, ReadTicketDetail, TicketDetail } from "./contracts";

interface ConversationCommandsDependencies {
  assistantContextLoading: () => boolean;
  assistantPending: () => boolean;
  canPromptBuild: () => boolean;
  promptAgent: (event: SubmitEvent) => Promise<void>;
  selectedProjectID: SourceAccessor<string | undefined>;
  assistantTicketID: () => string | undefined;
  detail: Accessor<TicketDetail | undefined>;
  setAgentOpen: (value: boolean | ((previous: boolean) => boolean)) => boolean;
  pauseClarification: (value: boolean) => void;
  pendingInterview: () => boolean;
  clarificationOrigins: Set<string>;
  assistantKey: () => string;
  selectedChange: Accessor<Change | undefined>;
  moveTicket: (ticket: Ticket, state: "inbox" | "ready") => Promise<boolean>;
  conversation: Accessor<ConversationView | undefined>;
  clarificationPaused: () => boolean;
  agentCommandScope: (
    kind: string,
    identity?: string | null | undefined,
    projectID?: string | undefined,
  ) => string;
  publishProvisionalAnswer(scope: string, turnId: string, text: string): void;
  clearProvisionalAnswer(scope: string, turnId: string | undefined): void;
  workspaceDisposed: boolean;
  acknowledgeCommand: (scope: string, ...commandIds: string[]) => void;
  mutate: DesktopMutation;
  publishConversation: (value: ConversationView | undefined) => void;
  agentCommandIds: ReturnType<typeof createAgentCommandIds>;
  trackConversationStream(controller: AbortController): () => void;
  refreshConversation: (
    projectID?: string | undefined,
    ticketID?: string | undefined,
  ) => Promise<void>;
  selectedTicketID: SourceAccessor<string | undefined>;
  setSelectedTicketID: Setter<string | undefined>;
  refreshTicketDetail: ReadTicketDetail;
  setError: Setter<string>;
  setPendingInterviewAnswer: Setter<{ key: string; questionID: string; text: string } | undefined>;
  pendingInterviewAnswer: SourceAccessor<
    { key: string; questionID: string; text: string } | undefined
  >;
}

export function createConversationCommands(dependencies: ConversationCommandsDependencies) {
  async function sendConversationMessage(event: SubmitEvent) {
    event.preventDefault();
    if (dependencies.assistantContextLoading()) return;
    if (dependencies.assistantPending()) return;
    if (dependencies.canPromptBuild()) {
      await dependencies.promptAgent(event);
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    const text = input ? readAttachmentContent(input).trim() : "";
    if (!text) return;
    await sendProjectMessage(text, form);
  }

  async function beginRequirementsInterview(intent: PlanningIntent = "requirements-interview") {
    const projectID = dependencies.selectedProjectID();
    const ticketID = dependencies.assistantTicketID();
    if (!projectID || !ticketID || dependencies.detail()?.ticket.id !== ticketID) return;
    dependencies.setAgentOpen(true);
    if (dependencies.assistantPending()) return;
    dependencies.pauseClarification(false);
    if (!dependencies.assistantTicketID() || dependencies.assistantPending()) return;
    if (dependencies.pendingInterview() && intent !== "technical-planning") return;
    dependencies.clarificationOrigins.add(dependencies.assistantKey());
    const ticket = dependencies.detail()?.ticket;
    if (ticket && ticket.state !== "ready" && !dependencies.selectedChange()) {
      if (!(await dependencies.moveTicket(ticket, "ready"))) return;
    }
    // Moving the Ticket is planning only. Start this explicit request only if
    // the user is still in the same Project/Ticket after that acknowledgement.
    if (
      dependencies.selectedProjectID() !== projectID ||
      dependencies.assistantTicketID() !== ticketID
    )
      return;
    await sendProjectMessage(
      intent === "full-planning"
        ? "Plan this Ticket: clarify the product requirements first, then prepare the technical design after I confirm them."
        : intent === "technical-planning"
          ? "Prepare the technical design for the saved product specification. Research the existing code and include focused PlantUML diagrams when they help."
          : "Start a requirements interview for this Ticket.",
      undefined,
      intent,
    );
  }

  async function sendProjectMessage(text: string, form?: HTMLFormElement, intent?: PlanningIntent) {
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    const ticketID = dependencies.assistantTicketID();
    const contextID = dependencies.conversation()?.contextId ?? undefined;
    if (
      !intent &&
      dependencies.clarificationPaused() &&
      unansweredClarification(dependencies.conversation()?.entries ?? [])
    )
      intent = "project-research";
    const scope = dependencies.agentCommandScope("project-message");
    const streamKey = dependencies.assistantKey();
    let streamTurnId: string | undefined;
    const clearStreamedAnswer = () => dependencies.clearProvisionalAnswer(streamKey, streamTurnId);
    let commandId: string | undefined;
    const contextIsCurrent = () =>
      !dependencies.workspaceDisposed &&
      dependencies.selectedProjectID() === projectID &&
      dependencies.assistantTicketID() === ticketID &&
      (dependencies.conversation()?.contextId ?? undefined) === contextID;
    const clearSubmittedDraft = () => {
      if (commandId) dependencies.acknowledgeCommand(scope, commandId);
      if (
        form &&
        contextIsCurrent() &&
        (() => {
          const input = form.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
          return input && readAttachmentContent(input).trim() === text;
        })()
      )
        form.reset();
    };
    const result = await dependencies.mutate(
      async () => {
        if (!contextIsCurrent()) return;
        const mode = ticketID && dependencies.selectedChange() ? "investigate" : "plan";
        if (!contextID && dependencies.conversation()?.mode !== mode) {
          const contextualConversation = await serverCall(
            setConversationMode({
              data: [projectID, { ...(ticketID ? { ticketId: ticketID } : {}), mode }],
            }),
          );
          if (!contextIsCurrent()) return;
          dependencies.publishConversation(contextualConversation);
        }
        commandId = dependencies.agentCommandIds.forInput(
          scope,
          JSON.stringify({ projectID, ticketID, text, intent }),
          text,
        );
        const streamController = new AbortController();
        const detachStream = dependencies.trackConversationStream(streamController);
        const message = {
          ...(ticketID ? { ticketId: ticketID } : {}),
          text,
          commandId,
          ...(intent ? { intent } : {}),
          ...(contextID ? { contextId: contextID } : {}),
        };
        const value = await streamConversation(
          (signal) =>
            serverCall(
              commissionConversationMessage({ ...{ signal }, data: [projectID, message] }),
            ),
          { signal: streamController.signal },
          (event) => {
            if (dependencies.workspaceDisposed) return;
            if (event.type === "admitted") {
              streamTurnId = event.turnId;
              clearSubmittedDraft();
              if (contextIsCurrent()) void dependencies.refreshConversation().catch(() => {});
            } else if (event.type === "answer" && event.turnId === streamTurnId) {
              dependencies.publishProvisionalAnswer(streamKey, event.turnId, event.text);
            } else if (event.type === "complete") {
              clearStreamedAnswer();
            }
          },
        ).finally(detachStream);
        clearSubmittedDraft();
        if (!contextIsCurrent()) return;
        dependencies.publishConversation(value);
        if (value.ticketId) {
          if (value.ticketId !== dependencies.selectedTicketID())
            dependencies.setSelectedTicketID(value.ticketId);
          await dependencies.refreshTicketDetail(value.ticketId);
        }
      },
      contextIsCurrent,
      dependencies.assistantKey(),
    );
    clearStreamedAnswer();
    if (result.ok || !contextIsCurrent()) return;

    const refreshed = await serverCall(
      getConversation({
        data: [
          projectID,
          {
            ...(ticketID ? { ticketId: ticketID } : {}),
            ...(contextID ? { contextId: contextID } : {}),
          },
        ],
      }),
    ).catch(() => null);
    if (!refreshed || !contextIsCurrent()) return;
    dependencies.publishConversation(refreshed);
    const admitted =
      commandId &&
      refreshed.entries.some(
        (entry) => entry.kind === "user-message" && entry.payload["commandId"] === commandId,
      );
    if (!admitted) return;
    try {
      clearSubmittedDraft();
      dependencies.setError(
        "Your message was saved, but the Project Agent could not finish its response.",
      );
    } catch (cause) {
      dependencies.setError(
        cause instanceof Error ? cause.message : "Browser recovery is unavailable.",
      );
    }
  }

  async function answerInterview(
    event: SubmitEvent,
    questionEntryID: string,
    question: InterviewQuestion,
  ) {
    event.preventDefault();
    dependencies.clarificationOrigins.add(dependencies.assistantKey());
    if (dependencies.assistantPending()) return;
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    const ticketID = dependencies.assistantTicketID();
    const contextKey = dependencies.assistantKey();
    const contextID = dependencies.conversation()?.contextId ?? undefined;
    const contextIsCurrent = () =>
      dependencies.selectedProjectID() === projectID &&
      dependencies.assistantTicketID() === ticketID &&
      dependencies.assistantKey() === contextKey;
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const customInput = form.querySelector<HTMLTextAreaElement>('textarea[name="custom"]');
    const customText = customInput ? readAttachmentContent(customInput).trim() : "";
    const answer = {
      selectedOptionIds:
        question.type === "single-select" && customText ? [] : data.getAll("option").map(String),
      customText,
    };
    const scope = dependencies.agentCommandScope("project-answer", questionEntryID);
    const pendingAnswer = {
      key: dependencies.assistantKey(),
      questionID: questionEntryID,
      text: normalizeInterviewAnswer(question, answer).labels.join(", "),
    };
    dependencies.setPendingInterviewAnswer(pendingAnswer);
    try {
      await dependencies.mutate(
        async () => {
          const commandId = dependencies.agentCommandIds.forInput(
            scope,
            JSON.stringify({ projectID, ticketID, questionEntryID, answer }),
          );
          const value = await serverCall(
            answerConversationQuestion({
              data: [
                projectID,
                {
                  ...(ticketID ? { ticketId: ticketID } : {}),
                  questionEntryId: questionEntryID,
                  commandId,
                  answer,
                  ...(contextID ? { contextId: contextID } : {}),
                },
              ],
            }),
          );
          dependencies.acknowledgeCommand(scope, commandId);
          if (!contextIsCurrent()) return;
          dependencies.publishConversation(value);
          if (value.ticketId) {
            if (value.ticketId !== dependencies.selectedTicketID())
              dependencies.setSelectedTicketID(value.ticketId);
            await dependencies.refreshTicketDetail(value.ticketId);
          }
        },
        contextIsCurrent,
        dependencies.assistantKey(),
      );
    } finally {
      if (dependencies.pendingInterviewAnswer() === pendingAnswer)
        dependencies.setPendingInterviewAnswer(undefined);
    }
  }

  return {
    sendConversationMessage,
    beginRequirementsInterview,
    answerInterview,
  };
}
