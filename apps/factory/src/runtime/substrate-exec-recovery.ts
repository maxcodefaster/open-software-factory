import { isDeepStrictEqual } from "node:util";
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
import { z } from "zod";
import { drizzleTransaction } from "#db/client";
import { developmentWorkspace, runtimeAttempt, substrateSource } from "#db/schema";
import { nativeActor } from "#runtime-kubernetes/substrate-control";
import { requireStoppedAgentInputsIn } from "../agent/runtime-api";
import { trackNativeOperation } from "./native-lock";
import {
  allow,
  binding,
  currentGrant,
  getActor,
  locked,
  observe,
  profile,
  retainedTicketPause,
  validateObservation,
} from "./substrate-exec-actor";
import { requireResumeContinuity, type SubstrateExecContext } from "./substrate-exec-helpers";
import { resumeActorIn } from "./substrate-exec-resume";
import { stopHandoffIn, stopIn, suspendIn } from "./substrate-exec-suspend";
import { substrateRetainedSourceIn, substrateRuntimePrincipalIn } from "./substrate-grant";
import { nativeInputStopIn } from "./substrate-input-stop";
import { substrateIsolatedPrincipalIn } from "./substrate-isolated-grant";
import { actorRPCIn, actorRPCOrigin } from "./substrate-rpc-facts";
import { substrateVerificationPrincipalIn } from "./substrate-verification-grant";

export function recoverExecution(ctx: SubstrateExecContext) {
  return locked(ctx, async (sql) => {
    const [present] = await drizzleTransaction(sql)
      .select({ attemptID: runtimeAttempt.id })
      .from(runtimeAttempt)
      .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNotNull(runtimeAttempt.atespace)));
    if (!present) return;
    const saved = await binding(ctx, sql);
    if (saved.deleting || saved.stopping) return stopIn(ctx, sql);
    if (saved.deleted || !saved.attemptedAt) return;
    const actor = await observe(ctx, sql, saved);
    const workspaceID = ctx.workspaceID;
    if (
      workspaceID &&
      ctx.sources &&
      actor.status.state === "ACTOR_STATE_RUNNING" &&
      (await sql.begin((tx) => substrateRetainedSourceIn(tx, workspaceID, ctx.attemptID)))
    ) {
      // Reconnect only the retained Source control owner. Observation does
      // not replay an uncertain Resume or acquire a completed Ticket writer.
      allow(ctx, actor.metadata.uid);
      return;
    }
    if (actor.status.state === "ACTOR_STATE_RESUMING") {
      const principal = await sql.begin((tx) =>
        ctx.verificationID
          ? substrateVerificationPrincipalIn(tx, ctx.attemptID)
          : ctx.isolated
            ? substrateIsolatedPrincipalIn(tx, ctx.attemptID)
            : substrateRuntimePrincipalIn(
                tx,
                ctx.attemptID,
                Boolean(ctx.workspaceID && ctx.sources),
              ),
      );
      await resumeActorIn(ctx, sql, saved, actor, principal);
      return;
    }
    if (["ACTOR_STATE_SUSPENDING", "ACTOR_STATE_SUSPENDED"].includes(actor.status.state)) {
      const [pausing] = await drizzleTransaction(sql)
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(
          and(
            eq(runtimeAttempt.id, ctx.attemptID),
            eq(runtimeAttempt.state, "pausing"),
            isNull(runtimeAttempt.stopIntendedAt),
          ),
        );
      // Continue only the recorded native Pause, not an uncertain Resume or
      // inference. suspendIn requires its original dispatch and snapshot,
      // and still independently confirms durability before Source handoff.
      if (pausing) await suspendIn(ctx, sql);
      return;
    }
    if (actor.status.state !== "ACTOR_STATE_RUNNING") return;
    if (await nativeInputStopIn(sql, ctx.attemptID)) {
      allow(ctx, actor.metadata.uid);
      return;
    }
    if (await retainedTicketPause(ctx, sql)) {
      allow(ctx, actor.metadata.uid);
      // Admission precedes reconnect. Only the authenticated, advertising
      // original Parent can continue this same checkpoint after it returns.
      if (ctx.hub.sourceConnected(ctx.attemptID)) await suspendIn(ctx, sql);
      return;
    }
    const db = drizzleTransaction(sql);
    const [attempt] = await db
      .select({ userID: runtimeAttempt.createdBy })
      .from(runtimeAttempt)
      .where(
        and(
          eq(runtimeAttempt.id, ctx.attemptID),
          or(
            inArray(runtimeAttempt.state, ["starting", "ready"]),
            and(
              expression`${Boolean(ctx.workspaceID && ctx.sources)}`,
              inArray(runtimeAttempt.state, ["failed", "pausing"]),
              exists(
                db
                  .select({ workspaceID: developmentWorkspace.id })
                  .from(developmentWorkspace)
                  .innerJoin(
                    substrateSource,
                    and(
                      eq(substrateSource.workspaceId, developmentWorkspace.id),
                      eq(runtimeAttempt.actorUid, substrateSource.actorUid),
                    ),
                  )
                  .where(
                    and(
                      eq(developmentWorkspace.id, runtimeAttempt.workspaceId),
                      eq(developmentWorkspace.kind, "personal"),
                      eq(substrateSource.owner, "actor"),
                      or(
                        and(isNull(runtimeAttempt.readyAt), isNotNull(runtimeAttempt.failure)),
                        and(
                          eq(runtimeAttempt.state, "pausing"),
                          isNotNull(runtimeAttempt.readyAt),
                          eq(substrateSource.writable, false),
                          isNotNull(substrateSource.checkpointId),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ),
          isNull(runtimeAttempt.stopIntendedAt),
        ),
      );
    if (!attempt) return;
    const principal = await sql.begin((tx) =>
      ctx.verificationID
        ? substrateVerificationPrincipalIn(tx, ctx.attemptID)
        : ctx.isolated
          ? substrateIsolatedPrincipalIn(tx, ctx.attemptID)
          : substrateRuntimePrincipalIn(tx, ctx.attemptID, Boolean(ctx.workspaceID && ctx.sources)),
    );
    await currentGrant(ctx, sql, principal);
    allow(ctx, actor.metadata.uid);
  });
}

export function authorizeConnectorRequest(ctx: SubstrateExecContext, request: Request) {
  if (
    request.headers.get("x-factory-runtime-attempt") !== ctx.attemptID ||
    request.headers.get("x-factory-runtime-generation") !== String(ctx.config.generation)
  )
    return false;
  // Native Resume owns the lifecycle lock until its control wakeup passes.
  // Admission must validate independently or the authentic Parent can never
  // establish the very connection that completes that native operation.
  const authorize = async () => {
    const sql = ctx.database.client;
    const saved = await binding(ctx, sql);
    const actorUID = saved.actorUID;
    if (
      !actorUID ||
      saved.deleting ||
      saved.deleted ||
      request.headers.get("x-factory-runtime-actor-uid") !== actorUID
    )
      return false;
    const retainedSourceParent = Boolean(
      ctx.workspaceID &&
        ctx.sources &&
        request.headers.get("x-factory-connector-role") === "parent",
    );
    const db = drizzleTransaction(sql);
    const newer = alias(runtimeAttempt, "newer");
    const allocation = async () => {
      await profile(ctx);
      const value = await getActor(ctx);
      if (!value) throw new Error("Original native Actor not observed");
      const actor = await validateObservation(ctx, sql, saved, value);
      if (
        actor.status.state === "ACTOR_STATE_RESUMING" &&
        saved.observation &&
        nativeActor.parse(saved.observation).status.state === "ACTOR_STATE_SUSPENDED"
      ) {
        // Source bootstrap needs the observed allocation, but admission
        // must never overwrite a later lifecycle/Stop observation.
        await db
          .update(runtimeAttempt)
          .set({ observation: actor })
          .where(
            and(
              eq(runtimeAttempt.id, ctx.attemptID),
              eq(runtimeAttempt.actorUid, actorUID),
              eq(runtimeAttempt.observation, saved.observation),
              isNull(runtimeAttempt.deleteIntendedAt),
              isNull(runtimeAttempt.deletedAt),
            ),
          );
      }
      return actor;
    };
    if (retainedSourceParent) {
      const [cleanup] = await db
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .innerJoin(substrateSource, eq(substrateSource.workspaceId, runtimeAttempt.workspaceId))
        .where(
          and(
            eq(runtimeAttempt.id, ctx.attemptID),
            eq(runtimeAttempt.state, "stopping"),
            isNotNull(runtimeAttempt.stopIntendedAt),
            eq(substrateSource.actorUid, actorUID),
            eq(substrateSource.owner, "actor"),
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
      if (cleanup) {
        await requireStoppedAgentInputsIn(sql, ctx.attemptID, await stopHandoffIn(ctx, sql));
        return (await allocation()).status.state === "ACTOR_STATE_RUNNING";
      }
    }
    const [attempt] = await db
      .select({ userID: runtimeAttempt.createdBy })
      .from(runtimeAttempt)
      .where(
        and(
          eq(runtimeAttempt.id, ctx.attemptID),
          eq(runtimeAttempt.generation, ctx.config.generation),
          or(
            inArray(runtimeAttempt.state, ["starting", "ready"]),
            and(
              expression`${retainedSourceParent}`,
              inArray(runtimeAttempt.state, ["failed", "pausing"]),
            ),
          ),
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
    if (!attempt) return false;
    const stoppingInput = await nativeInputStopIn(sql, ctx.attemptID);
    if (stoppingInput) {
      if (
        request.headers.get("x-factory-connector-role") !== "parent" ||
        !stoppingInput.resumed ||
        stoppingInput.completed
      )
        return false;
      return (await allocation()).status.state === "ACTOR_STATE_RUNNING";
    }
    if (retainedSourceParent && (await retainedTicketPause(ctx, sql)))
      return (await allocation()).status.state === "ACTOR_STATE_RUNNING";
    if (retainedSourceParent && ctx.workspaceID) {
      const workspaceID = ctx.workspaceID;
      if (await sql.begin((tx) => substrateRetainedSourceIn(tx, workspaceID, ctx.attemptID))) {
        const origin = actorRPCOrigin(saved.checkpoint);
        const resumed = await actorRPCIn(sql, ctx.attemptID, "resume", origin);
        if (
          !resumed?.attempted ||
          resumed.stopID ||
          resumed.actorUID !== actorUID ||
          !isDeepStrictEqual(resumed.originCheckpoint, saved.checkpoint)
        )
          return false;
        if (await actorRPCIn(sql, ctx.attemptID, "suspend", origin)) return false;
        const actor = await allocation();
        if (!(await sql.begin((tx) => substrateRetainedSourceIn(tx, workspaceID, ctx.attemptID))))
          return false;
        if (await actorRPCIn(sql, ctx.attemptID, "suspend", origin)) return false;
        if (!resumed.outcome) requireResumeContinuity(actor, saved, resumed);
        else {
          const completed = z
            .object({
              actorUID: z.literal(actorUID),
              state: z.literal("ACTOR_STATE_RUNNING"),
              version: z.string().regex(/^\d+$/),
            })
            .safeParse(resumed.outcome);
          if (
            !completed.success ||
            actor.status.state !== "ACTOR_STATE_RUNNING" ||
            BigInt(actor.metadata.version) < BigInt(completed.data.version)
          )
            return false;
        }
        return ["ACTOR_STATE_RUNNING", "ACTOR_STATE_RESUMING"].includes(actor.status.state);
      }
    }
    const principal = await sql.begin((tx) =>
      ctx.verificationID
        ? substrateVerificationPrincipalIn(tx, ctx.attemptID)
        : ctx.isolated
          ? substrateIsolatedPrincipalIn(tx, ctx.attemptID)
          : substrateRuntimePrincipalIn(tx, ctx.attemptID, retainedSourceParent),
    );
    await currentGrant(ctx, sql, principal);
    const actor = await allocation();
    await currentGrant(ctx, sql, principal);
    if (actor.status.state === "ACTOR_STATE_RUNNING") return true;
    if (actor.status.state !== "ACTOR_STATE_RESUMING") return false;
    const resumed = await actorRPCIn(
      sql,
      ctx.attemptID,
      "resume",
      actorRPCOrigin(saved.checkpoint),
    );
    if (!resumed?.attempted || resumed.stopID) return false;
    if (await actorRPCIn(sql, ctx.attemptID, "suspend", actorRPCOrigin(saved.checkpoint)))
      return false;
    requireResumeContinuity(actor, saved, resumed);
    // The official Resume waits for the control wakeup. These original,
    // authenticated control channels must connect during that allocation;
    // Project entry and writable Source still require their separate grants.
    return true;
  };
  return trackNativeOperation(authorize()).catch(() => false);
}
