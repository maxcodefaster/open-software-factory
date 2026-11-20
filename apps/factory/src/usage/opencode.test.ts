import { expect, test } from "bun:test";
import type { SessionStepFailed, SessionUsageRecorded } from "@opencode/client";
import { codingAllowanceDenial, drainOpenCodeUsage, openCodeUsageEntry } from "./opencode";

test.each(["generate", "title", "compaction"] as const)(
  "native %s usage retains its counters in the Factory journal",
  (source) => {
    const event: SessionUsageRecorded = {
      id: "event-owned",
      created: 1_700_000_000_000,
      type: "session.usage.recorded",
      durable: { aggregateID: "session-owned", seq: 2, version: 1 },
      data: {
        sessionID: "session-owned",
        source,
        cost: 0,
        tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 5 } },
      },
    };
    const entry = openCodeUsageEntry(event, "session-owned");
    expect(entry).toEqual({
      eventID: event.id,
      source: source === "generate" ? "step" : source,
      outcome: "completed",
      counters: { input: 100, output: 50, reasoning: 30, cacheRead: 40, cacheWrite: 5 },
      occurredAt: new Date(event.created).toISOString(),
    });
    expect(openCodeUsageEntry(event, "another-session")).toBeNull();
  },
);

test("native generation replay records consumption once and advances the exact Session", async () => {
  const event: SessionUsageRecorded = {
    id: "event-owned",
    created: 1_700_000_000_000,
    type: "session.usage.recorded",
    durable: { aggregateID: "session-owned", seq: 2, version: 1 },
    data: {
      sessionID: "session-owned",
      source: "generate",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 30, cache: { read: 40, write: 5 } },
    },
  };
  const records: Array<{ eventID: string; source: string; sequence: number }> = [];
  const advanced: number[] = [];
  const sequence = await drainOpenCodeUsage({
    sessionID: "session-owned",
    after: 1,
    async *log(after) {
      expect(after).toBe(1);
      yield { ...event, durable: { ...event.durable, seq: 1 } };
      yield event;
      yield event;
      yield { type: "log.synced", aggregateID: "session-owned", seq: 3 };
    },
    async record(entry, sequence) {
      records.push({ eventID: entry.eventID, source: entry.source, sequence });
    },
    async advance(sequence) {
      advanced.push(sequence);
    },
  });
  expect(records).toEqual([{ eventID: event.id, source: "step", sequence: 2 }]);
  expect(advanced).toEqual([3]);
  expect(sequence).toBe(3);
});

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
