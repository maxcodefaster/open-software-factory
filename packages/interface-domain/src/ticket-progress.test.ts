import { expect, test } from "bun:test";
import { deliveryBlocker, type TicketProgressInput, ticketProgress } from "./ticket-progress";

const submitted: TicketProgressInput = {
  ticketState: "in-progress",
  changeState: "active",
  implementationState: "committed",
};
test("unfinished technical planning is not described as an active model operation", () => {
  const text = ticketProgress({
    ticketState: "ready",
    technicalPlanningOutstanding: true,
    planning: false,
  });
  expect(text).toContain("Technical planning is unfinished");
  expect(text).not.toContain("in progress");
});

test("a waiting Interview question never reads as saved requirements ready to implement", () => {
  const text = ticketProgress({ ticketState: "ready", awaitingAnswer: true });
  expect(text).toContain("waiting for your answer");
  expect(text).not.toContain("Confirm the scope with Implement");
  expect(
    ticketProgress({
      ticketState: "ready",
      awaitingAnswer: true,
      technicalPlanningOutstanding: true,
    }),
  ).toContain("waiting for your answer");
});

test("a failed change points to the Coding conversation and keeps retained work", () => {
  const text = ticketProgress({ ...submitted, changeState: "failed", turnState: "failed" });
  expect(text).toContain("Coding conversation");
  expect(text).toContain("Retry");
});

test("failed review preparation keeps the recovery action scoped to the submitted candidate", () => {
  const text = ticketProgress({
    ...submitted,
    changeState: "failed",
    implementationState: "failed",
    turnState: "failed",
    turnPurpose: "review",
    verificationState: "succeeded",
    reviewState: "failed",
  });
  expect(text).toContain("Review preparation failed");
  expect(text).toContain("Retry review");
  expect(text).toContain("without repeating implementation");
  expect(text).not.toContain("Implementation could not finish");
});

test.each(["pending", "runner-starting"])(
  "submitted %s Verification does not claim that checks are already running",
  (verificationState) => {
    const text = ticketProgress({ ...submitted, verificationState });
    expect(text).toContain("preparing fresh checks");
    expect(text).not.toContain("running fresh checks");
    expect(text).not.toContain("No action needed");
  },
);

test("a retained preparation issue stays distinct from application failure and active checks", () => {
  const input = {
    ...submitted,
    verificationState: "runner-starting",
    verificationPreparationFailure: "Factorybox capacity refused preparation before dispatch",
  };
  expect(ticketProgress(input)).toContain("Check preparation needs attention");
  expect(ticketProgress(input)).not.toContain("running fresh checks");
  expect(ticketProgress(input)).not.toContain("verification check failed");
  expect(ticketProgress({ ...input, verificationState: "running" })).toContain(
    "running fresh checks",
  );
  expect(
    ticketProgress({ ...input, verificationState: "succeeded", reviewState: "passed" }),
  ).not.toContain("preparation");
});

test.each([
  [{ ...submitted, verificationState: "running" }, "running fresh checks"],
  [{ ...submitted, verificationState: "succeeded", reviewState: "running" }, "Independent review"],
  [
    { ...submitted, verificationState: "failed", verificationFailureKind: "execution-failed" },
    "runner or job setup",
  ],
  [
    {
      ...submitted,
      verificationState: "failed",
      verificationFailureKind: "execution-failed",
      checksRetryable: true,
    },
    "Fix its setup, then Retry checks",
  ],
  [
    { ...submitted, verificationState: "failed", verificationFailureKind: "cancelled" },
    "no application defect",
  ],
  [
    { ...submitted, verificationState: "failed", verificationFailureKind: "skipped" },
    "no code correction",
  ],
  [
    { ...submitted, verificationState: "failed", verificationFailureKind: "unavailable" },
    "diagnosis is unavailable",
  ],
  [
    { ...submitted, verificationState: "failed", correctionState: "running" },
    "Automatic correction",
  ],
  [
    { ...submitted, verificationState: "succeeded", reviewState: "incomplete" },
    "explicitly retrying review",
  ],
  [
    { ...submitted, verificationState: "succeeded", reviewState: "passed", threads: 1 },
    "resolve the open Threads",
  ],
  [
    { ...submitted, verificationState: "succeeded", reviewState: "passed", canDevelop: true },
    "approve Delivery",
  ],
  [
    { ...submitted, verificationState: "succeeded", reviewState: "passed", canDevelop: false },
    "A developer",
  ],
  [{ ...submitted, turnState: "uncertain", building: true }, "has not replayed"],
  [{ ...submitted, checksPaused: true }, "without repeating implementation"],
  [{ ...submitted, implementationState: "working", building: true }, "being implemented"],
  [{ ...submitted, implementationState: "waiting", building: true }, "needs an answer"],
  [{ ...submitted, changeState: "delivering" }, "existing Staging Preview"],
  [
    { ...submitted, changeState: "delivering", promotionState: "failed" },
    "merged, but Main Preview failed",
  ],
  [
    { ...submitted, changeState: "delivered", cleanupError: "owned resource retained" },
    "cleanup needs attention",
  ],
  [{ ticketState: "ready" }, "Requirements are saved"],
  [{ ticketState: "ready", planning: true }, "Planning is in progress"],
])("Ticket progress explains saved state %j", (input, text) => {
  expect(ticketProgress(input)).toContain(text);
});
test("earlier successful checks never approve unsubmitted corrections", () => {
  const text = ticketProgress({
    ...submitted,
    implementationState: "working",
    verificationState: "succeeded",
    reviewState: "passed",
  });
  expect(text).toContain("not submitted");
  expect(text).not.toContain("approve Delivery");
});

test("automatic correction names the observed failed check, without inventing a diagnosis", () => {
  expect(
    ticketProgress({
      ...submitted,
      verificationState: "failed",
      verificationFailureKind: "check-failed",
      verificationSummary: "Verification failed in Project checks: Validate invoice.",
      correctionState: "running",
    }),
  ).toContain("Validate invoice. Automatic correction");
});

const queued: TicketProgressInput = { ...submitted, changeState: "delivering" };
test("an approved Delivery names the Ticket whose failed promotion pauses the queue", () => {
  const text = ticketProgress({
    ...queued,
    deliveryBlock: { title: "Export invoices", reason: "promotion-failed" },
  });
  expect(text).toContain('Waiting for "Export invoices"');
  expect(text).toContain("Delivery is paused");
  expect(text).not.toContain("Delivery is in progress");
});

test("queue wording separates an unconfirmed merge from a merely busy queue", () => {
  expect(
    ticketProgress({ ...queued, deliveryBlock: { title: "A", reason: "merge-unconfirmed" } }),
  ).toContain("unconfirmed");
  const busy = ticketProgress({ ...queued, deliveryBlock: { title: "A", reason: "in-progress" } });
  expect(busy).toContain("one at a time");
  expect(busy).not.toContain("paused");
  expect(
    ticketProgress({ ...queued, deliveryBlock: { title: "x".repeat(200), reason: "in-progress" } })
      .length,
  ).toBeLessThan(260);
});

test("a failed Main Preview of this Ticket outranks any queue explanation", () => {
  expect(
    ticketProgress({
      ...queued,
      promotionState: "failed",
      deliveryBlock: { title: "A", reason: "in-progress" },
    }),
  ).toContain("retry Main Preview");
});

test("only an unfinished merge or Staging Promotion of another Change blocks the queue", () => {
  const own = { id: "own", mergeState: "pending" };
  const other = (id: string, mergeState?: string, promotionState?: string) => ({
    id,
    ticketId: `ticket-${id}`,
    mergeState,
    promotionState,
  });
  expect(deliveryBlocker(own, [other("a", "succeeded", "succeeded")])).toBeUndefined();
  expect(deliveryBlocker(own, [other("a", "failed")])).toBeUndefined();
  expect(deliveryBlocker(own, [other("a"), other("own", "pending")])).toBeUndefined();
  expect(deliveryBlocker(own, [other("a", "executing")])).toEqual({
    ticketId: "ticket-a",
    reason: "in-progress",
  });
  expect(
    deliveryBlocker(own, [other("a", "executing"), other("b", "succeeded", "failed")]),
  ).toEqual({ ticketId: "ticket-b", reason: "promotion-failed" });
  expect(deliveryBlocker(own, [other("a", "ambiguous")])?.reason).toBe("merge-unconfirmed");
  expect(deliveryBlocker({ id: "own", mergeState: "executing" }, [other("a", "executing")])).toBe(
    undefined,
  );
});
