import { and, desc, eq, sql as expression, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { change, operation, runtimeAttempt, substrateProvision, substrateSource } from "#db/schema";
import { hashConnectorToken } from "#runtime-domain/identity";
import { nativeSnapshot, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import type { PendingWriterHandoff } from "../agent/runtime-api";
import { CommandError } from "../command-error";
import { admitComputeIn } from "../usage/compute";
import {
  allow,
  binding,
  currentGrant,
  egress,
  getActor,
  locked,
  observe,
  profile,
  remember,
  requireSettledBootstrap,
} from "./substrate-exec-actor";
import { requireDurableROOTFS, type SubstrateExecContext } from "./substrate-exec-helpers";
import {
  createIsolatedStartIntentIn,
  createVerificationStartIntentIn,
} from "./substrate-exec-isolated";
import { resumeActorIn } from "./substrate-exec-resume";
import { stopIn, suspendIn } from "./substrate-exec-suspend";
import { substrateWorkspaceGrantIn, substrateWorkspaceRevisionIn } from "./substrate-grant";
import { nativeInputStopIn } from "./substrate-input-stop";
import { substrateResourceReservation } from "./substrate-resources";

export function startExecution(ctx: SubstrateExecContext, userID: string) {
  return locked(ctx, async (sql) => {
    const workspace = await currentGrant(ctx, sql, userID);
    if (
      ctx.workspaceID &&
      !workspace.changeID &&
      (!("ownerID" in workspace) ||
        !workspace.ownerID ||
        personalWorkspaceIdentity(ctx.config.projectID, workspace.ownerID).workspaceID !==
          ctx.workspaceID)
    )
      throw new CommandError("forbidden", "Native owned Workspace identity differs");
    const [existing] = await drizzleTransaction(sql)
      .select({ attemptID: runtimeAttempt.id })
      .from(runtimeAttempt)
      .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNotNull(runtimeAttempt.atespace)));
    if (!existing) {
      const [prior] = await drizzleTransaction(sql)
        .select({
          id: runtimeAttempt.id,
          generation: runtimeAttempt.generation,
          state: runtimeAttempt.state,
          actorUID: runtimeAttempt.actorUid,
          sourceProtocol: expression<
            string | null
          >`${runtimeAttempt.bindingIntent}->>'sourceRestoreProtocol'`,
          deleted: expression<boolean>`${runtimeAttempt.deletedAt} IS NOT NULL`,
        })
        .from(runtimeAttempt)
        .where(
          or(
            ctx.workspaceID ? eq(runtimeAttempt.workspaceId, ctx.workspaceID) : undefined,
            eq(runtimeAttempt.id, ctx.attemptID),
          ),
        )
        .orderBy(desc(runtimeAttempt.generation))
        .limit(1);
      if (prior) {
        const [retained] =
          ctx.workspaceID && ctx.sources && prior.actorUID
            ? await drizzleTransaction(sql)
                .select({ workspaceID: substrateSource.workspaceId })
                .from(substrateSource)
                .innerJoin(
                  substrateProvision,
                  and(
                    eq(substrateProvision.ownerId, substrateSource.workspaceId),
                    eq(substrateProvision.kind, "workspace"),
                    eq(substrateProvision.generation, ctx.config.generation),
                  ),
                )
                .where(
                  and(
                    eq(substrateSource.workspaceId, ctx.workspaceID),
                    eq(substrateSource.owner, "service"),
                    eq(substrateSource.writable, true),
                    or(
                      and(
                        eq(substrateSource.actorUid, prior.actorUID),
                        isNotNull(substrateSource.checkpoint),
                      ),
                      expression`${prior.sourceProtocol === "2"} AND ${substrateSource.serviceBase} IS NOT NULL`,
                    ),
                  ),
                )
            : [];
        if (
          !retained ||
          prior.id === ctx.attemptID ||
          prior.generation + 1 !== ctx.config.generation ||
          prior.state !== "stopped" ||
          !prior.deleted
        )
          throw new Error(
            "Native Workspace successor requires confirmed cleanup and independent Source",
          );
      } else if (ctx.workspaceID && ctx.config.generation !== 1)
        throw new Error("Native Workspace begins with generation one");
      await sql.begin(async (tx) => {
        const db = drizzleTransaction(tx);
        if (ctx.verificationID) {
          await createVerificationStartIntentIn(ctx, tx, ctx.verificationID, userID);
        } else if (ctx.isolated) {
          await createIsolatedStartIntentIn(ctx, tx, ctx.isolated, userID);
        } else {
          if (!ctx.workspaceID) throw new Error("Native Workspace identity is missing");
          const grant = await substrateWorkspaceGrantIn(
            ctx.database,
            tx,
            ctx.workspaceID,
            userID,
            true,
          );
          const revision = await substrateWorkspaceRevisionIn(tx, ctx.workspaceID);
          const [provision] = await db
            .select({ revision: expression<string>`${substrateProvision.intent}->>'revision'` })
            .from(substrateProvision)
            .where(
              and(
                eq(substrateProvision.ownerId, ctx.workspaceID),
                eq(substrateProvision.kind, "workspace"),
                eq(substrateProvision.generation, ctx.config.generation),
              ),
            );
          if (provision && provision.revision !== revision)
            throw new CommandError(
              "conflict",
              "Workspace execution revision differs from its native provisioning intent",
            );
          await admitComputeIn(tx, ctx.config.projectID, substrateResourceReservation(ctx.config));
          await db.insert(runtimeAttempt).values({
            id: ctx.attemptID,
            projectId: grant.projectID,
            workspaceId: ctx.workspaceID,
            changeId: grant.changeID,
            generation: ctx.config.generation,
            revision,
            state: "create-intended",
            parentConnectorTokenHash: hashConnectorToken(ctx.tokens.parent),
            createIntendedAt: expression`now()`,
            createdBy: userID,
            atespace: ctx.atespace,
            actorName: ctx.actorName,
            bindingIntent: ctx.retainedIntent,
          });
        }
        if (ctx.config.environment) {
          const environment =
            "isolatedID" in ctx.config ? ctx.config.environment.environment : "development";
          if (
            ctx.isolated?.isolatedKind === "publication" &&
            (environment !== "development" ||
              ctx.config.environment.version !== 0 ||
              ctx.config.environment.secretKey !== null)
          )
            throw new Error("Publication cannot inherit Project environments");
          await db.insert(operation).values({
            id: crypto.randomUUID(),
            kind: "runtime.environment_intent",
            scopeType: "runtime_attempt",
            scopeId: ctx.attemptID,
            idempotencyKey: `runtime.environment_intent:${ctx.attemptID}`,
            state: "recorded",
            payload: {
              environment,
              version: ctx.config.environment.version,
              secretKey: ctx.config.environment.secretKey,
            },
          });
        }
        if (ctx.config.declaredApps)
          await db
            .update(runtimeAttempt)
            .set({ declaredApps: ctx.config.declaredApps })
            .where(eq(runtimeAttempt.id, ctx.attemptID));
        if (workspace.changeID)
          await db
            .update(change)
            .set({
              runtimeAttemptId: ctx.attemptID,
              state: "starting",
              failure: null,
              version: expression`${change.version}+1`,
            })
            .where(eq(change.id, workspace.changeID));
      });
    }
    let saved = await binding(ctx, sql);
    if (saved.stopping || saved.deleting || saved.deleted)
      throw new Error("Native name is retired; it cannot be recreated");
    await profile(ctx);
    if (!saved.attemptedAt) {
      await currentGrant(ctx, sql, userID, true);
      if (await getActor(ctx)) throw new Error("Foreign or already-existing Actor was not adopted");
      await drizzleTransaction(sql)
        .update(runtimeAttempt)
        .set({ createAttemptedAt: expression`now()` })
        .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNull(runtimeAttempt.createAttemptedAt)));
      saved = await binding(ctx, sql);
      // Persisted above before dispatch. Errors remain unknown, not a second Create.
      let created: unknown;
      try {
        created = await ctx.call("CreateActor", {
          actor: {
            metadata: ctx.ref,
            actorTemplate: { atespace: ctx.atespace, name: "runtime" },
            workerSelector: { matchLabels: ctx.retainedIntent.actorSelector },
          },
        });
      } catch (error) {
        if (
          error instanceof SubstrateRPCError &&
          ["AlreadyExists", "PermissionDenied", "Unauthenticated", "InvalidArgument"].includes(
            error.code,
          )
        )
          await drizzleTransaction(sql)
            .update(runtimeAttempt)
            .set({ createRejected: true })
            .where(eq(runtimeAttempt.id, ctx.attemptID));
        throw error;
      }
      await remember(ctx, sql, saved, created);
      saved = await binding(ctx, sql);
    }
    let actor = await observe(ctx, sql, saved);
    await requireSettledBootstrap(ctx, sql, saved, actor.status.lastAssignedGeneration);
    if (ctx.workspaceID) await ctx.sources?.attach(ctx.workspaceID, actor.metadata.uid, sql);
    await egress(ctx);
    await drizzleTransaction(sql)
      .update(runtimeAttempt)
      .set({
        state: "starting",
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(runtimeAttempt.id, ctx.attemptID),
          eq(runtimeAttempt.state, "create-intended"),
          isNull(runtimeAttempt.stopIntendedAt),
        ),
      );
    // Create produces a natively SUSPENDED Actor. Resume uses that same
    // original identity; no source hooks, prompts or model queues are replayed.
    actor = await resumeActorIn(ctx, sql, saved, actor, userID);
    if (actor.status.state === "ACTOR_STATE_RUNNING") {
      await drizzleTransaction(sql)
        .update(runtimeAttempt)
        .set({
          state: "starting",
          failure: null,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(runtimeAttempt.id, ctx.attemptID),
            eq(runtimeAttempt.state, "create-intended"),
            isNull(runtimeAttempt.stopIntendedAt),
          ),
        );
      allow(ctx, actor.metadata.uid);
    }
    return ctx.attemptID;
  });
}

export function getExecution(ctx: SubstrateExecContext) {
  return locked(ctx, async (sql) => {
    const saved = await binding(ctx, sql);
    if (saved.deleted)
      return {
        engine: "substrate" as const,
        state: "deleted",
        coldRestart: true as const,
        portable: false as const,
        sourceHandoff: "pending" as const,
      };
    const actor = await observe(ctx, sql, saved);
    if (actor.status.state === "ACTOR_STATE_CRASHED") {
      const failure =
        actor.status.crash?.message === "killed for exceeding its memory limit"
          ? "Native execution exceeded its memory limit. Its latest filesystem state is not a confirmed recovery point; retained resources were not reverted or replaced."
          : "Native execution crashed. A pending snapshot is not a confirmed recovery point; retained resources were not reverted or replaced.";
      await drizzleTransaction(sql)
        .update(runtimeAttempt)
        .set({ state: "failed", failure, updatedAt: expression`now()` })
        .where(
          and(
            eq(runtimeAttempt.id, ctx.attemptID),
            inArray(runtimeAttempt.state, ["starting", "ready", "pausing", "paused", "failed"]),
            isNull(runtimeAttempt.stopIntendedAt),
            expression`(${runtimeAttempt.state}<>'failed' OR ${runtimeAttempt.failure} IS DISTINCT FROM ${failure})`,
          ),
        );
    }
    let sourceHandoff: "pending" | "confirmed-same-node" = "pending";
    const [source] = await drizzleTransaction(sql)
      .select({ workspaceID: substrateSource.workspaceId })
      .from(substrateSource)
      .innerJoin(runtimeAttempt, eq(runtimeAttempt.workspaceId, substrateSource.workspaceId))
      .where(
        and(
          eq(runtimeAttempt.id, ctx.attemptID),
          eq(runtimeAttempt.state, "paused"),
          isNull(runtimeAttempt.stopIntendedAt),
          eq(substrateSource.actorUid, actor.metadata.uid),
          eq(substrateSource.owner, "service"),
          eq(substrateSource.writable, true),
          gt(substrateSource.generation, 0),
          isNotNull(substrateSource.serviceBase),
          expression`${substrateSource.checkpoint}->>'actorUID'=${actor.metadata.uid}`,
        ),
      );
    if (source && actor.status.state === "ACTOR_STATE_SUSPENDED" && saved.checkpoint) {
      // A generic suspended state or an old local snapshot is not a Source
      // handoff. Independently re-observe the exact recorded durable ROOTFS.
      const recorded = nativeSnapshot.parse(saved.checkpoint);
      requireDurableROOTFS(actor, saved, recorded);
      sourceHandoff = "confirmed-same-node";
    }
    return {
      engine: "substrate" as const,
      actorUID: actor.metadata.uid,
      state: actor.status.state,
      version: actor.metadata.version,
      coldRestart: true as const,
      portable: false as const,
      sourceHandoff,
    };
  });
}

export function resumeExecution(ctx: SubstrateExecContext, userID: string, sourceOnly = false) {
  return locked(ctx, async (sql) => {
    await currentGrant(ctx, sql, userID, true, sourceOnly);
    const saved = await binding(ctx, sql);
    if (saved.stopping || saved.deleting || saved.deleted)
      throw new Error("Native Actor is stopping");
    const before = await observe(ctx, sql, saved);
    await requireSettledBootstrap(ctx, sql, saved, before.status.lastAssignedGeneration);
    // Public Resume/Suspend have ObjectRef only, no UID/version options.
    // Names are never reused; Get + pinned template + post-observation fence.
    // ROOTFS starts fresh processes during the native wakeup probe. Their
    // frozen environment endpoint must be admitted before dispatch, while
    // Connector upgrades still require the independently observed RUNNING allocation.
    await resumeActorIn(ctx, sql, saved, before, userID, undefined, undefined, sourceOnly);
  });
}

export function suspendExecution(ctx: SubstrateExecContext) {
  return locked(ctx, async (sql) => {
    // A Stop-only worker's authority belongs to its internal settlement,
    // never to an ordinary user Pause while that Stop is still pending.
    if (ctx.workspaceID && (await nativeInputStopIn(sql, ctx.attemptID)))
      throw new CommandError(
        "conflict",
        "Wait for Coding Stop confirmation before pausing this Workspace.",
      );
    return suspendIn(ctx, sql);
  });
}

export function stopExecution(ctx: SubstrateExecContext, handoff?: PendingWriterHandoff) {
  return locked(ctx, (sql) => stopIn(ctx, sql, handoff));
}
