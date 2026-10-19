import { expect, test } from "bun:test";
import { probeBuildModel } from "./build-probe";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";

test.each(["medium", "high", "xhigh", "max"] as const)(
  "native OpenCode uses Responses with %s reasoning and a real structured tool call",
  async (reasoningEffort) => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        expect(new URL(request.url).pathname).toBe("/v1/responses");
        expect(request.headers.get("authorization")).toBe("Bearer owned-native-key");
        const body = await request.json();
        expect(body.model).toBe("gpt-6.1-sol");
        expect(body.reasoning.effort).toBe(reasoningEffort);
        expect(body.store).toBe(false);
        expect(body.include).toContain("reasoning.encrypted_content");
        expect(body.tool_choice.name).toBe("factory_connection_probe");
        const item = {
          id: "owned-item",
          call_id: "owned-tool",
          type: "function_call" as const,
          name: "factory_connection_probe",
          arguments: JSON.stringify({ verified: true, value: "factory-connection-ok" }),
        };
        const response = fakeResponsesOutput(item);
        response.headers.set("x-ratelimit-limit-tokens", "30000");
        return response;
      },
    });
    try {
      const result = await probeBuildModel({
        connection: {
          provider: "openai",
          apiKey: "owned-native-key",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: "gpt-6.1-sol",
        reasoningEffort,
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
  },
);
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
