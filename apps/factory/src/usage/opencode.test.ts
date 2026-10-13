import { expect, test } from "bun:test";
import type { SessionStepFailed } from "@opencode/client";
import { codingAllowanceDenial, openCodeUsageEntry } from "./opencode";

test("only the exact local Coding denial is excluded, unrelated failures remain unknown", () => {
  const failure: SessionStepFailed = {
    id: "event-owned",
    created: Date.now(),
    type: "session.step.failed",
    durable: { aggregateID: "session-owned", seq: 1, version: 1 },
    data: {
      sessionID: "session-owned",
      assistantMessageID: "message-owned",
      error: { type: "access_denied", message: codingAllowanceDenial, status: 403 },
    },
  };
  expect(openCodeUsageEntry(failure, "session-owned")).toBeNull();
  failure.data.error.message = "Unrelated provider failure";
  expect(openCodeUsageEntry(failure, "session-owned")).toMatchObject({
    outcome: "failed",
    counters: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
  });
  failure.data.error.message = codingAllowanceDenial;
  failure.data.error.status = 502;
  expect(openCodeUsageEntry(failure, "session-owned")).not.toBeNull();
});
