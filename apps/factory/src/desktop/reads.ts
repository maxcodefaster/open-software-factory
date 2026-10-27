import type { Accessor, Setter, SourceAccessor } from "solid-js";
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { observeAgentActivity } from "../agent-activity-stream";
import type {
  AgentView,
  AppPreview,
  Change,
  ConversationView,
  DeliveryView,
  RuntimeAttempt,
} from "../api-contracts";
import type { createKnowledgeState } from "../knowledge/state";
import { unavailableLink } from "../navigation/desktop";
import { getAgentView } from "../server-functions/agent";
import { getConversation } from "../server-functions/conversations";
import { getDelivery } from "../server-functions/delivery";
import { serverCall } from "../server-functions/result";
import { getChanges, getProjectPreviews, getRuntimeAttempts } from "../server-functions/runtime";
import { getTicketDetail } from "../server-functions/tickets";
import type { createWorkspaceState } from "../workspace/state";
import type { WorkspaceTab } from "../workspace-tabs";
import { createInvalidatedRead } from "../zero/invalidated-read";
import { observeFactoryRead } from "../zero/reads";
import type { TicketDetail } from "./contracts";
import type { createConversationState } from "./conversation-state";

interface DesktopReadsDependencies {
  selectedProjectID: SourceAccessor<string | undefined>;
  setChanges: Setter<Change[]>;
  setAttempts: Setter<RuntimeAttempt[]>;
  setAppPreviews: Setter<AppPreview[]>;
  workspaces: ReturnType<typeof createWorkspaceState>;
  setLifecycleProjectID: Setter<string | undefined>;
  detail: Accessor<TicketDetail | undefined>;
  selectedTicketID: SourceAccessor<string | undefined>;
  selectedChange: Accessor<Change | undefined>;
  agentOpen: SourceAccessor<boolean>;
  agentReadFence: {
    beginRead: () => { revision: number; read: number };
    current: (token: { revision: number; read: number }) => boolean;
    commandPublished: () => void;
  };
  publishAgentView: (
    changeID: string,
    view: AgentView,
    read?: { revision: number; read: number },
    historyRequested?: boolean,
  ) => void;
  setDelivery: Setter<DeliveryView | undefined>;
  resetAgentView: () => void;
  setSyncError: Setter<string>;
  assistantTicketID: () => string | undefined;
  workspaceTabs: () => WorkspaceTab[];
  refreshKnowledge: ReturnType<typeof createKnowledgeState>["refresh"];
  agentActivityRevision: SourceAccessor<number>;
  setAgent: Setter<AgentView>;
  ticketReadGeneration: number;
  workspaceDisposed: boolean;
  setDetail: Setter<TicketDetail | undefined>;
  conversationReadFence: Pick<
    ReturnType<typeof createConversationState>,
    "beginRead" | "currentRead"
  >;
  selectedConversation: () => string | undefined;
  setConversation: (value: ConversationView | undefined) => void;
  acknowledgeConversation: (value: ConversationView) => void;
  setError: Setter<string>;
  publishConversation: (value: ConversationView | undefined) => void;
}

export function createDesktopReads(dependencies: DesktopReadsDependencies) {
  async function readLifecycleState(signal: AbortSignal) {
    const projectID = dependencies.selectedProjectID();
    if (!projectID) return;
    const [changeBody, attemptBody, previewBody] = await Promise.all([
      serverCall(getChanges({ ...{ signal }, data: [projectID] })),
      serverCall(getRuntimeAttempts({ ...{ signal }, data: [projectID] })),
      serverCall(getProjectPreviews({ ...{ signal }, data: [projectID] })),
    ]);
    if (dependencies.selectedProjectID() !== projectID) return;
    dependencies.setChanges(changeBody.changes);
    dependencies.setAttempts(attemptBody.attempts);
    dependencies.setAppPreviews(previewBody.previews);
    const staging = attemptBody.attempts.find(
      (attempt) =>
        attempt.projectId === projectID &&
        attempt.runtimeKind === "staging" &&
        attempt.currentStaging &&
        attempt.state === "ready",
    );
    dependencies.workspaces.followStaging(projectID, staging?.id);
    dependencies.setLifecycleProjectID(projectID);
    if (
      dependencies.detail()?.ticket.trashedAt &&
      dependencies.detail()?.ticket.id === dependencies.selectedTicketID()
    ) {
      await refreshTicketDetail();
    }
    const changeID = dependencies.selectedChange()?.id;
    if (changeID) {
      const observeStatus = !dependencies.agentOpen();
      const read = observeStatus ? dependencies.agentReadFence.beginRead() : undefined;
      const [agentView, deliveryView] = await Promise.all([
        observeStatus
          ? serverCall(getAgentView({ ...{ signal }, data: [changeID, false] }))
          : Promise.resolve(undefined),
        serverCall(getDelivery({ ...{ signal }, data: [changeID] })),
      ]);
      if (dependencies.selectedChange()?.id !== changeID) return;
      if (agentView && read && dependencies.agentReadFence.current(read)) {
        dependencies.publishAgentView(changeID, agentView, read, false);
      }
      dependencies.setDelivery(deliveryView);
    } else if (!changeID) {
      dependencies.resetAgentView();
      dependencies.setDelivery(undefined);
    }
  }

  const lifecycleRead = createInvalidatedRead({
    read: async (signal) => {
      await readLifecycleState(signal);
      dependencies.setSyncError("");
    },
    visible: () => !document.hidden,
    onError: (cause) =>
      dependencies.setSyncError(
        cause instanceof Error ? cause.message : "Factory updates are unavailable",
      ),
  });

  const refreshLifecycleState = lifecycleRead.refresh;

  onCleanup(lifecycleRead.stop);

  observeFactoryRead(
    () => {
      const projectId = dependencies.selectedProjectID();
      return projectId ? { projectId, scope: "lifecycle", resourceId: projectId } : null;
    },
    () => refreshLifecycleState(),
  );

  observeFactoryRead(
    () => {
      const projectId = dependencies.selectedProjectID(),
        resourceId = dependencies.selectedTicketID();
      return projectId && resourceId ? { projectId, scope: "ticket", resourceId } : null;
    },
    async () => {
      await refreshTicketDetail();
    },
    (cause) =>
      dependencies.setSyncError(
        cause instanceof Error ? cause.message : "Ticket updates are unavailable",
      ),
  );

  observeFactoryRead(
    () => {
      const projectId = dependencies.selectedProjectID();
      return projectId && dependencies.agentOpen()
        ? {
            projectId,
            scope: "conversation",
            resourceId: dependencies.assistantTicketID() ?? projectId,
          }
        : null;
    },
    () => refreshConversation(),
    (cause) =>
      dependencies.setSyncError(
        cause instanceof Error ? cause.message : "Conversation updates are unavailable",
      ),
  );

  observeFactoryRead(
    () => {
      const projectId = dependencies.selectedProjectID();
      return projectId && dependencies.workspaceTabs().some((tab) => tab.view === "knowledge")
        ? { projectId, scope: "knowledge", resourceId: projectId }
        : null;
    },
    (signal) => dependencies.refreshKnowledge(signal),
    (cause) =>
      dependencies.setSyncError(
        cause instanceof Error ? cause.message : "Wiki updates are unavailable",
      ),
  );

  const agentActivityTarget = createMemo(() =>
    dependencies.agentOpen() && dependencies.selectedChange()?.id
      ? `${dependencies.selectedChange()?.id}:${dependencies.agentActivityRevision()}`
      : "",
  );

  createEffect(
    () => agentActivityTarget(),
    (target) => {
      const changeID = target.split(":")[0];
      if (!changeID) return;
      const observedChangeID = changeID;
      const controller = new AbortController();
      let detach: (() => void) | undefined;
      function synchronize() {
        detach?.();
        detach = undefined;
        if (document.hidden || controller.signal.aborted) return;
        const read = dependencies.agentReadFence.beginRead();
        detach = observeAgentActivity({
          changeID: observedChangeID,
          signal: controller.signal,
          snapshot: (view) => {
            if (dependencies.selectedChange()?.id === changeID && dependencies.agentOpen())
              dependencies.publishAgentView(observedChangeID, view, read);
          },
          disconnected: () => {
            if (
              dependencies.selectedChange()?.id === changeID &&
              dependencies.agentReadFence.current(read)
            )
              dependencies.setAgent((view) => ({ ...view, messagesAvailable: false }));
          },
        });
      }
      synchronize();
      document.addEventListener("visibilitychange", synchronize);
      return () => {
        controller.abort();
        detach?.();
        document.removeEventListener("visibilitychange", synchronize);
      };
    },
  );

  async function refreshTicketDetail(ticketID = dependencies.selectedTicketID()) {
    const generation = ++dependencies.ticketReadGeneration;
    const projectID = dependencies.selectedProjectID();
    if (ticketID) {
      const body = await serverCall(getTicketDetail({ data: [ticketID] }));
      if (
        dependencies.workspaceDisposed ||
        dependencies.selectedProjectID() !== projectID ||
        dependencies.selectedTicketID() !== ticketID ||
        (dependencies.detail()?.ticket.id === ticketID &&
          body.ticket.version < (dependencies.detail()?.ticket.version ?? 0))
      )
        return;
      if (body.ticket.projectId !== projectID) throw new Error(unavailableLink);
      if (generation === dependencies.ticketReadGeneration) dependencies.setDetail(body);
      return body;
    }
  }

  async function refreshConversation(
    projectID = dependencies.selectedProjectID(),
    ticketID = dependencies.assistantTicketID(),
  ) {
    const generation = dependencies.conversationReadFence.beginRead();
    const selection = dependencies.selectedConversation();
    if (!projectID) {
      dependencies.setConversation(undefined);
      return;
    }
    const value = await serverCall(
      getConversation({
        data: [
          projectID,
          {
            ...(ticketID ? { ticketId: ticketID } : {}),
            ...(selection ? { contextId: selection } : {}),
          },
        ],
      }),
    );
    if (
      dependencies.workspaceDisposed ||
      !dependencies.conversationReadFence.currentRead(generation) ||
      dependencies.selectedProjectID() !== projectID ||
      dependencies.assistantTicketID() !== ticketID ||
      dependencies.selectedConversation() !== selection
    )
      return;
    try {
      if (value) dependencies.acknowledgeConversation(value);
    } catch (cause) {
      dependencies.setError(
        cause instanceof Error ? cause.message : "Browser recovery is unavailable.",
      );
    }
    dependencies.publishConversation(value ?? undefined);
  }

  async function refreshServerState() {
    await Promise.all([refreshLifecycleState(), refreshTicketDetail(), refreshConversation()]);
  }

  const observedContext = createMemo(() =>
    JSON.stringify([
      dependencies.selectedProjectID(),
      dependencies.agentOpen(),
      dependencies.selectedChange()?.id,
      dependencies.selectedConversation(),
    ]),
  );

  createEffect(observedContext, () => {
    // observedContext defines the subscription; refresh is a scoped read action.
    void untrack(refreshServerState).catch((cause) =>
      dependencies.setSyncError(
        cause instanceof Error ? cause.message : "Shared updates could not load",
      ),
    );
  });

  return { refreshConversation, refreshTicketDetail, refreshServerState, refreshLifecycleState };
}
