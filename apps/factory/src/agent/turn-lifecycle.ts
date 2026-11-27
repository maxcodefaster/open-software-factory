import { and, eq, sql as expression, type SQL } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import type {
  AgentActivity,
  AgentAdmission,
  AgentBrowser,
  RenewExecution,
  readCurrentChange,
} from "./controller-types";
import {
  type createOpenCodeClient,
  type readOpenCodeWorkspace,
  syncOpenCodeInputGuidance,
} from "./opencode-adapter";
import { connectOpenCodeBrowser, connectOpenCodeSources } from "./opencode-browser";

export type AgentIntent = Awaited<ReturnType<AgentAdmission["intent"]>>;
export type CurrentChange = Awaited<ReturnType<typeof readCurrentChange>>;
export type OpenCodeClient = ReturnType<typeof createOpenCodeClient>;
export type OpenCodeLocation = Awaited<ReturnType<typeof readOpenCodeWorkspace>>["location"];

export type DispatchPhase =
  | "pending"
  | "claimed"
  | "prepared"
  | "dispatched"
  | "running"
  | "settled";

export const DISPATCH_PHASE_TRANSITIONS: Record<DispatchPhase, readonly DispatchPhase[]> = {
  pending: ["claimed", "settled"],
  claimed: ["prepared", "settled"],
  prepared: ["dispatched", "settled"],
  dispatched: ["running", "settled"],
  running: ["settled"],
  settled: [],
};

export function canTransitionDispatchPhase(from: DispatchPhase, to: DispatchPhase): boolean {
  return DISPATCH_PHASE_TRANSITIONS[from].includes(to);
}

export function transitionDispatchPhase(from: DispatchPhase, to: DispatchPhase): DispatchPhase {
  if (!canTransitionDispatchPhase(from, to))
    throw new Error(`Invalid dispatch transition from ${from} to ${to}`);
  return to;
}

export type RecoveryPhase =
  | "claiming"
  | "observing"
  | "admitting-input"
  | "restoring"
  | "monitoring"
  | "uncertain";

export const RECOVERY_PHASE_TRANSITIONS: Record<RecoveryPhase, readonly RecoveryPhase[]> = {
  claiming: ["observing", "uncertain"],
  observing: ["observing", "admitting-input", "restoring", "uncertain"],
  "admitting-input": ["observing", "uncertain"],
  restoring: ["monitoring", "uncertain"],
  monitoring: ["uncertain"],
  uncertain: [],
};

export function canTransitionRecoveryPhase(from: RecoveryPhase, to: RecoveryPhase): boolean {
  return RECOVERY_PHASE_TRANSITIONS[from].includes(to);
}

export function transitionRecoveryPhase(from: RecoveryPhase, to: RecoveryPhase): RecoveryPhase {
  if (!canTransitionRecoveryPhase(from, to))
    throw new Error(`Invalid recovery transition from ${from} to ${to}`);
  return to;
}

export function startExecutionRenewal(
  activity: Pick<AgentActivity, "isClosed">,
  renewExecution: RenewExecution,
  turnID: string,
  ownerToken: string,
  intervalMS = 10_000,
): () => Promise<void> {
  let pendingRenewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (activity.isClosed() || pendingRenewal) return;
    pendingRenewal = renewExecution(turnID, ownerToken)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        pendingRenewal = undefined;
      });
  }, intervalMS);
  return async () => {
    clearInterval(timer);
    await pendingRenewal;
  };
}

export function assertOpenCodeSessionMatches(
  session: {
    id: string;
    location: { directory: string };
    model?: { providerID?: string; id?: string } | null;
  },
  expected: { sessionID: string; directory: string; modelID: string },
  errorMessage: string,
): void {
  if (
    session.id !== expected.sessionID ||
    session.location.directory !== expected.directory ||
    session.model?.providerID !== "factory" ||
    session.model.id !== expected.modelID
  ) {
    throw new Error(errorMessage);
  }
}

export async function syncOpenCodeTurnGuidance(
  client: OpenCodeClient,
  intent: AgentIntent,
  isReview: boolean,
): Promise<void> {
  if (intent.skillManifest !== null) await syncOpenCodeInputGuidance(client, intent);
  if (isReview)
    await client.session.instructions.entry.put({
      sessionID: intent.sessionID,
      key: "factory-review-policy",
      value: intent.text,
    });
}

export async function connectTurnBrowserAndSources(params: {
  browser: AgentBrowser | undefined;
  client: OpenCodeClient;
  turnID: string;
  ownerToken: string;
  browserTransport: AgentIntent["browserTransport"];
  isReview: boolean;
}): Promise<void> {
  const { browser, client, turnID, ownerToken, browserTransport, isReview } = params;
  const browserGrant = await browser?.prepare(turnID, ownerToken);
  if (browserTransport === "mcp" && browserGrant)
    await connectOpenCodeBrowser(client, browserGrant.runtimeEndpoint, browserGrant.runtimeBearer);
  if (!isReview && browserGrant)
    await connectOpenCodeSources(client, browserGrant.runtimeEndpoint, browserGrant.runtimeBearer);
}

export async function recordLegacySkillOperationsIn(
  sql: DatabaseTransaction,
  turnID: string,
  intent: Pick<AgentIntent, "skillManifest">,
  skillRevisionIDs: readonly string[],
): Promise<void> {
  if (intent.skillManifest !== null) return;
  const db = drizzleTransaction(sql);
  for (const revisionID of skillRevisionIDs) {
    await db
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: "coding.turn_skill",
        scopeType: "agent_turn",
        scopeId: turnID,
        idempotencyKey: `coding.turn_skill:${turnID}:${revisionID}`,
        activeKey: null,
        state: "loaded",
        payload: {
          turnId: turnID,
          revisionId: revisionID,
          loadedAt: new Date().toISOString(),
        },
      })
      .onConflictDoNothing({ target: operation.idempotencyKey });
  }
}

export function activeCodingPausePredicate(scopeId?: string | SQL) {
  return and(
    eq(operation.kind, "usage.coding_pause"),
    eq(operation.scopeType, "agent_turn"),
    scopeId !== undefined ? eq(operation.scopeId, scopeId) : undefined,
    eq(operation.state, "paused"),
    expression`(${operation.payload}->>'resumedByTurnId') IS NULL`,
  );
}
