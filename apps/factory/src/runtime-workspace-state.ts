import type { AppPreview, RuntimeAttempt } from "./api-contracts";
import { type WorkspaceTab, workspaceTabRuntimeURL } from "./workspace-tabs";

export function retryableMainPreview(attempt: RuntimeAttempt | undefined, projectID: string) {
  return Boolean(
    attempt?.projectId === projectID &&
      attempt.runtimeKind === "staging" &&
      attempt.currentStaging &&
      ["failed", "stopped"].includes(attempt.state),
  );
}

export function runtimeReconnecting(attempt: RuntimeAttempt | undefined) {
  return (
    attempt?.state === "starting" &&
    (attempt.failure === "parent connector reconnecting" ||
      attempt.failure === "child connector reconnecting")
  );
}

export function runtimeWorkspaceURL(
  tab: WorkspaceTab,
  projectID: string,
  attempts: readonly RuntimeAttempt[],
  attachedURL?: string,
  previews: readonly AppPreview[] = [],
  active = true,
) {
  if (!active && !attachedURL) return undefined;
  const attempt = attempts.find(
    (candidate) => candidate.id === tab.attemptID && candidate.projectId === projectID,
  );
  const projection = previews.find(
    (preview) =>
      preview.attemptID === tab.attemptID &&
      preview.projectID === projectID &&
      preview.channel === tab.appChannel,
  );
  // A confirmed failed restore has nothing to open. The panel explains and offers Start fresh.
  if (attempt?.restoreFailed) return undefined;
  const state = attempt?.state ?? projection?.state;
  const available =
    state &&
    (["ready", "pausing", "paused", "resuming"].includes(state) ||
      (runtimeReconnecting(attempt) && attachedURL === workspaceTabRuntimeURL(tab, true)));
  if (available && tab.view === "preview" && tab.appChannel && projection)
    return workspaceTabRuntimeURL(tab, true);
  if (!attempt) return undefined;
  const development = attempt.runtimeKind === "personal" || attempt.runtimeKind === "ticket";
  if (tab.view === "ide" && !development) return undefined;
  if (tab.view === "preview") {
    if (tab.appChannel ? !development || !attempt.workspaceId : attempt.runtimeKind !== "staging")
      return undefined;
  }
  const url = workspaceTabRuntimeURL(tab, true);
  const paused = ["pausing", "paused", "resuming"].includes(attempt.state);
  return attempt.state === "ready" ||
    paused ||
    (runtimeReconnecting(attempt) && attachedURL === url)
    ? url
    : undefined;
}

const runtimeStateLabels: Record<string, string> = {
  "create-intended": "Starting",
  starting: "Starting",
  ready: "Running",
  pausing: "Pausing",
  paused: "Paused",
  resuming: "Resuming",
  "stop-intended": "Stopping",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  "cleanup-failed": "Cleanup unconfirmed",
};

// Menu detail for a recorded compute state. Unknown states stay readable instead of raw.
export function runtimeStateLabel(state: string | undefined) {
  if (!state) return "Preparing";
  return runtimeStateLabels[state] ?? `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}
