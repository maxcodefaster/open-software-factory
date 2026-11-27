import { isDeepStrictEqual } from "node:util";
import {
  and,
  eq,
  exists,
  sql as expression,
  gt,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation as operationTable, runtimeAttempt, substrateSource } from "#db/schema";
import {
  type NativeActor,
  nativeSnapshot,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { CommandError } from "../command-error";
import { allow, binding, currentGrant, egress, observe } from "./substrate-exec-actor";
import {
  type Binding,
  type Database,
  requireDurableROOTFS,
  requireResumeContinuity,
  type SubstrateExecContext,
} from "./substrate-exec-helpers";
import { requireInitialVerificationResumeIn } from "./substrate-exec-isolated";
import { suspendIn } from "./substrate-exec-suspend";
import { substrateWorkspaceGrantIn } from "./substrate-grant";
import { nativeInputStopIn } from "./substrate-input-stop";
import {
  type ActorRPC,
  actorRPCIn,
  actorRPCOrigin,
  dispatchActorRPCIn,
  intendActorRPCIn,
} from "./substrate-rpc-facts";

async function requireCapacityWorkspaceResumeIn(
  ctx: SubstrateExecContext,
  sql: DatabaseTransaction,
  saved: Binding,
  actor: NativeActor,
  operation: ActorRPC,
  userID: string,
  waiting: boolean,
  sourceOnly = false,
) {
  const origin = actorRPCOrigin(saved.checkpoint);
  if (
    !ctx.workspaceID ||
    saved.deleting ||
    saved.deleted ||
    operation.action !== "resume" ||
    !operation.attempted ||
    operation.outcome ||
    operation.stopID !== null ||
    operation.originKey !== origin ||
    !isDeepStrictEqual(operation.originCheckpoint, saved.checkpoint) ||
    operation.actorUID !== saved.actorUID ||
    actor.metadata.uid !== operation.actorUID ||
    actor.metadata.version !== operation.nativeVersion ||
    actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
    actor.status.workerAssignment ||
    actor.sourceTag !== undefined ||
    (await actorRPCIn(sql, ctx.attemptID, "suspend", origin))
  )
    throw new CommandError(
      "unavailable",
      "Native capacity continuation differs from its original unassigned Workspace",
    );
  if (saved.checkpoint) requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
  else if (actor.status.lastAssignedGeneration || actor.status.snapshots?.length)
    throw new CommandError("unavailable", "Initial Workspace acquired an unrecorded checkpoint");
  const db = drizzleTransaction(sql);
  const newer = alias(runtimeAttempt, "newer");
  const [current] = await db
    .select({ id: runtimeAttempt.id })
    .from(runtimeAttempt)
    .where(
      and(
        eq(runtimeAttempt.id, ctx.attemptID),
        eq(runtimeAttempt.workspaceId, ctx.workspaceID),
        eq(runtimeAttempt.projectId, ctx.config.projectID),
        eq(runtimeAttempt.generation, ctx.config.generation),
        eq(runtimeAttempt.state, "starting"),
        isNull(runtimeAttempt.stopIntendedAt),
        or(expression`${saved.checkpoint !== null}`, isNull(runtimeAttempt.readyAt)),
        notExists(
          db
            .select({ id: newer.id })
            .from(newer)
            .where(
              and(
                eq(newer.workspaceId, runtimeAttempt.workspaceId),
                gt(newer.generation, runtimeAttempt.generation),
              ),
            ),
        ),
        or(
          expression`NOT ${waiting}`,
          exists(
            db
              .select({ id: operationTable.id })
              .from(operationTable)
              .where(
                and(
                  eq(operationTable.kind, "runtime.compute_wait"),
                  eq(operationTable.scopeType, "runtime_attempt"),
                  eq(operationTable.scopeId, expression`${runtimeAttempt.id}::text`),
                  eq(
                    operationTable.idempotencyKey,
                    expression`'runtime.compute_wait:' || ${runtimeAttempt.id}::text`,
                  ),
                  expression`${operationTable.payload}->>'reason' = 'compute-capacity'`,
                ),
              ),
          ),
        ),
      ),
    );
  if (!current)
    throw new CommandError(
      "unavailable",
      "Recorded native Resume remains unconfirmed; its RPC was not repeated",
    );
  if (sourceOnly) await currentGrant(ctx, sql, userID, true, true);
  else await substrateWorkspaceGrantIn(ctx.database, sql, ctx.workspaceID, userID, true);
  if (ctx.sources) {
    const [source] = await db
      .select({ workspaceID: substrateSource.workspaceId })
      .from(substrateSource)
      .where(
        and(
          eq(substrateSource.workspaceId, ctx.workspaceID),
          or(
            and(
              eq(substrateSource.actorUid, operation.actorUID),
              eq(substrateSource.owner, "actor"),
              eq(substrateSource.writable, true),
              isNull(substrateSource.checkpointId),
            ),
            // No worker was assigned. V2 has not granted this Actor a Source
            // writer yet; its saved independent tree remains authoritative.
            eq(substrateSource.owner, "service"),
          ),
        ),
      );
    if (!source)
      throw new CommandError(
        "unavailable",
        "Capacity continuation requires its unchanged original Source owner",
      );
  }
}

export async function resumeActorIn(
  ctx: SubstrateExecContext,
  sql: Database["client"],
  initialSaved: Binding,
  initialBefore: NativeActor,
  userID: string | null,
  stopID?: string,
  signal?: AbortSignal,
  sourceOnly = false,
) {
  let saved = initialSaved;
  let before = initialBefore;
  // The original Actor remains the sole Source owner. Native MEMORY resumes
  // its existing processes; ROOTFS cold entry revalidates the retained tree.
  // Neither path transfers files or renews a second canonical checkout.
  const finish = async (actor: NativeActor) => actor;
  if (before.status.state === "ACTOR_STATE_SUSPENDED") {
    const actual =
      saved.checkpoint || before.status.lastAssignedGeneration
        ? requireDurableROOTFS(before, saved)
        : null;
    if (actual && actual.uuid !== actorRPCOrigin(saved.checkpoint)) {
      const pausing = await actorRPCIn(
        sql,
        ctx.attemptID,
        "suspend",
        actorRPCOrigin(saved.checkpoint),
      );
      if (!pausing?.attempted)
        throw new CommandError(
          "unavailable",
          "Native checkpoint has no recorded Pause; no Resume was dispatched",
        );
      // Reconcile the original durable pause before this deliberate Resume.
      // No checkpoint RPC or Source transfer is repeated.
      await suspendIn(ctx, sql);
      saved = await binding(ctx, sql);
      before = await observe(ctx, sql, saved);
    }
  }
  const origin = actorRPCOrigin(saved.checkpoint);
  if (["ACTOR_STATE_RUNNING", "ACTOR_STATE_RESUMING"].includes(before.status.state)) {
    if (await actorRPCIn(sql, ctx.attemptID, "suspend", origin))
      throw new CommandError(
        "unavailable",
        "Recorded native Pause remains unconfirmed; its RPC was not repeated",
      );
    const recorded = await actorRPCIn(sql, ctx.attemptID, "resume", origin);
    if (!recorded?.attempted)
      throw new CommandError(
        "unavailable",
        "Native allocation has no recorded Resume; no operation was repeated",
      );
    if (before.status.state === "ACTOR_STATE_RESUMING" && userID && !stopID) {
      requireResumeContinuity(before, saved, recorded);
      if (recorded.stopID)
        throw new CommandError(
          "conflict",
          "A Stop-only Resume cannot authorize ordinary execution",
        );
      const requireCurrentStart = async () => {
        const db = drizzleTransaction(sql);
        const newer = alias(runtimeAttempt, "newer");
        const [current] = await db
          .select({ id: runtimeAttempt.id })
          .from(runtimeAttempt)
          .where(
            and(
              eq(runtimeAttempt.id, ctx.attemptID),
              eq(runtimeAttempt.state, "starting"),
              isNull(runtimeAttempt.stopIntendedAt),
              notExists(
                db
                  .select({ id: newer.id })
                  .from(newer)
                  .where(
                    and(
                      eq(newer.workspaceId, runtimeAttempt.workspaceId),
                      gt(newer.generation, runtimeAttempt.generation),
                    ),
                  ),
              ),
            ),
          );
        if (!current)
          throw new CommandError("conflict", "Original native startup is no longer current");
      };
      await requireCurrentStart();
      await currentGrant(ctx, sql, userID, true, sourceOnly);
      await egress(ctx);
      if (signal?.aborted) return before;
      await currentGrant(ctx, sql, userID, true, sourceOnly);
      await requireCurrentStart();
      // The pinned official workflow re-enters under its native Actor lease.
      // Keep the original dispatch/checkpoint/Source facts; do not transfer
      // Source again or issue a Create, hook or inference request here.
      allow(ctx, before.metadata.uid);
      await ctx.call("ResumeActor", { actor: ctx.ref });
      return finish(await observe(ctx, sql, await binding(ctx, sql)));
    }
    if (saved.actorUID) allow(ctx, saved.actorUID);
    return finish(before);
  }
  if (before.status.state !== "ACTOR_STATE_SUSPENDED")
    throw new CommandError(
      "unavailable",
      "Native Resume outcome is unsettled; its RPC was not repeated",
    );
  const operation = await intendActorRPCIn(
    sql,
    ctx.attemptID,
    "resume",
    saved.checkpoint,
    before,
    stopID,
  );
  if (operation.attempted) {
    if (!userID || stopID)
      throw new CommandError("conflict", "Current native execution authority is required");
    await sql.begin((tx) =>
      ctx.workspaceID
        ? requireCapacityWorkspaceResumeIn(
            ctx,
            tx,
            saved,
            before,
            operation,
            userID,
            true,
            sourceOnly,
          )
        : requireInitialVerificationResumeIn(ctx, tx, saved, before, operation, userID),
    );
  }
  if (userID) await currentGrant(ctx, sql, userID, true, sourceOnly);
  if (ctx.workspaceID && !operation.attempted)
    await ctx.sources?.resume(ctx.workspaceID, ctx.attemptID, sql, Boolean(stopID));
  await egress(ctx);
  if (signal?.aborted) return before;
  if (userID) await currentGrant(ctx, sql, userID, true, sourceOnly);
  await sql.begin(async (tx) => {
    if (stopID) {
      const stopped = await nativeInputStopIn(tx, ctx.attemptID, stopID);
      const [source] = await drizzleTransaction(tx)
        .select({
          id: expression<string>`${substrateSource.checkpoint}->>'id'`,
          epoch: substrateSource.writerEpoch,
        })
        .from(substrateSource)
        .where(
          and(
            eq(substrateSource.workspaceId, ctx.workspaceID ?? expression`NULL`),
            eq(substrateSource.actorUid, before.metadata.uid),
            eq(substrateSource.owner, "service"),
            eq(substrateSource.writable, false),
            isNotNull(substrateSource.checkpoint),
          ),
        );
      if (!stopped || !source) throw new Error("Native Stop Source transfer is unconfirmed");
      await drizzleTransaction(tx)
        .update(operationTable)
        .set({
          state: "resumed",
          payload: expression`${operationTable.payload} || jsonb_build_object(
            'sourceCheckpointId', ${source.id}::text,
            'sourceWriterEpoch', ${source.epoch + 1}::bigint,
            'resumeAttemptedAt', now()
          )`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operationTable.id, stopID),
            eq(operationTable.kind, "runtime.input_stop"),
            expression`(${operationTable.payload}->>'resumeAttemptedAt') IS NULL`,
          ),
        );
    }
    if (operation.attempted) {
      if (!userID)
        throw new CommandError("conflict", "Current native execution authority is required");
      // The official workflow can reject worker assignment without advancing
      // the Actor. Continue only the unchanged allocation under current
      // authority, keeping the first dispatch and Source transfer facts.
      if (ctx.workspaceID) {
        await requireCapacityWorkspaceResumeIn(
          ctx,
          tx,
          saved,
          before,
          operation,
          userID,
          true,
          sourceOnly,
        );
        // A confirmed refusal permits one continuation, not retries after an
        // unknown later reply. Only another confirmed capacity rejection
        // below may publish a new wait for this same dispatch.
        await drizzleTransaction(tx)
          .delete(operationTable)
          .where(
            and(
              eq(operationTable.kind, "runtime.compute_wait"),
              eq(operationTable.scopeType, "runtime_attempt"),
              eq(operationTable.scopeId, ctx.attemptID),
              eq(operationTable.idempotencyKey, `runtime.compute_wait:${ctx.attemptID}`),
              expression`${operationTable.payload}->>'reason' = 'compute-capacity'`,
            ),
          );
      } else await requireInitialVerificationResumeIn(ctx, tx, saved, before, operation, userID);
    } else await dispatchActorRPCIn(tx, ctx.attemptID, operation);
    await drizzleTransaction(tx)
      .update(runtimeAttempt)
      .set({ state: "starting", failure: null, updatedAt: expression`now()` })
      .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNull(runtimeAttempt.stopIntendedAt)));
  });
  allow(ctx, before.metadata.uid);
  try {
    await ctx.call("ResumeActor", { actor: ctx.ref });
  } catch (cause) {
    if (
      (ctx.verificationID || ctx.workspaceID) &&
      userID &&
      !stopID &&
      cause instanceof SubstrateRPCError &&
      cause.code === "ResourceExhausted"
    ) {
      let waiting = false;
      try {
        const currentBinding = await binding(ctx, sql);
        const actor = await observe(ctx, sql, currentBinding);
        await sql.begin(async (tx) => {
          const dispatched = await actorRPCIn(
            tx,
            ctx.attemptID,
            "resume",
            actorRPCOrigin(currentBinding.checkpoint),
          );
          if (!dispatched) return;
          if (ctx.workspaceID)
            await requireCapacityWorkspaceResumeIn(
              ctx,
              tx,
              currentBinding,
              actor,
              dispatched,
              userID,
              false,
              sourceOnly,
            );
          else
            await requireInitialVerificationResumeIn(
              ctx,
              tx,
              currentBinding,
              actor,
              dispatched,
              userID,
            );
          const db = drizzleTransaction(tx);
          const waitKey = `runtime.compute_wait:${ctx.attemptID}`;
          await db
            .insert(operationTable)
            .values({
              id: crypto.randomUUID(),
              kind: "runtime.compute_wait",
              scopeType: "runtime_attempt",
              scopeId: ctx.attemptID,
              idempotencyKey: waitKey,
              state: "waiting",
              payload: { reason: "compute-capacity" },
            })
            .onConflictDoNothing({ target: operationTable.idempotencyKey });
          const [hold] = await db
            .select({ reason: expression<string>`${operationTable.payload}->>'reason'` })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.idempotencyKey, waitKey),
                eq(operationTable.kind, "runtime.compute_wait"),
                eq(operationTable.scopeType, "runtime_attempt"),
                eq(operationTable.scopeId, ctx.attemptID),
              ),
            );
          waiting = hold?.reason === "compute-capacity";
        });
      } catch {
        // A lost observation, newer candidate, callback or Stop cannot turn
        // the rejected call into success or overwrite its original failure.
      }
      if (waiting && ctx.workspaceID)
        throw new CommandError(
          "unavailable",
          "Waiting for available compute capacity — no worker has room for this Workspace yet. Your files are safe; retry shortly.",
        );
    }
    throw cause;
  }
  return finish(await observe(ctx, sql, await binding(ctx, sql)));
}
