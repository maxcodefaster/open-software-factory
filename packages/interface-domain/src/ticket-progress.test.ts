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

test.each([
  [{ ...submitted, verificationState: "running" }, "running fresh checks"],
  [{ ...submitted, verificationState: "succeeded", reviewState: "running" }, "Independent review"],
  [
    { ...submitted, verificationState: "failed", verificationFailureKind: "execution-failed" },
    "runner or job setup",
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
