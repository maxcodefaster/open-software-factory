import { expect, test } from "bun:test";
import { knowledgeGenerationSchema } from "./api-contracts";
import { wikiElapsed, wikiGenerationProgress } from "./wiki-progress";

const id = crypto.randomUUID();

test("a queued update says it is waiting, not working", () => {
  const text = wikiGenerationProgress({ state: "pending" }, 120_000);
  expect(text).toContain("Queued");
  expect(text).not.toContain("Running for");
});

test("an update with nothing published says so and reports elapsed time", () => {
  const text = wikiGenerationProgress({ state: "running", pageCount: 0 }, 3 * 60_000);
  expect(text).toContain("No pages are published yet");
  expect(text).toContain("Running for 3 minutes");
});

test("published pages are counted while the remaining guides continue", () => {
  const text = wikiGenerationProgress({ state: "running", pageCount: 1 }, 30_000);
  expect(text).toContain("1 page published so far");
  expect(text).toContain("remaining guides");
  expect(wikiGenerationProgress({ state: "running", pageCount: 4 })).toContain(
    "4 pages published so far",
  );
});

test("recorded phase and guide position replace the generic description", () => {
  expect(
    wikiGenerationProgress({
      state: "running",
      pageCount: 2,
      progress: { phase: "writing", topicsTotal: 7, topicsDone: 2, currentTopic: "Billing API" },
    }),
  ).toContain("Writing guide 3 of 7: Billing API.");
  expect(
    wikiGenerationProgress({
      state: "running",
      progress: { phase: "planning", topicsTotal: 0, topicsDone: 0, currentTopic: null },
    }),
  ).toContain("Planning");
  expect(
    wikiGenerationProgress({
      state: "running",
      progress: { phase: "publishing", topicsTotal: 4, topicsDone: 4, currentTopic: null },
    }),
  ).toContain("guide 4 of 4");
});

test("elapsed time is rounded down to whole minutes", () => {
  expect(wikiElapsed(59_000)).toBe("under a minute");
  expect(wikiElapsed(60_000)).toBe("1 minute");
  expect(wikiElapsed(5 * 60_000 + 59_000)).toBe("5 minutes");
});

test("the generation contract keeps recorded progress and tolerates null", () => {
  expect(knowledgeGenerationSchema.parse({ id, state: "running", progress: null }).progress).toBe(
    undefined,
  );
  expect(
    knowledgeGenerationSchema.parse({
      id,
      state: "running",
      progress: { phase: "writing", topicsTotal: 4, topicsDone: 1, currentTopic: "Setup" },
    }).progress?.currentTopic,
  ).toBe("Setup");
});
