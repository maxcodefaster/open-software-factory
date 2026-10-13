export const boardStages = [
  { id: "ideas", label: "Ideas" },
  { id: "requirements", label: "Requirements" },
  { id: "implementation", label: "Implementation" },
  { id: "review", label: "Review" },
] as const;

export type BoardStage = (typeof boardStages)[number]["id"];

export type TicketBoardInput = {
  ticketState: "inbox" | "backlog" | "ready" | "in-progress" | "cancelled" | "done";
  changeState?: string | undefined;
  verificationState?: string | undefined;
  buildTurnState?: string | undefined;
  implementationState?: string | undefined;
};

function hasCurrentImplementation(input: TicketBoardInput) {
  return (
    ["branch-pending", "starting", "failed", "cancelling"].includes(input.changeState ?? "") ||
    ["pending", "dispatching", "running", "uncertain", "failed", "stopped"].includes(
      input.buildTurnState ?? "",
    ) ||
    ["starting", "working", "waiting", "failed", "stopped"].includes(
      input.implementationState ?? "",
    )
  );
}

export function ticketBoardStage(input: TicketBoardInput): BoardStage | "history" {
  if (
    input.ticketState === "done" ||
    input.ticketState === "cancelled" ||
    input.changeState === "delivered" ||
    input.changeState === "cancelled"
  ) {
    return "history";
  }
  if (input.changeState === "delivering") return "review";
  if (hasCurrentImplementation(input)) return "implementation";
  if (
    ["pending", "runner-starting", "running", "succeeded"].includes(input.verificationState ?? "")
  ) {
    return "review";
  }
  if (input.changeState || input.ticketState === "in-progress") return "implementation";
  if (input.ticketState === "ready") return "requirements";
  return "ideas";
}

export function ticketBoardStatus(input: TicketBoardInput): string {
  if (input.changeState === "delivered") return "Delivered";
  if (input.changeState === "cancelled" || input.ticketState === "cancelled") return "Cancelled";
  if (input.ticketState === "done") return "Completed";
  if (input.changeState === "delivering") return "Delivering";
  if (input.changeState === "cancelling") return "Cancelling";
  if (["branch-pending", "starting"].includes(input.changeState ?? "")) {
    return "Change starting";
  }
  if (input.changeState === "failed") return "Change failed";
  if (hasCurrentImplementation(input)) {
    if (input.buildTurnState === "uncertain") return "Needs attention";
    if (input.buildTurnState === "failed" || input.implementationState === "failed")
      return "Implementation paused";
    if (input.buildTurnState === "stopped" || input.implementationState === "stopped")
      return "Stopped";
    return "Implementation";
  }

  if (input.verificationState === "succeeded") return "Verified";
  if (input.verificationState === "failed") return "Verification failed";
  if (input.verificationState === "running") return "Verification running";
  if (input.verificationState === "runner-starting") return "Verification starting";
  if (input.verificationState === "pending") return "Verification pending";

  if (input.changeState || input.ticketState === "in-progress") return "Implementation";
  if (input.ticketState === "ready") return "Requirements";
  return "Idea";
}
