import { z } from "zod";
import {
  feedbackCreateInput,
  feedbackDispatchInput,
  feedbackUpdateInput,
  type ReviewFeedback,
  type reviewRegion,
  type VisualReview,
} from "#conversation-domain/visual-review";
import { reviewTime } from "./playback";

export const pendingCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("feedback"), input: feedbackCreateInput }),
  z.strictObject({ action: z.literal("update"), input: feedbackUpdateInput }),
  z.strictObject({ action: z.literal("send"), input: feedbackDispatchInput }),
]);

export type PendingReviewCommand = z.infer<typeof pendingCommand>;

export type PanelReviewCapture = {
  id: string;
  frame?: Blob;
  documentId?: string;
  selector?: string;
  context:
    | { source: "recording"; recordingId: string; timestampMs: number }
    | { source: "preview"; attemptId: string; representation?: "dom-reconstruction" };
  page: string;
  element?: string;
  timestampMs?: number;
  region?: z.infer<typeof reviewRegion>;
};

export type RetainedReviewView = {
  body: string;
  kind: "comment" | "thread";
  capture?: PanelReviewCapture | undefined;
  time: number;
  recordingID?: string;
  scenario: string;
  composing: boolean;
  marking: boolean;
  position: { x: number; y: number };
  replies: Record<string, string>;
};

export type RestoredPendingCommand =
  | { status: "none" }
  | { status: "ok"; command: PendingReviewCommand }
  | { status: "corrupt" };

// Navigation state only. Preserve a draft and playhead when the Ticket view
// unmounts to show another Factory tab; it never admits work or changes provenance.
const retainedReviewViews = new Map<string, RetainedReviewView>();

export function getRetainedReviewView(key: string): RetainedReviewView | undefined {
  return retainedReviewViews.get(key);
}

export function saveRetainedReviewView(key: string, value: RetainedReviewView): void {
  retainedReviewViews.set(key, value);
}

export function reviewCommandKey(userID: string, changeID: string): string {
  return `factory:visual-review:${userID}:${changeID}:command`;
}

export function reviewViewKey(
  userID: string,
  changeID: string,
  compact: boolean,
  viewID: string | undefined,
): string {
  return `${userID}:${changeID}:${compact ? (viewID ?? "preview") : "ticket"}`;
}

export function restorePendingCommand(key: string): RestoredPendingCommand {
  try {
    const stored = sessionStorage.getItem(key);
    if (!stored) return { status: "none" };
    return { status: "ok", command: pendingCommand.parse(JSON.parse(stored)) };
  } catch {
    return { status: "corrupt" };
  }
}

export function hasConflictingStoredCommand(
  key: string,
  current: PendingReviewCommand | undefined,
): boolean {
  const stored = sessionStorage.getItem(key);
  return Boolean(stored && (!current || stored !== JSON.stringify(current)));
}

export function matchesPendingCommand(
  current: PendingReviewCommand,
  action: string,
  input: unknown,
): boolean {
  return current.action === action && JSON.stringify(current.input) === JSON.stringify(input);
}

export function persistPendingCommand(key: string, command: PendingReviewCommand): void {
  sessionStorage.setItem(key, JSON.stringify(command));
}

export function clearPendingCommand(key: string): void {
  sessionStorage.removeItem(key);
}

export function countOpenThreads(feedback: readonly ReviewFeedback[]): number {
  return feedback.filter((item) => item.kind === "thread" && item.state !== "resolved").length;
}

export function composerSourceLabel(capture: PanelReviewCapture | undefined): string | undefined {
  if (!capture) return undefined;
  return capture.context.source === "recording"
    ? `Video · ${reviewTime((capture.timestampMs ?? 0) / 1000, true)}`
    : (capture.element ?? capture.page);
}

export function buildFeedbackAnnotation(
  frozen: PanelReviewCapture,
  media: { id: string; page?: string | undefined } | undefined,
): Record<string, unknown> {
  return {
    source: frozen.context.source,
    ...(media ? { mediaId: media.id } : {}),
    page: media?.page ?? frozen.page,
    ...(frozen.context.source === "preview"
      ? {
          attemptId: frozen.context.attemptId,
          ...(frozen.documentId ? { documentId: frozen.documentId } : {}),
          ...(frozen.selector ? { selector: frozen.selector } : {}),
        }
      : {}),
    ...(frozen.region ? { region: frozen.region } : {}),
    ...(frozen.element ? { element: frozen.element } : {}),
    ...(frozen.timestampMs !== undefined ? { timestampMs: frozen.timestampMs } : {}),
  };
}

export function isFeedbackSeekable(item: ReviewFeedback, view: VisualReview | undefined): boolean {
  const annotation = item.annotation;
  return (
    annotation?.source === "recording" &&
    annotation.recordingId === view?.recording?.id &&
    view?.recording?.state === "complete"
  );
}

export function buildWebVttCaptions(
  scenarios: VisualReview["scenarios"],
  durationMs: number,
): string {
  const time = (milliseconds: number) => {
    const total = Math.max(0, Math.round(milliseconds));
    return `${String(Math.floor(total / 3_600_000)).padStart(2, "0")}:${String(Math.floor(total / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(total / 1_000) % 60).padStart(2, "0")}.${String(total % 1_000).padStart(3, "0")}`;
  };
  const text = (input: string) =>
    input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\n\n", "\n");
  const cues = scenarios
    .filter(
      (scenario) =>
        scenario.observationKind !== "source" && scenario.hasRecordingPosition !== false,
    )
    .map(
      (scenario) =>
        `${time(scenario.startedMs)} --> ${time(Math.max(scenario.startedMs + 1, scenario.endedMs ?? durationMs))}\n${text([scenario.title, scenario.expected ? `Expected: ${scenario.expected}` : "", scenario.observed ? `Observed: ${scenario.observed}` : ""].filter(Boolean).join("\n"))}`,
    );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

export function shouldPreservePausedScenario(
  selected: VisualReview["scenarios"][number] | undefined,
  currentTimeSeconds: number,
): boolean {
  if (!selected) return false;
  return (
    selected.observationKind === "source" ||
    selected.hasRecordingPosition === false ||
    // Unchanged checks can share a compact frame. Keep the chosen paused
    // result at that boundary, rather than replacing it with the last one.
    Math.abs(selected.startedMs - currentTimeSeconds * 1000) <= 50
  );
}

export function calculateComposerPosition(
  outer: DOMRect | undefined,
  rect: DOMRect,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: Math.max(
      12,
      Math.min((outer?.width ?? 340) - 326, rect.x - (outer?.x ?? 0) + x * rect.width + 14),
    ),
    y: Math.max(
      12,
      rect.y - (outer?.y ?? 0) + Math.min(y * rect.height, Math.max(12, rect.height - 280)),
    ),
  };
}

export function calculateAddFeedbackPosition(surfaceWidth: number | undefined): {
  x: number;
  y: number;
} {
  return {
    x: Math.max(12, (surfaceWidth ?? 340) - 326),
    y: 12,
  };
}

export function recordingEmptyMessage(recording: VisualReview["recording"] | undefined): string {
  if (recording?.state === "deleted")
    return "This QA video was removed. Original comment frames and feedback remain.";
  if (["recording", "intended"].includes(recording?.state ?? ""))
    return "Recording the current QA flow. The video becomes available when capture finishes.";
  return recording?.reason ?? "No complete QA recording yet.";
}

export function scenarioStatusLabel(status: VisualReview["scenarios"][number]["status"]): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "unverified") return "Unverified";
  return "Unfinished";
}
