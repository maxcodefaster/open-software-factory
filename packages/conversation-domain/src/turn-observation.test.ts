import { expect, test } from "bun:test";
import { turnObservationInput } from "./turn-observation";

test("live research progress remains readable after more than twelve lookups", () => {
  const value = {
    id: crypto.randomUUID(),
    commandId: crypto.randomUUID(),
    state: "running",
    engine: "mastra",
    mode: "plan",
    modelId: "owned-planning-model",
    skills: [],
    progress: { phase: "reading", completedLookups: 16 },
  };
  expect(turnObservationInput.parse(value).progress?.completedLookups).toBe(16);
  expect(
    turnObservationInput.safeParse({
      ...value,
      progress: { ...value.progress, completedLookups: -1 },
    }).success,
  ).toBe(false);
});
