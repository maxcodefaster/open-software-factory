import {
  and,
  eq,
  exists,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  developmentWorkspace,
  operation as operationTable,
  runtimeAttempt,
  substrateProvision,
  substrateSource,
} from "#db/schema";
import { nativeSnapshot } from "#runtime-kubernetes/substrate-control";
import type { RetainedStopTarget } from "../agent/runtime-api";
import { templateInitialSourceRole } from "../workspace/source-role-fence";
import { trackNativeOperation } from "./native-lock";
import { allow, binding, inputStopVersion, locked, observe, profile } from "./substrate-exec-actor";
import {
  type Database,
  requireDurableROOTFS,
  type SubstrateExecContext,
} from "./substrate-exec-helpers";
import { resumeActorIn } from "./substrate-exec-resume";
import { suspendIn } from "./substrate-exec-suspend";
import {
  matchesNativeInputStop,
  nativeInputStopAssignment,
  nativeInputStopIn,
  nativeInputStopResult,
} from "./substrate-input-stop";

async function completeInputStopIn(
  ctx: SubstrateExecContext,
  sql: Database["client"],
  stopID: string,
) {
  const changed = await drizzleTransaction(sql)
    .update(operationTable)
    .set({
      state: "completed",
      completedAt: expression`now()`,
      updatedAt: expression`now()`,
      payload: expression`${operationTable.payload} || jsonb_build_object(
        'completedCheckpoint', ${runtimeAttempt.checkpoint},
        'completedSourceCheckpointId', ${substrateSource.checkpoint}->>'id'
      )`,
    })
    .from(runtimeAttempt)
    .innerJoin(substrateSource, eq(substrateSource.workspaceId, runtimeAttempt.workspaceId))
    .where(
      and(
        eq(operationTable.id, stopID),
        eq(operationTable.kind, "runtime.input_stop"),
        eq(operationTable.scopeType, "runtime_attempt"),
        eq(operationTable.scopeId, ctx.attemptID),
        eq(runtimeAttempt.id, ctx.attemptID),
        eq(runtimeAttempt.state, "paused"),
        isNull(runtimeAttempt.stopIntendedAt),
        expression`${substrateSource.workspaceId} = (${operationTable.payload}->>'workspaceId')::uuid`,
        expression`${runtimeAttempt.actorUid} = (${operationTable.payload}->>'actorUid')::uuid`,
        expression`${runtimeAttempt.observation}#>>'{status,state}' = 'ACTOR_STATE_SUSPENDED'`,
        expression`(${runtimeAttempt.checkpoint}->>'generation')::bigint > (${operationTable.payload}->'checkpoint'->>'generation')::bigint`,
        expression`${runtimeAttempt.checkpoint}->>'uuid' IS DISTINCT FROM ${operationTable.payload}->'checkpoint'->>'uuid'`,
        expression`${substrateSource.actorUid} = (${operationTable.payload}->>'actorUid')::uuid`,
        eq(substrateSource.owner, "service"),
        eq(substrateSource.writable, true),
        isNotNull(substrateSource.checkpoint),
        isNotNull(substrateSource.serviceBase),
        isNotNull(operationTable.result),
        expression`(${operationTable.result}->'confirmed') = 'true'::jsonb`,
        isNull(operationTable.completedAt),
      ),
    )
    .returning({ stopID: operationTable.id });
  if (changed.length !== 1)
    throw new Error("Native Stop completion lost its exact Source/snapshot binding");
}

// The maintenance caller holds the installation fence and this Workspace's
// transaction lock. This permits retaining stopped work across an upgrade,
// not confirming Stop or dispatching any cleanup, lifecycle or inference.
export async function stoppedWorkRetainedIn(
  ctx: SubstrateExecContext,
  sql: DatabaseTransaction,
  stopID: string,
) {
  const db = drizzleTransaction(sql);
  const newer = alias(runtimeAttempt, "newer");
  const [retained] = await db
    .select({
      id: runtimeAttempt.id,
      state: runtimeAttempt.state,
      sourceOwner: substrateSource.owner,
      sourceActorUID: substrateSource.actorUid,
    })
    .from(runtimeAttempt)
    .innerJoin(
      developmentWorkspace,
      and(
        eq(developmentWorkspace.id, runtimeAttempt.workspaceId),
        eq(developmentWorkspace.projectId, runtimeAttempt.projectId),
        eq(developmentWorkspace.changeId, runtimeAttempt.changeId),
        eq(developmentWorkspace.kind, "ticket"),
      ),
    )
    .innerJoin(
      change,
      and(eq(change.id, runtimeAttempt.changeId), eq(change.runtimeAttemptId, runtimeAttempt.id)),
    )
    .innerJoin(
      changeAgentSession,
      and(
        eq(changeAgentSession.changeId, change.id),
        eq(changeAgentSession.runtimeAttemptId, runtimeAttempt.id),
      ),
    )
    .innerJoin(
      changeAgentTurnIntent,
      and(
        eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
        eq(changeAgentTurnIntent.changeId, change.id),
        eq(changeAgentTurnIntent.runtimeAttemptId, runtimeAttempt.id),
        eq(changeAgentTurnIntent.sessionId, changeAgentSession.opencodeSessionId),
        isNotNull(changeAgentTurnIntent.promptId),
      ),
    )
    .innerJoin(
      agentTurn,
      and(eq(agentTurn.id, changeAgentTurnIntent.turnId), eq(agentTurn.changeId, change.id)),
    )
    .innerJoin(substrateSource, eq(substrateSource.workspaceId, developmentWorkspace.id))
    .where(
      and(
        eq(runtimeAttempt.id, ctx.attemptID),
        inArray(runtimeAttempt.state, ["paused", "ready"]),
        isNull(runtimeAttempt.stopIntendedAt),
        exists(
          db
            .select({ id: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "installation.maintenance"),
                eq(operationTable.idempotencyKey, "installation.maintenance:singleton"),
                eq(operationTable.state, "enabled"),
              ),
            ),
        ),
        eq(changeAgentSession.state, "stopped"),
        eq(changeAgentSession.stopPending, true),
        eq(changeAgentSession.stopId, stopID),
        isNotNull(changeAgentSession.nativeSessionConfirmedAt),
        inArray(agentTurn.state, ["failed", "stopped", "completed"]),
        eq(substrateSource.writable, true),
        gt(substrateSource.generation, 0),
        isNull(substrateSource.checkpointId),
        or(
          and(
            eq(substrateSource.owner, "actor"),
            isNotNull(runtimeAttempt.readyAt),
            isNotNull(substrateSource.seedConfirmedAt),
          ),
          and(
            eq(substrateSource.owner, "service"),
            isNotNull(substrateSource.serviceBase),
            isNotNull(substrateSource.checkpoint),
          ),
        ),
        notExists(
          db
            .select({ stopID: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "runtime.input_stop"),
                eq(operationTable.scopeType, "runtime_attempt"),
                eq(operationTable.scopeId, expression`${runtimeAttempt.id}::text`),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "runtime.actor_rpc"),
                eq(operationTable.scopeType, "runtime_attempt"),
                eq(operationTable.scopeId, expression`${runtimeAttempt.id}::text`),
                isNull(operationTable.result),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: newer.id })
            .from(newer)
            .where(
              and(
                eq(newer.workspaceId, developmentWorkspace.id),
                gt(newer.generation, runtimeAttempt.generation),
              ),
            ),
        ),
      ),
    );
  if (!retained) return false;
  const saved = await binding(ctx, sql);
  if (saved.stopping || saved.deleting || saved.deleted || !saved.actorUID || !saved.attemptedAt)
    return false;
  if (retained.sourceActorUID !== saved.actorUID) return false;
  if (
    retained.sourceOwner === "actor" &&
    (!ctx.sources || saved.intent.sourceRestoreProtocol !== 2)
  )
    return false;
  if (retained.sourceOwner === "service" && (retained.state !== "paused" || !saved.checkpoint))
    return false;
  const actor = await observe(ctx, sql, saved);
  if (retained.sourceOwner === "actor") {
    // The control plane does not replace or resume the canonical Actor.
    // Keeping an explicitly stopped, unconfirmed input is not quiescence
    // or execution authority; its Stop barrier survives the upgrade.
    if (retained.state === "ready") return actor.status.state === "ACTOR_STATE_RUNNING";
    if (!saved.checkpoint) return false;
    requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
    return true;
  }
  requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
  const [source] = await db
    .select({ workspaceID: substrateSource.workspaceId })
    .from(substrateSource)
    .where(
      and(
        eq(substrateSource.workspaceId, ctx.workspaceID ?? expression`NULL`),
        eq(substrateSource.actorUid, actor.metadata.uid),
        eq(substrateSource.owner, "service"),
        eq(substrateSource.writable, true),
        isNotNull(substrateSource.serviceBase),
        gt(substrateSource.generation, 0),
        expression`${substrateSource.checkpoint}->>'actorUID'=${actor.metadata.uid}`,
        expression`${substrateSource.checkpoint}->>'workspaceID'=${substrateSource.workspaceId}::text`,
        expression`(${substrateSource.checkpoint}->>'generation')::bigint=${substrateSource.generation}`,
        expression`(${substrateSource.checkpoint}->>'writerEpoch')::bigint<${substrateSource.writerEpoch}`,
      ),
    );
  return Boolean(source && (await inputStopVersion(ctx)));
}

export async function supportsInitialSourceRole(
  ctx: SubstrateExecContext,
  sql: DatabaseTransaction,
) {
  return trackNativeOperation(
    (async () => {
      if (!ctx.workspaceID || ctx.config.deployment !== "fresh-workspaces") return false;
      const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      if (db?.name !== ctx.config.database)
        throw new Error("Native adapter is limited to its explicitly owned database");
      const saved = await binding(ctx, sql);
      if (saved.deleting || saved.deleted || !saved.actorUID || saved.checkpoint) return false;
      const [provision] = await drizzleTransaction(sql)
        .select({
          workloadImage: expression<
            string | null
          >`${substrateProvision.intent}#>>'{configuration,workloadImage}'`,
        })
        .from(substrateProvision)
        .where(
          and(
            eq(substrateProvision.ownerId, ctx.workspaceID),
            eq(substrateProvision.kind, "workspace"),
            eq(substrateProvision.generation, ctx.config.generation),
          ),
        );
      if (!provision?.workloadImage) return false;
      // The caller already owns the runtime try-lock. Do not acquire another
      // connection/lock here. Native reads validate UID/version/full spec hash.
      return templateInitialSourceRole(await profile(ctx), {
        workspaceID: ctx.workspaceID,
        attemptID: ctx.attemptID,
        generation: ctx.config.generation,
        projectID: ctx.config.projectID,
        workloadImage: provision.workloadImage,
      });
    })(),
  );
}

export async function settleInputStop(
  ctx: SubstrateExecContext,
  target: RetainedStopTarget,
  signal: AbortSignal,
) {
  if (!ctx.workspaceID || !ctx.sources || target.attemptID !== ctx.attemptID || signal.aborted)
    return false;
  const workspaceID = ctx.workspaceID;
  const sources = ctx.sources;
  const progress = await locked(ctx, async (sql) => {
    let operation = await nativeInputStopIn(sql, ctx.attemptID, target.stopID);
    if (
      operation &&
      (operation.changeID !== target.changeID ||
        operation.assignment.sessionID !== target.sessionID ||
        operation.assignment.promptID !== target.promptID)
    )
      return "pending";
    const saved = await binding(ctx, sql);
    if (saved.deleting || saved.deleted || !saved.actorUID) return "pending";
    const actor = await observe(ctx, sql, saved);
    if (operation?.completed) {
      requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
      await sources.requireIndependent(workspaceID, saved.actorUID, sql);
      return "complete";
    }
    if (!operation) {
      if (
        target.mode === "observe" ||
        actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
        !saved.checkpoint
      )
        return "pending";
      requireDurableROOTFS(actor, saved, nativeSnapshot.parse(saved.checkpoint));
      await sources.requireIndependent(workspaceID, saved.actorUID, sql);
      const [scope] = await drizzleTransaction(sql)
        .select({ modelID: expression<string>`${agentTurn.authority}->>'modelId'` })
        .from(changeAgentSession)
        .innerJoin(
          changeAgentTurnIntent,
          eq(changeAgentTurnIntent.turnId, changeAgentSession.stopTurnId),
        )
        .innerJoin(agentTurn, eq(agentTurn.id, changeAgentTurnIntent.turnId))
        .innerJoin(runtimeAttempt, eq(runtimeAttempt.id, changeAgentSession.runtimeAttemptId))
        .where(
          and(
            eq(changeAgentSession.changeId, target.changeID),
            eq(changeAgentSession.state, "stopped"),
            eq(changeAgentSession.stopPending, true),
            eq(changeAgentSession.stopId, target.stopID),
            eq(changeAgentSession.runtimeAttemptId, ctx.attemptID),
            eq(changeAgentSession.opencodeSessionId, target.sessionID),
            eq(changeAgentTurnIntent.runtimeAttemptId, ctx.attemptID),
            eq(changeAgentTurnIntent.sessionId, target.sessionID),
            eq(changeAgentTurnIntent.promptId, target.promptID),
          ),
        );
      if (!scope) return "pending";
      const version = await inputStopVersion(ctx);
      if (!version) return "pending";
      const assignment = nativeInputStopAssignment.parse({
        stopID: target.stopID,
        attemptID: ctx.attemptID,
        sessionID: target.sessionID,
        promptID: target.promptID,
        modelID: scope.modelID,
        version,
        mode: "interrupt",
      });
      await drizzleTransaction(sql)
        .insert(operationTable)
        .values({
          id: target.stopID,
          kind: "runtime.input_stop",
          scopeType: "runtime_attempt",
          scopeId: ctx.attemptID,
          idempotencyKey: `runtime.input_stop:${target.stopID}`,
          state: "intended",
          payload: {
            stopId: target.stopID,
            runtimeAttemptId: ctx.attemptID,
            workspaceId: workspaceID,
            changeId: target.changeID,
            actorUid: saved.actorUID,
            assignment,
            checkpoint: saved.checkpoint,
          },
        });
      operation = await nativeInputStopIn(sql, ctx.attemptID, target.stopID);
    }
    if (!operation) return "pending";
    if (!operation.resumed) {
      // Admission above is durable before closing the independently editable
      // Source. Export its latest offline edits, not the original pause copy.
      if (target.mode === "observe" || actor.status.state !== "ACTOR_STATE_SUSPENDED")
        return "pending";
      requireDurableROOTFS(actor, saved, nativeSnapshot.parse(operation.checkpoint));
      // This is the original Actor and its admitted Stop-only cold branch.
      // The recorded RPC is never replayed after an uncertain response.
      await resumeActorIn(ctx, sql, saved, actor, null, target.stopID, signal);
      return signal.aborted ? "pending" : "working";
    }
    if (actor.status.state === "ACTOR_STATE_RUNNING") {
      allow(ctx, operation.actorUID);
      return "working";
    }
    if (
      operation.result &&
      ["ACTOR_STATE_SUSPENDED", "ACTOR_STATE_SUSPENDING"].includes(actor.status.state)
    ) {
      await suspendIn(ctx, sql);
      if (operation.result.confirmed) {
        await completeInputStopIn(ctx, sql, target.stopID);
        return "complete";
      }
      return "pending";
    }
    return "pending";
  });
  if (progress === "complete") return true;
  if (progress !== "working" || signal.aborted) return false;
  // The wakeup probe confirms Stop-only admission before the metadata
  // engine finishes. Observe its existing Source transport briefly, with
  // no second Resume; the normal Stop observer retains longer outcomes.
  for (
    let observation = 0;
    observation < 5 && !signal.aborted && !ctx.hub.sourceConnected(ctx.attemptID);
    observation++
  )
    await Bun.sleep(1000);
  if (signal.aborted || !ctx.hub.sourceConnected(ctx.attemptID)) return false;
  let result: z.infer<typeof nativeInputStopResult> | null = null;
  const existing = await nativeInputStopIn(ctx.database.client, ctx.attemptID, target.stopID);
  if (!existing) return false;
  result = existing.result;
  if (!result) {
    try {
      const response = await ctx.hub.parentOperation(ctx.attemptID, {
        operationId: target.stopID,
        action: "input-stop-result",
      });
      const parsed = nativeInputStopResult.safeParse(JSON.parse(response.data ?? "null"));
      if (parsed.success && matchesNativeInputStop(existing.assignment, parsed.data))
        result = parsed.data;
    } catch {
      /* An unknown result never confirms Stop. Source may still be safely paused. */
    }
  }
  if (!result) return false;
  const observedResult = result;
  return locked(ctx, async (sql) => {
    const operation = await nativeInputStopIn(sql, ctx.attemptID, target.stopID);
    if (!operation || signal.aborted) return false;
    if (operation.completed) return true;
    if (observedResult)
      await drizzleTransaction(sql)
        .update(operationTable)
        .set({
          result: observedResult,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operationTable.id, target.stopID),
            eq(operationTable.kind, "runtime.input_stop"),
            isNull(operationTable.result),
            expression`(${operationTable.payload}->>'resumeAttemptedAt') IS NOT NULL`,
          ),
        );
    await suspendIn(ctx, sql);
    if (!observedResult.confirmed) return false;
    await completeInputStopIn(ctx, sql, target.stopID);
    return true;
  });
}
