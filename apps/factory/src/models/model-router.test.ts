import { expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";
import { nativeModel } from "./native";

// Qualification of the official router, not a second Factory provider implementation.
test.each(["anthropic", "deepseek", "openai"])(
  "Mastra URL overrides select compatible Chat, not the native %s adapter",
  async (provider) => {
    const router = new ModelRouterLanguageModel({
      id: `${provider}/owned-model`,
      url: "https://owned-endpoint.invalid/v1",
      apiKey: "owned-key",
      headers: { "x-owned-header": "owned-secret" },
    });
    expect(await router.resolveApiProviderId()).toBe(`${provider}.chat`);
    expect(router.serializeForSpan()).not.toHaveProperty("config");
    const serialized = JSON.stringify(router.serializeForSpan());
    for (const privateValue of ["owned-endpoint", "owned-key", "owned-secret"])
      expect(serialized).not.toContain(privateValue);
  },
);

test.each(["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-sol-2026-09-29"])(
  "Mastra explicit Responses sends %s tools, provider options and headers privately",
  async (modelID) => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        expect(new URL(request.url).pathname).toBe("/v1/responses");
        expect(request.headers.get("authorization")).toBe("Bearer owned-router-key");
        expect(request.headers.get("x-owned-header")).toBe("owned-header");
        const body = await request.json();
        expect(body.model).toBe(modelID);
        expect(body.store).toBe(false);
        expect(body.reasoning.effort).toBe("low");
        expect(body.tools[0].name).toBe("owned_tool");
        const item = {
          id: "owned-item",
          call_id: "owned-call",
          type: "function_call" as const,
          name: "owned_tool",
          arguments: "{}",
        };
        if (body.stream) return fakeResponsesOutput(item);
        return Response.json({
          id: "resp_owned",
          created_at: 1,
          status: "completed",
          model: modelID,
          output: [item],
          error: null,
          incomplete_details: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      },
    });
    try {
      const router = new ModelRouterLanguageModel({
        id: `openai/${modelID}`,
        url: `http://127.0.0.1:${server.port}/v1`,
        api: "responses",
        apiKey: "owned-router-key",
        headers: { "x-owned-header": "owned-header" },
      });
      expect(await router.resolveApiProviderId()).toBe("openai.responses");
      const result = await new Agent({
        id: "router-qualification",
        name: "Router qualification",
        instructions: "Call owned_tool.",
        model: router,
        maxRetries: 0,
        tools: {
          owned_tool: createTool({
            id: "owned_tool",
            description: "Return a test value",
            inputSchema: z.object({}).strict(),
          }),
        },
      }).generate("hi", {
        abortSignal: AbortSignal.timeout(2000),
        maxSteps: 1,
        providerOptions: { openai: { reasoningEffort: "low", store: false } },
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  },
);

test("Mastra compatible OpenAI Chat preserves options but not native reasoning token limits", async () => {
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer owned-router-key");
      const body = await request.json();
      bodies.push(body);
      expect(body.store).toBe(false);
      expect(body.reasoning_effort).toBe("low");
      return Response.json({
        id: "chatcmpl_owned",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    },
  });
  try {
    const baseURL = `http://127.0.0.1:${server.port}/v1`;
    for (const model of [
      { id: "openai/gpt-5.6-terra" as const, url: baseURL, apiKey: "owned-router-key" },
      await nativeModel(
        { provider: "openai", baseURL, apiKey: "owned-router-key" },
        "gpt-5.6-terra",
      ),
    ])
      await new Agent({
        id: "router-chat-qualification",
        name: "Router Chat qualification",
        instructions: "Answer briefly.",
        model,
        maxRetries: 0,
      }).generate("hi", {
        abortSignal: AbortSignal.timeout(2000),
        modelSettings: { maxOutputTokens: 64 },
        providerOptions: { openai: { store: false, reasoningEffort: "low" } },
      });
    expect(requests).toBe(2);
    expect(bodies[0]).toMatchObject({ max_tokens: 64 });
    expect(bodies[0]).not.toHaveProperty("max_completion_tokens");
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 64 });
    expect(bodies[1]).not.toHaveProperty("max_tokens");
  } finally {
    await server.stop(true);
  }
});

test("Mastra compatible Chat does not backfill required native DeepSeek V4 reasoning history", async () => {
  const modelID = "deepseek-v4-pro";
  const bodies: { messages: { role: string; reasoning_content?: string }[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer owned-deepseek-key");
      const body = await request.json();
      bodies.push(body);
      const toolCall = bodies.length % 2 === 1;
      return Response.json({
        id: "chatcmpl_owned",
        created: 1,
        model: modelID,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: toolCall ? "" : "ok",
              ...(toolCall
                ? {
                    tool_calls: [
                      {
                        id: "owned-tool",
                        type: "function",
                        function: { name: "owned_tool", arguments: "{}" },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    },
  });
  try {
    const baseURL = `http://127.0.0.1:${server.port}/v1`;
    for (const model of [
      { id: `deepseek/${modelID}` as const, url: baseURL, apiKey: "owned-deepseek-key" },
      await nativeModel({ provider: "deepseek", baseURL, apiKey: "owned-deepseek-key" }, modelID),
    ]) {
      const result = await new Agent({
        id: "router-deepseek-qualification",
        name: "Router DeepSeek qualification",
        instructions: "Call owned_tool, then answer.",
        model,
        maxRetries: 0,
        tools: {
          owned_tool: createTool({
            id: "owned_tool",
            description: "Return a test value",
            inputSchema: z.object({}).strict(),
            execute: async () => ({ value: "owned-value" }),
          }),
        },
      }).generate("hi", { abortSignal: AbortSignal.timeout(2000), maxSteps: 2 });
      expect(result.text).toBe("ok");
    }
    expect(bodies).toHaveLength(4);
    expect(bodies[1]?.messages.find((message) => message.role === "assistant")).not.toHaveProperty(
      "reasoning_content",
    );
    expect(bodies[3]?.messages.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_content: "",
    });
  } finally {
    await server.stop(true);
  }
});
