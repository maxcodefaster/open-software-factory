import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { NativeActor } from "../../../../packages/runtime-kubernetes/src/substrate-control";
import { CommandError } from "../command-error";
import type { AgentTurnTransaction } from "../agent/turn-store";

type SQL = ReturnType<typeof createDatabase>["client"] | AgentTurnTransaction;
export type ActorRPC = {
  action: "resume" | "suspend";
  originKey: string;
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
  const [row] = await sql<ActorRPC[]>`
    SELECT action,origin_key AS "originKey",actor_uid::text AS "actorUID",
      native_version AS "nativeVersion",stop_id::text AS "stopID",attempted_at IS NOT NULL AS attempted,outcome
    FROM factory.substrate_actor_rpc
    WHERE runtime_attempt_id=${attemptID} AND action=${action} AND origin_key=${originKey}`;
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
  await sql`INSERT INTO factory.substrate_actor_rpc(runtime_attempt_id,action,origin_key,
    actor_uid,native_version,origin_checkpoint,stop_id)
    VALUES(${attemptID},${action},${originKey},${actor.metadata.uid},${actor.metadata.version},
      ${checkpoint === null ? null : JSON.stringify(checkpoint)}::text::jsonb,${stopID ?? null})
    ON CONFLICT(runtime_attempt_id,action,origin_key) DO NOTHING`;
  const row = await actorRPCIn(sql, attemptID, action, originKey);
  if (!row || row.actorUID !== actor.metadata.uid || row.stopID !== (stopID ?? null))
    throw new Error("Native lifecycle intent differs from the original Actor");
  return row;
}

export async function dispatchActorRPCIn(sql: SQL, attemptID: string, operation: ActorRPC) {
  const result = await sql`UPDATE factory.substrate_actor_rpc SET attempted_at=now()
    WHERE runtime_attempt_id=${attemptID} AND action=${operation.action}
      AND origin_key=${operation.originKey} AND actor_uid=${operation.actorUID} AND attempted_at IS NULL`;
  if (result.count !== 1)
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
  await sql`UPDATE factory.substrate_actor_rpc SET outcome=${JSON.stringify(outcome)}::text::jsonb,
    outcome_recorded_at=now()
    WHERE runtime_attempt_id=${attemptID} AND action=${operation.action}
      AND origin_key=${operation.originKey} AND actor_uid=${operation.actorUID}
      AND attempted_at IS NOT NULL AND outcome IS NULL`;
}
