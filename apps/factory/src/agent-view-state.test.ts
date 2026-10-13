import { expect, test } from "bun:test";
import type { AgentView } from "./api-contracts";
import { buildAgentHint, buildAgentStatus, retainAgentActivity } from "./agent-view-state";
import { buildAgentNeedsStart } from "./agent-view-state";

const loaded: AgentView = {
  state: "working",
  messagesAvailable: true,
  sessionAvailable: true,
  runtimeConnected: true,
  stopPending: false,
  stopId: null,
  messages: [{ id: "output", role: "assistant", text: "Build output", at: 1 }],
};
const unavailable: AgentView = {
  state: "committed",
  messagesAvailable: false,
  sessionAvailable: true,
  runtimeConnected: false,
  stopPending: false,
  stopId: null,
  messages: [],
};

test("startup Stop offers Start rather than a nonexistent Session resume", () => {
  const view: AgentView = { ...loaded, state: "stopped", sessionAvailable: false };
  expect(buildAgentNeedsStart(view)).toBe(true);
  expect(buildAgentHint(view)).toBe(
    "Stopped before Build started. Start implementation when ready.",
  );
  expect(buildAgentNeedsStart({ ...view, sessionAvailable: true })).toBe(false);
});

test("interrupted connection does not claim work is observed running or restart it", () => {
  const view: AgentView = { ...loaded, runtimeConnected: false };
  expect(buildAgentStatus(view)).toBe("Reconnecting");
  expect(buildAgentHint(view)).toBe(
    "Connection interrupted. Waiting for the same Build. Work is not restarted.",
  );
  expect(buildAgentStatus({ ...view, runtimeConnected: true })).toBe("Working");
});

test("keeps the same Change's activity while publishing its actual terminal status", () => {
  expect(retainAgentActivity({ changeID: "a", view: loaded }, "a", unavailable).view).toEqual({
    ...unavailable,
    messages: loaded.messages,
  });
});

test("never retains another Change's activity or fabricates missing output", () => {
  expect(retainAgentActivity({ changeID: "a", view: loaded }, "b", unavailable).view).toEqual(
    unavailable,
  );
  expect(retainAgentActivity(undefined, "a", unavailable).view).toEqual(unavailable);
});

test("accepts genuinely empty history once the live read succeeds", () => {
  const empty: AgentView = { ...unavailable, messagesAvailable: true };
  expect(retainAgentActivity({ changeID: "a", view: loaded }, "a", empty).view).toEqual(empty);
});

test("pending Stop overrides every session state without promising resume", () => {
  for (const state of [
    "idle",
    "starting",
    "working",
    "waiting",
    "stopped",
    "failed",
    "committed",
  ] as const) {
    const pending: AgentView = { ...loaded, state, stopPending: true };
    expect(buildAgentStatus(pending)).toBe("Stop unconfirmed");
    expect(buildAgentHint(pending)).toBe("Stop saved. Build waits for confirmation.");
  }
});

test("only a confirmed stopped session shows the resume hint", () => {
  const stopped: AgentView = { ...loaded, state: "stopped" };
  expect(buildAgentStatus(stopped)).toBe("Stopped");
  expect(buildAgentHint(stopped)).toBe("Stopped. Your next message resumes the session.");
  expect(buildAgentStatus(loaded)).toBe("Working");
  expect(buildAgentStatus(unavailable)).toBe("Complete");
});

test("an unresolved commit is never ordinary input waiting or a promise to resume", () => {
  const view: AgentView = {
    ...loaded,
    state: "waiting",
    commitOperation: {
      id: crypto.randomUUID(),
      state: "push-intended",
      lastError: "Commit outcome not confirmed",
    },
  };
  expect(buildAgentStatus(view)).toBe("Commit unconfirmed");
  expect(buildAgentHint(view)).toBe("Commit outcome unconfirmed. New Build waits for recovery.");
  expect(buildAgentStatus({ ...view, state: "stopped" })).toBe("Stopped");
  expect(buildAgentHint({ ...view, state: "stopped" })).not.toContain("resumes");
  expect(buildAgentStatus({ ...view, stopPending: true })).toBe("Stop unconfirmed");
  const saving: AgentView = {
    ...view,
    commitOperation: { id: crypto.randomUUID(), state: "push-intended" },
  };
  expect(buildAgentStatus(saving)).toBe("Saving commit");
});
