import type { CodingReasoning } from "../../conversation-domain/src/model-settings";
import type { SystemContract } from "../../system-contract/src/system-contract";
import { runtimeAgentProcess } from "./agent-process";
import { factoryboxAssignmentSecret, factoryboxSharedLabels } from "./factorybox-location";
import {
  type FactoryboxRuntimeProfile,
  factoryboxSandboxID,
  renderFactoryboxRuntime,
} from "./factorybox-runtime";
import { type RuntimeVerification, runtimeVerificationProcess } from "./verification-process";

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
  readonly appOrigins?: Readonly<Record<string, string>>;
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
  readonly verification?: RuntimeVerification;
}

export function renderRuntimeResources(input: RuntimeManifestInput) {
  const ownerID = input.runtimeOwnerID ?? input.attemptID;
  const mode = input.mode ?? "development";
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
  if (input.appOrigins) {
    if (
      Object.keys(input.appOrigins).length !== apps.length ||
      apps.some((app) => typeof input.appOrigins?.[String(app.port)] !== "string")
    )
      throw new Error("Published App origins must match the declared ports");
    for (const origin of Object.values(input.appOrigins)) {
      const parsed = new URL(origin);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin)
        throw new Error("Published App addresses must be exact HTTP(S) origins");
    }
  }
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
      ...apps.map((app) => ({
        name: runtimeName(app.id),
        label: app.label,
        command: app.command,
        ...(input.appOrigins
          ? { env: { FACTORY_APP_ORIGINS: JSON.stringify(input.appOrigins) } }
          : {}),
      })),
      ...(input.agent ? [runtimeAgentProcess(input.agent, input.generation)] : []),
      ...(input.verification ? [runtimeVerificationProcess(input.verification)] : []),
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
