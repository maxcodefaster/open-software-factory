import { expect, test } from "bun:test";
import { ModelExecutionBoundError } from "../models/execution-policy";
import { generateWiki } from "./generation-agent";
import {
  rejectedWikiStructuredResult,
  WikiHumanEditConflict,
  WikiSourceEvidenceError,
  WikiStructuredResultError,
  WikiTopicCoverageError,
  WikiTopicPlanError,
  WikiTopicQualityError,
  wikiGenerationFailureMessage,
} from "./generation-failure";

test("Wiki diagnostics distinguish known failures without exposing model prose or paths", () => {
  const fallback = "Existing safe failure";
  expect(
    wikiGenerationFailureMessage(new WikiTopicPlanError("private source path"), fallback),
  ).toContain("topic plan");
  expect(
    wikiGenerationFailureMessage(
      new WikiTopicCoverageError(["private source and prose"]),
      fallback,
    ),
  ).toContain("essential reader guidance");
  expect(
    wikiGenerationFailureMessage(
      new WikiTopicQualityError("private-slug", ["private prose"]),
      fallback,
    ),
  ).toContain("source and quality checks");
  expect(
    wikiGenerationFailureMessage(new WikiSourceEvidenceError(["private/path"]), fallback),
  ).toContain("source it had not inspected");
  expect(wikiGenerationFailureMessage(new WikiHumanEditConflict(), fallback)).toContain(
    "not overwritten",
  );
  expect(wikiGenerationFailureMessage(new WikiStructuredResultError(), fallback)).toContain(
    "required format",
  );
  for (const cause of [
    new WikiTopicPlanError("private source path"),
    new WikiTopicCoverageError(["private source and prose"]),
    new WikiTopicQualityError("private-slug", ["private prose"]),
    new WikiSourceEvidenceError(["private/path"]),
    new Error("Authorization: private provider key"),
  ])
    expect(wikiGenerationFailureMessage(cause, fallback)).not.toContain("private");
});

test("a Wiki correction receives only a recognized, complete and bounded rejected structured result", () => {
  const value = {
    findings: [{ claim: "x".repeat(1201), paths: ["src/app.ts"] }],
    uncertainties: [],
  };
  const failure = {
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    details: { value: JSON.stringify(value) },
  };
  expect(rejectedWikiStructuredResult(failure)).toEqual(value);
  expect(
    rejectedWikiStructuredResult({ ...failure, id: "UNKNOWN_PROVIDER_FAILURE" }),
  ).toBeUndefined();
  expect(
    rejectedWikiStructuredResult({ ...failure, details: { value: "incomplete {" } }),
  ).toBeUndefined();
  expect(
    rejectedWikiStructuredResult({
      ...failure,
      details: { value: "x".repeat(1024 * 1024 + 1) },
    }),
  ).toBeUndefined();
});

test("Wiki diagnostics preserve serialized execution bounds but bound error traversal", () => {
  const bound = new ModelExecutionBoundError("requests");
  expect(wikiGenerationFailureMessage({ cause: { name: bound.name } }, "fallback")).toContain(
    "No additional provider request",
  );
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(wikiGenerationFailureMessage(cycle, "fallback")).toBe("fallback");
  for (const status of [400, 401, 403, 404, 429, 500, 503])
    expect(
      wikiGenerationFailureMessage(
        { name: "ForgeHttpError", status, message: "private source diagnostic" },
        "Safe source failure",
      ),
    ).toBe("Safe source failure");
});

test.each([
  [401, "credentials"],
  [403, "not available"],
  [404, "not available"],
  [429, "rate limit"],
  [400, "rejected"],
  [422, "rejected"],
  [500, "provider could not complete"],
  [502, "provider could not complete"],
  [503, "provider could not complete"],
] as const)(
  "native Wiki failure preserves safe HTTP %s classification without replay",
  async (status, expected) => {
    let requests = 0;
    let publications = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json(
          { error: { message: "private-provider-prose Authorization: private-key" } },
          { status },
        );
      },
    });
    try {
      const failure = await generateWiki({
        name: "Owned Wiki refusal",
        commit: "a".repeat(40),
        modelId: "gpt-6.1-sol",
        connection: {
          provider: "openai",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "owned-test-not-a-secret",
        },
        pages: [],
        inventory: [{ path: "src/app.ts", sha: "a".repeat(40), size: 20 }],
        changedPaths: ["src/app.ts"],
        sources: [],
        readFiles: async (paths) =>
          paths.map((path) => ({ path, content: "export const app = 1;" })),
        publish: async () => {
          publications++;
          return [];
        },
        signal: AbortSignal.timeout(10_000),
      }).catch((cause: unknown) => cause);
      const diagnostic = wikiGenerationFailureMessage(failure, "Safe generic Wiki failure");
      expect(diagnostic).toContain(expected);
      expect(diagnostic).not.toContain("private");
      expect(diagnostic).not.toContain("127.0.0.1");
      expect(requests).toBe(1);
      expect(publications).toBe(0);
    } finally {
      await server.stop(true);
    }
  },
  15_000,
);
