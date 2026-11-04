import { expect, test } from "bun:test";
import type { WikiPageSnapshot } from "../../../../packages/knowledge-domain/src/generation";
import { knownModelRejection } from "../models/execution-policy";
import { generateWiki } from "./generation-workflow";
import { WikiPublicationConflict } from "./publication";

test.each([
  "success",
  "broken-link",
  "wrong-parent",
  "unsupported-claim",
  "publication-conflict",
  "invalid-research",
  "repair-needs-rejected-research",
  "provider-failure-not-repaired",
  "unread-research-once",
  "unread-research-always",
  "duplicate-prose",
  "empty-topic",
  "verbose-overview",
  "execution-bound",
  "checker-budget-exhausted",
  "invalid-plan-once",
  "invalid-plan-always",
  "verbose-topic-plan",
  "source-hungry-checker",
  "bare-wiki-reference",
  "planned-links-need-more-repair",
  "large-repository",
  "many-topics",
  "authority-change",
  "rate-limited-once",
  "rate-limited-always",
  "shared-budget-exhausted",
  "one-sibling-fails",
  "large-source",
])(
  "real Mastra checked progressive workflow: %s",
  async (scenario) => {
    const files = Array.from({ length: scenario === "many-topics" ? 114 : 64 }, (_, index) => ({
      path: `src/flow-${index}.ts`,
      sha: "a".repeat(40),
      size: 30,
    }));
    if (scenario === "large-repository")
      files.push(
        ...Array.from({ length: 3083 }, (_, index) => ({
          path: `apps/web/src/components/modules/services/feature-${index}/entry.tsx`,
          sha: "b".repeat(40),
          size: 30,
        })),
      );
    const topics = Array.from({ length: scenario === "many-topics" ? 6 : 4 }, (_, index) => ({
      slug: index ? `guide-${index}` : "overview",
      title: `Flow ${index}`,
      purpose: "Explain an actual reader workflow",
      paths: files.slice(index * 16, index * 16 + 16).map((file) => file.path),
      pageIDs: [],
      parentSlug: index ? "overview" : null,
    }));
    const read = new Set<string>();
    const pages: WikiPageSnapshot[] = [];
    const topicLookups = new Map<string, number>();
    const checkedSources = new Set<string>();
    const publishedSlugs = new Set<string>();
    const progressLog: Array<{
      phase: string;
      topicsTotal: number;
      topicsDone: number;
      currentTopic: string | null;
    }> = [];
    const budget = {
      remaining:
        scenario === "execution-bound"
          ? 1
          : scenario === "checker-budget-exhausted" || scenario === "shared-budget-exhausted"
            ? 5
            : 32,
    };
    const researchCalls = new Map<string, number>();
    let fetchedPaths = 0,
      truncatedToolResult = false;
    let inFlight = 0,
      maximumInFlight = 0,
      publishing = 0,
      overlappingPublications = 0;
    let writes = 0,
      checks = 0,
      publications = 0,
      researches = 0,
      plans = 0,
      receivedRequests = 0,
      largestRequest = 0;
    const toolNames = new Set<string>();
    const corrections: Array<{ rejectedResult?: { topics?: typeof topics }; correction?: string }> =
      [];
    const keys = ["FACTORY_MODEL_BASE_URL", "FACTORY_MODEL_API_KEY"];
    const before = keys.map((key) => process.env[key]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        receivedRequests++;
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        try {
          return await respond(request);
        } finally {
          inFlight--;
        }
      },
    });
    async function respond(request: Request) {
      await Bun.sleep(10);
      if (
        scenario === "rate-limited-always" ||
        (scenario === "rate-limited-once" && receivedRequests === 3)
      )
        return Response.json(
          { error: { message: "Rate limit reached" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      if (scenario === "provider-failure-not-repaired")
        return Response.json(
          { error: { message: "Controlled unavailable provider" } },
          { status: 503 },
        );
      const incoming = (await request.json()) as {
        tools?: Array<{ function?: { name?: string } }>;
        tool_choice?: string;
        messages: Array<{
          role: string;
          content: string | Array<{ type: string; text?: string }> | null;
        }>;
      };
      largestRequest = Math.max(largestRequest, JSON.stringify(incoming).length);
      if (
        incoming.messages.some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content).includes("truncated") &&
            JSON.stringify(message.content).includes("nextStartLine"),
        )
      )
        truncatedToolResult = true;
      for (const tool of incoming.tools ?? []) toolNames.add(tool.function?.name ?? "");
      const body = {
        messages: incoming.messages.map((message) => ({
          ...message,
          content:
            typeof message.content === "string"
              ? message.content
              : (message.content?.find((part) => part.type === "text")?.text ?? ""),
        })),
      };
      const system = body.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const raw =
        body.messages.find(
          (message) => message.role === "user" && message.content.includes('"project"'),
        )?.content ??
        body.messages.find(
          (message) => message.role === "user" && message.content.includes('"topic"'),
        )?.content;
      if (!raw) throw new Error("Missing controlled workflow input");
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const prompt = (parsed.input ?? parsed) as {
        topic: (typeof topics)[number];
        issues?: string[];
      };
      let output: unknown;
      let sourceToolCall = false;
      let sourcePaths: string[] | undefined;
      if (system.includes("Review the whole proposed Wiki topic plan")) {
        output = { issues: [] };
      } else if (system.includes("Research manifests")) {
        plans++;
        if (parsed.correction) corrections.push(parsed);
        output = {
          topics: (scenario === "checker-budget-exhausted" ? topics.slice(0, 1) : topics).map(
            (topic, index) => ({
              ...topic,
              ...(index === 0 &&
              (scenario === "invalid-plan-always" ||
                (scenario === "invalid-plan-once" && plans === 1))
                ? { paths: ["src/not-in-the-inventory.ts"] }
                : {}),
              ...(index === 1 && scenario === "verbose-topic-plan" && plans === 1
                ? { purpose: "x".repeat(801) }
                : {}),
            }),
          ),
        };
        if (scenario === "verbose-topic-plan" && plans === 2) expect(raw).toContain("800");
      } else if (system.includes("Follow relationships")) {
        researches++;
        // Topics research concurrently, so scripted faults follow the overview's own calls.
        const nth = (researchCalls.get(prompt.topic.slug) ?? 0) + 1;
        researchCalls.set(prompt.topic.slug, nth);
        const overview = prompt.topic.slug === "overview";
        const replies = topicLookups.get(prompt.topic.slug) ?? 0;
        if (scenario === "many-topics" && replies < 3) {
          sourceToolCall = true;
          topicLookups.set(prompt.topic.slug, replies + 1);
          const topicIndex = topics.findIndex((topic) => topic.slug === prompt.topic.slug);
          sourcePaths = [files[96 + topicIndex * 3 + replies]?.path ?? ""];
        }
        const rejectedResearchAvailable =
          parsed.rejectedResult?.findings?.[0]?.claim?.length === 1201 &&
          parsed.correction?.includes("findings.0.claim");
        if (parsed.correction && scenario.startsWith("unread-research")) {
          expect(parsed.correction).toContain("Research cites unread source: src/flow-63.ts");
          expect(parsed.correction).toContain("use readSource");
          expect(parsed.rejectedResult.findings[0].paths).toEqual(["src/flow-63.ts"]);
        }
        output = {
          findings: [
            {
              claim:
                (scenario === "invalid-research" && overview && nth === 1) ||
                (scenario === "repair-needs-rejected-research" &&
                  overview &&
                  nth <= 2 &&
                  !rejectedResearchAvailable)
                  ? "x".repeat(1201)
                  : "Verified workflow",
              paths:
                scenario === "unread-research-always" ||
                (scenario === "unread-research-once" && overview && nth === 1)
                  ? ["src/flow-63.ts"]
                  : prompt.topic.paths.slice(0, 8),
            },
          ],
          uncertainties: [],
        };
      } else if (system.includes("Write only this topic")) {
        writes++;
        // A child researches early but writes only after its parent was published.
        if (prompt.topic.parentSlug) expect(publishedSlugs.has(prompt.topic.parentSlug)).toBe(true);
        // The writer receives the evidence its findings cite, not every file the research read.
        expect(
          (prompt as { sources?: Array<{ path: string }> }).sources?.map((source) => source.path),
        ).toEqual(prompt.topic.paths.slice(0, 8));
        expect((prompt as { currentPages?: unknown[] }).currentPages).toEqual([]);
        output = {
          pages:
            scenario === "empty-topic"
              ? []
              : [
                  {
                    body:
                      scenario === "planned-links-need-more-repair" &&
                      prompt.topic.slug === "overview" &&
                      writes <= 3
                        ? "Useful verified behavior. See [Flow 1](#wiki/guide-1)."
                        : scenario === "bare-wiki-reference" &&
                            prompt.topic.slug === "guide-1" &&
                            !prompt.issues?.length
                          ? "See #wiki/overview for the verified orientation."
                          : scenario === "verbose-overview" &&
                              !prompt.issues?.length &&
                              prompt.topic.slug === "overview"
                            ? "x".repeat(1201)
                            : !prompt.issues?.length && prompt.topic.slug === "overview"
                              ? "Useful verified behavior.\n\n## Sources\n\nSource noise."
                              : `Useful verified behavior for ${prompt.topic.slug}.${prompt.topic.parentSlug ? `\n\n[Overview](#wiki/${scenario === "broken-link" ? "missing-page" : "overview"})` : ""}`,
                    ...(scenario === "wrong-parent" && prompt.topic.slug !== "overview"
                      ? { parentSlug: null }
                      : {}),
                    sources: prompt.topic.paths,
                  },
                ],
        };
      } else {
        checks++;
        // The checker verifies the draft against its cited sources and needs no research findings.
        expect((prompt as { findings?: unknown }).findings).toBeUndefined();
        sourceToolCall =
          (scenario === "source-hungry-checker" || scenario === "large-source") &&
          !checkedSources.has(prompt.topic.slug);
        if (sourceToolCall) checkedSources.add(prompt.topic.slug);
        expect(system).toContain("normalized publication package, not a raw writer response");
        expect(system).toContain("Do not flag these fields or request schema changes");
        expect(system).toContain("Judge the current draft, not an earlier rejected version");
        expect(system).toContain("Never request source-code changes");
        expect(system).toContain("Clearly labelled advice");
        expect(system).toContain("Do not invent an overclaim that the draft does not make");
        expect(system).toContain(
          "A topic purpose cannot require onward navigation to unpublished planned guides",
        );
        expect(system).toContain(
          "Repository-document pointers are optional, not a substitute publication gate",
        );
        output = {
          issues:
            (scenario === "unsupported-claim" && prompt.topic.slug !== "overview") ||
            (scenario === "one-sibling-fails" && prompt.topic.slug === "guide-1")
              ? ["Draft invents deployment unsupported by inspected source"]
              : scenario === "duplicate-prose" && prompt.topic.slug !== "overview"
                ? ["The status transition is repeated under multiple headings"]
                : [],
        };
      }
      return Response.json({
        id: "owned-wiki",
        object: "chat.completion",
        created: 1,
        model: "controlled-wiki",
        choices: [
          {
            index: 0,
            message: sourceToolCall
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `read-${receivedRequests}`,
                      type: "function",
                      function: {
                        name: "readSource",
                        arguments: JSON.stringify({
                          paths: sourcePaths ?? prompt.topic.paths.slice(0, 1),
                        }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: JSON.stringify(output) },
            finish_reason: sourceToolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    process.env["FACTORY_MODEL_BASE_URL"] = `http://127.0.0.1:${server.port}/v1`;
    process.env["FACTORY_MODEL_API_KEY"] = "owned-test-not-a-secret";
    try {
      const run = generateWiki({
        name: "Workflow fixture",
        commit: "a".repeat(40),
        modelId: "controlled-wiki",
        connection: {
          provider: "openai",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "owned-test-not-a-secret",
        },
        pages: [],
        inventory: files,
        changedPaths: files.map((file) => file.path),
        sources: [],
        signal: AbortSignal.timeout(15_000),
        authorize: async () => {
          if (scenario === "authority-change" && receivedRequests > 0)
            throw new Error("Wiki execution authority changed");
        },
        progress: async (value) => {
          progressLog.push(value);
        },
        ...(scenario === "many-topics"
          ? {}
          : {
              providerRequests: budget,
            }),
        readFiles: async (paths) =>
          paths.map((path) => {
            read.add(path);
            fetchedPaths++;
            return {
              path,
              content:
                scenario === "large-source"
                  ? "export const valid = true;\n".repeat(520)
                  : "export const valid = true;",
            };
          }),
        publish: async (output) => {
          if (scenario === "publication-conflict")
            throw new WikiPublicationConflict("Controlled revision conflict");
          publications++;
          if (publishing++) overlappingPublications++;
          await Bun.sleep(5);
          publishing--;
          for (const page of output.pages) {
            publishedSlugs.add(page.slug);
            expect(page.body).not.toContain("## Sources");
            if (scenario === "bare-wiki-reference")
              expect(page.body).not.toContain("See #wiki/overview");
            if (scenario === "planned-links-need-more-repair" && page.slug === "overview")
              expect(page.body).not.toContain("#wiki/guide-1");
            pages.push({
              id: crypto.randomUUID(),
              slug: page.slug,
              title: page.title,
              body: page.body,
              version: 1,
              revisionId: crypto.randomUUID(),
              parentId: pages[0]?.id ?? null,
              state: "active",
              citations: page.sources.map((path) => ({ path, commitSha: "a".repeat(40) })),
            });
          }
          return pages;
        },
      });
      if (scenario === "authority-change") {
        await expect(run).rejects.toThrow("Wiki execution authority changed");
        expect(receivedRequests).toBe(1);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "provider-failure-not-repaired") {
        await expect(run).rejects.toBeDefined();
        expect(receivedRequests).toBe(1);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "invalid-plan-always") {
        await expect(run).rejects.toThrow("Unknown seed paths: src/not-in-the-inventory.ts");
        expect(plans).toBe(2);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "rate-limited-always") {
        // One request plus four Retry-After repeats, each charged to the shared budget; then the
        // definite 429 surfaces as a known rejection instead of hanging or retrying forever.
        const failure = await run.catch((cause: unknown) => cause);
        expect(knownModelRejection(failure)).toBe(true);
        expect(receivedRequests).toBe(5);
        expect(budget.remaining).toBe(32 - 5);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "execution-bound") {
        const failure = await run.catch((cause: unknown) => cause);
        expect(knownModelRejection(failure)).toBe(true);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "checker-budget-exhausted") {
        await expect(run).rejects.toThrow("Wiki topic failed bounded quality checks");
        expect(receivedRequests).toBe(5);
        expect(checks).toBe(0);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "unread-research-always") {
        await expect(run).rejects.toThrow("Research cites unread source: src/flow-63.ts");
        // The overview and its repair; siblings may research alongside before the failure lands.
        expect(researches).toBeGreaterThanOrEqual(2);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "shared-budget-exhausted") {
        // Concurrent topics draw on one provider request budget that is never exceeded.
        const failure = await run.catch((cause: unknown) => cause);
        expect(knownModelRejection(failure)).toBe(true);
        expect(receivedRequests).toBe(5);
        expect(budget.remaining).toBe(0);
        expect(publications).toBe(0);
        return;
      }
      if (
        ![
          "success",
          "invalid-research",
          "repair-needs-rejected-research",
          "unread-research-once",
          "verbose-overview",
          "invalid-plan-once",
          "verbose-topic-plan",
          "source-hungry-checker",
          "large-source",
          "bare-wiki-reference",
          "planned-links-need-more-repair",
          "large-repository",
          "many-topics",
          "rate-limited-once",
        ].includes(scenario)
      ) {
        await expect(run).rejects.toThrow(
          scenario === "publication-conflict"
            ? "Controlled revision conflict"
            : ["wrong-parent", "empty-topic"].includes(scenario)
              ? "Structured output validation failed"
              : "Wiki topic failed bounded quality checks",
        );
        expect(publications).toBe(
          ["publication-conflict", "execution-bound", "empty-topic"].includes(scenario)
            ? 0
            : // One failed sibling does not discard the topics that published around it.
              scenario === "one-sibling-fails"
              ? 3
              : 1,
        );
        expect(receivedRequests).toBeLessThanOrEqual(32);
        if (scenario === "large-repository") {
          // 3,147 files must not reach any prompt: agents explore with tools instead.
          expect(largestRequest).toBeLessThan(60_000);
          expect([...toolNames]).toEqual(
            expect.arrayContaining(["readSource", "listDirectory", "findFiles"]),
          );
        }
        return;
      }
      const result = await run;
      if (scenario === "invalid-plan-once") {
        expect(corrections).toHaveLength(1);
        expect(corrections[0]?.rejectedResult?.topics?.[0]?.paths).toEqual([
          "src/not-in-the-inventory.ts",
        ]);
        expect(corrections[0]?.correction).toContain(
          "Unknown seed paths: src/not-in-the-inventory.ts",
        );
      }
      expect(result.pages).toEqual([]);
      expect(overlappingPublications).toBe(0);
      expect(maximumInFlight).toBeLessThanOrEqual(3);
      if (scenario === "rate-limited-once") {
        // The refused request repeated once and finished the same generation.
        expect(publications).toBe(4);
        expect(plans).toBe(1);
        expect(budget.remaining).toBe(32 - receivedRequests);
      }
      if (scenario === "success") {
        // Child topics research while their parent is written, so provider calls overlap.
        expect(maximumInFlight).toBeGreaterThan(1);
        expect(progressLog[0]).toEqual({
          phase: "writing",
          topicsTotal: 4,
          topicsDone: 0,
          currentTopic: "Flow 0",
        });
        expect(progressLog.map((entry) => entry.topicsDone)).toEqual(
          [...progressLog.map((entry) => entry.topicsDone)].sort((a, b) => a - b),
        );
        expect(progressLog.some((entry) => entry.phase === "publishing")).toBe(true);
        expect(progressLog.at(-1)).toEqual({
          phase: "publishing",
          topicsTotal: 4,
          topicsDone: 4,
          currentTopic: null,
        });
      }
      if (scenario === "many-topics") {
        expect(receivedRequests).toBeGreaterThan(32);
        expect(publications).toBe(6);
        expect(read.size).toBe(114);
        return;
      }
      expect(read.size).toBe(64);
      expect(publications).toBe(4);
      expect(writes).toBe(
        scenario === "planned-links-need-more-repair"
          ? 7
          : scenario === "bare-wiki-reference"
            ? 6
            : 5,
      );
      expect(checks).toBe(
        scenario === "source-hungry-checker" || scenario === "large-source" ? 8 : 4,
      );
      // Each repository path is fetched once per generation, however many agents read it.
      expect(fetchedPaths).toBe(64);
      if (scenario === "large-source") {
        expect(truncatedToolResult).toBe(true);
        expect(largestRequest).toBeLessThan(120_000);
      }
      expect(researches).toBe(
        ["invalid-research", "repair-needs-rejected-research", "unread-research-once"].includes(
          scenario,
        )
          ? 5
          : 4,
      );
      expect(plans).toBe(["invalid-plan-once", "verbose-topic-plan"].includes(scenario) ? 2 : 1);
    } finally {
      await server.stop(true);
      keys.forEach((key, index) => {
        if (before[index] === undefined) delete process.env[key];
        else process.env[key] = before[index];
      });
    }
  },
  20_000,
);

test.each(["update", "no-op", "foreign-id", "identity-field", "checked-retry"])(
  "existing Wiki writer keeps Factory-owned identity: %s",
  async (scenario) => {
    const id = crypto.randomUUID();
    const page: WikiPageSnapshot = {
      id,
      slug: "original-guide",
      title: "Original guide",
      body: "Human business purpose.",
      version: 2,
      revisionId: crypto.randomUUID(),
      parentId: crypto.randomUUID(),
      state: "active",
      citations: [],
    };
    let publications = 0;
    let plans = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = (await request.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        const system = incoming.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        if (system.includes("Research manifests")) plans++;
        const output = system.includes("Research manifests")
          ? {
              topics: [
                {
                  slug: "planned-package",
                  title: "Planned package",
                  purpose: "Update the existing guide.",
                  paths: ["src/main.ts"],
                  pageIDs: [id],
                  parentSlug: null,
                },
              ],
            }
          : system.includes("Follow relationships")
            ? {
                findings: [{ claim: "Verified current flow.", paths: ["src/main.ts"] }],
                uncertainties: [],
              }
            : system.includes("Write only this topic")
              ? {
                  pages:
                    scenario === "no-op"
                      ? []
                      : [
                          {
                            id: scenario === "foreign-id" ? crypto.randomUUID() : id,
                            title: "Updated guide",
                            body: "Human business purpose.\n\nVerified current flow.",
                            sources: ["src/main.ts"],
                            ...(scenario === "identity-field" ? { slug: "renamed-guide" } : {}),
                          },
                        ],
                }
              : { issues: [] };
        return Response.json({
          id: "owned-existing-wiki",
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
        name: "Existing Wiki fixture",
        commit: "a".repeat(40),
        modelId: "controlled-wiki",
        connection: {
          provider: "openai",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "owned-test-not-a-secret",
        },
        pages: [page],
        ...(scenario === "checked-retry" ? { completedPageIDs: [id] } : {}),
        inventory: [{ path: "src/main.ts", sha: "a".repeat(40), size: 30 }],
        changedPaths: ["src/main.ts"],
        sources: [],
        signal: AbortSignal.timeout(15_000),
        readFiles: async (paths) => paths.map((path) => ({ path, content: "Verified flow." })),
        publish: async (output) => {
          publications++;
          if (scenario === "no-op") expect(output.pages).toEqual([]);
          else {
            expect(output.pages).toHaveLength(1);
            expect(output.pages[0]).toEqual({
              id,
              slug: "original-guide",
              title: "Updated guide",
              body: "Human business purpose.\n\nVerified current flow.",
              sources: ["src/main.ts"],
              parentSlug: null,
            });
          }
          return [page];
        },
      });
      if (["foreign-id", "identity-field"].includes(scenario)) {
        await expect(run).rejects.toThrow("Structured output validation failed");
        expect(publications).toBe(0);
      } else {
        expect(await run).toEqual({ pages: [] });
        expect(publications).toBe(scenario === "checked-retry" ? 0 : 1);
        if (scenario === "checked-retry") expect(plans).toBe(1);
      }
    } finally {
      await server.stop(true);
    }
  },
  20_000,
);
