import type { AgentView } from "./api-contracts";

export type AgentSnapshot = { changeID: string; view: AgentView };

export function createAgentReadFence() {
  let revision = 0;
  let read = 0;
  return {
    beginRead: () => ({ revision, read: ++read }),
    current: (token: { revision: number; read: number }) =>
      token.revision === revision && token.read === read,
    commandPublished: () => {
      revision++;
    },
  };
}

const agentStatusLabels = {
  idle: "Ready to build",
  starting: "Starting",
  working: "Working",
  waiting: "Needs input",
  stopped: "Stopped",
  failed: "Failed",
  committed: "Submitted for verification",
} satisfies Record<AgentView["state"], string>;

export function buildAgentStatus(view: AgentView) {
  if (view.stopPending) return "Stop unconfirmed";
  if (view.state === "stopped") return "Stopped";
  if (view.commitOperation)
    return view.commitOperation.lastError ? "Commit unconfirmed" : "Saving commit";
  if (view.state === "working" && !view.runtimeConnected) return "Reconnecting";
  return agentStatusLabels[view.state];
}

export function buildAgentHint(view: AgentView) {
  if (view.stopPending) return "Stop saved. Build waits for confirmation.";
  if (view.commitOperation)
    return view.commitOperation.lastError
      ? "Commit outcome unconfirmed. New Build waits for recovery."
      : "Saving source changes. New work waits for this commit.";
  if (view.state === "working")
    return view.runtimeConnected
      ? "Working in the Ticket Workspace"
      : "Connection interrupted. Waiting for the same Build. Work is not restarted.";
  if (view.state === "stopped" && !view.sessionAvailable)
    return "Stopped before Build started. Start implementation when ready.";
  if (view.state === "stopped") return "Stopped. Your next message resumes the session.";
  if (view.state === "committed")
    return "Source submitted. Verification and your review determine whether the Change is ready.";
  return agentStatusLabels[view.state];
}

export function buildAgentNeedsStart(view: AgentView) {
  return (
    view.state === "idle" ||
    view.state === "failed" ||
    (view.state === "stopped" && !view.sessionAvailable)
  );
}

export function buildAgentEmptyMessage(view: AgentView) {
  if (view.stopPending)
    return "Waiting for Stop confirmation. The admitted work will not be replayed.";
  if (view.commitOperation) return "Waiting for source submission to settle.";
  return {
    idle: "Ask about the Project, or start implementation of this approved Ticket.",
    starting: "Preparing implementation. Activity will appear here.",
    working: "Implementation activity will appear here.",
    waiting: "Review this turn's result before continuing.",
    failed: "Review the implementation issue above before retrying.",
    stopped: "Your source is retained. Resume implementation when ready.",
    committed: "Review the submitted changes, or describe a correction.",
  }[view.state];
}

export function retainAgentActivity(
  previous: AgentSnapshot | undefined,
  changeID: string,
  view: AgentView,
  historyRequested = true,
): AgentSnapshot {
  return {
    changeID,
    view: {
      ...view,
      messagesAvailable:
        !historyRequested && previous?.changeID === changeID
          ? previous.view.messagesAvailable
          : view.messagesAvailable,
      messages:
        (!historyRequested || !view.messagesAvailable) && previous?.changeID === changeID
          ? previous.view.messages
          : view.messages,
    },
  };
}
