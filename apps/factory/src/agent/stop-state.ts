import { and, eq, inArray, isNull, ne, notExists, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, changeAgentSession } from "#db/schema";
import type { RuntimeAttemptView } from "../runtime/types";

export type Database = ReturnType<typeof createDatabase>;
export type SqlExecutor = Database["client"] | DatabaseTransaction;
export type StopTarget = { stopID: string | null; turnID: string | null };
export type StopOrigin = "user" | "authority-loss";

export type PendingWriterHandoff = { turnID: string; epoch: string };
export type RetainedStopTarget = {
  changeID: string;
  stopID: string;
  attemptID: string;
  sessionID: string;
  promptID: string;
  mode: "interrupt" | "observe";
};

export const ACTIVE_TURN_STATES = ["pending", "dispatching", "running", "uncertain"] as const;

export const RETAINED_RUNTIME_STATES = [
  "failed",
  "cleanup-failed",
  "stopped",
  "paused",
  "starting",
  "pausing",
] as const;

export type StopPhase = "requested" | "fenced" | "dispatched" | "confirmed" | "unconfirmed";

export const STOP_PHASE_TRANSITIONS: Record<StopPhase, readonly StopPhase[]> = {
  requested: ["fenced", "confirmed"],
  fenced: ["dispatched", "confirmed", "unconfirmed"],
  dispatched: ["confirmed", "unconfirmed"],
  unconfirmed: ["dispatched", "confirmed", "unconfirmed"],
  confirmed: [],
};

export function canTransitionStopPhase(from: StopPhase, to: StopPhase): boolean {
  return STOP_PHASE_TRANSITIONS[from].includes(to);
}

export type StopCandidate = {
  attemptID: string;
  sessionID: string | null;
  runtimeState: string;
  dispatched: boolean;
  stopID: string | null;
  turnID: string | null;
  promptID: string | null;
  intentAttemptID: string | null;
  currentAttemptID: string | null;
  bootstrap: boolean | null;
  intendedSessionID: string | null;
  sessionConfirmed: boolean;
  implementationConfirmed: boolean;
  turnState: string | null;
};

export type StopConfirmationProof = {
  unsubmittedBootstrap: boolean;
  pausedBootstrap: boolean;
  retainedSettled: boolean;
};

// Caller attribution is available only while its exact publication is in flight.
// A process restart loses this context; recovery must then remain neutral.
const publishingOrigins = new Map<string, { changeID: string; origin: StopOrigin }>();

export async function withPublishingOrigin<T>(
  stopID: string,
  changeID: string,
  origin: StopOrigin,
  work: () => Promise<T>,
): Promise<T> {
  publishingOrigins.set(stopID, { changeID, origin });
  try {
    return await work();
  } finally {
    publishingOrigins.delete(stopID);
  }
}

export function getPublishingOrigin(
  stopID: string | null,
  changeID: string,
): StopOrigin | undefined {
  if (!stopID) return undefined;
  const caller = publishingOrigins.get(stopID);
  return caller?.changeID === changeID ? caller.origin : undefined;
}

export function stopOutcomeSummary(origin?: StopOrigin): string {
  if (origin === "user") return "Stopped by the user";
  if (origin === "authority-loss")
    return "Stopped because execution authority could not be renewed";
  return "Execution stopped";
}

export function pendingStopSessionPredicate(
  changeID: string,
  filters: {
    stopID?: string | null | undefined;
    matchNullStopID?: boolean | undefined;
    attemptID?: string | undefined;
    sessionID?: string | null | undefined;
    matchSessionID?: boolean | undefined;
    dispatched?: boolean | undefined;
    requireUnconfirmedNative?: boolean | undefined;
    requireUnconfirmedImplementation?: boolean | undefined;
  } = {},
) {
  return and(
    eq(changeAgentSession.changeId, changeID),
    eq(changeAgentSession.state, "stopped"),
    eq(changeAgentSession.stopPending, true),
    filters.dispatched === undefined
      ? undefined
      : eq(changeAgentSession.stopDispatched, filters.dispatched),
    filters.matchNullStopID
      ? query`${changeAgentSession.stopId} IS NOT DISTINCT FROM ${filters.stopID ?? null}`
      : filters.stopID !== undefined && filters.stopID !== null
        ? eq(changeAgentSession.stopId, filters.stopID)
        : undefined,
    filters.attemptID === undefined
      ? undefined
      : eq(changeAgentSession.runtimeAttemptId, filters.attemptID),
    filters.matchSessionID
      ? query`${changeAgentSession.opencodeSessionId} IS NOT DISTINCT FROM ${filters.sessionID ?? null}`
      : undefined,
    filters.requireUnconfirmedNative
      ? isNull(changeAgentSession.nativeSessionConfirmedAt)
      : undefined,
    filters.requireUnconfirmedImplementation
      ? isNull(changeAgentSession.implementationSessionConfirmedAt)
      : undefined,
  );
}

export function noOtherActiveTurnPredicate(
  db: ReturnType<typeof drizzleTransaction>,
  excludeTurnId: string | typeof agentTurn.id,
) {
  const other = alias(agentTurn, "other");
  return notExists(
    db
      .select({ id: other.id })
      .from(other)
      .where(
        and(
          eq(other.changeId, changeAgentSession.changeId),
          ne(other.id, excludeTurnId),
          inArray(other.state, [...ACTIVE_TURN_STATES]),
        ),
      ),
  );
}

export async function settleStopTurnIn(
  sql: SqlExecutor,
  changeID: string,
  target: StopTarget,
  origin?: StopOrigin,
): Promise<void> {
  if (!target.turnID) return;
  // Never hold Change while waiting on Turn: execution locks Turn first.
  // A delayed caller can affect only the Turn captured when its Stop began.
  await drizzleTransaction(sql)
    .update(agentTurn)
    .set({
      state: "stopped",
      ownerToken: null,
      ownerExpiresAt: null,
      outcomeSummary: stopOutcomeSummary(origin),
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(agentTurn.id, target.turnID),
        eq(agentTurn.changeId, changeID),
        inArray(agentTurn.state, [...ACTIVE_TURN_STATES]),
      ),
    );
}

export function isFreshUnconfirmedBootstrap(candidate: StopCandidate): boolean {
  return (
    candidate.bootstrap === true &&
    !candidate.sessionConfirmed &&
    candidate.sessionID === candidate.intendedSessionID
  );
}

export function isConfirmedPausedBootstrap(
  paused: RuntimeAttemptView | null | undefined,
  attemptID: string,
  changeID: string,
): boolean {
  return Boolean(
    paused?.id === attemptID &&
      paused.changeId === changeID &&
      paused.workspaceKind === "ticket" &&
      paused.state === "paused" &&
      paused.native?.engine === "substrate" &&
      Boolean(paused.native.actorUID) &&
      paused.native.state === "ACTOR_STATE_SUSPENDED" &&
      paused.native.sourceHandoff === "confirmed-same-node",
  );
}

export function canAttemptRetainedSettle(
  candidate: StopCandidate,
  connected: boolean,
): candidate is StopCandidate & { stopID: string; sessionID: string; promptID: string } {
  return Boolean(
    candidate.stopID &&
      candidate.sessionID &&
      candidate.promptID &&
      candidate.intentAttemptID === candidate.attemptID &&
      !connected &&
      (RETAINED_RUNTIME_STATES as readonly string[]).includes(candidate.runtimeState),
  );
}
