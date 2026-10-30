import { expect, test } from "bun:test";
import type { WikiPageSnapshot } from "../../../../packages/knowledge-domain/src/generation";
import { generateWiki } from "./generation-workflow";

test.each(["missing-guide", "genuine-no-op", "rejected-plan", "unavailable-reviewer"] as const)(
  "whole-Wiki planning checks useful coverage before accepting %s",
  async (scenario) => {
    const overview: WikiPageSnapshot = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Forms project",
      body:
        scenario === "genuine-no-op"
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
          plans++;
          if (plans > 1) {
            const correction = messages.find(
              (message) => message.role === "user" && message.content.includes('"correction"'),
            )?.content;
            expect(correction).toContain("Local setup and verification");
            expect(correction).toContain("rejectedResult");
          }
          output = {
            topics: scenario === "missing-guide" && plans > 1 ? [topic] : [],
          };
        } else if (system.includes("Review the whole proposed Wiki topic plan")) {
          coverageChecks++;
          if (scenario === "unavailable-reviewer")
            return Response.json(
              { error: { message: "Controlled unavailable coverage reviewer" } },
              { status: 503 },
            );
          output = {
            issues:
              scenario === "genuine-no-op" || (scenario === "missing-guide" && plans > 1)
                ? []
                : [
                    "Local setup and verification are deferred by the current overview, although docs/forms.md describes both. The empty plan leaves that useful guidance missing.",
                  ],
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
        inventory: [{ path: source.path, sha: "b".repeat(40), size: source.content.length }],
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
      if (scenario === "rejected-plan") {
        await expect(run).rejects.toThrow("Wiki topic plan omits essential reader coverage");
        expect([plans, coverageChecks, publications]).toEqual([2, 2, 0]);
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
