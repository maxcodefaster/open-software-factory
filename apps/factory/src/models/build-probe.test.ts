import { expect, test } from "bun:test";
import { probeBuildModel } from "./build-probe";

test("native OpenCode Terra provider proves a structured tool call with supported reasoning settings", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer owned-native-key");
      const body = await request.json();
      expect(body.model).toBe("gpt-5.6-terra");
      expect(body.reasoning_effort).toBe("none");
      expect(body.tool_choice.function.name).toBe("factory_connection_probe");
      const chunk = {
        id: "owned",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "owned-tool",
                  type: "function",
                  function: {
                    name: "factory_connection_probe",
                    arguments: JSON.stringify({ verified: true, value: "factory-connection-ok" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "x-ratelimit-limit-tokens": "30000" },
      });
    },
  });
  try {
    const result = await probeBuildModel({
      connection: {
        provider: "openai",
        apiKey: "owned-native-key",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
      },
      modelId: "gpt-5.6-terra",
      signal: AbortSignal.timeout(3000),
    });
    expect(result).toMatchObject({
      status: "ready",
      toolCall: true,
      structuredOutput: true,
      limits: { tokens: 30000 },
    });
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});
test("native OpenCode provider errors and Stop are sanitized and never retried", async () => {
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
        return Response.json({ error: { message: "owned-sensitive-error" } }, { status });
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          provider: "openai",
          apiKey: "owned-sensitive-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: "owned-build-model",
        signal: AbortSignal.timeout(3000),
      });
      expect(result.status).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("owned-sensitive");
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  }
  const stopped = await probeBuildModel({
    connection: { apiKey: "unused" },
    modelId: "unused",
    signal: AbortSignal.abort(),
  });
  expect(stopped.status).toBe("stopped");
});
