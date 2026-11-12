export type RuntimeAttemptView = {
  id: string;
  projectId: string;
  changeId: string | null;
  workspaceId: string | null;
  workspaceKind: "personal" | "ticket" | null;
  ownerUserId: string | null;
  generation: string;
  revision: string;
  runtimeKind:
    | "personal"
    | "ticket"
    | "staging"
    | "verification"
    | "prebuild"
    | "publication"
    | null;
  currentStaging?: boolean;
  state: string;
  computeWait?: string | null;
  kubernetesNamespace?: string;
  kubernetesPodName?: string;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
  /** Latest transition into ready (Connector ready). Null until the attempt first became ready. */
  readyAt?: string | null;
  /** First moment Factory saw each declared App healthy since `readyAt`. */
  appReadyAt?: Record<string, string>;
  /** The native record proves the paused Sandbox's Resume failed (resuming, or its discard needs another try); the owner may start fresh. */
  restoreFailed?: boolean;
  native?: {
    engine: "substrate";
    actorUID?: string;
    state: string;
    version?: string;
    coldRestart: true;
    portable: false;
    sourceHandoff: "pending" | "confirmed-same-node";
  };
};

export type RuntimeProcessView = {
  name: string;
  label?: string;
  state: string;
  output: string;
  startedAt?: string;
  exitCode?: number;
};
