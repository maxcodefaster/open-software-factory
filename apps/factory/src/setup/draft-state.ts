import { createHmac } from "node:crypto";
import { CommandError } from "../command-error";

export const SETUP_DRAFT_KIND = "projects.setup_draft";
export const REPOSITORY_INTENT_KIND = "projects.repository_intent";

export type SetupDraftState = "draft" | "creating" | "checking" | "failed" | "created";

export const SETUP_DRAFT_TRANSITIONS: Record<SetupDraftState, readonly SetupDraftState[]> = {
  draft: ["creating"],
  creating: ["checking", "failed", "created"],
  checking: ["checking", "failed", "created"],
  failed: ["checking", "failed", "created"],
  created: [],
};

export function canTransitionSetupDraft(from: SetupDraftState, to: SetupDraftState): boolean {
  return SETUP_DRAFT_TRANSITIONS[from].includes(to);
}

export type RepositoryIntentState =
  | "credential-intended"
  | "create-intended"
  | "repository-ready"
  | "committed"
  | "uncertain"
  | "failed";

export const RECOVERABLE_INTENT_STATES = [
  "credential-intended",
  "create-intended",
  "repository-ready",
  "uncertain",
] as const;

export const REPOSITORY_INTENT_TRANSITIONS: Record<
  RepositoryIntentState,
  readonly RepositoryIntentState[]
> = {
  "credential-intended": [
    "create-intended",
    "repository-ready",
    "committed",
    "uncertain",
    "failed",
  ],
  "create-intended": ["repository-ready", "committed", "uncertain", "failed"],
  "repository-ready": ["committed", "uncertain", "failed"],
  uncertain: ["create-intended", "repository-ready", "committed", "uncertain", "failed"],
  failed: ["create-intended", "repository-ready", "committed", "uncertain", "failed"],
  committed: [],
};

export function canTransitionRepositoryIntent(
  from: RepositoryIntentState,
  to: RepositoryIntentState,
): boolean {
  return REPOSITORY_INTENT_TRANSITIONS[from].includes(to);
}

export type RepositoryIntentPayload = {
  setupId: string;
  name: string;
  slug: string;
  kind: "starter" | "import";
  sourceUrl: string;
  credentialKey: string | null;
  fingerprint: string;
};

export type RepositoryIntentResult = {
  defaultBranch?: string | null;
  credentialRemovedAt?: string | null;
};

export type RepositoryIntentSnapshot = {
  commandID: string;
  setupID: string;
  userID: string;
  projectID: string;
  name: string;
  slug: string;
  kind: "starter" | "import";
  sourceURL: string;
  credentialKey: string | null;
  fingerprint: string;
  state: RepositoryIntentState;
  defaultBranch: string | null;
  credentialRemovedAt: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type RepositoryIntentMutation = {
  commandID?: string;
  setupID?: string;
  userID?: string;
  projectID?: string;
  name?: string;
  slug?: string;
  kind?: "starter" | "import";
  sourceURL?: string;
  credentialKey?: string | null;
  fingerprint?: string;
  state?: RepositoryIntentState;
  defaultBranch?: string | null;
  failure?: string | null;
  credentialRemovedAt?: string | null;
  createdAt?: Date;
  completedAt?: Date | null;
};

export const setupDraftActiveKey = (userID: string) => `${SETUP_DRAFT_KIND}:${userID}`;
export const repositoryIntentKey = (projectID: string) => `${REPOSITORY_INTENT_KIND}:${projectID}`;

export const initialDraftPayload = {
  version: 1,
  name: "",
  slug: "",
  kind: "starter",
  sourceURL: "",
  commandID: null,
};

export const setupConflictError = () =>
  new CommandError("conflict", "Project setup changed. Reload before continuing.");

export const setupUnavailableError = () =>
  new CommandError(
    "unavailable",
    "Repository setup is still being checked. Your setup is retained.",
  );

export function computeRepositoryFingerprint(
  signingKey: string,
  input: {
    setupID: string;
    name: string;
    slug: string;
    kind: "starter" | "import";
    sourceURL: string;
    token: string;
  },
): string {
  return createHmac("sha256", signingKey).update(JSON.stringify(input)).digest("hex");
}

/**
 * Enforces the immutability invariants formerly checked by the PostgreSQL
 * `guard_project_repository_intent` trigger: intent identity/inputs are
 * immutable, committed state/branch/completion are final, and credential
 * removal timestamp cannot change once recorded.
 */
export function assertRepositoryIntentMutable(
  current: RepositoryIntentSnapshot,
  next: RepositoryIntentMutation,
) {
  const immutableChanged =
    (next.commandID !== undefined && next.commandID !== current.commandID) ||
    (next.setupID !== undefined && next.setupID !== current.setupID) ||
    (next.userID !== undefined && next.userID !== current.userID) ||
    (next.projectID !== undefined && next.projectID !== current.projectID) ||
    (next.name !== undefined && next.name !== current.name) ||
    (next.slug !== undefined && next.slug !== current.slug) ||
    (next.kind !== undefined && next.kind !== current.kind) ||
    (next.sourceURL !== undefined && next.sourceURL !== current.sourceURL) ||
    (next.credentialKey !== undefined && next.credentialKey !== current.credentialKey) ||
    (next.fingerprint !== undefined && next.fingerprint !== current.fingerprint) ||
    (next.createdAt !== undefined && next.createdAt.getTime() !== current.createdAt.getTime());
  const committedChanged =
    current.state === "committed" &&
    ((next.state !== undefined && next.state !== current.state) ||
      (next.defaultBranch !== undefined && next.defaultBranch !== current.defaultBranch) ||
      (next.completedAt !== undefined &&
        next.completedAt?.getTime() !== current.completedAt?.getTime()));
  const credentialRemovalChanged =
    current.credentialRemovedAt !== null &&
    next.credentialRemovedAt !== undefined &&
    next.credentialRemovedAt !== current.credentialRemovedAt;
  if (immutableChanged || committedChanged || credentialRemovalChanged)
    throw new CommandError("conflict", "Project repository intent is immutable");
}
