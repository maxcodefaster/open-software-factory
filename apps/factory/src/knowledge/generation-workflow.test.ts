import { expect, test } from "bun:test";
import type { WikiPageSnapshot } from "../../../../packages/knowledge-domain/src/generation";
import { generateWiki } from "./generation-workflow";
import { WikiPublicationConflict } from "./publication";

test.each([
  "success",
  "broken-link",
  "wrong-parent",
  "unsupported-claim",
  "publication-conflict",
  "invalid-research",
  "duplicate-prose",
  "empty-topic",
  "verbose-overview",
  "execution-bound",
])(
  "real Mastra checked progressive workflow: %s",
  async (scenario) => {
    const files = Array.from({ length: 64 }, (_, index) => ({
      path: `src/flow-${index}.ts`,
      sha: "a".repeat(40),
      size: 30,
    }));
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
      researches = 0;
    const keys = ["FACTORY_MODEL_BASE_URL", "FACTORY_MODEL_API_KEY"];
    const before = keys.map((key) => process.env[key]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = (await request.json()) as {
          messages: Array<{
            role: string;
            content: string | Array<{ type: string; text?: string }>;
          }>;
        };
        const body = {
          messages: incoming.messages.map((message) => ({
            ...message,
            content:
              typeof message.content === "string"
                ? message.content
                : (message.content.find((part) => part.type === "text")?.text ?? ""),
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
        if (system.includes("Research manifests")) output = { topics };
        else if (system.includes("Follow relationships")) {
          researches++;
          expect(publications).toBe(topics.findIndex((topic) => topic.slug === prompt.topic.slug));
          output = {
            findings: [
              {
                claim:
                  scenario === "invalid-research" && researches === 1
                    ? "x".repeat(1201)
                    : "Verified workflow",
                paths: prompt.topic.paths.slice(0, 8),
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
                      id: null,
                      slug: prompt.topic.slug,
                      title: prompt.topic.title,
                      body:
                        scenario === "verbose-overview" &&
                        !prompt.issues?.length &&
                        prompt.topic.slug === "overview"
                          ? "x".repeat(1201)
                          : !prompt.issues?.length && prompt.topic.slug === "overview"
                            ? "Useful verified behavior.\n\n## Sources\n\nSource noise."
                            : `Useful verified behavior for ${prompt.topic.slug}.${prompt.topic.parentSlug ? `\n\n[Overview](#wiki/${scenario === "broken-link" ? "missing-page" : "overview"})` : ""}`,
                      parentSlug:
                        scenario === "wrong-parent" && prompt.topic.slug !== "overview"
                          ? null
                          : prompt.topic.parentSlug,
                      sources: prompt.topic.paths,
                    },
                  ],
          };
        } else {
          checks++;
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
              message: { role: "assistant", content: JSON.stringify(output) },
              finish_reason: "stop",
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
        modelCalls: { remaining: scenario === "execution-bound" ? 1 : 32 },
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
      if (!["success", "invalid-research", "verbose-overview"].includes(scenario)) {
        await expect(run).rejects.toThrow(
          scenario === "publication-conflict"
            ? "Controlled revision conflict"
            : scenario === "execution-bound"
              ? "Wiki topic failed bounded quality checks"
              : "Wiki topic failed bounded quality checks",
        );
        expect(publications).toBe(
          ["publication-conflict", "execution-bound", "empty-topic"].includes(scenario) ? 0 : 1,
        );
        expect(checks).toBeLessThanOrEqual(4);
        return;
      }
      const result = await run;
      expect(result.pages).toEqual([]);
      expect(read.size).toBe(64);
      expect(publications).toBe(4);
      expect(writes).toBe(5);
      expect(checks).toBe(4);
      expect(researches).toBe(scenario === "invalid-research" ? 5 : 4);
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
