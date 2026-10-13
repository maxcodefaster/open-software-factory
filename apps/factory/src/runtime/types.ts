export type RuntimeAttemptView = {
  id: string;
  projectId: string;
  changeId: string | null;
  workspaceId: string | null;
  workspaceKind: "personal" | "ticket" | null;
  ownerUserId: string | null;
  generation: string;
  revision: string;
  runtimeKind: "personal" | "ticket" | "staging" | "verification" | null;
  currentStaging?: boolean;
  state: string;
  computeWait?: string | null;
  kubernetesNamespace?: string;
  kubernetesPodName?: string;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeProcessView = {
  name: string;
  label?: string;
  state: string;
  output: string;
  startedAt?: string;
  exitCode?: number;
};
