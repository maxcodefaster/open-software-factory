import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  wikiInstructions,
  wikiReviewTask,
} from "../../apps/factory/src/knowledge/generation-workflow";
import { nativeAgentPolicy, nativeStepGuard } from "../../apps/factory/src/models/execution-policy";
import { modelProviderOptions, nativeModel } from "../../apps/factory/src/models/native";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";

test.skipIf(process.env["FACTORY_WIKI_QUALITY_LIVE"] !== "1")(
  "native Wiki review accepts accurate source limitations and rejects invented guarantees",
  async () => {
    const modelId = "gpt-6-luna";
    if (process.env["FACTORY_PROJECT_AGENT_MODEL"] !== modelId)
      throw new Error("Explicit Luna planning configuration is required");
    const connection = projectModelConnection("knowledge");
    const providerOptions = modelProviderOptions(connection, modelId);
    const directory = resolve(".factory/test-results/wiki-review-quality", crypto.randomUUID());
    await mkdir(directory, { recursive: true });
    const sources = await Promise.all(
      ["test/auth.test.ts", "src/app.ts", "src/db/client.ts"].map(async (path) => ({
        path,
        content: await readFile(resolve("templates/starter-app", path), "utf8"),
      })),
    );
    const healthy = [
      "## HTTP test setup and cleanup",
      "The production-router example in test/auth.test.ts creates the application, asserts that its server is not listening, starts the listener and awaits the listening event before entering its try block. Its finally block removes the uniquely owned test user and closes the application. That cleanup is not reached if the initial listener setup fails.",
      "For new tests, include setup that allocates resources within cleanup protection and handle partial setup, including an application created but not yet listening. This is advice for adapting the pattern, not a claim that the existing test already protects that setup.",
      "## Database pools",
      "Each createDatabase() call configures its own PostgreSQL connection pool with max: 5. This is a per-pool setting, not an application-wide connection limit.",
    ].join("\n\n");
    const cases = [
      { name: "accurate-limitations-and-advice", body: healthy, reject: false },
      {
        name: "false-cleanup-guarantee",
        body: healthy.replace(
          "That cleanup is not reached if the initial listener setup fails.",
          "The existing test guarantees that its finally cleanup also runs if the initial listen() call throws before entering try.",
        ),
        reject: true,
      },
      {
        name: "false-global-pool",
        body: healthy.replace(
          "Each createDatabase() call configures its own PostgreSQL connection pool with max: 5. This is a per-pool setting, not an application-wide connection limit.",
          "Every createDatabase() call shares one global PostgreSQL pool. Even two independently created applications can never open more than five database connections in total.",
        ),
        reject: true,
      },
    ];
    const results: unknown[] = [];
    const requests = { remaining: 12 };
    try {
      for (const control of cases) {
        const signal = AbortSignal.timeout(90_000);
        const readSource = createTool({
          id: "read-wiki-source",
          description: "Read the exact supplied fixture source, never execute it.",
          inputSchema: z.object({ paths: z.array(z.string()).min(1).max(8) }),
          outputSchema: z.array(z.object({ path: z.string(), content: z.string() })),
          execute: async ({ paths }) =>
            paths.map((path) => {
              const source = sources.find((source) => source.path === path);
              if (!source) throw new Error("Source outside this calibration");
              return source;
            }),
        });
        const agent = new Agent({
          id: "checker",
          name: "Factory Wiki checker",
          ...nativeAgentPolicy,
          model: await nativeModel(connection, modelId),
          tools: { readSource },
          instructions: `${wikiInstructions}\n${wikiReviewTask}`,
        });
        const mastra = new Mastra({ agents: { checker: agent }, logger: noopLogger });
        const guard = nativeStepGuard({ signal, maxInputBytes: 1024 * 1024, requests });
        const output = await mastra.getAgent("checker").generate(
          JSON.stringify({
            topic: {
              slug: "http-tests",
              title: "HTTP tests and database pools",
              purpose:
                "Explain the existing HTTP test cleanup limitation, safe adaptation advice and per-pool connection scope.",
              paths: sources.map(({ path }) => path),
              pageIDs: [],
              parentSlug: "overview",
            },
            plannedTopics: [],
            findings: { findings: [], uncertainties: [] },
            currentPages: [
              {
                slug: "overview",
                state: "active",
                body: "Developer guidance is covered in the HTTP tests guide.",
              },
            ],
            draft: {
              pages: [
                {
                  id: null,
                  slug: "http-tests",
                  title: "HTTP tests and database pools",
                  parentSlug: "overview",
                  body: control.body,
                  sources: sources.map(({ path }) => path),
                },
              ],
            },
            sources,
          }),
          {
            maxSteps: 2,
            abortSignal: signal,
            prepareStep: async (step) => {
              await guard(step);
              if (step.stepNumber >= 1) return { toolChoice: "none" as const };
            },
            modelSettings: { maxRetries: 0, maxOutputTokens: 8000 },
            ...(providerOptions ? { providerOptions } : {}),
            structuredOutput: {
              schema: z.object({ issues: z.array(z.string().min(1).max(800)).max(12) }),
              jsonPromptInjection: "auto",
            },
          },
        );
        if (output.error) throw output.error;
        const issues = output.object?.issues;
        expect(issues).toBeDefined();
        results.push({ name: control.name, expectedRejection: control.reject, issues });
        expect((issues?.length ?? 0) > 0).toBe(control.reject);
      }
    } finally {
      await writeFile(
        resolve(directory, "result.json"),
        JSON.stringify({ modelId, results }, null, 2),
      );
    }
  },
  300_000,
);
