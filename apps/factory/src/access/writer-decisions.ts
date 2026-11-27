import { and, eq, sql as query } from "drizzle-orm";
import type { createDatabase, drizzleTransaction } from "#db/client";
import { auditEvent, change, changeWriter, developmentWorkspace, operation } from "#db/schema";
import type { PendingWriterHandoff } from "../agent/runtime-api";
import type { RuntimeAttemptView } from "../runtime/types";
import type { SourceRoleFence } from "../workspace/source-role-fence";
import type { WriterActivity } from "./writer-activity";

export const CHANGE_EDITING_DECISION_KIND = "access.change_editing_decision";
export const changeEditingDecisionDedupeKey = (commandID: string) =>
  `${CHANGE_EDITING_DECISION_KIND}:${commandID}`;

export const CHANGE_EDITING_REQUEST_KIND = "access.change_editing_request";
export const changeEditingRequestKey = (id: string) => `${CHANGE_EDITING_REQUEST_KIND}:${id}`;
export const changeEditingRequestActiveKey = (
  changeID: string,
  requesterID: string,
  writerEpoch: string | number,
) => `${CHANGE_EDITING_REQUEST_KIND}:${changeID}:${requesterID}:${writerEpoch}`;

export const ACTIVE_AGENT_TURN_STATES: ("pending" | "dispatching" | "running" | "uncertain")[] = [
  "pending",
  "dispatching",
  "running",
  "uncertain",
];
export const SETTLED_COMMIT_STATES: ("succeeded" | "failed")[] = ["succeeded", "failed"];

export type WriterDatabase = ReturnType<typeof createDatabase>;
export type WriterTransactionDB = ReturnType<typeof drizzleTransaction>;

export type WriterView = {
  state: string;
  epoch: number;
  canWrite: boolean;
  stopPending: boolean;
  yours: boolean;
  commandID: string | null;
  actor: {
    kind: "human" | "agent";
    user: { id: string; name: string } | null;
    delegated: boolean;
    workState: string | null;
  } | null;
  requester: { id: string; name: string } | null;
  presence: {
    idle: boolean;
    secondsSinceEdit: number | null;
    connected: boolean;
  } | null;
  handoffKind: "takeover" | "release";
  requests: { id: string; requester: { id: string; name: string }; epoch: number }[];
};

export type WriterRuntimeBoundary = {
  startPersisted?(changeID: string, userID: string): Promise<unknown>;
  stop(attemptID: string, handoff?: PendingWriterHandoff): Promise<unknown>;
  get(attemptID: string): Promise<Pick<RuntimeAttemptView, "state" | "native"> | null>;
};

export type ChangeWriterControllerOptions = {
  database: WriterDatabase;
  runtime: WriterRuntimeBoundary;
  stopAgent(changeID: string): Promise<unknown>;
  protect(changeID: string, writers: readonly string[]): Promise<void>;
  fenceSource?(
    changeID: string,
    epoch: string,
    writable: boolean,
    commission?: SourceRoleFence,
  ): Promise<void>;
  agentUsername: string;
  stopDeadlineMs?: number;
  activity?: WriterActivity;
};

export type WriterContext = ChangeWriterControllerOptions & {
  activity: WriterActivity;
};

export type HumanTransfer = {
  epoch: number;
  approverID?: string;
  requestID?: string;
};

export async function withExclusiveWriter<T>(
  database: WriterDatabase,
  changeID: string,
  work: () => Promise<T>,
): Promise<T> {
  const connection = database.coordination();
  const key = `change-writer-operation:${changeID}`;
  try {
    await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
    return await work();
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
    } finally {
      await connection.end({ timeout: 1 });
    }
  }
}

export async function hasCollaborativeWorkspace(db: WriterTransactionDB, changeID: string) {
  const [shared] = await db
    .select({ id: developmentWorkspace.id })
    .from(developmentWorkspace)
    .where(
      and(eq(developmentWorkspace.changeId, changeID), developmentWorkspace.collaborationEnabled),
    );
  return Boolean(shared);
}

export async function recordEditingDecision(
  db: WriterTransactionDB,
  input: {
    commandID: string;
    changeID: string;
    actorID: string;
    kind: "release" | "takeover" | "approve" | "idle-takeover";
    fromEpoch: number;
    targetUserID: string | null;
    requestID: string | null;
  },
) {
  await db.insert(auditEvent).values({
    id: input.commandID,
    kind: CHANGE_EDITING_DECISION_KIND,
    scopeType: "change",
    scopeId: input.changeID,
    dedupeKey: changeEditingDecisionDedupeKey(input.commandID),
    actorId: input.actorID,
    payload: {
      changeId: input.changeID,
      kind: input.kind,
      fromEpoch: input.fromEpoch,
      toEpoch: input.fromEpoch + 1,
      targetUserId: input.targetUserID,
      requestId: input.requestID,
    },
  });
}

export async function beginWriterHandoff(
  db: WriterTransactionDB,
  changeID: string,
  handoffKind: "release" | "takeover",
  userID: string,
  commandID: string,
) {
  await db
    .update(changeWriter)
    .set({
      state: "handoff",
      handoffKind,
      epoch: query`${changeWriter.epoch}+1`,
      userId: null,
      turnId: null,
      requestedBy: userID,
      requestId: commandID,
      fenceRequired: true,
      fenceAttemptId: query`(${db.select({ id: change.runtimeAttemptId }).from(change).where(eq(change.id, changeID))})`,
      updatedAt: query`now()`,
    })
    .where(eq(changeWriter.changeId, changeID));
}

export async function supersedeEditingRequests(db: WriterTransactionDB, changeID: string) {
  const decidedAt = new Date().toISOString();
  await db
    .update(operation)
    .set({
      state: "superseded",
      activeKey: null,
      payload: query`${operation.payload} || ${JSON.stringify({ decidedAt })}::jsonb`,
      completedAt: query`now()`,
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(operation.kind, CHANGE_EDITING_REQUEST_KIND),
        eq(operation.scopeType, "change"),
        eq(operation.scopeId, changeID),
        eq(operation.state, "requested"),
      ),
    );
}
