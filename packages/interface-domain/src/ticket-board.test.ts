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

  test("failed review preparation stays in Review and does not become an implementation failure", () => {
    const input = {
      ticketState: "in-progress" as const,
      changeState: "failed",
      verificationState: "succeeded",
      buildTurnPurpose: "review",
      buildTurnState: "failed",
      implementationState: "failed",
    };
    expect(ticketBoardStage(input)).toBe("review");
    expect(ticketBoardStatus(input)).toBe("Review needs attention");
  });

  test.each(["pending", "dispatching", "running", "failed", "stopped", "completed"])(
    "independent review %s stays in Review instead of looking like another implementation",
    (state) => {
      const input = {
        ticketState: "in-progress" as const,
        changeState: "active",
        verificationState: "succeeded",
        buildTurnPurpose: "review",
        buildTurnState: state,
        implementationState: state === "completed" ? "committed" : "working",
      };
      expect(ticketBoardStage(input)).toBe("review");
      expect(ticketBoardStatus(input)).not.toBe("Implementation");
    },
  );

  test.each(["pending", "stopped"])(
    "review %s stays in Review while its compute is starting or stopped",
    (state) => {
      const input = {
        ticketState: "in-progress" as const,
        changeState: "starting",
        verificationState: "succeeded",
        buildTurnPurpose: "review",
        buildTurnState: state,
        implementationState: state === "stopped" ? "stopped" : "starting",
      };
      expect(ticketBoardStage(input)).toBe("review");
      expect(ticketBoardStatus(input)).toBe(
        state === "stopped" ? "Review needs attention" : "Preparing independent review",
      );
    },
  );

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

  test.each(
    ["pending", "dispatching", "running"].flatMap((buildTurnState) =>
      ["stopped", "failed"].map((implementationState) => ({
        buildTurnState,
        implementationState,
      })),
    ),
  )(
    "an active $buildTurnState successor outranks the retained Session's $implementationState copy",
    ({ buildTurnState, implementationState }) => {
      const input = {
        ticketState: "in-progress" as const,
        changeState: "active",
        buildTurnState,
        implementationState,
      };
      expect(ticketBoardStage(input)).toBe("implementation");
      expect(ticketBoardStatus(input)).toBe("Implementation");
    },
  );

  test.each(["stopped", "failed"])(
    "a retained %s implementation keeps its status without an active successor",
    (implementationState) => {
      for (const buildTurnState of [undefined, "completed"]) {
        const input = {
          ticketState: "in-progress" as const,
          changeState: "active",
          buildTurnState,
          implementationState,
        };
        expect(ticketBoardStage(input)).toBe("implementation");
        expect(ticketBoardStatus(input)).toBe(
          implementationState === "stopped" ? "Stopped" : "Implementation paused",
        );
      }
    },
  );

  test.each([
    ["uncertain", "Needs attention"],
    ["failed", "Implementation paused"],
    ["stopped", "Stopped"],
  ])("a latest %s turn keeps its own status", (buildTurnState, label) => {
    const input = {
      ticketState: "in-progress" as const,
      changeState: "active",
      buildTurnState,
      implementationState: "working",
    };
    expect(ticketBoardStage(input)).toBe("implementation");
    expect(ticketBoardStatus(input)).toBe(label);
  });

  test("a successor does not override terminal, review or Delivery precedence", () => {
    const input = {
      ticketState: "in-progress" as const,
      changeState: "active",
      buildTurnState: "pending",
      implementationState: "stopped",
    };
    for (const [changeState, stage, status] of [
      ["cancelled", "history", "Cancelled"],
      ["delivered", "history", "Delivered"],
      ["delivering", "review", "Delivering"],
      ["cancelling", "implementation", "Cancelling"],
    ]) {
      expect(ticketBoardStage({ ...input, changeState })).toBe(stage);
      expect(ticketBoardStatus({ ...input, changeState })).toBe(status);
    }
    for (const ticketState of ["done", "cancelled"] as const) {
      expect(ticketBoardStage({ ...input, ticketState })).toBe("history");
      expect(ticketBoardStatus({ ...input, ticketState })).toBe(
        ticketState === "done" ? "Completed" : "Cancelled",
      );
    }
    const review = {
      ...input,
      buildTurnPurpose: "review",
      verificationState: "succeeded",
    };
    expect(ticketBoardStage(review)).toBe("review");
    expect(ticketBoardStatus(review)).toBe("Independent review");
  });
});
