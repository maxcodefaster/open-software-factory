import { expect, test } from "bun:test";
import { nativeInputSize } from "../models/execution-policy";
import { generateProjectResponse } from "./adapter";
import { compactResearchPrompt, createResearchContextProcessor } from "./research-context";

test.each([
  { transport: "chat", modelId: "owned-research-context" },
  { transport: "responses", modelId: "gpt-6.1-sol" },
])(
  "read-only $transport research finishes after source pages exceed the prompt bound",
  async ({ transport, modelId }) => {
    const commitSha = "a".repeat(40);
    const paths = Array.from({ length: 24 }, (_, index) => `src/routes/page-${index}.astro`);
    const firstPath = paths[0];
    if (!firstPath) throw new Error("Missing first owned source");
    const reads: string[] = [];
    const prompts: string[] = [];
    let step = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe(
          transport === "chat" ? "/v1/chat/completions" : "/v1/responses",
        );
        const body = (await request.json()) as {
          messages?: unknown[];
          input?: unknown[];
          store?: boolean;
        };
        prompts.push(JSON.stringify(body.messages ?? body.input));
        if (transport === "responses") expect(body.store).toBe(false);
        const selected = paths.slice((step - 1) * 4, step * 4);
        const calls: Array<{ name: string; args: Record<string, string | number> }> =
          step === 0
            ? [{ name: "findCode", args: { query: "src/routes" } }]
            : selected.map((path) => ({
                name: "readCode",
                args: { commitSha, path, startLine: 1, lineCount: 80 },
              }));
        if (step === 7)
          calls.push({
            name: "readCode",
            args: { commitSha, path: firstPath, startLine: 1, lineCount: 80 },
          });
        const done = step > 0 && !calls.length;
        step++;
        const output = JSON.stringify({
          output: {
            kind: "answer",
            message: "All requested immutable source pages were inspected.",
            citations: [],
          },
        });
        if (transport === "responses")
          return Response.json({
            id: `resp-owned-research-${step}`,
            created_at: 1,
            model: modelId,
            status: "completed",
            output: done
              ? [
                  {
                    type: "message",
                    id: `msg-owned-research-${step}`,
                    role: "assistant",
                    content: [{ type: "output_text", annotations: [], text: output }],
                  },
                ]
              : calls.map((call, index) => ({
                  type: "function_call",
                  id: `fc-read-${step}-${index}`,
                  call_id: `read-${step}-${index}`,
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                })),
            usage: { input_tokens: 10, output_tokens: 10 },
          });
        return Response.json({
          id: `owned-research-${step}`,
          object: "chat.completion",
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              message: done
                ? {
                    role: "assistant",
                    content: output,
                  }
                : {
                    role: "assistant",
                    tool_calls: calls.map((call, index) => ({
                      id: `read-${step}-${index}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.args) },
                    })),
                  },
              finish_reason: done ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      },
    });
    try {
      const result = await generateProjectResponse({
        mode: "investigate",
        modelId,
        connection: {
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "owned-research-context",
        },
        prompt: "Inspect all source pages. HUMAN_SCOPE_MUST_REMAIN_READ_ONLY.",
        history: [],
        signal: AbortSignal.timeout(8_000),
        research: {
          search: async () => [],
          read: async () => {
            throw new Error("This fixture inspects immutable code only");
          },
          code: {
            projectID: crypto.randomUUID(),
            paths: async () => ({ commitSha, paths, truncated: false }),
            read: async (input) => {
              reads.push(input.path);
              return {
                ...input,
                body: `1: IMMUTABLE_BODY_FOR_${input.path}\n${"// retained immutable route implementation\n".repeat(400)}`.slice(
                  0,
                  15_500,
                ),
                truncated: false,
                url: `https://forge.invalid/source/${commitSha}/${input.path}`,
              };
            },
          },
        },
      });
      expect(result).toMatchObject({
        kind: "answer",
        message: "All requested immutable source pages were inspected.",
      });
      expect(reads).toEqual(paths);
      expect(prompts).toHaveLength(9);
      for (const prompt of prompts) expect(prompt).toContain("HUMAN_SCOPE_MUST_REMAIN_READ_ONLY");
      for (const path of paths.slice(-4))
        expect(prompts[7]).toContain(`IMMUTABLE_BODY_FOR_${path}`);
      expect(prompts.at(-1)).toContain(`IMMUTABLE_BODY_FOR_${firstPath}`);
      expect(prompts.at(-1)).toContain("sourceTextOmittedFromPrompt");
      expect(Math.max(...prompts.map((prompt) => Buffer.byteLength(prompt)))).toBeLessThan(
        paths.length * 15_500,
      );
    } finally {
      await provider.stop(true);
    }
  },
);

type Prompt = Parameters<typeof compactResearchPrompt>[0];

function sourceStep(id: string, body: string): Prompt {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "readCode",
          input: {
            commitSha: "a".repeat(40),
            path: `src/${id}.astro`,
            startLine: 1,
            lineCount: 80,
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "readCode",
          output: {
            type: "json",
            value: {
              body,
              path: `src/${id}.astro`,
              commitSha: "a".repeat(40),
              startLine: 1,
              lineCount: 80,
              citation: { id: "owned-project", source: "code", reference: 1 },
              truncated: false,
            },
          },
        },
      ],
    },
  ];
}

test("prompt compaction retains authority, paired calls, source provenance and the latest reads", () => {
  const prompt: Prompt = [
    { role: "system", content: "Binding read-only authority" },
    { role: "user", content: [{ type: "text", text: "All authored decisions remain intact" }] },
    ...sourceStep("old", "old immutable source\n".repeat(14_000)),
    ...sourceStep("latest", "latest immutable source"),
  ];
  const before = JSON.stringify(prompt);
  const projected = compactResearchPrompt(prompt);
  expect(JSON.stringify(prompt)).toBe(before);
  expect(projected[0]).toBe(prompt[0]);
  expect(projected[1]).toBe(prompt[1]);
  expect(projected[2]).toBe(prompt[2]);
  expect(projected.at(-1)).toBe(prompt.at(-1));
  const message = projected[3];
  if (message?.role !== "tool") throw new Error("Missing paired source result");
  expect(message.content[0]).toMatchObject({
    toolCallId: "old",
    toolName: "readCode",
    output: {
      type: "json",
      value: {
        sourceTextOmittedFromPrompt: true,
        path: "src/old.astro",
        commitSha: "a".repeat(40),
        citation: { id: "owned-project", source: "code", reference: 1 },
        reread: {
          tool: "readCode",
          arguments: {
            path: "src/old.astro",
            commitSha: "a".repeat(40),
            startLine: 1,
            lineCount: 80,
          },
        },
      },
    },
  });
  expect(nativeInputSize({ messages: projected, systemMessages: [] }).textBytes).toBeLessThan(
    256 * 1024,
  );
  const short = sourceStep("small", "Small source read");
  expect(compactResearchPrompt(short)).toBe(short);
});

test("source compaction cannot bypass oversized authored input, latest results or authority loss", async () => {
  const processor = createResearchContextProcessor({
    signal: AbortSignal.timeout(2_000),
    authorize: async () => {},
  });
  const process = (prompt: Prompt) =>
    processor.processLLMRequest?.({
      prompt,
    } as Parameters<NonNullable<typeof processor.processLLMRequest>>[0]);
  await expect(
    process([
      { role: "user", content: [{ type: "text", text: "x".repeat(256 * 1024) }] },
      ...sourceStep("old", "old source\n".repeat(25_000)),
      ...sourceStep("latest", "latest source"),
    ]),
  ).rejects.toThrow("Model input bound reached");
  await expect(process(sourceStep("latest", "new source\n".repeat(30_000)))).rejects.toThrow(
    "Model input bound reached",
  );
  const mutations: Prompt = sourceStep(
    "mutation",
    "retained effectful result\n".repeat(12_000),
  ).map((message) => {
    if (message.role === "assistant")
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool-call" ? { ...part, toolName: "createTicket" } : part,
        ),
      };
    if (message.role === "tool")
      return {
        ...message,
        content: message.content.map((part) => ({ ...part, toolName: "createTicket" })),
      };
    return message;
  });
  await expect(process([...mutations, ...sourceStep("latest", "latest source")])).rejects.toThrow(
    "Model input bound reached",
  );
  const revoked = createResearchContextProcessor({
    signal: AbortSignal.timeout(2_000),
    authorize: async () => {
      throw new Error("Execution authority ended");
    },
  });
  await expect(
    revoked.processLLMRequest?.({
      prompt: sourceStep("small", "small source"),
    } as Parameters<NonNullable<typeof revoked.processLLMRequest>>[0]),
  ).rejects.toThrow("Execution authority ended");
});
