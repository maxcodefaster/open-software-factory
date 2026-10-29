import { expect, test } from "bun:test";
import { generateProjectResponse } from "./adapter";

for (const streaming of [false, true]) {
  for (const interruption of ["none", "authority", "cancelled"] as const) {
    test(`technical planning ${interruption === "none" ? "finishes after more than six steps and twelve lookups" : `stops extended research on ${interruption}`} (${streaming ? "stream" : "generate"})`, async () => {
      const projectID = crypto.randomUUID();
      const commit = "a".repeat(40);
      const paths = [
        "tools/workspace.mjs",
        "package.json",
        "README.md",
        "tools/workspace.test.mjs",
        "tools/workspace-help.test.mjs",
        "tools/verify.mjs",
        "tools/handoff.mjs",
        "tools/start.mjs",
      ];
      const calls = paths.flatMap((path) => [
        { name: "findCode", arguments: { query: path } },
        { name: "readCode", arguments: { path, commitSha: commit, startLine: 1, lineCount: 80 } },
      ]);
      const requests: { tools?: unknown[]; tool_choice?: unknown }[] = [];
      const inspected: string[] = [];
      const cancellation = new AbortController();
      let lookups = 0;
      const output = {
        output: {
          kind: "technical-design",
          message: "Add side-effect-free help to the existing helper.",
          design: {
            context: "The workspace helper already dispatches the existing commands.",
            proposedChanges: "Handle known help invocations before Git or network work.",
            decisions: ["Keep existing command behavior."],
            assumptions: [],
            risks: [],
            validation: [
              { criterion: 1, check: "Run the helper outside a repository with Git unavailable." },
            ],
            diagrams: [],
          },
          citations: [
            {
              source: "code",
              id: projectID,
              label: "Workspace helper",
              commitSha: commit,
              path: paths[0],
              reference: null,
            },
          ],
        },
      };
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            stream?: boolean;
            tools?: unknown[];
            tool_choice?: unknown;
          };
          const step = requests.push(body) - 1;
          const tool = calls[step];
          const toolCall = tool
            ? {
                id: `research-${step}`,
                type: "function",
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              }
            : undefined;
          if (body.stream) {
            const value = {
              id: `owned-${step}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "owned-technical-planning",
              choices: [
                {
                  index: 0,
                  delta: toolCall
                    ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
                    : { role: "assistant", content: JSON.stringify(output) },
                  finish_reason: null,
                },
              ],
            };
            const finish = {
              ...value,
              choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
            };
            return new Response(
              `data: ${JSON.stringify(value)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return Response.json({
            id: `owned-${step}`,
            object: "chat.completion",
            created: 1,
            model: "owned-technical-planning",
            choices: [
              {
                index: 0,
                message: toolCall
                  ? { role: "assistant", content: null, tool_calls: [toolCall] }
                  : { role: "assistant", content: JSON.stringify(output) },
                finish_reason: toolCall ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        },
      });
      try {
        const response = generateProjectResponse({
          mode: "plan",
          modelId: "owned-technical-planning",
          connection: {
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
            apiKey: "owned-no-provider",
          },
          technicalPlanning: {
            requirementRevisionId: crypto.randomUUID(),
            documentId: null,
            previousDesignId: null,
            sourceCommit: commit,
          },
          prompt: "Design a safe CLI help change for the confirmed requirements.",
          history: [],
          signal: AbortSignal.any([AbortSignal.timeout(10_000), cancellation.signal]),
          ...(streaming ? { answerText: async () => {} } : {}),
          research: {
            authorize: async () => {
              if (interruption === "authority" && lookups >= 14)
                throw new Error("Development authority revoked");
            },
            search: async () => [],
            read: async () => {
              throw new Error("No non-code source was requested");
            },
            code: {
              paths: async (query) => {
                lookups++;
                return { commitSha: commit, paths: [query], truncated: false };
              },
              read: async (input) => {
                lookups++;
                inspected.push(input.path);
                if (interruption === "cancelled" && lookups >= 14)
                  cancellation.abort(new Error("Planning cancelled"));
                return {
                  ...input,
                  body: "1: inspected source",
                  truncated: false,
                  url: `https://forge.invalid/${input.path}`,
                };
              },
            },
          },
        });
        if (interruption !== "none") {
          await expect(response).rejects.toThrow();
          expect(lookups).toBe(14);
          expect(requests).toHaveLength(14);
          return;
        }
        const result = await response;
        expect(result.kind).toBe("technical-design");
        expect(lookups).toBe(16);
        expect(inspected).toEqual(paths);
        expect(requests).toHaveLength(17);
        const final = requests.at(-1);
        // The model chose to finish after inspecting all sources. Factory did not
        // force an early answer by removing its research tools at a fixed step.
        expect((final?.tools ?? []).length).toBeGreaterThan(0);
        expect(final?.tool_choice ?? "auto").toBe("auto");
      } finally {
        await provider.stop(true);
      }
    }, 20_000);
  }
}
