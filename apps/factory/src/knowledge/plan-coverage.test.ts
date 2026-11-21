import { expect, test } from "bun:test";
import type { WikiPageSnapshot } from "../../../../packages/knowledge-domain/src/generation";
import { generateWiki, wikiPlanReviewSchema } from "./generation-workflow";

// Live generation 5bd8b45f-001f-4203-87ca-c6d643d49320, 2026-11-15.
const selfNegatingLiveFinding =
  "The current pages cover application development, tests and production behavior, but the overview is titled “Factory Starter” and presents the project as a generic starter. That framing is contradicted by the repository README’s project identity, “Factory Starter,” so no stale claim is established; however, with no proposed topics and no material changes to document, the plan does not call for any Wiki work. A useful Wiki should orient contributors to the existing guides, but the current overview already provides a short orientation and the other pages cover their reader tasks.";

test.each([
  "missing-guide",
  "genuine-no-op",
  "self-negating-live-finding",
  "actionable-live-finding",
  "mixed-findings",
  "malformed-coverage",
  "unread-evidence",
  "rejected-plan",
  "unavailable-reviewer",
] as const)(
  "whole-Wiki planning checks useful coverage before accepting %s",
  async (scenario) => {
    const overview: WikiPageSnapshot = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Forms project",
      body:
        scenario === "genuine-no-op" || scenario === "self-negating-live-finding"
          ? "Run npm run dev for the local Forms editor. Verify with npm test. Production writes remain disabled."
          : "This project has a Forms editor. Local setup and verification are planned for separate guides.",
      version: 1,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    };
    const source = {
      path: "docs/forms.md",
      content:
        "# Local Forms development\nRun npm run dev for the local editor. Verify with npm test. Production writes remain disabled.",
    };
    const topic = {
      slug: "forms-development",
      title: "Local Forms development",
      purpose: "Explain the supported local editor and verification commands.",
      paths: [source.path],
      pageIDs: [],
      parentSlug: "overview",
    };
    let plans = 0;
    let coverageChecks = 0;
    let publications = 0;
    let pages = [overview];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = (await request.json()) as {
          messages: Array<{
            role: string;
            content: string | Array<{ type: string; text?: string }> | null;
          }>;
        };
        const messages = incoming.messages.map((message) => ({
          ...message,
          content:
            typeof message.content === "string"
              ? message.content
              : (message.content?.find((part) => part.type === "text")?.text ?? ""),
        }));
        const system = messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        let output: unknown;
        if (system.includes("Research manifests")) {
          expect(system).toContain(
            "A push is a reason to check relevance, not a reason to publish",
          );
          expect(system).toContain("Prefer updating an existing page by pageIDs");
          expect(system).toContain("documentedAreas are source exploration hints");
          plans++;
          if (plans > 1) {
            const correction = messages.find(
              (message) => message.role === "user" && message.content.includes('"correction"'),
            )?.content;
            expect(correction).toContain("Local setup and verification");
            expect(correction).toContain("rejectedResult");
          }
          output = { topics: [] };
        } else if (system.includes("Return the complete corrected topic plan")) {
          expect(system).toContain("remove redundant topics");
          expect(system).toContain("updates to the existing owner");
          const user = messages.find((message) => message.role === "user")?.content ?? "";
          expect(user).toContain(
            scenario === "actionable-live-finding"
              ? selfNegatingLiveFinding
              : "Local setup and verification",
          );
          expect(user).not.toContain('"kind":"nonissue"');
          plans++;
          output = { topics: scenario === "missing-guide" ? [topic] : [] };
        } else if (system.includes("Review the whole proposed Wiki topic plan")) {
          expect(system).toContain("Reject a new topic whose reader task is already covered");
          coverageChecks++;
          if (scenario === "unavailable-reviewer")
            return Response.json(
              { error: { message: "Controlled unavailable coverage reviewer" } },
              { status: 503 },
            );
          expect(system).toContain("Do not invent a requiredChange");
          const nonissue = { kind: "nonissue", reason: selfNegatingLiveFinding };
          const actionable = {
            kind: "actionable",
            readerTask: "Local setup and verification",
            requiredChange:
              scenario === "actionable-live-finding"
                ? selfNegatingLiveFinding
                : "Local setup and verification are deferred by the current overview, although docs/forms.md describes both. Add that missing reader guidance.",
            sourcePaths: scenario === "unread-evidence" ? ["src/unread.ts"] : [source.path],
          };
          output =
            scenario === "malformed-coverage"
              ? { findings: [], issues: [selfNegatingLiveFinding] }
              : {
                  findings:
                    scenario === "genuine-no-op" ||
                    (scenario === "missing-guide" && coverageChecks === 2)
                      ? []
                      : scenario === "self-negating-live-finding"
                        ? [nonissue]
                        : scenario === "mixed-findings"
                          ? [nonissue, actionable]
                          : [actionable],
                };
        } else if (system.includes("Follow relationships")) {
          output = {
            findings: [{ claim: source.content, paths: [source.path] }],
            uncertainties: [],
          };
        } else if (system.includes("Write only this topic")) {
          output = {
            pages: [
              {
                body: source.content.replace("# Local Forms development\n", ""),
                sources: [source.path],
              },
            ],
          };
        } else output = { issues: [] };
        return Response.json({
          id: "owned-wiki-coverage",
          object: "chat.completion",
          created: 1,
          model: "controlled-wiki",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(output) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const run = generateWiki({
        name: "Forms coverage fixture",
        commit: "a".repeat(40),
        modelId: "controlled-wiki",
        connection: {
          provider: "openai",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "owned-test-not-a-secret",
        },
        pages,
        inventory: [
          { path: source.path, sha: "b".repeat(40), size: source.content.length },
          { path: "src/unread.ts", sha: "c".repeat(40), size: 30 },
        ],
        changedPaths: [source.path],
        sources: [source],
        signal: AbortSignal.timeout(15_000),
        readFiles: async () => [source],
        publish: async (output) => {
          publications++;
          expect(output.pages).toHaveLength(1);
          expect(output.pages[0]).toMatchObject({
            id: null,
            slug: topic.slug,
            parentSlug: overview.slug,
            sources: [source.path],
          });
          pages = [
            overview,
            {
              ...overview,
              id: crypto.randomUUID(),
              slug: topic.slug,
              title: topic.title,
              body: output.pages[0]?.body ?? "",
              parentId: overview.id,
            },
          ];
          return pages;
        },
      });
      if (["rejected-plan", "actionable-live-finding", "mixed-findings"].includes(scenario)) {
        await expect(run).rejects.toThrow("Wiki topic plan omits essential reader coverage");
        expect([plans, coverageChecks, publications]).toEqual([2, 2, 0]);
      } else if (scenario === "malformed-coverage") {
        await expect(run).rejects.toThrow("Structured output validation failed");
        expect([plans, coverageChecks, publications]).toEqual([1, 3, 0]);
      } else if (scenario === "unread-evidence") {
        await expect(run).rejects.toThrow("Research cites unread source: src/unread.ts");
        expect([plans, coverageChecks, publications]).toEqual([1, 2, 0]);
      } else if (scenario === "unavailable-reviewer") {
        await expect(run).rejects.toThrow();
        expect([plans, coverageChecks, publications]).toEqual([1, 1, 0]);
      } else {
        expect(await run).toEqual({ pages: [] });
        expect([plans, coverageChecks, publications]).toEqual(
          scenario === "missing-guide" ? [2, 2, 1] : [1, 1, 0],
        );
        expect(pages[0]).toBe(overview);
      }
    } finally {
      await server.stop(true);
    }
  },
  20_000,
);

test.each([
  { findings: [{ kind: "actionable", readerTask: "Setup", sourcePaths: ["README.md"] }] },
  { findings: [{ kind: "actionable", requiredChange: "Add setup", sourcePaths: ["README.md"] }] },
  {
    findings: [
      { kind: "actionable", readerTask: "Setup", requiredChange: "Add setup", sourcePaths: [] },
    ],
  },
  { findings: [{ kind: "nonissue", reason: "Covered", requiredChange: "Add setup" }] },
  { findings: [{ kind: "unknown", reason: "Covered" }] },
  { findings: [], issues: ["Setup is missing"] },
])("the plan review contract rejects incomplete or ambiguous findings: %j", (output) => {
  expect(wikiPlanReviewSchema.safeParse(output).success).toBe(false);
});

test("the coverage reviewer receives bounded previews and a refused request is repeated", async () => {
  const large = {
    path: "docs/large.md",
    content: `# Large guide\n${"Run npm test to verify the editor.\n".repeat(900)}`,
  };
  let planned = 0;
  let refusals = 0;
  let reviewed: Array<{ path: string; content: string; truncated?: boolean }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = (await request.json()) as {
        messages: Array<{ role: string; content: string | Array<{ text?: string }> | null }>;
      };
      const text = (content: string | Array<{ text?: string }> | null) =>
        typeof content === "string" ? content : (content?.[0]?.text ?? "");
      const system = incoming.messages
        .filter((message) => message.role === "system")
        .map((message) => text(message.content))
        .join("\n");
      let output: unknown = { findings: [] };
      if (system.includes("Review the whole proposed Wiki topic plan")) {
        // The first coverage request is refused before any inference starts.
        if (refusals++ === 0)
          return Response.json(
            { error: { message: "Rate limit reached" } },
            { status: 429, headers: { "retry-after-ms": "5" } },
          );
        const user = text(
          incoming.messages.find((message) => message.role === "user")?.content ?? "",
        );
        reviewed = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)).sources;
      } else if (system.includes("Research manifests")) {
        planned++;
        output = { topics: [] };
      }
      return Response.json({
        id: "owned-wiki-previews",
        object: "chat.completion",
        created: 1,
        model: "controlled-wiki",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(output) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const budget = { remaining: 10 };
  try {
    const result = await generateWiki({
      name: "Preview fixture",
      commit: "a".repeat(40),
      modelId: "controlled-wiki",
      connection: {
        provider: "openai",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "owned-test-not-a-secret",
      },
      pages: [
        {
          id: crypto.randomUUID(),
          slug: "overview",
          title: "Overview",
          body: "Run npm test to verify the editor.",
          version: 1,
          revisionId: crypto.randomUUID(),
          parentId: null,
          state: "active",
          citations: [],
        },
      ],
      inventory: [{ path: large.path, sha: "b".repeat(40), size: large.content.length }],
      changedPaths: [],
      sources: [large],
      providerRequests: budget,
      signal: AbortSignal.timeout(15_000),
      readFiles: async () => [large],
      publish: async () => {
        throw new Error("An empty plan publishes nothing");
      },
    });
    expect(result).toEqual({ pages: [] });
    expect(planned).toBe(1);
    expect(refusals).toBe(2);
    // Planner, one refused and repeated coverage request: three admitted requests in total.
    expect(budget.remaining).toBe(7);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]?.truncated).toBe(true);
    expect(reviewed[0]?.content.length).toBeLessThanOrEqual(2_000);
  } finally {
    await server.stop(true);
  }
}, 20_000);
