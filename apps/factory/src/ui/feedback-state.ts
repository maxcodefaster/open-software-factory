export type FeedbackState = "idle" | "pending" | "success" | "error";
export type SaveFeedbackState = "idle" | "dirty" | "saving" | "saved" | "error";

export const feedbackAcknowledgementMs = 2_400;

export function copyFeedbackLabel(state: FeedbackState, label = "Copy") {
  return {
    idle: label,
    pending: "Copying…",
    success: "Copied",
    error: "Copy failed",
  }[state];
}

export function saveFeedback(state: SaveFeedbackState): {
  state: FeedbackState;
  message: string;
} {
  const messages = {
    idle: { state: "idle", message: "" },
    dirty: { state: "idle", message: "Changes will save automatically" },
    saving: { state: "pending", message: "Saving…" },
    saved: { state: "success", message: "Saved" },
    error: { state: "error", message: "Not saved. Your draft is retained." },
  } satisfies Record<SaveFeedbackState, { state: FeedbackState; message: string }>;
  return messages[state];
}
