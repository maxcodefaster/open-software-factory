import { expect, test } from "bun:test";
import { type TicketProgressInput, ticketProgress } from "./ticket-progress";

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
