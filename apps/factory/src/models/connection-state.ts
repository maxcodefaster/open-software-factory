import type {
  ModelConnectionView,
  ModelConnectionWrite,
  ModelProbeResult,
  ModelProvider,
} from "#conversation-domain/model-connection";
import type { CodingReasoning, ModelSettingsView } from "#conversation-domain/model-settings";
import type { getModelConnections } from "../server-functions/models";
import { modelProbeExplanation } from "./probe-explanation";

export type Catalogue = Extract<
  Awaited<ReturnType<typeof getModelConnections>>,
  { ok: true }
>["value"];

export type ModelRole = "planning" | "build";

export type RoleSelection = {
  connectionID: string;
  modelId: string;
  reasoningEffort?: CodingReasoning;
};

export type PendingAdoption = {
  commandID: string;
  role: ModelRole;
  version: number;
};

export type PendingCheck = {
  commandID: string;
  settingsVersion: number;
  connectionID: string;
  version: number;
  role: ModelRole;
  modelId: string;
  reasoningEffort?: CodingReasoning;
  confirmInference: true;
};

export type ConnectionFormState =
  | { kind: "viewing"; saved: boolean }
  | {
      kind: "editing";
      target: ModelConnectionView | undefined;
      provider: ModelProvider;
      apiKey: string;
      endpoint: string;
      pendingSave?: ModelConnectionWrite | undefined;
    }
  | {
      kind: "saving";
      target: ModelConnectionView | undefined;
      provider: ModelProvider;
      apiKey: string;
      endpoint: string;
      pendingSave: ModelConnectionWrite;
    };

export type ProbeActivity =
  | {
      kind: "idle";
      pendingAdoption?: PendingAdoption | undefined;
      pendingCheck?: PendingCheck | undefined;
    }
  | {
      kind: "probing";
      role: ModelRole;
      abort: AbortController;
      pendingAdoption?: PendingAdoption | undefined;
      pendingCheck?: PendingCheck | undefined;
    };

export type RoleDraftState = {
  connectionID: string;
  model: string;
  custom: boolean;
  reasoning: CodingReasoning;
  dirty: boolean;
  result?: ModelProbeResult | undefined;
};

export function isProbingRole(probe: ProbeActivity, role: ModelRole): boolean {
  return probe.kind === "probing" && probe.role === role;
}

export function connectionLabel(connection: {
  provider: ModelProvider;
  endpoint: string | null;
  connectionID: string;
}): string {
  const host = connection.endpoint ? new URL(connection.endpoint).host : connection.provider;
  return `${host.endsWith(".openai.azure.com") ? `Azure · ${host.replace(/\.openai\.azure\.com$/, "")}` : host} · ${connection.connectionID.slice(0, 6)}`;
}

export function startEditingConnection(target?: ModelConnectionView): ConnectionFormState {
  return {
    kind: "editing",
    target,
    provider: target?.provider ?? "openai",
    apiKey: "",
    endpoint: target?.endpoint ?? "",
  };
}

export function isConnectionFormLocked(form: ConnectionFormState): boolean {
  return form.kind === "saving" || (form.kind === "editing" && Boolean(form.pendingSave));
}

export function initialRoleDraft(
  data: Catalogue,
  settings: ModelSettingsView,
  roleName: ModelRole,
): RoleDraftState {
  const role = data.roles.find((entry) => entry.role === roleName)?.active;
  const environment = data.deployment.find((entry) => entry.role === roleName && entry.configured);
  const available = data.connections.filter((entry) => entry.configured);
  return {
    connectionID:
      role?.connectionID ??
      environment?.connectionID ??
      (available.length === 1 ? available[0]?.connectionID : undefined) ??
      "",
    model: role?.modelId ?? environment?.modelId ?? "",
    custom: false,
    reasoning: settings.rules.build.reasoningEffort,
    dirty: false,
  };
}

export function availableModelsForRole(input: {
  data: Catalogue;
  role: ModelRole;
  model: string;
  provider: ModelProvider | undefined;
}): string[] {
  const active = input.data.roles.find((entry) => entry.role === input.role)?.active;
  const deployment = input.data.deployment.find(
    (entry) => entry.role === input.role && entry.configured,
  );
  const activeProvider = input.data.connections.find(
    (entry) => entry.connectionID === active?.connectionID,
  )?.provider;
  return [
    ...new Set([
      ...(input.model ? [input.model] : []),
      ...(active?.modelId && activeProvider === input.provider ? [active.modelId] : []),
      ...(deployment?.modelId && deployment.provider === input.provider
        ? [deployment.modelId]
        : []),
      ...(input.data.providers.find((entry) => entry.provider === input.provider)?.models ?? []),
    ]),
  ];
}

export function describeRoleAccessStatus(input: {
  checking: boolean;
  active: Catalogue["roles"][number] | undefined;
  deploymentConfigured: boolean;
  endpoint: string | null | undefined;
}): string {
  if (input.checking) return "Checking access…";
  const check = input.active?.check;
  if (check?.state === "probing") return "Access check in progress";
  if (check?.state === "uncertain") return "Last check interrupted. Nothing was resent.";
  if (check?.result && check.result.status !== "ready")
    return `Last check failed. ${modelProbeExplanation(check.result.status, input.endpoint)}`;
  if (check?.result?.status === "ready") return "Access checked";
  return input.active?.active || input.deploymentConfigured
    ? "Access not checked"
    : "Not configured";
}
