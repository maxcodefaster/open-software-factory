import { expect, test } from "bun:test";
import { generateProjectResponse } from "./adapter";

for (const streaming of [false, true]) {
  test(`technical planning reserves final output after six real research steps (${streaming ? "stream" : "generate"})`, async () => {
    const projectID = crypto.randomUUID();
    const commit = "a".repeat(40);
    const paths = ["tools/workspace.mjs", "package.json", "README.md"];
    const calls = paths.flatMap((path) => [
      { name: "findCode", arguments: { query: path } },
      { name: "readCode", arguments: { path, commitSha: commit, startLine: 1, lineCount: 80 } },
    ]);
    const requests: { tools?: unknown[]; tool_choice?: unknown }[] = [];
    const inspected: string[] = [];
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
      const result = await generateProjectResponse({
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
        signal: AbortSignal.timeout(10_000),
        ...(streaming ? { answerText: async () => {} } : {}),
        research: {
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
      expect(result.kind).toBe("technical-design");
      expect(lookups).toBe(6);
      expect(inspected).toEqual(paths);
      expect(requests).toHaveLength(7);
      const final = requests.at(-1);
      expect(final?.tools ?? []).toHaveLength(0);
      expect(final?.tool_choice === undefined || final?.tool_choice === "none").toBe(true);
    } finally {
      await provider.stop(true);
    }
  }, 20_000);
}
