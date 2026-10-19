import type { SystemContract } from "../../system-contract/src/system-contract";
import { renderEnvboxPod } from "./envbox-pod";
import { verificationSupervisor } from "./verification-process";
import { openCodeModelConfiguration } from "./opencode-model";
import type { CodingReasoning } from "../../conversation-domain/src/model-settings";

export interface RuntimeManifestInput {
  readonly attemptID: string;
  readonly generation: number;
  readonly namespace: string;
  readonly podName: string;
  readonly projectID: string;
  readonly runtimeOwnerID?: string;
  readonly mode?: "development" | "staging" | "verification" | "prebuild";
  readonly repositoryURL: string;
  readonly repositoryIdentity?: string;
  readonly preserveWorkspace?: boolean;
  readonly storageNode?: string;
  readonly revision: string;
  readonly devcontainerPath: string;
  readonly composeProjectName: string;
  readonly connectorToken: string;
  readonly childConnectorToken: string;
  readonly controlURL: string;
  readonly runtimeHostImage: string;
  readonly registryCA: string;
  readonly environmentVersion?: number;
  readonly prebuild?: {
    readonly id: string;
    readonly platform: "native" | "linux/arm64" | "linux/amd64";
    readonly imageRepository: string;
  };
  readonly systemContract?: SystemContract;
  readonly agent?: {
    readonly modelBaseURL: string;
    readonly modelToken: string;
    readonly modelID: string;
    readonly modelIDs: readonly string[];
    readonly provider?: "openai" | "anthropic" | "deepseek";
    readonly reasoningEffort?: CodingReasoning;
    readonly browserToolsImage: string;
    readonly browserURL: string;
    readonly browserToken: string;
  };
  readonly verification?: {
    readonly forgeURL: string;
    readonly runnerUUID: string;
    readonly runnerToken: string;
    readonly runnerLabel: string;
  };
}

export function renderRuntimeResources(input: RuntimeManifestInput) {
  const ownerID = input.runtimeOwnerID ?? input.attemptID;
  const mode = input.mode ?? "development";
  if (input.agent && !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(input.agent.browserToolsImage))
    throw new Error("Build browser image must be pinned by exact digest");
  if (mode !== "verification" && mode !== "prebuild" && !input.systemContract) {
    throw new Error("A System Contract is required outside Verification");
  }
  const apps =
    mode === "verification" || mode === "prebuild" ? [] : (input.systemContract?.apps ?? []);
  const primaryApp = input.systemContract?.primaryApp;
  const runtimeName = (appID: string) => (appID === primaryApp ? "app" : `app-${appID}`);
  const namespaceLabels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/project": input.projectID,
    "factory.dev/runtime-owner": ownerID,
  };
  const labels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-attempt": input.attemptID,
    "factory.dev/runtime-generation": String(input.generation),
    "factory.dev/project": input.projectID,
    "factory.dev/runtime-owner": ownerID,
  };
  const assignment = JSON.stringify({
    version: 1,
    runtimeAttemptId: input.attemptID,
    generation: input.generation,
    workspaceFolder: "/home/coder/project",
    remoteWorkspaceFolder: "/workspace/project",
    repositoryUrl: input.repositoryURL,
    repositoryIdentity: input.repositoryIdentity ?? input.projectID,
    preserveWorkspace: input.preserveWorkspace ?? false,
    revision: input.revision,
    devcontainerPath: input.devcontainerPath,
    composeProjectName: input.composeProjectName,
    controlUrl: input.controlURL,
    ...(input.prebuild ? { prebuild: input.prebuild } : {}),
    ...(input.environmentVersion === undefined
      ? {}
      : { environmentVersion: input.environmentVersion }),
    ...(input.agent ? { browserToolsImage: input.agent.browserToolsImage } : {}),
    channels: [
      ...apps.map((app) => ({
        name: runtimeName(app.id),
        kind: "app",
        target: `http://127.0.0.1:${app.port}`,
        healthPath: app.healthPath,
      })),
      ...(mode === "development" || mode === "prebuild"
        ? [
            {
              name: "ide",
              kind: "ide",
            },
          ]
        : []),
      ...(input.agent
        ? [
            {
              name: "agent",
              kind: "agent",
              target: "http://127.0.0.1:4096",
              healthPath: "/api/health",
            },
          ]
        : []),
      ...(input.verification
        ? [
            {
              name: "verification",
              kind: "verification",
              target: "http://127.0.0.1:4500",
              healthPath: "/health",
            },
          ]
        : []),
    ],
    processes: [
      ...apps.map((app) => ({ name: runtimeName(app.id), label: app.label, command: app.command })),
      ...(input.agent
        ? [
            {
              name: "agent",
              command: [
                "sh",
                "-c",
                'umask 077; mkdir -p "$HOME/.config/opencode"; printf %s "$FACTORY_OPENCODE_CONFIG" > "$HOME/.config/opencode/opencode.json"; export OPENCODE_DB=/workspace/project/.git/factory-opencode.db; exec /opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs',
              ],
              env: {
                FACTORY_BUILD_BROWSER_COMMAND: `/tmp/factory-runtime-connector-${input.generation}`,
                FACTORY_BUILD_BROWSER_URL: input.agent.browserURL,
                FACTORY_BUILD_BROWSER_TOKEN: input.agent.browserToken,
                OPENCODE_PASSWORD: input.agent.modelToken,
                OPENCODE_DISABLE_MODELS_FETCH: "1",
                FACTORY_OPENCODE_TOKEN: input.agent.modelToken,
                FACTORY_OPENCODE_CONFIG: JSON.stringify({
                  skills: ["/opt/factory/admitted-skills"],
                  model: `factory/${input.agent.modelID}`,
                  providers: {
                    factory: {
                      package: openCodeModelConfiguration(input.agent).package,
                      canonical: input.agent.provider ?? "openai",
                      env: ["FACTORY_OPENCODE_TOKEN"],
                      websocket: false,
                      name: "Factory",
                      settings: {
                        baseURL: input.agent.modelBaseURL,
                        apiKey: input.agent.modelToken,
                        ...openCodeModelConfiguration(input.agent).settings,
                      },
                      models: Object.fromEntries(
                        input.agent.modelIDs.map((id) => [id, { name: id }]),
                      ),
                    },
                  },
                  permissions: [{ action: "*", resource: "*", effect: "allow" }],
                }),
              },
            },
          ]
        : []),
      ...(input.verification
        ? [
            {
              name: "verification",
              command: [
                "sh",
                "-c",
                `umask 077; mkdir -p "$HOME/.factory-runner"; printf %s "$FACTORY_RUNNER_CONFIG" > "$HOME/.factory-runner/config.yml"; exec node -e '${verificationSupervisor}'`,
              ],
              env: {
                FACTORY_RUNNER_CONFIG: [
                  "log:",
                  "  level: info",
                  "  job_level: info",
                  "runner:",
                  "  capacity: 1",
                  "  timeout: 30m",
                  "  shutdown_timeout: 1m",
                  "cache:",
                  "  enabled: false",
                  "host:",
                  "  workdir_parent: /tmp/factory-actions",
                  "server:",
                  "  connections:",
                  "    factory:",
                  `      url: ${input.verification.forgeURL}`,
                  `      uuid: ${input.verification.runnerUUID}`,
                  `      token: ${input.verification.runnerToken}`,
                  "      fetch_interval: 1s",
                  "      labels:",
                  `        - ${input.verification.runnerLabel}:host`,
                  "",
                ].join("\n"),
              },
            },
          ]
        : []),
    ],
    connectorStateDir: "/home/coder/connector-state",
  });
  return [
    {
      apiVersion: "v1",
      kind: "Namespace" as const,
      metadata: { name: input.namespace, labels: namespaceLabels },
    },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: "runtime-assignment", namespace: input.namespace, labels },
      stringData: {
        "assignment.json": assignment,
        "parent-token": input.connectorToken,
        "child-token": input.childConnectorToken,
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: "registry-ca", namespace: input.namespace, labels },
      stringData: { "ca.crt": input.registryCA },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim" as const,
      metadata: { name: "runtime-data", namespace: input.namespace, labels },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "8Gi" } } },
    },
    renderEnvboxPod({ ...input, hostname: input.attemptID, labels, mode }),
  ];
}
