import { and, eq, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation as operationTable } from "#db/schema";
import type { NativeActor } from "#runtime-kubernetes/substrate-control";
import { CommandError } from "../command-error";

type SQL = ReturnType<typeof createDatabase>["client"] | DatabaseTransaction;
export type ActorRPC = {
  action: "resume" | "suspend";
  originKey: string;
  originCheckpoint: unknown;
  actorUID: string;
  nativeVersion: string;
  stopID: string | null;
  attempted: boolean;
  outcome: unknown;
};

function actorRPCKey(attemptID: string, action: ActorRPC["action"], originKey: string) {
  return `runtime.actor_rpc:${attemptID}:${action}:${originKey}`;
}

export function actorRPCOrigin(checkpoint: unknown) {
  return checkpoint === null ? "initial" : z.object({ uuid: z.uuid() }).parse(checkpoint).uuid;
}

export async function actorRPCIn(
  sql: SQL,
  attemptID: string,
  action: ActorRPC["action"],
  originKey: string,
) {
  const [row] = await drizzleTransaction(sql)
    .select({
      action: query<ActorRPC["action"]>`${operationTable.payload}->>'action'`,
      originKey: query<string>`${operationTable.payload}->>'originKey'`,
      originCheckpoint: query<unknown>`NULLIF(${operationTable.payload}->'originCheckpoint', 'null'::jsonb)`,
      actorUID: query<string>`${operationTable.payload}->>'actorUid'`,
      nativeVersion: query<string>`${operationTable.payload}->>'nativeVersion'`,
      stopID: query<string | null>`${operationTable.payload}->>'stopId'`,
      attempted: query<boolean>`(${operationTable.payload}->>'attemptedAt') IS NOT NULL`,
      outcome: query<unknown>`${operationTable.result}`,
    })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.idempotencyKey, actorRPCKey(attemptID, action, originKey)),
        eq(operationTable.kind, "runtime.actor_rpc"),
        eq(operationTable.scopeType, "runtime_attempt"),
        eq(operationTable.scopeId, attemptID),
      ),
    );
  return row ?? null;
}

// These are dispatch/outcome facts under the existing runtime lock. Substrate
// still owns every Actor transition; no scheduler or second state machine.
export async function intendActorRPCIn(
  sql: SQL,
  attemptID: string,
  action: ActorRPC["action"],
  checkpoint: unknown,
  actor: NativeActor,
  stopID?: string,
) {
  const originKey = actorRPCOrigin(checkpoint);
  await drizzleTransaction(sql)
    .insert(operationTable)
    .values({
      id: crypto.randomUUID(),
      kind: "runtime.actor_rpc",
      scopeType: "runtime_attempt",
      scopeId: attemptID,
      idempotencyKey: actorRPCKey(attemptID, action, originKey),
      state: "intended",
      payload: {
        runtimeAttemptId: attemptID,
        action,
        originKey,
        actorUid: actor.metadata.uid,
        nativeVersion: actor.metadata.version,
        originCheckpoint: checkpoint ?? null,
        stopId: stopID ?? null,
      },
    })
    .onConflictDoNothing({
      target: operationTable.idempotencyKey,
    });
  const row = await actorRPCIn(sql, attemptID, action, originKey);
  if (!row || row.actorUID !== actor.metadata.uid || row.stopID !== (stopID ?? null))
    throw new Error("Native lifecycle intent differs from the original Actor");
  return row;
}

export async function dispatchActorRPCIn(sql: SQL, attemptID: string, operation: ActorRPC) {
  const result = await drizzleTransaction(sql)
    .update(operationTable)
    .set({
      state: "attempted",
      payload: query`${operationTable.payload} || jsonb_build_object('attemptedAt', now())`,
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(
          operationTable.idempotencyKey,
          actorRPCKey(attemptID, operation.action, operation.originKey),
        ),
        eq(operationTable.kind, "runtime.actor_rpc"),
        eq(operationTable.scopeType, "runtime_attempt"),
        eq(operationTable.scopeId, attemptID),
        query`${operationTable.payload}->>'actorUid' = ${operation.actorUID}`,
        query`(${operationTable.payload}->>'attemptedAt') IS NULL`,
      ),
    )
    .returning({ originKey: query<string>`${operationTable.payload}->>'originKey'` });
  if (result.length !== 1)
    throw new CommandError(
      "unavailable",
      `Recorded native ${operation.action} remains unconfirmed; its RPC was not repeated`,
    );
}

export async function observeActorRPCIn(
  sql: SQL,
  attemptID: string,
  operation: ActorRPC,
  actor: NativeActor,
  checkpoint?: unknown,
) {
  const outcome = {
    actorUID: actor.metadata.uid,
    version: actor.metadata.version,
    state: actor.status.state,
    ...(checkpoint ? { checkpoint } : {}),
  };
  await drizzleTransaction(sql)
    .update(operationTable)
    .set({
      state: "completed",
      result: outcome,
      completedAt: query`now()`,
      updatedAt: query`now()`,
    })
    .where(
      and(
        eq(
          operationTable.idempotencyKey,
          actorRPCKey(attemptID, operation.action, operation.originKey),
        ),
        eq(operationTable.kind, "runtime.actor_rpc"),
        eq(operationTable.scopeType, "runtime_attempt"),
        eq(operationTable.scopeId, attemptID),
        query`${operationTable.payload}->>'actorUid' = ${operation.actorUID}`,
        query`(${operationTable.payload}->>'attemptedAt') IS NOT NULL`,
        isNull(operationTable.result),
      ),
    );
}
