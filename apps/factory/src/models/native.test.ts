import { expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { fakeResponsesOutput } from "../../../../test/support/fake-openai-responses";
import {
  modelProviderOptions,
  nativeEndpoints,
  nativeModel,
  providerCatalogue,
  validateModelEndpoint,
} from "./native";
import { modelProbeFailure, probeModel, reportedModelLimits } from "./probe";

test("native catalogue comes from pinned Mastra and contains only Factory-supported providers", async () => {
  const catalogue = await providerCatalogue();
  expect(catalogue.map((entry) => entry.provider)).toEqual(["openai", "anthropic", "deepseek"]);
  expect(catalogue.every((entry) => entry.models.length > 0)).toBe(true);
  expect(await nativeModel({ provider: "anthropic", apiKey: "test" }, "claude-haiku-4-5")).toEqual({
    id: "anthropic/claude-haiku-4-5",
    apiKey: "test",
  });
});

test.each(["gpt-6-luna", "gpt-6.1-sol"])(
  "native %s reasoning uses the Responses SDK without an enterprise URL override too",
  async (modelID) => {
    const model = await nativeModel({ provider: "openai", apiKey: "unused-native-model" }, modelID);
    if (typeof model !== "object" || model === null) throw new Error("Missing native SDK model");
    expect(Reflect.get(model, "provider")).toBe("openai.responses");
  },
);

test("the qualified Sol snapshot shares Responses/privacy policy without guessing other IDs", async () => {
  const modelID = "gpt-6.1-sol-2026-09-29";
  const model = await nativeModel({ provider: "openai", apiKey: "unused" }, modelID);
  if (typeof model !== "object" || model === null) throw new Error("Missing native SDK model");
  expect(Reflect.get(model, "provider")).toBe("openai.responses");
  expect(modelProviderOptions({ apiKey: "unused" }, modelID)).toEqual({
    openai: { store: false },
  });
  expect(modelProviderOptions({ apiKey: "unused" }, "gpt-6-luna")).toEqual({
    openai: { reasoningEffort: "low", store: false },
  });
  for (const id of [
    "gpt-6.1-sol-2026-09-30",
    "gpt-6-luna-2026-09-29",
    "custom-sol-deployment",
    "gpt-6.1-sol-latest",
    "unknown-model",
    "toString",
  ])
    expect(modelProviderOptions({ apiKey: "unused" }, id)).toBeUndefined();
  expect(
    modelProviderOptions({ provider: "anthropic", apiKey: "unused" }, modelID),
  ).toBeUndefined();
});

test("Planning uses the exact qualified Sol snapshot on both stateless Responses steps", async () => {
  let requests = 0;
  const modelID = "gpt-6.1-sol-2026-09-29";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/responses");
      const body = await request.json();
      expect(body.model).toBe(modelID);
      expect(body.store).toBe(false);
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
        apiKey: "owned-key",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
      },
      modelId: modelID,
      signal: AbortSignal.timeout(3000),
    });
    expect(result).toMatchObject({
      status: "ready",
      modelId: modelID,
      toolCall: true,
      structuredOutput: true,
    });
    expect(requests).toBe(2);
  } finally {
    await server.stop(true);
  }
});

test("conversation model choices omit known non-conversation OpenAI model families", async () => {
  const models = (await providerCatalogue()).find((entry) => entry.provider === "openai")?.models;
  expect(models).toContain("gpt-4.1");
  for (const id of [
    "chatgpt-image-latest",
    "gpt-image-1",
    "gpt-image-2",
    "gpt-realtime-2.1",
    "text-embedding-3-large",
    "text-embedding-3-small",
    "text-embedding-ada-002",
  ])
    expect(models).not.toContain(id);
});

test("endpoint policy rejects credentials, plaintext, native path spoofing and unapproved origins", () => {
  expect(validateModelEndpoint({ provider: "anthropic", endpoint: null })).toBe(
    nativeEndpoints.anthropic,
  );
  for (const endpoint of [
    "http://provider.test/v1",
    "https://key@provider.test/v1",
    "https://provider.test/v1?key=test",
    "https://provider.test/v1#key",
    "https://api.anthropic.com/proxy",
    "https://provider.test/%2e%2e/v1",
  ])
    expect(() => validateModelEndpoint({ provider: "anthropic", endpoint })).toThrow();
  expect(() =>
    validateModelEndpoint({ provider: "openai", endpoint: "https://private.test/v1" }),
  ).toThrow("modelAllowedOrigins");
  expect(
    validateModelEndpoint({ provider: "openai", endpoint: "https://private.test/v1/" }, [
      "https://private.test",
    ]),
  ).toBe("https://private.test/v1");
});

test("reported limits remain unknown when absent, invalid or outside safe integer range", () => {
  expect(reportedModelLimits(undefined)).toEqual({
    requests: null,
    tokens: null,
    remainingRequests: null,
    remainingTokens: null,
  });
  expect(
    reportedModelLimits({
      "X-RateLimit-Limit-Tokens": "2000",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-limit-requests": "-1",
      "x-ratelimit-remaining-requests": "9007199254740992",
    }),
  ).toEqual({ requests: null, tokens: 2000, remainingRequests: null, remainingTokens: 0 });
  expect(reportedModelLimits({ "anthropic-ratelimit-requests-limit": "50" }).requests).toBe(50);
});

test("probe errors expose only safe classification including nested native SDK errors and Stop", () => {
  expect(modelProbeFailure({ cause: { statusCode: 401, message: "provider-secret" } })).toBe(
    "invalid-credentials",
  );
  expect(modelProbeFailure({ statusCode: 403 })).toBe("model-denied");
  expect(modelProbeFailure({ statusCode: 429 })).toBe("rate-limited");
  expect(modelProbeFailure({ statusCode: 400 })).toBe("unsupported");
  expect(modelProbeFailure(new Error("provider-secret"))).toBe("unavailable");
  expect(modelProbeFailure({}, AbortSignal.abort())).toBe("stopped");
  expect(
    modelProbeFailure({}, AbortSignal.abort(new DOMException("expired", "TimeoutError"))),
  ).toBe("timeout");
});

test("enterprise Anthropic endpoint uses native Messages SDK and x-api-key, not chat translation", async () => {
  let requestCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requestCount++;
      expect(new URL(request.url).pathname).toBe("/v1/messages");
      expect(request.headers.get("x-api-key")).toBe("test-native-key");
      expect(request.headers.get("authorization")).toBeNull();
      const body = (await request.json()) as { model: string };
      expect(body.model).toBe("claude-haiku-4-5");
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    },
  });
  try {
    const model = await nativeModel(
      {
        provider: "anthropic",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-native-key",
      },
      "claude-haiku-4-5",
    );
    await new Agent({
      id: "native-request-test",
      name: "Native request test",
      instructions: "Answer briefly",
      model,
      maxRetries: 0,
    }).generate("hi", { abortSignal: AbortSignal.timeout(2000) });
    expect(requestCount).toBe(1);
  } finally {
    await server.stop(true);
  }
});
