export type DeveloperIDEState =
  | "create-intended"
  | "preparing"
  | "ready"
  | "failed"
  | "stop-intended"
  | "stopped";

export interface DeveloperIDEIdentity {
  readonly userID: string;
  readonly epoch: number;
  readonly serviceID: string;
  readonly namespace: string;
  readonly podName: string;
}

export function developerIDEIdentity(userID: string, epoch: number): DeveloperIDEIdentity {
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(userID) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error("Invalid Developer IDE identity");
  return {
    userID,
    epoch,
    serviceID: `editor-${userID}-${epoch}`,
    namespace: `factory-editor-${userID.replaceAll("-", "")}`,
    podName: `editor-${epoch}`,
  };
}
