import type { CodingReasoning } from "#conversation-domain/model-settings";
import { nativeToolShell } from "./native-tool";
import { openCodeModelConfiguration, openCodeModelMetadata } from "./opencode-model";

export interface RuntimeAgentConfiguration {
  readonly modelBaseURL: string;
  readonly modelToken: string;
  readonly modelID: string;
  readonly modelIDs: readonly string[];
  readonly provider?: "openai" | "anthropic" | "deepseek";
  readonly reasoningEffort?: CodingReasoning;
  readonly browserToolsImage: string;
  readonly browserURL: string;
  readonly browserToken: string;
}

// The pinned OpenCode process inside the native Work container.
export function runtimeAgentProcess(agent: RuntimeAgentConfiguration) {
  return {
    name: "agent",
    command: [
      "sh",
      "-c",
      `umask 077; git_dir=$(git rev-parse --absolute-git-dir) || exit; export OPENCODE_DB="$git_dir/factory-opencode.db"
${nativeToolShell("bun")}
exec "$factory_runtime" /opt/factory-tools/opt/factory/opencode/server/server.mjs`,
    ],
    env: {
      FACTORY_BUILD_BROWSER_URL: agent.browserURL,
      FACTORY_BUILD_BROWSER_TOKEN: agent.browserToken,
      OPENCODE_PASSWORD: agent.modelToken,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      FACTORY_OPENCODE_TOKEN: agent.modelToken,
      FACTORY_OPENCODE_CONFIG: JSON.stringify({
        skills: ["/run/factory-skills/admitted"],
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
