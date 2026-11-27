import { and, eq, sql as expression, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import { changeWriter, operation as operationTable, runtimeAttempt } from "#db/schema";
import { nativeActor, nativeSnapshot } from "#runtime-kubernetes/substrate-control";
import { type PendingWriterHandoff, requireStoppedAgentInputsIn } from "../agent/runtime-api";
import { CommandError } from "../command-error";
import {
  allow,
  binding,
  getActor,
  observe,
  profile,
  remember,
  retainedBootstrap,
} from "./substrate-exec-actor";
import {
  type Database,
  requireDurableROOTFS,
  requireRecordedPause,
  requireSubstrateActor,
  retainedPauseProgress,
  type SubstrateExecContext,
} from "./substrate-exec-helpers";
import { substrateUnsettledBootstrapIn } from "./substrate-grant";
import { nativeInputStopIn } from "./substrate-input-stop";
import {
  actorRPCIn,
  actorRPCOrigin,
  dispatchActorRPCIn,
  intendActorRPCIn,
  observeActorRPCIn,
} from "./substrate-rpc-facts";

export async function suspendIn(ctx: SubstrateExecContext, sql: Database["client"]) {
  const saved = await binding(ctx, sql);
  if (saved.stopping || saved.deleting || saved.deleted)
    throw new Error("Native Actor is stopping");
  const before = await observe(ctx, sql, saved);
  const [recorded] = await drizzleTransaction(sql)
    .select({ state: runtimeAttempt.state })
    .from(runtimeAttempt)
    .where(eq(runtimeAttempt.id, ctx.attemptID));
  const reentering =
    before.status.state === "ACTOR_STATE_SUSPENDING" && recorded?.state === "pausing";
  if (
    !["ACTOR_STATE_RUNNING", "ACTOR_STATE_SUSPENDED"].includes(before.status.state) &&
    !reentering
  )
    throw new CommandError(
      "unavailable",
      "Native pause outcome is unsettled; no operation was repeated",
    );
  const completing =
    before.status.state === "ACTOR_STATE_SUSPENDED" &&
    (recorded?.state === "pausing" || recorded?.state === "paused");
  const retainedProgress = reentering || completing ? retainedPauseProgress(saved) : undefined;
  const continuation = reentering ? requireRecordedPause(before, saved) : retainedProgress;
  // A disconnected initial Parent cannot prove workload liveness. An already
  // completed durable pause can be reconciled without another checkpoint.
  const bootstrap = await retainedBootstrap(ctx, sql);
  const unsettledInitial =
    bootstrap ||
    Boolean(
      ctx.workspaceID &&
        ctx.sources &&
        (await substrateUnsettledBootstrapIn(sql, ctx.workspaceID, ctx.attemptID)),
    );
  if (unsettledInitial && !completing && !reentering && !ctx.hub.sourceConnected(ctx.attemptID))
    throw new CommandError(
      "unavailable",
      "Initial Source is unavailable. No native checkpoint was dispatched because workload liveness and Source handoff are unconfirmed.",
    );
  const retainBootstrap = bootstrap && completing;
  const inputStop = ctx.workspaceID ? await nativeInputStopIn(sql, ctx.attemptID) : null;
  if (ctx.workspaceID && !inputStop && !completing && !reentering) {
    // Current file access may wake this retained Actor. An ordinary halt
    // must not preserve admitted inference that the file read could resume.
    // Coding cancellation has its own explicit command and confirmation.
    const [active] = await sql`
      SELECT a.id FROM factory.runtime_attempt a WHERE a.id=${ctx.attemptID}
      AND (EXISTS(SELECT 1 FROM factory.agent_turn turn
        WHERE turn.change_id=a.change_id AND turn.state IN ('pending','dispatching','running','uncertain'))
        OR EXISTS(SELECT 1 FROM factory.change_agent_session session
          WHERE session.runtime_attempt_id=a.id
            AND (session.stop_pending OR session.state IN ('starting','working'))))`;
    if (active)
      throw new CommandError(
        "conflict",
        "Stop Coding before pausing this Workspace. File access may resume compute, never AI work.",
      );
  }
  if (inputStop?.snapshotAttempted && !completing && !reentering)
    throw new CommandError(
      "unavailable",
      "Recorded Stop-only native pause is unconfirmed; its snapshot RPC was not repeated",
    );
  const origin = actorRPCOrigin(saved.checkpoint);
  let operation = await actorRPCIn(sql, ctx.attemptID, "suspend", origin);
  if (reentering) {
    if (
      !continuation ||
      !operation?.attempted ||
      operation.outcome ||
      operation.actorUID !== before.metadata.uid ||
      operation.stopID !== (inputStop?.stopID ?? null) ||
      BigInt(before.metadata.version) <= BigInt(operation.nativeVersion)
    )
      throw new CommandError(
        "unavailable",
        "Native pause continuation requires its original dispatched Actor and checkpoint",
      );
    if (retainedProgress) {
      if (
        retainedProgress.uuid !== continuation.uuid ||
        retainedProgress.generation !== continuation.generation ||
        retainedProgress.durableSnapshot.object.snapshotUri !==
          continuation.durableSnapshot.object.snapshotUri ||
        (retainedProgress.durableSnapshot.state === "SNAPSHOT_STORAGE_STATE_COMPLETED" &&
          continuation.durableSnapshot.state !== "SNAPSHOT_STORAGE_STATE_COMPLETED")
      )
        throw new Error("Recorded native pause snapshot changed during continuation");
    }
  } else if (!completing) {
    if (operation?.attempted)
      throw new CommandError(
        "unavailable",
        "Recorded native Pause remains unconfirmed; its RPC was not repeated",
      );
    const resumed = await actorRPCIn(sql, ctx.attemptID, "resume", origin);
    if (!resumed?.attempted || !resumed.outcome)
      throw new CommandError("unavailable", "Native Pause requires its recorded original Resume");
    operation = await intendActorRPCIn(
      sql,
      ctx.attemptID,
      "suspend",
      saved.checkpoint,
      before,
      inputStop?.stopID,
    );
  }
  if (completing && !operation?.attempted)
    requireDurableROOTFS(before, saved, nativeSnapshot.parse(saved.checkpoint));
  if (completing && operation?.attempted && !operation.outcome) requireRecordedPause(before, saved);
  await drizzleTransaction(sql)
    .update(runtimeAttempt)
    .set({ state: "pausing", updatedAt: expression`now()` })
    .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNull(runtimeAttempt.stopIntendedAt)));
  // Ordinary Pause is wholly native. Only the separate read-only Coding
  // cancellation protocol may need its own Source export, never user halt.
  if (ctx.workspaceID && inputStop && !retainBootstrap)
    await ctx.sources?.freezeActor(ctx.workspaceID, ctx.attemptID, sql);
  ctx.hub.revoke(ctx.attemptID);
  if (!completing && !reentering) {
    if (!operation) throw new Error("Native Pause dispatch intent is unavailable");
    const dispatch = operation;
    await sql.begin(async (tx) => {
      await dispatchActorRPCIn(tx, ctx.attemptID, dispatch);
      if (inputStop)
        await drizzleTransaction(tx)
          .update(operationTable)
          .set({
            state: "suspending",
            payload: expression`${operationTable.payload} || jsonb_build_object('snapshotAttemptedAt', now())`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(operationTable.id, inputStop.stopID),
              eq(operationTable.kind, "runtime.input_stop"),
              expression`(${operationTable.payload}->>'resumeAttemptedAt') IS NOT NULL`,
              expression`(${operationTable.payload}->>'snapshotAttemptedAt') IS NULL`,
            ),
          );
    });
    operation = { ...dispatch, attempted: true };
  }
  // A completed observation needs no RPC. Only a pinned server-side
  // SUSPENDING workflow may re-enter native Suspend, which continues its
  // existing snapshot under Substrate's Actor lease rather than minting one.
  const returned = completing
    ? before
    : requireSubstrateActor(
        z.object({ actor: nativeActor }).parse(
          await ctx.call("SuspendActor", {
            actor: ctx.ref,
            options: { mode: "DURABILITY_MODE_SYNCHRONOUS" },
          }),
        ).actor,
        { ...saved, actorUID: before.metadata.uid },
      );
  const returnedSnapshot = requireDurableROOTFS(
    returned,
    { ...saved, actorUID: before.metadata.uid },
    continuation,
  );
  if (operation?.attempted && completing && returnedSnapshot.uuid === operation.originKey)
    throw new Error("Native Pause did not produce its next ROOTFS checkpoint");
  const actor = await observe(ctx, sql, await binding(ctx, sql));
  const checkpoint = requireDurableROOTFS(
    actor,
    { ...saved, actorUID: before.metadata.uid },
    returnedSnapshot,
  );
  if (
    before.status.state === "ACTOR_STATE_RUNNING" &&
    checkpoint.generation <= (before.status.lastAssignedGeneration ?? 0)
  )
    throw new Error("Suspend did not produce the next snapshot generation");
  // Independent Get established COMPLETED. Keep the last good checkpoint
  // on every rejection; a native reply alone cannot release Source.
  const dispatched = operation;
  await sql.begin(async (tx) => {
    const db = drizzleTransaction(tx);
    await db.update(runtimeAttempt).set({ checkpoint }).where(eq(runtimeAttempt.id, ctx.attemptID));
    await db
      .update(runtimeAttempt)
      .set({
        state: "paused",
        failure: expression`CASE WHEN ${runtimeAttempt.readyAt} IS NULL THEN ${runtimeAttempt.failure} ELSE NULL END`,
        updatedAt: expression`now()`,
      })
      .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNull(runtimeAttempt.stopIntendedAt)));
    if (dispatched?.attempted && !dispatched.outcome)
      await observeActorRPCIn(tx, ctx.attemptID, dispatched, actor, checkpoint);
  });
  if (ctx.workspaceID && inputStop && !retainBootstrap)
    await ctx.sources?.makeIndependent(ctx.workspaceID, sql);
}

export async function stopHandoffIn(ctx: SubstrateExecContext, sql: Database["client"]) {
  if (!ctx.workspaceID) return undefined;
  // Recover only the already commissioned handoff, never grant a new writer.
  const [pending] = await drizzleTransaction(sql)
    .select({
      turnID: changeWriter.turnId,
      epoch: expression<string>`${changeWriter.epoch}::text`,
    })
    .from(changeWriter)
    .innerJoin(runtimeAttempt, eq(runtimeAttempt.changeId, changeWriter.changeId))
    .where(
      and(
        eq(runtimeAttempt.id, ctx.attemptID),
        isNotNull(runtimeAttempt.stopIntendedAt),
        eq(changeWriter.state, "agent-preparing"),
        eq(changeWriter.fenceAttemptId, ctx.attemptID),
        eq(changeWriter.fenceRequired, true),
      ),
    );
  return pending?.turnID ? { turnID: pending.turnID, epoch: pending.epoch } : undefined;
}

export async function stopIn(
  ctx: SubstrateExecContext,
  sql: Database["client"],
  handoff?: PendingWriterHandoff,
) {
  let saved = await binding(ctx, sql);
  const db = drizzleTransaction(sql);
  let pendingHandoff = handoff;
  if (!saved.deleted) {
    pendingHandoff ??= await stopHandoffIn(ctx, sql);
    if (ctx.workspaceID) await requireStoppedAgentInputsIn(sql, ctx.attemptID, pendingHandoff);
    // Final Stop is durable before Source export. It can only continue cleanup.
    await db
      .update(runtimeAttempt)
      .set({
        stopIntendedAt: expression`COALESCE(${runtimeAttempt.stopIntendedAt},now())`,
        state: "stopping",
        updatedAt: expression`now()`,
      })
      .where(eq(runtimeAttempt.id, ctx.attemptID));
    await ctx.shutdownCoding(ctx.attemptID);
    ctx.hub.suspend(ctx.attemptID);
    if (ctx.workspaceID && ctx.config.deployment === "fresh-workspaces") {
      if (!ctx.sources || !saved.actorUID)
        throw new CommandError(
          "unavailable",
          "Workspace Stop requires its confirmed Source owner; the original Actor was retained",
        );
      if (!saved.deleting) {
        await observe(ctx, sql, saved);
        // Keep the original Parent available only for its fenced Source export.
        // A fresh bootstrap cannot fetch its Environment under final Stop intent.
        allow(ctx, saved.actorUID);
        await ctx.sources.freezeActor(ctx.workspaceID, ctx.attemptID, sql);
        await ctx.sources.makeIndependent(ctx.workspaceID, sql);
      }
      await ctx.sources.requireIndependent(ctx.workspaceID, saved.actorUID, sql);
    }
    await db
      .update(runtimeAttempt)
      .set({
        deleteIntendedAt: expression`COALESCE(${runtimeAttempt.deleteIntendedAt},now())`,
      })
      .where(eq(runtimeAttempt.id, ctx.attemptID));
    ctx.hub.revoke(ctx.attemptID);
    saved = await binding(ctx, sql);
    if (ctx.workspaceID) await requireStoppedAgentInputsIn(sql, ctx.attemptID, pendingHandoff);
    await profile(ctx);
    const value = await getActor(ctx);
    if (value) {
      if (!saved.actorUID)
        throw new Error("Delete requires previously observed original Actor UID");
      const actor = await remember(ctx, sql, saved, value);
      await ctx.call("DeleteActor", {
        actor: ctx.ref,
        options: { uid: saved.actorUID, version: actor.metadata.version },
      });
      if (await getActor(ctx)) throw new Error("Native Delete has not completed");
    } else if (!saved.actorUID)
      throw new Error(
        "Unknown create outcome retained; absent Actor without an original UID is not confirmed deletion",
      );
    await db
      .update(runtimeAttempt)
      .set({ deletedAt: expression`now()` })
      .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNull(runtimeAttempt.deletedAt)));
  }
  // A crash after confirmed Delete must still complete the saved Stop outcome.
  await db
    .update(runtimeAttempt)
    .set({
      state: "stopped",
      updatedAt: expression`now()`,
    })
    .where(
      and(eq(runtimeAttempt.id, ctx.attemptID), expression`${runtimeAttempt.state}<>'stopped'`),
    );
}
