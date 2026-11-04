import type { AppPreview, RuntimeAttempt } from "./api-contracts";

export type PreviewStatusInput = {
  attempt?: Pick<RuntimeAttempt, "state" | "failure" | "computeWait"> | undefined;
  app?: Pick<AppPreview, "label" | "port" | "process" | "state"> | undefined;
  // Time in the current wait, in milliseconds.
  waited: number;
  phase: "loading" | "failed";
  // Factory's own proxy answered 502/503/504 for the first document.
  unreachable?: boolean;
  delayedAfter?: number;
};

export type PreviewStatus = { headline: string; detail?: string; cause?: string };

const starting = ["create-intended", "starting"];
const asleep = ["pausing", "paused", "resuming"];

export const restoreUnknownHeadline = "Restoring the paused Sandbox could not be confirmed.";
export const restoreUnknownDetail =
  "Factory has not confirmed whether it restored, so it keeps the paused Sandbox untouched. Your files are unchanged.";
export const restoreFailedHeadline = "The paused Sandbox could not be restored.";
export const restoreFailedDetail =
  "Your files are unchanged. Start fresh to continue; the paused memory and private container data are discarded.";

// Native restore and build failures can carry whole log excerpts and host paths.
// Show the recorded cause up to a readable bound; the full text stays in the record.
export function boundedCause(cause: string, limit = 240) {
  const text = cause.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 40))}…`;
}

function appName(app: PreviewStatusInput["app"]) {
  return app?.port ? `the App on port ${app.port}` : "the App";
}

export function appProcessCause(process: AppPreview["process"]) {
  if (!process) return undefined;
  if (process.state === "failed" || process.state === "stopped")
    return process.exitCode === undefined
      ? "The App process is not running."
      : `The App process exited with code ${process.exitCode}.`;
  return undefined;
}

// Names only what Factory recorded. A page the App itself serves, including its
// own 5xx page, is the App's answer and never a Factory failure.
export function previewStatus(input: PreviewStatusInput): PreviewStatus {
  const delayedAfter = input.delayedAfter ?? 30_000;
  const { attempt, app } = input;
  const processCause = appProcessCause(app?.process);
  if (input.phase === "failed") {
    const cause =
      processCause ??
      (attempt?.failure
        ? boundedCause(attempt.failure)
        : attempt && starting.includes(attempt.state)
          ? "Compute is still starting."
          : input.unreachable
            ? `Factory could not get an answer from ${appName(app)}. It may still be starting, or its health check may be failing.`
            : "Factory refused the Preview request. Reload the view; if it persists, reopen the Preview.");
    // An unknown restore outcome stays untouched: reloading cannot settle it.
    if (attempt?.state === "resuming" && attempt.failure)
      return {
        headline: "Could not open Preview.",
        cause,
        detail:
          "Factory has not confirmed whether the paused Sandbox restored, so it keeps it untouched. Your files are unchanged.",
      };
    return { headline: "Could not open Preview.", cause, detail: "Retry with Reload view." };
  }
  if (attempt?.computeWait)
    return {
      headline:
        "Waiting for execution capacity. The Preview starts automatically when space is available.",
    };
  if (attempt && starting.includes(attempt.state))
    return {
      headline: "Starting compute for the Preview…",
      detail: "Factory opens the Preview as soon as the App is reachable.",
    };
  // Opening a paused Workspace resumes it. Its App has not been asked yet.
  if (attempt && asleep.includes(attempt.state))
    return {
      headline: "Resuming compute for the Preview…",
      detail: "Factory opens the Preview as soon as the App is reachable.",
    };
  if (processCause)
    return {
      headline: app?.port ? `Waiting for the App on port ${app.port}…` : "Waiting for the App…",
      cause: processCause,
    };
  if (input.waited >= delayedAfter)
    return {
      headline: app?.port
        ? `The App on port ${app.port} has not answered yet. You can keep waiting.`
        : "Preview is taking longer to open. You can keep waiting.",
      detail: "Factory keeps waiting. Reload the view to try again.",
    };
  if (!app?.port) return { headline: "Opening Preview…" };
  return {
    headline: `Waiting for the App on port ${app.port}…`,
    detail: "Compute is running. Waiting for the App to answer.",
  };
}

export function appResponseNotice(status: number | undefined, app: PreviewStatusInput["app"]) {
  if (!status || status < 500) return undefined;
  return `The App${app?.port ? ` on port ${app.port}` : ""} answered HTTP ${status}. This is the App's own response, so Factory reached it. Check the App's process output or restart it from the IDE.`;
}
