import { expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import ts from "typescript";
import { modelProvider } from "#conversation-domain/model-connection";
import { modelProviderOptions, nativeModel } from "./native";
import { installationPlanningConnection } from "./resolver";

const keys = [
  "FACTORY_PLANNING_MODEL_BASE_URL",
  "FACTORY_PLANNING_MODEL_API_KEY",
  "FACTORY_PLANNING_MODEL_PROVIDER",
  "FACTORY_MODEL_BASE_URL",
  "FACTORY_MODEL_API_KEY",
  "FACTORY_MODEL_PROVIDER",
] as const;

async function withEnvironment<T>(
  environment: Partial<Record<(typeof keys)[number], string>>,
  operation: () => T | Promise<T>,
) {
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    return await operation();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

test.each([
  { path: "../learning/worker.ts", resolutions: 2 },
  { path: "../monitoring/worker-diagnose.ts", resolutions: 1 },
])(
  "$path background model resolution explicitly excludes personal configuration",
  async (input) => {
    const source = ts.createSourceFile(
      input.path,
      await Bun.file(new URL(input.path, import.meta.url)).text(),
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "resolve" &&
        ((ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "models") ||
          (ts.isPropertyAccessExpression(node.expression.expression) &&
            node.expression.expression.name.text === "models"))
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(calls).toHaveLength(input.resolutions);
    for (const call of calls) {
      const context = call.arguments[2];
      if (!context || !ts.isObjectLiteralExpression(context))
        throw new Error("Background model context must be explicit");
      const personal = context.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "personal",
      );
      if (!personal || !ts.isPropertyAssignment(personal))
        throw new Error("Background model resolution must exclude personal settings");
      expect(personal.initializer.kind).toBe(ts.SyntaxKind.FalseKeyword);
    }
  },
);

test("installation Planning uses role credentials and provider before shared defaults", async () => {
  await withEnvironment(
    {
      FACTORY_PLANNING_MODEL_BASE_URL: " https://planning.factory.test/v1/ ",
      FACTORY_PLANNING_MODEL_API_KEY: " owned-planning-key ",
      FACTORY_PLANNING_MODEL_PROVIDER: " anthropic ",
      FACTORY_MODEL_BASE_URL: "https://shared.factory.test/v1",
      FACTORY_MODEL_API_KEY: "owned-shared-key",
      FACTORY_MODEL_PROVIDER: "openai",
    },
    () => {
      expect(installationPlanningConnection()).toEqual({
        provider: "anthropic",
        baseURL: "https://planning.factory.test/v1",
        apiKey: "owned-planning-key",
      });
    },
  );
});

test("blank Planning fields inherit the shared installation values independently", async () => {
  await withEnvironment(
    {
      FACTORY_PLANNING_MODEL_BASE_URL: " ",
      FACTORY_PLANNING_MODEL_API_KEY: "",
      FACTORY_PLANNING_MODEL_PROVIDER: " ",
      FACTORY_MODEL_BASE_URL: "https://shared.factory.test/v1/",
      FACTORY_MODEL_API_KEY: "owned-shared-key",
      FACTORY_MODEL_PROVIDER: "deepseek",
    },
    () => {
      expect(installationPlanningConnection()).toEqual({
        provider: "deepseek",
        baseURL: "https://shared.factory.test/v1",
        apiKey: "owned-shared-key",
      });
    },
  );
  await withEnvironment(
    {
      FACTORY_PLANNING_MODEL_API_KEY: "owned-planning-key",
      FACTORY_MODEL_BASE_URL: "https://shared.factory.test/v1/",
      FACTORY_MODEL_API_KEY: "owned-shared-key",
    },
    () => {
      expect(installationPlanningConnection()).toEqual({
        provider: "openai",
        baseURL: "https://shared.factory.test/v1",
        apiKey: "owned-planning-key",
      });
    },
  );
});

test.each(modelProvider.options)(
  "%s installation Planning permits the native endpoint without a relay URL",
  async (provider) => {
    await withEnvironment(
      {
        FACTORY_PLANNING_MODEL_API_KEY: "owned-native-key",
        FACTORY_PLANNING_MODEL_PROVIDER: provider,
      },
      async () => {
        const connection = installationPlanningConnection();
        expect(connection).toEqual({ provider, apiKey: "owned-native-key" });
        const modelId = provider === "openai" ? "gpt-6-luna" : "owned-model";
        const model = await nativeModel(connection, modelId);
        if (provider === "openai") {
          if (typeof model !== "object" || model === null) throw new Error("Missing native model");
          expect(Reflect.get(model, "provider")).toBe("openai.responses");
          expect(modelProviderOptions(connection, modelId)).toEqual({
            openai: { reasoningEffort: "low", store: false },
          });
        } else {
          expect(model).toEqual({
            id: `${provider}/${modelId}` as const,
            apiKey: "owned-native-key",
          });
          expect(modelProviderOptions(connection, modelId)).toBeUndefined();
        }
      },
    );
  },
);

test.each(["", "   "])(
  "missing or blank credentials %j report unavailable without disclosing configuration",
  async (apiKey) => {
    await withEnvironment(
      {
        FACTORY_MODEL_BASE_URL: "https://private-host.factory.test/v1",
        FACTORY_MODEL_API_KEY: apiKey,
        FACTORY_PLANNING_MODEL_API_KEY: apiKey,
      },
      () => {
        expect(installationPlanningConnection).toThrow("The Planning model is not configured");
        try {
          installationPlanningConnection();
        } catch (cause) {
          expect(cause).toMatchObject({ code: "unavailable", status: 503 });
          expect(String(cause)).not.toContain("private-host");
        }
      },
    );
  },
);

test("an unsupported installation provider is rejected rather than translated to OpenAI", async () => {
  await withEnvironment(
    {
      FACTORY_PLANNING_MODEL_PROVIDER: "unsupported-provider",
      FACTORY_PLANNING_MODEL_API_KEY: "owned-private-key",
      FACTORY_MODEL_PROVIDER: "openai",
    },
    () => {
      expect(installationPlanningConnection).toThrow();
      try {
        installationPlanningConnection();
      } catch (cause) {
        expect(String(cause)).not.toContain("owned-private-key");
      }
    },
  );
});

test.each(modelProvider.options)(
  "resolved %s installation credentials retain native protocol and authentication",
  async (provider) => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = (await request.json()) as { model: string };
        expect(body.model).toBe("owned-model");
        if (provider === "anthropic") {
          expect(new URL(request.url).pathname).toBe("/v1/messages");
          expect(request.headers.get("x-api-key")).toBe("owned-native-key");
          expect(request.headers.get("authorization")).toBeNull();
          return Response.json({
            id: "msg_owned",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 1 },
          });
        }
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        expect(request.headers.get("authorization")).toBe("Bearer owned-native-key");
        expect(request.headers.get("x-api-key")).toBeNull();
        return Response.json({
          id: "chat_owned",
          object: "chat.completion",
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
      await withEnvironment(
        {
          FACTORY_PLANNING_MODEL_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          FACTORY_PLANNING_MODEL_API_KEY: "owned-native-key",
          FACTORY_PLANNING_MODEL_PROVIDER: provider,
        },
        async () => {
          const model = await nativeModel(installationPlanningConnection(), "owned-model");
          const result = await new Agent({
            id: "installation-planning-test",
            name: "Installation Planning test",
            instructions: "Answer briefly",
            model,
            maxRetries: 0,
          }).generate("hi", { abortSignal: AbortSignal.timeout(2000) });
          expect(result.text).toBe("ok");
          expect(requests).toBe(1);
        },
      );
    } finally {
      await server.stop(true);
    }
  },
);
