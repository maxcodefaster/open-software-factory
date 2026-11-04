import { expect, test } from "bun:test";
import { z } from "zod";
import { describeStructuredFailure, structuredFailure } from "./generation-failure";
import { createWikiMetrics } from "./generation-metrics";
import { stripSourcesFooter, unlinkUnavailableGuides } from "./page-tidy";
import { documentedReaderAreas } from "./reader-areas";
import { factTokens, wordingOnlyChange } from "./wording-change";

test("metrics count steps, tool rounds, pauses and stage time without any model text", () => {
  let now = 0;
  const metrics = createWikiMetrics(() => now);
  const run = metrics.begin("investigator");
  run.step(1);
  run.step(1);
  run.step(0);
  run.wait(1500);
  now = 4000;
  run.end();
  metrics.begin("checker").step(0);
  metrics.stage("overview", "write", 2500);
  metrics.stage("overview", "write", 500);
  expect(metrics.totals()).toEqual({ modelSteps: 4, toolRounds: 2, pausedMs: 1500 });
  expect(metrics.roleLines()[0]).toBe(
    "investigator runs=1 steps=3 toolRounds=2 busy=4.0s paused=1.5s",
  );
  expect(metrics.topicLine("overview", "published")).toBe("topic overview published write=3.0s");
  expect(metrics.elapsedMs()).toBe(4000);
});

test("a closing Sources section is removed, a Sources heading in the middle is left alone", () => {
  expect(stripSourcesFooter("Text.\n\n## Sources\n\n- a.ts")).toBe("Text.");
  expect(stripSourcesFooter("Text.\n\nSources:\n\n- a.ts")).toBe("Text.");
  const middle = "Text.\n\n## Sources\n\nHow sources work.\n\n## Next\n\nMore.";
  expect(stripSourcesFooter(middle)).toBe(middle);
  expect(stripSourcesFooter("No footer here.")).toBe("No footer here.");
});

test("links to unpublished or mistyped guides become plain text, code and published links stay", () => {
  const published = new Set(["overview"]);
  expect(
    unlinkUnavailableGuides(
      "See [Setup](#wiki/setup) and [Overview](#wiki/overview).\n\n```md\n[Setup](#wiki/setup)\n```",
      published,
    ),
  ).toBe("See Setup and [Overview](#wiki/overview).\n\n```md\n[Setup](#wiki/setup)\n```");
  expect(unlinkUnavailableGuides("[Setup](#wiki/setup)", new Set(["setup"]))).toBe(
    "[Setup](#wiki/setup)",
  );
});

test("documented reader areas combine README sections and documentation files", () => {
  const inventory = [
    { path: "README.md" },
    { path: "docs/setup.md" },
    { path: "docs/architecture/overview.md" },
    { path: "docs/README.md" },
    { path: "src/index.ts" },
  ];
  const sources = [
    {
      path: "README.md",
      content:
        "# Product\n## Installation\n## License\n```sh\n## not a heading\n```\n## Usage\n### Tuning\n",
    },
  ];
  expect(documentedReaderAreas(inventory, sources)).toEqual([
    "Installation",
    "Usage",
    "Tuning",
    "docs/setup.md",
    "docs/architecture/overview.md",
  ]);
  expect(documentedReaderAreas([{ path: "src/a.ts" }], [])).toEqual([]);
});

test("wording-only needs no new fact, little growth and unchanged cited files", () => {
  const current = "Run `npm test` in src/app.ts. It takes 5 minutes. See [Setup](#wiki/setup).";
  const input = { cited: ["src/app.ts"], changedPaths: ["other.ts"] };
  expect(
    wordingOnlyChange({
      ...input,
      current,
      draft: "To verify, run `npm test` in src/app.ts; about 5 minutes. See [Setup](#wiki/setup).",
    }),
  ).toBe(true);
  expect(
    wordingOnlyChange({ ...input, current, draft: "Run `npm test` in src/app.ts. 7 minutes." }),
  ).toBe(false);
  expect(
    wordingOnlyChange({ ...input, current, draft: `${current} Also run \`npm run lint\`.` }),
  ).toBe(false);
  expect(
    wordingOnlyChange({ ...input, current, draft: `${current} ${"More words. ".repeat(10)}` }),
  ).toBe(false);
  expect(
    wordingOnlyChange({
      current,
      draft: current,
      cited: ["src/app.ts"],
      changedPaths: ["src/app.ts"],
    }),
  ).toBe(false);
  expect([...factTokens("Call `openSession()` with MAX_RETRIES at https://x.test/a")]).toEqual(
    expect.arrayContaining(["opensession()", "max_retries", "https://x.test/a"]),
  );
});

test("a structured refusal is classified from the SDK error chain without its text", async () => {
  const schema = z.object({ pages: z.array(z.string()).length(1) });
  const zod = schema.safeParse({ pages: [] }).error;
  const invalid = Object.assign(new Error("x"), {
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    details: { value: '{"pages":[]}' },
    cause: zod,
  });
  expect(structuredFailure(invalid)).toEqual({
    kind: "invalid",
    issues: ["pages:too_small"],
    chars: 12,
  });
  const truncated = Object.assign(new Error("x"), {
    id: "STRUCTURED_OUTPUT_TRUNCATED",
    details: { finishReason: "length", value: "{".repeat(30) },
  });
  expect(describeStructuredFailure(structuredFailure(truncated))).toBe("truncated chars=30");
  expect(structuredFailure(schema.safeParse(undefined).error).kind).toBe("empty");
  expect(structuredFailure(new Error("other")).kind).toBe("malformed");
});
