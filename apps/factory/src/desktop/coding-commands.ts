import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { z } from "zod";
import type { ConversationMode } from "../../../../packages/conversation-domain/src/conversation";
import type { createAgentCommandIds } from "../agent-command-ids";
import type { AgentView, Change, ConversationView, DeliveryView } from "../api-contracts";
import { readAttachmentContent } from "../attachments/composer";
import {
  checkCodingStop,
  getAgentView,
  newCodingConversation,
  requestCodingChanges,
  resumeCoding as requestCodingResume,
  sendCodingPrompt,
  startCoding,
  stopCoding,
} from "../server-functions/agent";
import { newProjectConversation, setConversationMode } from "../server-functions/conversations";
import { serverCall } from "../server-functions/result";
import type { DesktopMutation } from "./contracts";

interface CodingCommandsDependencies {
  assistantContextLoading: () => boolean;
  selectedProjectID: SourceAccessor<string | undefined>;
  assistantTicketID: () => string | undefined;
  selectedChange: Accessor<Change | undefined>;
  assistantKey: () => string;
  agentCommandScope: (
    kind: string,
    identity?: string | null | undefined,
    projectID?: string | undefined,
  ) => string;
  mutate: DesktopMutation;
  agentCommandIds: ReturnType<typeof createAgentCommandIds>;
  conversation: Accessor<ConversationView | undefined>;
  acknowledgeCommand: (scope: string, ...commandIds: string[]) => void;
  setConversationSelections: Setter<Record<string, string>>;
  conversationScope: () => string;
  refreshServerState: () => Promise<void>;
  publishConversation: (value: ConversationView | undefined) => void;
  codingWriterBlocked: () => boolean;
  setError: Setter<string>;
  agent: Accessor<AgentView>;
  chosenCodingReasoning: () => "max" | "medium" | "high" | "xhigh" | undefined;
  publishAgentView: (
    changeID: string,
    view: AgentView,
    read?: ReturnType<() => { revision: number; read: number }>,
    historyRequested?: boolean,
  ) => void;
  refreshLifecycleState: () => Promise<void>;
  delivery: Accessor<DeliveryView | undefined>;
  retryReview: (changeID: string) => Promise<void>;
  selectedTicketID: SourceAccessor<string | undefined>;
  selectedConversation: () => string | undefined;
  conversationMode: () => ConversationMode;
  setConversation: (value: ConversationView | undefined) => void;
  agentReadFence: {
    beginRead: () => { revision: number; read: number };
    current: (token: { revision: number; read: number }) => boolean;
    commandPublished: () => void;
  };
  historicalCoding: () => boolean;
  correctionTarget: SourceAccessor<string | undefined>;
}

export function createCodingCommands(dependencies: CodingCommandsDependencies) {
  async function newConversation(coding: boolean) {
    if (dependencies.assistantContextLoading()) return;
    const projectID = dependencies.selectedProjectID();
    const ticketID = dependencies.assistantTicketID();
    const changeID = dependencies.selectedChange()?.id;
    const key = dependencies.assistantKey();
    const scope = dependencies.agentCommandScope(
      coding ? "new-coding-conversation" : "new-conversation",
    );
    if (!projectID || (coding && !changeID)) return;
    await dependencies.mutate(async () => {
      const previous = dependencies.agentCommandIds.latest(scope);
      const retained = previous
        ? z
            .object({
              projectID: z.uuid(),
              ticketID: z.uuid().optional(),
              contextId: z.uuid().nullable(),
            })
            .parse(JSON.parse(previous.input))
        : undefined;
      if (retained && (retained.projectID !== projectID || retained.ticketID !== ticketID))
        throw new Error("Recover the existing conversation request before creating another one.");
      const contextId = retained
        ? retained.contextId
        : (dependencies.conversation()?.activeCodingContextId ?? null);
      const commandId =
        previous?.commandId ??
        dependencies.agentCommandIds.forInput(
          scope,
          JSON.stringify({ projectID, ticketID, contextId }),
        );
      if (coding && changeID) {
        const result = await serverCall(
          newCodingConversation({ data: [changeID, { commandId, contextId }] }),
        );
        dependencies.acknowledgeCommand(scope, commandId);
        if (dependencies.assistantKey() !== key) return;
        dependencies.setConversationSelections((previous) => ({
          ...previous,
          [dependencies.conversationScope()]: result.contextId,
        }));
        await dependencies.refreshServerState();
      } else {
        const result = await serverCall(
          newProjectConversation({
            data: [
              projectID,
              {
                commandId,
                ...(ticketID ? { ticketId: ticketID } : {}),
              },
            ],
          }),
        );
        dependencies.acknowledgeCommand(scope, commandId);
        if (dependencies.assistantKey() !== key) return;
        dependencies.setConversationSelections((previous) => ({
          ...previous,
          [dependencies.conversationScope()]: result.contextId ?? "original",
        }));
        dependencies.publishConversation(result);
      }
    });
  }

  async function startAgent() {
    if (dependencies.assistantContextLoading()) return;
    const change = dependencies.selectedChange();
    if (!change) return;
    if (dependencies.codingWriterBlocked()) {
      dependencies.setError(
        "Request editing or wait for release before starting Coding. Your draft is retained.",
      );
      return;
    }
    const scope = dependencies.agentCommandScope("change-start", change.id);
    await dependencies.mutate(async () => {
      if (!(await prepareBuildConversation(change.id))) return;
      const codingReasoning = dependencies.agent().turn
        ? undefined
        : dependencies.chosenCodingReasoning();
      const contextId = dependencies.conversation()?.contextId;
      const input = {
        ...(codingReasoning ? { codingReasoning } : {}),
        ...(contextId ? { contextId } : {}),
      };
      const commandId = dependencies.agentCommandIds.forInput(
        scope,
        codingReasoning ? JSON.stringify({ changeID: change.id, ...input }) : change.id,
      );
      const value = await serverCall(startCoding({ data: [change.id, { commandId, ...input }] }));
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedChange()?.id === change.id)
        dependencies.publishAgentView(change.id, value);
      await dependencies.refreshLifecycleState();
    });
  }

  async function resumeCoding() {
    const change = dependencies.selectedChange(),
      pause = dependencies.agent().codingPause;
    if (!change || !pause) return;
    if (
      dependencies.agent().turn?.id === pause.turnID &&
      dependencies.agent().turn?.purpose === "review" &&
      dependencies.agent().turn?.state === "failed" &&
      dependencies.delivery()?.reviewId
    )
      return dependencies.retryReview(change.id);
    const scope = `coding-resume:${change.id}:${pause.turnID}`;
    await dependencies.mutate(async () => {
      const commandId = dependencies.agentCommandIds.forInput(scope, pause.turnID);
      const result = await serverCall(
        requestCodingResume({ data: [change.id, { commandId, pausedTurnId: pause.turnID }] }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (dependencies.selectedChange()?.id === change.id)
        dependencies.publishAgentView(change.id, result);
      await dependencies.refreshLifecycleState();
    });
  }

  async function prepareBuildConversation(changeID: string) {
    const projectID = dependencies.selectedProjectID();
    const ticketID = dependencies.selectedTicketID();
    const selected = dependencies.selectedConversation();
    const current = () =>
      dependencies.selectedProjectID() === projectID &&
      dependencies.selectedTicketID() === ticketID &&
      dependencies.selectedConversation() === selected &&
      dependencies.selectedChange()?.id === changeID &&
      dependencies.conversationMode() === "build";
    if (!projectID || !ticketID || !current()) return false;
    if (dependencies.conversation()?.mode !== "build") {
      const value = await serverCall(
        setConversationMode({ data: [projectID, { ticketId: ticketID, mode: "build" }] }),
      );
      if (!current()) return false;
      dependencies.setConversation(value);
    }
    return current();
  }

  async function stopAgent() {
    const change = dependencies.selectedChange();
    if (!change) return;
    await dependencies.mutate(async () => {
      const value = await serverCall(stopCoding({ data: [change.id] }));
      if (dependencies.selectedChange()?.id === change.id)
        dependencies.publishAgentView(change.id, value);
    });
  }

  async function checkStopStatus() {
    const change = dependencies.selectedChange();
    if (!change) return;
    const read = dependencies.agentReadFence.beginRead();
    await dependencies.mutate(async () => {
      const value = await serverCall(getAgentView({ data: [change.id] }));
      if (dependencies.selectedChange()?.id === change.id)
        dependencies.publishAgentView(change.id, value, read);
    });
  }

  async function recheckStopConfirmation() {
    const change = dependencies.selectedChange();
    const stopId = dependencies.agent().stopId;
    if (!change || !stopId) return;
    await dependencies.mutate(async () => {
      const value = await serverCall(checkCodingStop({ data: [change.id, { stopId }] }));
      if (dependencies.selectedChange()?.id === change.id)
        dependencies.publishAgentView(change.id, value);
    });
  }

  async function promptAgent(event: SubmitEvent) {
    event.preventDefault();
    if (dependencies.assistantContextLoading()) return;
    const change = dependencies.selectedChange();
    if (!change) return;
    if (dependencies.codingWriterBlocked()) {
      dependencies.setError(
        "Request editing or wait for release before sending Coding instructions. Your draft is retained.",
      );
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    const text = input ? readAttachmentContent(input).trim() : "";
    if (!text) return;
    const scope = dependencies.agentCommandScope("change-prompt", change.id);
    const contextId = dependencies.conversation()?.contextId ?? undefined;
    const targetKey = dependencies.assistantKey();
    await dependencies.mutate(async () => {
      if (!(await prepareBuildConversation(change.id))) return;
      if (dependencies.assistantKey() !== targetKey || dependencies.historicalCoding()) return;
      const commandId = dependencies.agentCommandIds.forInput(
        scope,
        JSON.stringify({ changeID: change.id, text }),
        text,
      );
      const action = dependencies.correctionTarget() === change.id ? "request-changes" : "prompt";
      const value = await serverCall(
        (action === "request-changes" ? requestCodingChanges : sendCodingPrompt)({
          data: [
            change.id,
            {
              commandId,
              text,
              ...(contextId ? { contextId } : {}),
            },
          ],
        }),
      );
      dependencies.acknowledgeCommand(scope, commandId);
      if (
        dependencies.selectedChange()?.id === change.id &&
        dependencies.assistantKey() === targetKey
      ) {
        dependencies.publishAgentView(change.id, value);
        // Pending disables the composer, so FormData omits its submitted value.
        const input = form.elements.namedItem("message") as HTMLTextAreaElement | null;
        if (input && readAttachmentContent(input).trim() === text) form.reset();
      }
    });
  }

  return {
    newConversation,
    startAgent,
    resumeCoding,
    stopAgent,
    checkStopStatus,
    recheckStopConfirmation,
    promptAgent,
  };
}
