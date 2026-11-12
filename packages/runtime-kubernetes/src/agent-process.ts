import type { RuntimeManifestInput } from "./manifest";
import { openCodeModelConfiguration, openCodeModelMetadata } from "./opencode-model";

// The same pinned OpenCode process/configuration for both concrete runtimes.
export function runtimeAgentProcess(
  agent: NonNullable<RuntimeManifestInput["agent"]>,
  generation: number,
) {
  return {
    name: "agent",
    command: [
      "sh",
      "-c",
      "umask 077; export OPENCODE_DB=/workspace/project/.git/factory-opencode.db; exec /opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs",
    ],
    env: {
      FACTORY_BUILD_BROWSER_COMMAND: `/tmp/factory-runtime-connector-${generation}`,
      FACTORY_BUILD_BROWSER_URL: agent.browserURL,
      FACTORY_BUILD_BROWSER_TOKEN: agent.browserToken,
      OPENCODE_PASSWORD: agent.modelToken,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      FACTORY_OPENCODE_TOKEN: agent.modelToken,
      FACTORY_OPENCODE_CONFIG: JSON.stringify({
        skills: ["/opt/factory/admitted-skills"],
        model: `factory/${agent.modelID}`,
        providers: {
          factory: {
            package: openCodeModelConfiguration(agent).package,
            canonical: agent.provider ?? "openai",
            env: ["FACTORY_OPENCODE_TOKEN"],
            name: "Factory",
            settings: {
              transport: "http",
              compaction: { type: "summary" },
              baseURL: agent.modelBaseURL,
              apiKey: agent.modelToken,
              ...openCodeModelConfiguration(agent).settings,
            },
            models: Object.fromEntries(
              agent.modelIDs.map((id) => [id, openCodeModelMetadata(agent.provider, id)]),
            ),
          },
        },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      }),
    },
  };
}
