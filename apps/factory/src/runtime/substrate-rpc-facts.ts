import { and, eq, isNotNull, isNull, sql as query } from "drizzle-orm";
import { z } from "zod";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import { substrateActorRpc } from "../../../../packages/db/src/schema";
import type { NativeActor } from "../../../../packages/runtime-kubernetes/src/substrate-control";
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
      action: query<ActorRPC["action"]>`${substrateActorRpc.action}`,
      originKey: substrateActorRpc.originKey,
      originCheckpoint: substrateActorRpc.originCheckpoint,
      actorUID: substrateActorRpc.actorUid,
      nativeVersion: substrateActorRpc.nativeVersion,
      stopID: substrateActorRpc.stopId,
      attempted: query<boolean>`${substrateActorRpc.attemptedAt} IS NOT NULL`,
      outcome: substrateActorRpc.outcome,
    })
    .from(substrateActorRpc)
    .where(
      and(
        eq(substrateActorRpc.runtimeAttemptId, attemptID),
        eq(substrateActorRpc.action, action),
        eq(substrateActorRpc.originKey, originKey),
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
    .insert(substrateActorRpc)
    .values({
      runtimeAttemptId: attemptID,
      action,
      originKey,
      actorUid: actor.metadata.uid,
      nativeVersion: actor.metadata.version,
      originCheckpoint: checkpoint,
      stopId: stopID ?? null,
    })
    .onConflictDoNothing({
      target: [
        substrateActorRpc.runtimeAttemptId,
        substrateActorRpc.action,
        substrateActorRpc.originKey,
      ],
    });
  const row = await actorRPCIn(sql, attemptID, action, originKey);
  if (!row || row.actorUID !== actor.metadata.uid || row.stopID !== (stopID ?? null))
    throw new Error("Native lifecycle intent differs from the original Actor");
  return row;
}

export async function dispatchActorRPCIn(sql: SQL, attemptID: string, operation: ActorRPC) {
  const result = await drizzleTransaction(sql)
    .update(substrateActorRpc)
    .set({ attemptedAt: query`now()` })
    .where(
      and(
        eq(substrateActorRpc.runtimeAttemptId, attemptID),
        eq(substrateActorRpc.action, operation.action),
        eq(substrateActorRpc.originKey, operation.originKey),
        eq(substrateActorRpc.actorUid, operation.actorUID),
        isNull(substrateActorRpc.attemptedAt),
      ),
    )
    .returning({ originKey: substrateActorRpc.originKey });
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
    .update(substrateActorRpc)
    .set({ outcome, outcomeRecordedAt: query`now()` })
    .where(
      and(
        eq(substrateActorRpc.runtimeAttemptId, attemptID),
        eq(substrateActorRpc.action, operation.action),
        eq(substrateActorRpc.originKey, operation.originKey),
        eq(substrateActorRpc.actorUid, operation.actorUID),
        isNotNull(substrateActorRpc.attemptedAt),
        isNull(substrateActorRpc.outcome),
      ),
    );
}
