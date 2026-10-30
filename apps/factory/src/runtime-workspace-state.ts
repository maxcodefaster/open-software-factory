import type { AppPreview, RuntimeAttempt } from "./api-contracts";
import { type WorkspaceTab, workspaceTabRuntimeURL } from "./workspace-tabs";

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
