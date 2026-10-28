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
  "invalid-plan-once",
  "invalid-plan-always",
  "verbose-topic-plan",
  "source-hungry-checker",
  "bare-wiki-reference",
  "large-repository",
])(
  "real Mastra checked progressive workflow: %s",
  async (scenario) => {
    const files = Array.from({ length: 64 }, (_, index) => ({
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
    const topics = Array.from({ length: 4 }, (_, index) => ({
      slug: index ? `guide-${index}` : "overview",
      title: `Flow ${index}`,
      purpose: "Explain an actual reader workflow",
      paths: files.slice(index * 16, index * 16 + 16).map((file) => file.path),
      pageIDs: [],
      parentSlug: index ? "overview" : null,
    }));
    const read = new Set<string>();
    const pages: WikiPageSnapshot[] = [];
    let writes = 0,
      checks = 0,
      publications = 0,
      researches = 0,
      plans = 0,
      receivedRequests = 0;
    const corrections: Array<{ rejectedResult?: { topics?: typeof topics }; correction?: string }> =
      [];
    const keys = ["FACTORY_MODEL_BASE_URL", "FACTORY_MODEL_API_KEY"];
    const before = keys.map((key) => process.env[key]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        receivedRequests++;
        if (scenario === "provider-failure-not-repaired")
          return Response.json(
            { error: { message: "Controlled unavailable provider" } },
            { status: 503 },
          );
        const incoming = (await request.json()) as {
          tool_choice?: string;
          messages: Array<{
            role: string;
            content: string | Array<{ type: string; text?: string }> | null;
          }>;
        };
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
        if (system.includes("Research manifests")) {
          plans++;
          if (parsed.correction) corrections.push(parsed);
          output = {
            topics: topics.map((topic, index) => ({
              ...topic,
              ...(index === 0 &&
              (scenario === "invalid-plan-always" ||
                (scenario === "invalid-plan-once" && plans === 1))
                ? { paths: ["src/not-in-the-inventory.ts"] }
                : {}),
              ...(index === 1 && scenario === "verbose-topic-plan" && plans === 1
                ? { purpose: "x".repeat(801) }
                : {}),
            })),
          };
          if (scenario === "verbose-topic-plan" && plans === 2) expect(raw).toContain("800");
        } else if (system.includes("Follow relationships")) {
          researches++;
          const rejectedResearchAvailable =
            parsed.rejectedResult?.findings?.[0]?.claim?.length === 1201 &&
            parsed.correction?.includes("findings.0.claim");
          if (parsed.correction && scenario.startsWith("unread-research")) {
            expect(parsed.correction).toContain("Research cites unread source: src/flow-63.ts");
            expect(parsed.correction).toContain("use readSource");
            expect(parsed.rejectedResult.findings[0].paths).toEqual(["src/flow-63.ts"]);
          }
          expect(publications).toBe(topics.findIndex((topic) => topic.slug === prompt.topic.slug));
          output = {
            findings: [
              {
                claim:
                  (scenario === "invalid-research" && researches === 1) ||
                  (scenario === "repair-needs-rejected-research" &&
                    researches <= 2 &&
                    !rejectedResearchAvailable)
                    ? "x".repeat(1201)
                    : "Verified workflow",
                paths:
                  scenario === "unread-research-always" ||
                  (scenario === "unread-research-once" && researches === 1)
                    ? ["src/flow-63.ts"]
                    : prompt.topic.paths.slice(0, 8),
              },
            ],
            uncertainties: [],
          };
        } else if (system.includes("Write only this topic")) {
          writes++;
          output = {
            pages:
              scenario === "empty-topic"
                ? []
                : [
                    {
                      body:
                        scenario === "bare-wiki-reference" &&
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
          sourceToolCall = scenario === "source-hungry-checker" && incoming.tool_choice !== "none";
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
              scenario === "unsupported-claim" && prompt.topic.slug !== "overview"
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
                        id: `read-${checks}`,
                        type: "function",
                        function: {
                          name: "readSource",
                          arguments: JSON.stringify({ paths: prompt.topic.paths.slice(0, 1) }),
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
      },
    });
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
        providerRequests: { remaining: scenario === "execution-bound" ? 1 : 32 },
        readFiles: async (paths) =>
          paths.map((path) => {
            read.add(path);
            return { path, content: "export const valid = true;" };
          }),
        publish: async (output) => {
          if (scenario === "publication-conflict")
            throw new WikiPublicationConflict("Controlled revision conflict");
          publications++;
          for (const page of output.pages) {
            expect(page.body).not.toContain("## Sources");
            if (scenario === "bare-wiki-reference")
              expect(page.body).not.toContain("See #wiki/overview");
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
      if (scenario === "execution-bound") {
        const failure = await run.catch((cause: unknown) => cause);
        expect(knownModelRejection(failure)).toBe(true);
        expect(publications).toBe(0);
        return;
      }
      if (scenario === "unread-research-always") {
        await expect(run).rejects.toThrow("Research cites unread source: src/flow-63.ts");
        expect(researches).toBe(2);
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
          "bare-wiki-reference",
          "large-repository",
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
          ["publication-conflict", "execution-bound", "empty-topic"].includes(scenario) ? 0 : 1,
        );
        expect(checks).toBeLessThanOrEqual(4);
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
      expect(read.size).toBe(64);
      expect(publications).toBe(4);
      expect(writes).toBe(scenario === "bare-wiki-reference" ? 6 : 5);
      expect(checks).toBe(scenario === "source-hungry-checker" ? 8 : 4);
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
