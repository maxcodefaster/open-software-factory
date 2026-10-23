import { expect, test } from "bun:test";
import { adjacentScenario, reviewTime, scenarioAt } from "./playback";

const chapters = [
  {
    id: "save",
    title: "Save",
    category: "normal" as const,
    startedMs: 0,
    endedMs: 5000,
    status: "passed" as const,
  },
  {
    id: "empty",
    title: "Empty",
    category: "error" as const,
    startedMs: 5000,
    endedMs: 12000,
    status: "passed" as const,
  },
  {
    id: "unknown",
    title: "Missing timing",
    category: "boundary" as const,
    startedMs: 0,
    endedMs: null,
    status: null,
    hasRecordingPosition: false,
  },
  {
    id: "retry",
    title: "Retry",
    category: "boundary" as const,
    startedMs: 12000,
    endedMs: 20000,
    status: "passed" as const,
  },
];

test("playhead follows recorded chapters without treating missing timing as a position", () => {
  expect(scenarioAt(chapters, 0)?.id).toBe("save");
  expect(scenarioAt(chapters, 5)?.id).toBe("empty");
  expect(scenarioAt(chapters, 11.9)?.id).toBe("empty");
  expect(scenarioAt(chapters, 12)?.id).toBe("retry");
  expect(scenarioAt(chapters, 20)?.id).toBe("retry");
  expect(scenarioAt([], 5)).toBeUndefined();
});

test("chapter navigation moves to the adjacent boundary without restarting playback", () => {
  expect(adjacentScenario(chapters, 0, 1)?.id).toBe("empty");
  expect(adjacentScenario(chapters, 5, 1)?.id).toBe("retry");
  expect(adjacentScenario(chapters, 6, -1)?.id).toBe("empty");
  expect(adjacentScenario(chapters, 5, -1)?.id).toBe("save");
  expect(adjacentScenario(chapters, 12, 1)).toBeUndefined();
  expect(adjacentScenario(chapters, 0, -1)).toBeUndefined();
});

test("review clocks handle an unloaded recording and recordings longer than an hour", () => {
  expect(reviewTime(Number.NaN)).toBe("0:00");
  expect(reviewTime(-5)).toBe("0:00");
  expect(reviewTime(42.9)).toBe("0:42");
  expect(reviewTime(94)).toBe("1:34");
  expect(reviewTime(3661)).toBe("1:01:01");
  expect(reviewTime(0.8, true)).toBe("0:00.8");
});
