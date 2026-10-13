import { describe, expect, test } from "bun:test";
import { ticketBoardStage, ticketBoardStatus } from "./ticket-board";

describe("Ticket board stages", () => {
  test("shows the product journey rather than internal Change terminology", () => {
    expect(ticketBoardStage({ ticketState: "inbox" })).toBe("ideas");
    expect(ticketBoardStage({ ticketState: "ready" })).toBe("requirements");
    expect(ticketBoardStage({ ticketState: "in-progress", changeState: "active" })).toBe(
      "implementation",
    );
    expect(
      ticketBoardStage({
        ticketState: "in-progress",
        changeState: "active",
        verificationState: "running",
      }),
    ).toBe("review");
  });

  test("returns failed verification to implementation and removes terminal work", () => {
    expect(
      ticketBoardStage({
        ticketState: "in-progress",
        changeState: "active",
        verificationState: "failed",
      }),
    ).toBe("implementation");
    expect(ticketBoardStage({ ticketState: "done", changeState: "delivered" })).toBe("history");
    expect(ticketBoardStage({ ticketState: "cancelled", changeState: "cancelled" })).toBe(
      "history",
    );
  });

  test("describes the effective lifecycle instead of exposing a stale Ticket state", () => {
    expect(ticketBoardStatus({ ticketState: "ready" })).toBe("Requirements");
    expect(ticketBoardStatus({ ticketState: "in-progress", changeState: "active" })).toBe(
      "Implementation",
    );
    expect(
      ticketBoardStatus({
        ticketState: "in-progress",
        changeState: "active",
        verificationState: "running",
      }),
    ).toBe("Verification running");
    expect(
      ticketBoardStatus({
        ticketState: "in-progress",
        changeState: "cancelled",
      }),
    ).toBe("Cancelled");
    expect(ticketBoardStatus({ ticketState: "in-progress", changeState: "delivered" })).toBe(
      "Delivered",
    );
  });

  test.each([
    ["cancelling", "Cancelling"],
    ["starting", "Change starting"],
    ["failed", "Change failed"],
  ])("does not hide Change %s behind an older Verification", (changeState, label) => {
    expect(
      ticketBoardStatus({
        ticketState: "in-progress",
        changeState,
        verificationState: "succeeded",
      }),
    ).toBe(label);
  });

  test("a failed implementation cannot enter Review because an older check passed", () => {
    expect(
      ticketBoardStage({
        ticketState: "in-progress",
        changeState: "failed",
        verificationState: "succeeded",
      }),
    ).toBe("implementation");
  });

  test.each(["pending", "dispatching", "running", "uncertain"])(
    "an admitted correction %s returns to Implementation before a new commit exists",
    (buildTurnState) => {
      const input = {
        ticketState: "in-progress" as const,
        changeState: "active",
        verificationState: "succeeded",
        buildTurnState,
      };
      expect(ticketBoardStage(input)).toBe("implementation");
      expect(ticketBoardStatus(input)).not.toBe("Verified");
    },
  );
});
