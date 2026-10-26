import { createHmac } from "node:crypto";

export type WorkspaceSourceState =
  | "create-intended"
  | "preparing"
  | "ready"
  | "failed"
  | "stop-intended"
  | "stopped";

export interface WorkspaceSourceIdentity {
  readonly workspaceID: string;
  readonly epoch: number;
  readonly serviceID: string;
  readonly podName: string;
  readonly secretName: string;
}

export function workspaceSourceIdentity(
  workspaceID: string,
  epoch: number,
): WorkspaceSourceIdentity {
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(workspaceID) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error("Invalid Workspace source identity");
  const key = `${workspaceID.replaceAll("-", "")}-${epoch}`;
  return {
    workspaceID,
    epoch,
    serviceID: `source-${key}`,
    podName: `source-${key}`,
    secretName: `source-access-${key}`,
  };
}

export function workspaceSourceCapability(secret: string, identity: WorkspaceSourceIdentity) {
  return createHmac("sha256", secret)
    .update(`factory-workspace-source-v1:${identity.workspaceID}:${identity.epoch}`)
    .digest("hex");
}
