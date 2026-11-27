import type { EnvironmentSettingsView, EnvironmentWrite } from "#project-domain/environment";
import { plainErrorMessage } from "../command-error";
import {
  discardEnvironmentSave,
  getEnvironment,
  saveEnvironment,
} from "../server-functions/environments";
import { serverCall } from "../server-functions/result";
import type { EnvironmentPhase } from "./settings-state";

export async function runLoadEnvironment(
  projectID: string,
  scope: EnvironmentSettingsView["environment"],
): Promise<
  | { ok: true; value: EnvironmentSettingsView; phase: EnvironmentPhase }
  | { ok: false; phase: EnvironmentPhase }
> {
  try {
    const value = await serverCall(getEnvironment({ data: [projectID, scope] }));
    return { ok: true, value, phase: { kind: "ready" } };
  } catch (cause) {
    return {
      ok: false,
      phase: {
        kind: "load-error",
        message:
          cause instanceof Error ? plainErrorMessage(cause.message) : "Could not load environment",
      },
    };
  }
}

export async function runDiscardEnvironmentSave(
  projectID: string,
  scope: EnvironmentSettingsView["environment"],
  commandID: string,
  currentRetry: EnvironmentWrite | undefined,
): Promise<
  | { ok: true; value: EnvironmentSettingsView; phase: EnvironmentPhase }
  | { ok: false; phase: EnvironmentPhase }
> {
  try {
    const value = await serverCall(discardEnvironmentSave({ data: [projectID, scope, commandID] }));
    return {
      ok: true,
      value,
      phase: { kind: "ready", notice: "Pending save discarded. Existing settings are unchanged." },
    };
  } catch {
    return {
      ok: false,
      phase: {
        kind: "ready",
        pendingRetry: currentRetry,
        error: "Could not discard the pending save. Reload to check its result.",
      },
    };
  }
}

export async function runSaveEnvironment(
  projectID: string,
  scope: EnvironmentSettingsView["environment"],
  input: EnvironmentWrite,
): Promise<
  | { ok: true; value: EnvironmentSettingsView; phase: EnvironmentPhase }
  | { ok: false; latest?: EnvironmentSettingsView | undefined; phase: EnvironmentPhase }
> {
  try {
    const value = await serverCall(saveEnvironment({ data: [projectID, scope, input] }));
    return {
      ok: true,
      value,
      phase: {
        kind: "ready",
        notice: "Saved. Restart existing compute to apply runtime variable changes.",
      },
    };
  } catch (cause) {
    const latest = await serverCall(getEnvironment({ data: [projectID, scope] })).catch(
      () => undefined,
    );
    const keepRetry = !latest || (latest.pending && latest.pendingCommandID === input.commandID);
    return {
      ok: false,
      latest,
      phase: {
        kind: "ready",
        pendingRetry: keepRetry ? input : undefined,
        error:
          cause instanceof Error ? plainErrorMessage(cause.message) : "Could not save environment",
      },
    };
  }
}
