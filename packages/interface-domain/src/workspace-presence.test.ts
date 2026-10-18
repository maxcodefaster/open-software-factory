import { describe, expect, test } from "bun:test";
import { workspacePresence } from "./workspace-presence";

describe("Workspace presence", () => {
  test("distinguishes a reconnect from startup without overriding Stop or cancellation", () => {
    expect(workspacePresence({ runtimeState: "starting", connectionInterrupted: true })).toBe(
      "Workspace reconnecting",
    );
    expect(workspacePresence({ runtimeState: "ready", connectionInterrupted: true })).toBe(
      "Workspace reconnecting",
    );
    expect(workspacePresence({ runtimeState: "stopped", connectionInterrupted: true })).toBe(
      "Workspace stopped",
    );
    expect(
      workspacePresence({
        changeState: "cancelled",
        runtimeState: "starting",
        connectionInterrupted: true,
      }),
    ).toBe("Change cancelled");
  });
  test.each([
    ["create-intended", "Workspace starting"],
    ["starting", "Workspace starting"],
    ["ready", "Workspace ready"],
    ["failed", "Workspace failed"],
    ["stop-intended", "Workspace stopping"],
    ["stopping", "Workspace stopping"],
    ["stopped", "Workspace stopped"],
  ])("describes runtime %s as %s", (runtimeState, label) => {
    expect(workspacePresence({ changeState: "active", runtimeState })).toBe(label);
  });

  test("does not turn a stale Agent observation into running compute", () => {
    expect(
      workspacePresence({
        changeState: "active",
        runtimeState: "stopped",
        implementationState: "working",
      }),
    ).toBe("Workspace stopped");
    expect(workspacePresence({ changeState: "active", implementationState: "working" })).toBe(
      "Workspace status unavailable",
    );
    expect(
      workspacePresence({
        changeState: "active",
        runtimeState: "ready",
        implementationState: "working",
      }),
    ).toBe("Implementation running");
    expect(
      workspacePresence({
        changeState: "active",
        runtimeState: "ready",
        implementationState: "committed",
      }),
    ).toBe("Workspace ready");
    expect(workspacePresence({ changeState: "active", implementationState: "committed" })).toBe(
      "Workspace status unavailable",
    );
  });

  test.each([
    ["delivered", "Delivered"],
    ["cancelled", "Change cancelled"],
    ["cancelling", "Change cancelling"],
    ["delivering", "Delivery in progress"],
  ])("keeps Change %s authoritative", (changeState, label) => {
    expect(
      workspacePresence({ changeState, runtimeState: "ready", implementationState: "working" }),
    ).toBe(label);
  });

  test("does not claim that an idle Change has already started its Workspace", () => {
    expect(workspacePresence({ changeState: "active", implementationState: "idle" })).toBe(
      "Workspace starts with implementation",
    );
    expect(workspacePresence({ changeState: "starting" })).toBe("Workspace starting");
    expect(workspacePresence({ changeState: "failed" })).toBe("Change failed");
  });
});
