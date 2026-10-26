import type { CodingReasoning } from "../../conversation-domain/src/model-settings";
import type { SystemContract } from "../../system-contract/src/system-contract";
import { factoryboxAssignmentSecret, factoryboxSharedLabels } from "./factorybox-location";
import {
  type FactoryboxRuntimeProfile,
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";
import { openCodeModelConfiguration, openCodeModelMetadata } from "./opencode-model";
import { verificationSupervisor } from "./verification-process";

export interface RuntimeManifestInput {
  readonly attemptID: string;
  readonly workerID: string;
  readonly reserveSlotID?: string;
  readonly generation: number;
  readonly namespace: string;
  readonly podName: string;
  readonly projectID: string;
  readonly runtimeOwnerID?: string;
  readonly mode?: "development" | "staging" | "verification" | "prebuild" | "publication";
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
  readonly factoryboxProfile: FactoryboxRuntimeProfile;
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
    readonly handle?: string;
    readonly publication?: {
      id: string;
      version: string;
      credentialURL: string;
      credentialToken: string;
      registryURL?: string;
    };
  };
}

export function renderRuntimeResources(input: RuntimeManifestInput) {
  const ownerID = input.runtimeOwnerID ?? input.attemptID;
  const mode = input.mode ?? "development";
  const publication = input.verification?.publication;
  const publicationEnvironment = publication
    ? {
        FACTORY_RELEASE_ID: publication.id,
        FACTORY_RELEASE_VERSION: publication.version,
        FACTORY_RELEASE_SOURCE: "/workspace/project",
        FACTORY_RELEASE_CREDENTIAL_URL: publication.credentialURL,
        FACTORY_RELEASE_CREDENTIAL_TOKEN: publication.credentialToken,
        FACTORY_RELEASE_REGISTRY: new URL(publication.registryURL ?? input.verification!.forgeURL)
          .host,
        FACTORY_RELEASE_REGISTRY_URL: new URL(
          publication.registryURL ?? input.verification!.forgeURL,
        ).origin,
      }
    : {};
  if (input.agent && !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(input.agent.browserToolsImage))
    throw new Error("Build browser image must be pinned by exact digest");
  if (
    mode !== "verification" &&
    mode !== "prebuild" &&
    mode !== "publication" &&
    !input.systemContract
  ) {
    throw new Error("A System Contract is required outside Verification");
  }
  const apps =
    mode === "verification" || mode === "prebuild" || mode === "publication"
      ? []
      : (input.systemContract?.apps ?? []);
  const primaryApp = input.systemContract?.primaryApp;
  const runtimeName = (appID: string) => (appID === primaryApp ? "app" : `app-${appID}`);
  const namespaceLabels = factoryboxSharedLabels(input.workerID);
  const labels = {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-attempt": input.attemptID,
    "factory.dev/runtime-generation": String(input.generation),
    "factory.dev/project": input.projectID,
    "factory.dev/runtime-owner": input.reserveSlotID ?? ownerID,
    ...(input.reserveSlotID ? { "factory.dev/execution-slot": input.reserveSlotID } : {}),
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
                "umask 077; export OPENCODE_DB=/workspace/project/.git/factory-opencode.db; exec /opt/factory/opencode/bun /opt/factory/opencode/server/server.mjs",
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
                      name: "Factory",
                      settings: {
                        transport: "http",
                        compaction: { type: "summary" },
                        baseURL: input.agent.modelBaseURL,
                        apiKey: input.agent.modelToken,
                        ...openCodeModelConfiguration(input.agent).settings,
                      },
                      models: Object.fromEntries(
                        input.agent.modelIDs.map((id) => [
                          id,
                          openCodeModelMetadata(input.agent?.provider, id),
                        ]),
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
                ...(input.verification.handle
                  ? { FACTORY_RUNNER_HANDLE: input.verification.handle }
                  : {}),
                ...publicationEnvironment,
                FACTORY_RUNNER_CONFIG: [
                  "log:",
                  "  level: info",
                  "  job_level: info",
                  "runner:",
                  "  capacity: 1",
                  "  timeout: 30m",
                  "  shutdown_timeout: 1m",
                  // Native runner job processes use configured envs, not the supervisor's env.
                  ...(publication
                    ? [
                        "  envs:",
                        ...Object.entries(publicationEnvironment).map(
                          ([key, value]) => `    ${key}: ${JSON.stringify(value)}`,
                        ),
                      ]
                    : []),
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
                  ...(input.verification.publication
                    ? [`        - factory-release-${input.verification.publication.id}:host`]
                    : []),
                  "",
                ].join("\n"),
              },
            },
          ]
        : []),
    ],
    connectorStateDir: "/home/coder/connector-state",
  });
  const execution = renderFactoryboxRuntime({
    ...input,
    sandboxID: factoryboxSandboxID(input.reserveSlotID ?? input.attemptID),
    reserve: Boolean(input.reserveSlotID),
    labels,
    runtimeOwnerID: input.reserveSlotID ?? ownerID,
    profile: input.factoryboxProfile,
    sharedSource: input.preserveWorkspace ?? false,
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
      metadata: {
        name: factoryboxAssignmentSecret(input.reserveSlotID ?? input.attemptID),
        namespace: input.namespace,
        labels,
      },
      stringData: {
        "assignment.json": assignment,
        "parent-token": input.connectorToken,
        "child-token": input.childConnectorToken,
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret" as const,
      metadata: { name: "registry-ca", namespace: input.namespace, labels: namespaceLabels },
      stringData: { "ca.crt": input.registryCA },
    },
    execution.sourceClaim,
    execution.claim,
    execution.pod,
  ];
}
