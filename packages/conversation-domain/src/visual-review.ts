import { z } from "zod";

export const reviewRegion = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((r) => r.x + r.width <= 1.001 && r.y + r.height <= 1.001);

const annotationPosition = {
  page: z.string().min(1).max(4_096),
  region: reviewRegion.optional(),
  element: z.string().max(1_000).optional(),
};
export const annotationInput = z.discriminatedUnion("source", [
  z.strictObject({
    ...annotationPosition,
    source: z.literal("recording"),
    mediaId: z.uuid(),
    timestampMs: z.number().int().nonnegative(),
    recordingId: z.uuid().optional(),
  }),
  z
    .strictObject({
      ...annotationPosition,
      source: z.literal("preview"),
      mediaId: z.uuid().optional(),
      attemptId: z.uuid().optional(),
      documentId: z.uuid().optional(),
      selector: z.string().max(1_000).optional(),
      representation: z.enum(["original", "dom-reconstruction", "unavailable"]).optional(),
    })
    .refine((value) => Boolean(value.mediaId || value.attemptId), {
      message: "Preview feedback needs its Runtime Attempt, even without a context image",
    }),
]);
export const feedbackCreateInput = z.strictObject({
  commandId: z.uuid(),
  kind: z.enum(["comment", "thread"]),
  body: z.string().trim().min(1).max(2_000),
  annotation: annotationInput.optional(),
});
export const feedbackUpdateInput = z.strictObject({
  commandId: z.uuid(),
  feedbackId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  action: z.enum(["reply", "resolve", "reopen"]),
  body: z.string().trim().min(1).max(2_000).optional(),
});
export const feedbackDispatchInput = z.strictObject({
  commandId: z.uuid(),
  feedback: z.array(z.strictObject({ id: z.uuid(), version: z.number().int().positive() })).min(1),
});
export const feedbackSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["comment", "thread"]),
  state: z.enum(["open", "implemented", "resolved"]),
  version: z.number().int().positive(),
  authorId: z.string(),
  author: z.string(),
  commitSha: z.string(),
  annotation: annotationInput.nullable(),
  createdAt: z.string(),
  correctionState: z.enum(["pending", "running", "sent", "retry"]).nullish(),
  messages: z.array(
    z.object({
      id: z.uuid(),
      author: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type ReviewFeedback = z.infer<typeof feedbackSchema>;

// The UI has no per-item selection. This is the complete batch a person can
// explicitly commission, excluding notes and work already awaiting rechecking.
export function pendingReviewThreads(feedback: readonly ReviewFeedback[]) {
  return feedback.filter(
    (item) =>
      item.kind === "thread" &&
      item.state === "open" &&
      (!item.correctionState || ["pending", "retry"].includes(item.correctionState)),
  );
}
export const visualReviewSchema = z.object({
  feedback: z.array(feedbackSchema),
  readOnly: z.boolean().optional(),
  currentCommitSha: z.string().optional(),
  canSendCorrections: z.boolean().optional(),
  recordingCurrent: z.boolean().optional(),
  recordingEnabled: z.boolean(),
  recording: z
    .object({
      id: z.uuid(),
      state: z.enum(["intended", "recording", "complete", "unavailable", "deleted"]),
      commitSha: z.string(),
      durationMs: z.number().nonnegative().nullable(),
      reason: z.string().nullable(),
    })
    .nullable(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category: z.enum(["normal", "error", "boundary"]),
      observationKind: z.enum(["app", "source"]).nullish(),
      startedMs: z.number().nonnegative(),
      endedMs: z.number().nonnegative().nullable(),
      status: z.enum(["passed", "failed", "unverified"]).nullable(),
      expected: z.string().optional(),
      observed: z.string().nullable().optional(),
      hasRecordingPosition: z.boolean().optional(),
    }),
  ),
});
export type VisualReview = z.infer<typeof visualReviewSchema>;

export const feedbackToolCallInput = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("feedback_list"),
    arguments: z.strictObject({}),
  }),
  z.strictObject({
    name: z.literal("feedback_read"),
    arguments: z.strictObject({ feedbackId: z.uuid() }),
  }),
  z.strictObject({
    name: z.literal("feedback_implemented"),
    arguments: z.strictObject({ feedbackId: z.uuid() }),
  }),
]);
export const feedbackToolCatalogue = feedbackToolCallInput.options.map((option) => ({
  name: option.shape.name.value,
  description:
    option.shape.name.value === "feedback_list"
      ? "List the complete, explicitly admitted revision batch. Read each Thread before making changes."
      : option.shape.name.value === "feedback_read"
        ? "Read a Thread in this revision batch, including its discussion and original saved frame."
        : "Mark a Thread in this revision batch implemented, awaiting human recheck. This does not resolve it or permit Delivery.",
  inputSchema: z.toJSONSchema(option.shape.arguments, { target: "draft-7", io: "input" }),
}));
