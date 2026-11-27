import { isDeepStrictEqual } from "node:util";
import { and, eq, exists, sql as expression, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, runtimeAttempt } from "#db/schema";
import { hashConnectorToken } from "#runtime-domain/identity";
import {
  nativeActor,
  nativeMetadata,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { trackNativeOperation } from "./native-lock";
import {
  type Binding,
  type Database,
  type LoadedBinding,
  requirePauseContinuity,
  requireResumeContinuity,
  requireSubstrateActor,
  type SubstrateExecContext,
  substrateTemplateSHA256,
} from "./substrate-exec-helpers";
import {
  substrateBootstrapContinuationBlocked,
  substrateBootstrapRetentionIn,
  substrateRetainedSourceIn,
  substrateTicketSourcePauseIn,
  substrateUnsettledBootstrapIn,
  substrateWorkspaceGrantIn,
} from "./substrate-grant";
import { substrateIsolatedGrantIn } from "./substrate-isolated-grant";
import { actorRPCIn, actorRPCOrigin, observeActorRPCIn } from "./substrate-rpc-facts";
import { substrateVerificationGrantIn } from "./substrate-verification-grant";

export async function egress(ctx: SubstrateExecContext) {
  let value: unknown;
  try {
    value = await ctx.call("GetActorEgressPolicy", { actor: ctx.ref, name: "default" });
  } catch (error) {
    if (!(error instanceof SubstrateRPCError) || error.code !== "NotFound") throw error;
    value = await ctx.call("CreateActorEgressPolicy", {
      actor: ctx.ref,
      egressPolicy: {
        metadata: { atespace: ctx.atespace, name: "default" },
        rules: ctx.egressRules,
      },
    });
  }
  const policy = z.object({ metadata: nativeMetadata, rules: z.unknown() }).parse(value);
  if (
    policy.metadata.atespace !== ctx.atespace ||
    policy.metadata.name !== "default" ||
    !isDeepStrictEqual(policy.rules, ctx.egressRules)
  )
    throw new Error("Native Connector egress differs from its pinned restricted policy");
}

export async function binding(
  ctx: SubstrateExecContext,
  sql: Database["client"] | DatabaseTransaction = ctx.database.client,
): Promise<LoadedBinding> {
  const [row] = await drizzleTransaction(sql)
    .select({
      intent: runtimeAttempt.bindingIntent,
      atespace: runtimeAttempt.atespace,
      actorName: runtimeAttempt.actorName,
      actorUID: runtimeAttempt.actorUid,
      attemptedAt: expression<string | null>`${runtimeAttempt.createAttemptedAt}::text`,
      createRejected: runtimeAttempt.createRejected,
      stopping: expression<boolean>`${runtimeAttempt.stopIntendedAt} IS NOT NULL`,
      deleting: expression<boolean>`${runtimeAttempt.deleteIntendedAt} IS NOT NULL`,
      deleted: expression<boolean>`${runtimeAttempt.deletedAt} IS NOT NULL`,
      checkpoint: runtimeAttempt.checkpoint,
      observation: runtimeAttempt.observation,
    })
    .from(runtimeAttempt)
    .where(and(eq(runtimeAttempt.id, ctx.attemptID), isNotNull(runtimeAttempt.atespace)));
  if (!row?.atespace || !row.actorName || !isDeepStrictEqual(row.intent, ctx.retainedIntent))
    throw new Error("Native current configuration differs from immutable binding");
  return { ...row, atespace: row.atespace, actorName: row.actorName, intent: ctx.retainedIntent };
}

export function locked<T>(
  ctx: SubstrateExecContext,
  action: (sql: Database["client"]) => Promise<T>,
) {
  return trackNativeOperation(
    (async () => {
      const sql = ctx.database.coordination();
      try {
        await sql`SELECT pg_advisory_lock(hashtext(${`runtime:${ctx.ownerID}`}))`;
        const [db] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
        if (db?.name !== ctx.config.database)
          throw new Error("Native adapter is limited to its explicitly owned database");
        return await action(sql);
      } finally {
        try {
          await sql`SELECT pg_advisory_unlock(hashtext(${`runtime:${ctx.ownerID}`}))`;
        } finally {
          await sql.end({ timeout: 1 });
        }
      }
    })(),
  );
}

export async function profile(ctx: SubstrateExecContext) {
  const space = z
    .object({ metadata: nativeMetadata })
    .parse(await ctx.call("GetAtespace", { atespace: { name: ctx.atespace } }));
  const template = z
    .object({
      metadata: nativeMetadata,
      snapshotConfig: z
        .object({
          preferredFidelity: z.enum(["SNAPSHOT_FIDELITY_ROOTFS", "SNAPSHOT_FIDELITY_MEMORY"]),
          goldenSnapshotConfig: z
            .object({ mode: z.literal("GOLDEN_SNAPSHOT_MODE_DISABLED") })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(
      await ctx.call("GetActorTemplate", {
        actorTemplate: { atespace: ctx.atespace, name: "runtime" },
      }),
    );
  if (
    space.metadata.name !== ctx.atespace ||
    space.metadata.uid !== ctx.config.atespaceUID ||
    template.metadata.atespace !== ctx.atespace ||
    template.metadata.name !== "runtime" ||
    template.metadata.uid !== ctx.config.templateUID ||
    template.metadata.version !== ctx.config.templateVersion ||
    substrateTemplateSHA256(template) !== ctx.config.templateSHA256
  )
    throw new Error("Native Atespace/template/profile binding changed");
  return template;
}

export async function getActor(ctx: SubstrateExecContext) {
  try {
    return await ctx.call("GetActor", { actor: ctx.ref });
  } catch (error) {
    if (error instanceof SubstrateRPCError && error.code === "NotFound") return null;
    throw error;
  }
}

export async function validateObservation(
  ctx: SubstrateExecContext,
  sql: Database["client"] | DatabaseTransaction,
  saved: Binding,
  value: unknown,
) {
  const actor = requireSubstrateActor(value, saved);
  const old = saved.observation ? nativeActor.parse(saved.observation) : null;
  if (old && BigInt(actor.metadata.version) < BigInt(old.metadata.version))
    throw new Error("Stale native resource version");
  // Validate before replacing the retained observation. A rejected native
  // substitution must not become the next read's trusted progress.
  requirePauseContinuity(actor, saved);
  if (["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"].includes(actor.status.state)) {
    const resumed = await actorRPCIn(
      sql,
      ctx.attemptID,
      "resume",
      actorRPCOrigin(saved.checkpoint),
    );
    if (resumed?.attempted && !resumed.outcome) requireResumeContinuity(actor, saved, resumed);
  }
  return actor;
}

export async function remember(
  ctx: SubstrateExecContext,
  sql: Database["client"] | DatabaseTransaction,
  saved: Binding,
  value: unknown,
) {
  const actor = await validateObservation(ctx, sql, saved, value);
  const result = await drizzleTransaction(sql)
    .update(runtimeAttempt)
    .set({
      actorUid: expression`COALESCE(${runtimeAttempt.actorUid},${actor.metadata.uid}::uuid)`,
      observation: actor,
    })
    .where(
      and(
        eq(runtimeAttempt.id, ctx.attemptID),
        isNull(runtimeAttempt.deletedAt),
        or(isNull(runtimeAttempt.actorUid), eq(runtimeAttempt.actorUid, actor.metadata.uid)),
      ),
    )
    .returning({ attemptID: runtimeAttempt.id });
  if (result.length !== 1) throw new Error("Native current Actor UID binding changed");
  return actor;
}

export function allow(ctx: SubstrateExecContext, uid: string) {
  ctx.hub.allow(
    ctx.attemptID,
    ctx.config.generation,
    hashConnectorToken(ctx.tokens.parent),
    hashConnectorToken(ctx.tokens.child),
    uid,
  );
}

export async function observe(
  ctx: SubstrateExecContext,
  sql: Database["client"] | DatabaseTransaction,
  saved: Binding,
) {
  if (saved.createRejected)
    throw new Error("Native Create was rejected; an existing Actor is never adopted");
  await profile(ctx);
  const value = await getActor(ctx);
  if (!value) throw new Error("Original native Actor not observed; create is never replayed");
  const actor = await remember(ctx, sql, saved, value);
  if (actor.status.state === "ACTOR_STATE_RUNNING") {
    const resumed = await actorRPCIn(
      sql,
      ctx.attemptID,
      "resume",
      actorRPCOrigin(saved.checkpoint),
    );
    if (resumed?.attempted && !resumed.outcome)
      await observeActorRPCIn(sql, ctx.attemptID, resumed, actor);
  }
  if (
    (ctx.verificationID || ctx.workspaceID) &&
    ["ACTOR_STATE_RESUMING", "ACTOR_STATE_RUNNING"].includes(actor.status.state)
  ) {
    const db = drizzleTransaction(sql);
    await db.delete(operation).where(
      and(
        eq(operation.kind, "runtime.compute_wait"),
        eq(operation.scopeType, "runtime_attempt"),
        eq(operation.scopeId, ctx.attemptID),
        eq(operation.idempotencyKey, `runtime.compute_wait:${ctx.attemptID}`),
        expression`${operation.payload}->>'reason' = 'compute-capacity'`,
        exists(
          db
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.id, ctx.attemptID),
                inArray(runtimeAttempt.state, ["starting", "ready"]),
                isNull(runtimeAttempt.stopIntendedAt),
              ),
            ),
        ),
      ),
    );
  }
  return actor;
}

export async function inputStopVersion(ctx: SubstrateExecContext) {
  // Provisioning retains metadata only. Read bootstrap capability from the
  // native owner after its exact UID/version/spec-hash checks. Its credential-
  // bearing environment is never persisted or returned.
  const template = z
    .object({
      containers: z.array(
        z.object({ env: z.array(z.object({ name: z.string(), value: z.string() })) }),
      ),
    })
    .safeParse(await profile(ctx));
  const entries = template.success
    ? template.data.containers
        .flatMap((container) => container.env)
        .filter((env) => env.name === "FACTORY_SUBSTRATE_BOOTSTRAP")
    : [];
  if (entries.length !== 1) return null;
  try {
    const bootstrap = z
      .object({
        sourceHandoff: z.literal(true),
        inputStop: z.object({
          version: z.literal(1),
          openCodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        }),
      })
      .safeParse(JSON.parse(entries[0]?.value ?? "null"));
    return bootstrap.success ? bootstrap.data.inputStop.openCodeVersion : null;
  } catch {
    return null;
  }
}

export async function currentGrant(
  ctx: SubstrateExecContext,
  sql: Database["client"] | DatabaseTransaction,
  userID: string,
  newExecution = false,
  sourceOnly = false,
) {
  return sql.begin(async (tx) => {
    if (sourceOnly) {
      if (!ctx.workspaceID || !ctx.sources || ctx.verificationID || ctx.isolated)
        throw new CommandError("forbidden", "Current Workspace Source grant required");
      const workspace = await workspaceAuthorityIn(tx, ctx.workspaceID, userID, true);
      const retained = await substrateRetainedSourceIn(tx, ctx.workspaceID, ctx.attemptID);
      if (!retained || retained.projectID !== ctx.config.projectID)
        throw new CommandError("conflict", "Current retained Actor Source grant required");
      return workspace;
    }
    if (ctx.verificationID)
      return substrateVerificationGrantIn(
        tx,
        ctx.config.projectID,
        ctx.verificationID,
        ctx.attemptID,
        userID,
      );
    if (ctx.isolated)
      return substrateIsolatedGrantIn(
        tx,
        ctx.config.projectID,
        ctx.isolated,
        ctx.attemptID,
        userID,
      );
    if (!ctx.workspaceID) throw new Error("Native Workspace identity is missing");
    const workspace = await substrateWorkspaceGrantIn(
      ctx.database,
      tx,
      ctx.workspaceID,
      userID,
      newExecution,
    );
    if (workspace.projectID !== ctx.config.projectID)
      throw new CommandError("forbidden", "Native Workspace Project differs from its grant");
    return workspace;
  });
}

export async function retainedBootstrap(ctx: SubstrateExecContext, sql: Database["client"]) {
  if (ctx.config.deployment !== "fresh-workspaces" || !ctx.workspaceID || !ctx.sources)
    return false;
  return Boolean(await substrateBootstrapRetentionIn(sql, ctx.workspaceID, ctx.attemptID));
}

export async function retainedTicketPause(ctx: SubstrateExecContext, sql: Database["client"]) {
  return ctx.workspaceID && ctx.sources
    ? sql.begin((transaction) => substrateTicketSourcePauseIn(transaction, ctx.attemptID))
    : null;
}

export async function requireSettledBootstrap(
  ctx: SubstrateExecContext,
  sql: Database["client"],
  saved: Binding,
  generation = 0,
) {
  if (
    (saved.checkpoint || generation > 0) &&
    ((await retainedBootstrap(ctx, sql)) ||
      (ctx.config.deployment === "fresh-workspaces" &&
        ctx.workspaceID &&
        ctx.sources &&
        (await substrateUnsettledBootstrapIn(sql, ctx.workspaceID, ctx.attemptID))))
  )
    throw new CommandError("conflict", substrateBootstrapContinuationBlocked);
}
