import type { AgentView } from "./api-contracts";

export type AgentSnapshot = { changeID: string; view: AgentView };

const agentStatusLabels = {
  idle: "Ready to build",
  starting: "Starting",
  working: "Working",
  waiting: "Needs input",
  stopped: "Stopped",
  failed: "Failed",
  committed: "Complete",
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
      : "Saving completed Build. New work waits for this commit.";
  if (view.state === "working")
    return view.runtimeConnected
      ? "Working in the Ticket Workspace"
      : "Connection interrupted. Waiting for the same Build. Work is not restarted.";
  if (view.state === "stopped" && !view.sessionAvailable)
    return "Stopped before Build started. Start implementation when ready.";
  if (view.state === "stopped") return "Stopped. Your next message resumes the session.";
  return agentStatusLabels[view.state];
}

export function buildAgentNeedsStart(view: AgentView) {
  return (
    view.state === "idle" ||
    view.state === "failed" ||
    (view.state === "stopped" && !view.sessionAvailable)
  );
}

export function retainAgentActivity(
  previous: AgentSnapshot | undefined,
  changeID: string,
  view: AgentView,
): AgentSnapshot {
  return {
    changeID,
    view: {
      ...view,
      messages:
        !view.messagesAvailable && previous?.changeID === changeID
          ? previous.view.messages
          : view.messages,
    },
  };
}
