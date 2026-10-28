import { expect, test } from "bun:test";
import { probeModel } from "./probe";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";

test.each(["gpt-6-luna", "gpt-6.1-sol"])(
  "native Planning probe uses Responses tools and structured output for %s",
  async (modelID) => {
    let requests = 0;
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path !== "/v1/responses")
          return Response.json(
            { error: { message: "Reasoning tools need Responses" } },
            { status: 422 },
          );
        const body = await request.json();
        expect(body.model).toBe(modelID);
        expect(body.store).toBe(false);
        expect(body.reasoning?.effort).not.toBe("none");
        if (requests === 2) expect(JSON.stringify(body.input)).toContain("factory-connection-ok");
        const item =
          requests === 1
            ? {
                type: "function_call" as const,
                id: "owned-probe-item",
                call_id: "owned-probe-call",
                name: "probe",
                arguments: "{}",
              }
            : {
                type: "message" as const,
                id: "owned-probe-answer",
                role: "assistant" as const,
                content: [
                  {
                    type: "output_text" as const,
                    annotations: [] as never[],
                    text: JSON.stringify({ verified: true, value: "factory-connection-ok" }),
                  },
                ],
              };
        if (body.stream) return fakeResponsesOutput(item);
        return Response.json({
          id: "resp_owned_probe",
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
      const result = await probeModel({
        connection: {
          provider: "openai",
          apiKey: "owned-responses-probe",
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        },
        modelId: modelID,
        signal: AbortSignal.timeout(3000),
      });
      expect(result).toMatchObject({ status: "ready", toolCall: true, structuredOutput: true });
      expect(requests).toBe(2);
      expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
    } finally {
      await server.stop(true);
    }
  },
);

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
