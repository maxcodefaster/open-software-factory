import { expect, test } from "bun:test";
import { probeModel } from "./probe";

test("actual native probe executes a tool and structured output in two requests with reported limits", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/messages");
      const body = (await request.json()) as {
        model: string;
        tools: Array<{ name: string }>;
        messages: unknown[];
      };
      expect(body.tools.some((tool) => tool.name === "probe")).toBe(true);
      if (requests === 2) expect(JSON.stringify(body.messages)).toContain("factory-connection-ok");
      return Response.json(
        {
          id: `msg_${requests}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content:
            requests === 1
              ? [{ type: "tool_use", id: "tool_owned", name: "probe", input: {} }]
              : [
                  {
                    type: "text",
                    text: JSON.stringify({ verified: true, value: "factory-connection-ok" }),
                  },
                ],
          stop_reason: requests === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 5 },
        },
        {
          headers: {
            "anthropic-ratelimit-tokens-limit": "20000",
            "anthropic-ratelimit-requests-remaining": "9",
          },
        },
      );
    },
  });
  try {
    const result = await probeModel({
      connection: {
        provider: "anthropic",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "owned-probe-key",
      },
      modelId: "claude-haiku-4-5",
      signal: AbortSignal.timeout(2000),
    });
    expect(result).toMatchObject({
      status: "ready",
      toolCall: true,
      structuredOutput: true,
      limits: { tokens: 20000, remainingRequests: 9, requests: null },
    });
    expect(requests).toBe(2);
  } finally {
    await server.stop(true);
  }
});

test("actual probe does not retry invalid credentials, forbidden models or 429 and never returns provider secrets", async () => {
  for (const [status, expected] of [
    [401, "invalid-credentials"],
    [403, "model-denied"],
    [429, "rate-limited"],
  ] as const) {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json(
          {
            type: "error",
            error: { type: "authentication_error", message: "owned-sensitive-response" },
          },
          { status },
        );
      },
    });
    try {
      const result = await probeModel({
        connection: {
          provider: "anthropic",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "owned-sensitive-key",
        },
        modelId: "claude-haiku-4-5",
        signal: AbortSignal.timeout(2000),
      });
      expect(result.status).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("owned-sensitive");
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  }
});

test("Stop before probe performs no provider request", async () => {
  const result = await probeModel({
    connection: { provider: "openai", apiKey: "not-used" },
    modelId: "gpt-6-luna",
    signal: AbortSignal.abort(),
  });
  expect(result.status).toBe("stopped");
  expect(result.toolCall).toBe(false);
});
