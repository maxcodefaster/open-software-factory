import { describe, expect, test } from "bun:test";
import {
  effectiveOpenReviewThreads,
  isActiveTurnState,
  technicalDesignStale,
} from "./ticket-state-helpers";

describe("ticket state helpers", () => {
  test("isActiveTurnState identifies pending, dispatching, and running turns", () => {
    expect(isActiveTurnState("pending")).toBe(true);
    expect(isActiveTurnState("dispatching")).toBe(true);
    expect(isActiveTurnState("running")).toBe(true);
    expect(isActiveTurnState("completed")).toBe(false);
    expect(isActiveTurnState("failed")).toBe(false);
    expect(isActiveTurnState("stopped")).toBe(false);
    expect(isActiveTurnState("uncertain")).toBe(false);
    expect(isActiveTurnState(undefined)).toBe(false);
  });

  test("effectiveOpenReviewThreads prefers live count including zero over delivery fallback", () => {
    expect(effectiveOpenReviewThreads(0, 3)).toBe(0);
    expect(effectiveOpenReviewThreads(2, 5)).toBe(2);
    expect(effectiveOpenReviewThreads(undefined, 4)).toBe(4);
    expect(effectiveOpenReviewThreads(undefined, undefined)).toBeUndefined();
  });

  test("technicalDesignStale detects mismatch against latest requirement revision", () => {
    expect(technicalDesignStale({ requirementRevisionId: "rev-1" }, "rev-2")).toBe(true);
    expect(technicalDesignStale({ requirementRevisionId: "rev-1" }, "rev-1")).toBe(false);
    expect(technicalDesignStale({ requirementRevisionId: "rev-1" }, undefined)).toBe(true);
    expect(technicalDesignStale(undefined, "rev-1")).toBe(false);
  });
});
