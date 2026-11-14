import { expect, test } from "bun:test";
import { runtimeAgentProcess } from "./agent-process";

test.each([undefined, "medium", "high"] as const)(
  "the native agent process retains its admitted configuration and scoped capabilities: %s",
  (reasoningEffort) => {
    const agent = {
      modelBaseURL: "https://factory.test/internal/model/owned/v1",
      modelToken: "owned-generation-model-token",
      modelID: "gpt-5.6-terra",
      modelIDs: ["gpt-5.6-terra", "approved-alternative", "gpt-6.1-sol"],
      ...(reasoningEffort ? { reasoningEffort } : {}),
      browserToolsImage: `registry.test/browser@sha256:${"a".repeat(64)}`,
      browserURL: "https://factory.test/internal/build-browser/owned",
      browserToken: "owned-generation-browser-token",
    };
    const process = runtimeAgentProcess(agent, 2);
    expect(process.name).toBe("agent");
    expect(process.command.slice(0, 2)).toEqual(["sh", "-c"]);
    const command = process.command[2];
    expect(command).toContain("/opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs");
    expect(command).toContain("OPENCODE_DB=/workspace/project/.git/factory-opencode.db");
    expect(command).not.toMatch(/opencode web|\.config\/opencode/);
    expect(process.env.OPENCODE_PASSWORD).toBe(agent.modelToken);
    expect(process.env.FACTORY_BUILD_BROWSER_COMMAND).toBe("/tmp/factory-runtime-connector-2");
    expect(process.env.FACTORY_BUILD_BROWSER_URL).toBe(agent.browserURL);
    expect(process.env.FACTORY_BUILD_BROWSER_TOKEN).toBe(agent.browserToken);
    const config = JSON.parse(process.env.FACTORY_OPENCODE_CONFIG);
    const provider = config.providers.factory;
    expect(config.skills).toEqual(["/opt/factory/admitted-skills"]);
    expect(provider.env).toEqual(["FACTORY_OPENCODE_TOKEN"]);
    expect(provider.settings).toMatchObject({
      transport: "http",
      compaction: { type: "summary" },
      baseURL: agent.modelBaseURL,
      apiKey: agent.modelToken,
      reasoningEffort: reasoningEffort ?? "none",
    });
    expect(provider.websocket).toBeUndefined();
    expect(provider.package).toBe(
      reasoningEffort
        ? "@opencode/ai/providers/openai/responses"
        : "@opencode/ai/providers/openai/chat",
    );
    expect(provider.models).toEqual({
      "gpt-5.6-terra": { name: "gpt-5.6-terra" },
      "approved-alternative": { name: "approved-alternative" },
      "gpt-6.1-sol": {
        name: "gpt-6.1-sol",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    });
    expect(JSON.stringify(process)).not.toMatch(
      /FACTORY_AUTH_SECRET|FACTORY_MODEL_API_KEY|FACTORY_FORGEJO_TOKEN/,
    );
  },
);
