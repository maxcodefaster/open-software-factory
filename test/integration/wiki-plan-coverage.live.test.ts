import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  wikiInstructions,
  wikiPlanReviewTask,
} from "../../apps/factory/src/knowledge/generation-workflow";
import { nativeAgentPolicy, nativeStepGuard } from "../../apps/factory/src/models/execution-policy";
import { modelProviderOptions, nativeModel } from "../../apps/factory/src/models/native";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";

const active = new Set<AbortController>();
afterAll(() => {
  for (const controller of active) controller.abort();
});

test.skipIf(process.env["FACTORY_WIKI_PLAN_COVERAGE_LIVE"] !== "1")(
  "native Wiki plan review distinguishes research intent, missing guidance and a genuine no-op",
  async () => {
    const modelId = "gpt-6-luna";
    if (process.env["FACTORY_PROJECT_AGENT_MODEL"] !== modelId)
      throw new Error("Explicit Luna planning configuration is required");
    const connection = projectModelConnection("knowledge");
    const providerOptions = modelProviderOptions(connection, modelId);
    const directory = resolve(".factory/test-results/wiki-plan-quality", crypto.randomUUID());
    await mkdir(directory, { recursive: true });
    const sources = [
      {
        path: "package.json",
        content:
          '{"name":"forms-fixture","scripts":{"dev":"node src/server.mjs","test":"node --test"}}',
      },
      {
        path: "src/routes.ts",
        content:
          'export const operations = ["create draft", "update draft", "publish", "read versions", "read audit", "rollback"];',
      },
      {
        path: "docs/editor-architecture.md",
        content:
          "# Target architecture\nThe component studio and draft-preview design are future targets. This document does not establish an implemented editor UI or preview-security guarantees.",
      },
    ];
    const overview = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Forms API",
      state: "active",
      body: "A Forms API with draft and publication operations. Detailed authoring guidance is planned.",
    };
    const development = {
      id: crypto.randomUUID(),
      slug: "development",
      title: "Development",
      state: "active",
      body: "Start the fixture with npm run dev. Run its checks with npm test.",
    };
    const researchTopic = {
      slug: "forms-authoring",
      title: "Author and publish Forms safely",
      purpose:
        "Investigate the declared draft, publication, version, audit and rollback operations. Explain only supported current behavior and distinguish it from the future editor/preview design. Inspect focused implementation and tests before making any guarantees.",
      paths: sources.map(({ path }) => path),
      pageIDs: [],
      parentSlug: "overview",
    };
    const cases = [
      {
        name: "research-topic-is-not-a-guarantee",
        pages: [overview, development],
        topics: [researchTopic],
        reject: false,
      },
      {
        name: "missing-authoring-guidance",
        pages: [overview, development],
        topics: [],
        reject: true,
      },
      {
        name: "genuine-complete-no-op",
        pages: [
          { ...overview, body: "A Forms API. See Development and Forms operations for guidance." },
          development,
          {
            id: crypto.randomUUID(),
            slug: "forms-operations",
            title: "Forms operations",
            state: "active",
            body: "The route manifest declares create draft, update draft, publish, version reads, audit reads and rollback. It supplies no detailed authorization or validation implementation. The editor architecture describes a future component studio and draft-preview design; do not treat these as implemented UI or preview-security guarantees.",
          },
        ],
        topics: [],
        reject: false,
      },
    ];
    const results: unknown[] = [];
    const controller = new AbortController();
    active.add(controller);
    try {
      for (const control of cases) {
        const readSource = createTool({
          id: "read-wiki-source",
          description: "Read exact supplied calibration source without executing it.",
          inputSchema: z.object({ paths: z.array(z.string()).min(1).max(8) }),
          outputSchema: z.array(z.object({ path: z.string(), content: z.string() })),
          execute: async ({ paths }) =>
            paths.map((path) => {
              const file = sources.find((file) => file.path === path);
              if (!file) throw new Error("Source outside this calibration");
              return file;
            }),
        });
        const agent = new Agent({
          id: "topic-plan-checker",
          name: "Factory Wiki topic-plan checker",
          ...nativeAgentPolicy,
          model: await nativeModel(connection, modelId),
          tools: { readSource },
          instructions: `${wikiInstructions}\n${wikiPlanReviewTask}`,
        });
        const mastra = new Mastra({ agents: { checker: agent }, logger: noopLogger });
        const started = performance.now();
        const output = await mastra.getAgent("checker").generate(
          JSON.stringify({
            project: "Forms planning calibration",
            files: sources.map(({ path, content }) => ({
              path,
              sha: "a".repeat(40),
              size: content.length,
            })),
            changedPaths: [],
            currentPages: control.pages,
            completedPageIDs: [],
            proposedTopics: control.topics,
            sources,
          }),
          {
            maxSteps: Infinity,
            abortSignal: controller.signal,
            prepareStep: nativeStepGuard({
              signal: controller.signal,
              maxInputBytes: 1024 * 1024,
            }),
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
        results.push({
          name: control.name,
          expectedRejection: control.reject,
          issues,
          elapsedMS: Math.round(performance.now() - started),
        });
        expect(issues).toBeDefined();
        expect((issues?.length ?? 0) > 0).toBe(control.reject);
      }
    } finally {
      controller.abort();
      active.delete(controller);
      await writeFile(
        resolve(directory, "result.json"),
        JSON.stringify(
          {
            modelId,
            instructionsSHA256: createHash("sha256")
              .update(`${wikiInstructions}\n${wikiPlanReviewTask}`)
              .digest("hex"),
            results,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ evidence: directory, casesObserved: results.length }));
    }
  },
  300_000,
);
