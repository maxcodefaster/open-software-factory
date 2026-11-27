import { z } from "zod";
import { candidateReviewResultInput } from "#conversation-domain/candidate-review";
import { optionalEnum, optionalString } from "../optional-values";

export const deliveryViewSchema = z.object({
  deliveryPolicyId: optionalString,
  monitoringIncidentId: optionalString,
  monitoringState: optionalString,
  monitoringReason: optionalString,
  monitoringPolicyId: optionalString,
  openReviewThreads: z.number().int().nonnegative().optional(),
  verificationId: optionalString,
  checksStopId: optionalString,
  checksRetryAttemptId: optionalString,
  reviewId: optionalString,
  reviewState: optionalString,
  reviewCurrent: z.boolean().optional(),
  reviewSummary: optionalString,
  reviewFindings: z
    .preprocess((value) => value ?? [], candidateReviewResultInput.shape.findings)
    .optional(),
  cleanupError: optionalString,
  pullRequestNumber: z.preprocess(
    (value) =>
      value === null
        ? undefined
        : typeof value === "string" && /^[1-9]\d*$/.test(value)
          ? Number(value)
          : value,
    z.number().int().positive().optional(),
  ),
  pullRequestUrl: optionalString,
  pullRequestState: optionalString,
  verificationCommitSha: optionalString,
  verificationState: optionalString,
  verificationSummary: optionalString,
  verificationPreparationFailure: optionalString,
  verificationComputeWait: z.boolean().optional(),
  verificationFailureKind: optionalEnum([
    "check-failed",
    "execution-failed",
    "cancelled",
    "skipped",
    "unavailable",
    "pending",
  ]),
  correctionState: optionalString,
  actionRunUrl: optionalString,
  approvedAt: optionalString,
  mergeState: optionalString,
  mergedCommitSha: optionalString,
  promotionId: optionalString,
  promotionState: optionalString,
  promotionFailure: optionalString,
  replacementRuntimeAttemptId: optionalString,
  replacementRuntimeState: optionalString,
});

export type DeliveryView = z.infer<typeof deliveryViewSchema>;
