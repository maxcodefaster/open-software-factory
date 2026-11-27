import {
  and,
  desc,
  eq,
  exists,
  sql as expression,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  change,
  changeCommitOperation,
  operation as operationTable,
  runtimeAttempt,
  substrateProvision,
  verification,
} from "#db/schema";
import { hashConnectorToken } from "#runtime-domain/identity";
import type { NativeActor } from "#runtime-kubernetes/substrate-control";
import { CommandError } from "../command-error";
import { admitComputeIn } from "../usage/compute";
import type {
  Binding,
  SubstrateExecContext,
  SubstrateIsolatedConfiguration,
} from "./substrate-exec-helpers";
import { substrateIsolatedGrantIn } from "./substrate-isolated-grant";
import { substrateResourceReservation } from "./substrate-resources";
import { type ActorRPC, actorRPCIn } from "./substrate-rpc-facts";
import { substrateVerificationGrantIn } from "./substrate-verification-grant";

export async function requireInitialVerificationResumeIn(
  ctx: SubstrateExecContext,
  sql: DatabaseTransaction,
  saved: Binding,
  actor: NativeActor,
  operation: ActorRPC,
  userID: string,
) {
  if (
    !ctx.verificationID ||
    ctx.workspaceID ||
    saved.deleting ||
    saved.deleted ||
    saved.checkpoint !== null ||
    operation.action !== "resume" ||
    !operation.attempted ||
    operation.outcome ||
    operation.originKey !== "initial" ||
    operation.originCheckpoint !== null ||
    operation.stopID !== null ||
    operation.actorUID !== saved.actorUID ||
    actor.metadata.uid !== operation.actorUID ||
    actor.metadata.version !== operation.nativeVersion ||
    actor.status.state !== "ACTOR_STATE_SUSPENDED" ||
    actor.status.workerAssignment ||
    actor.status.lastAssignedGeneration ||
    actor.status.snapshots?.length ||
    actor.sourceTag !== undefined ||
    (await actorRPCIn(sql, ctx.attemptID, "suspend", "initial"))
  )
    throw new CommandError(
      "unavailable",
      "Initial native Verification Resume differs from its original unassigned Actor",
    );
  await substrateVerificationGrantIn(
    sql,
    ctx.config.projectID,
    ctx.verificationID,
    ctx.attemptID,
    userID,
  );
  const db = drizzleTransaction(sql);
  const [current] = await db
    .select({ id: runtimeAttempt.id })
    .from(runtimeAttempt)
    .innerJoin(verification, eq(verification.id, runtimeAttempt.verificationId))
    .innerJoin(change, eq(change.id, verification.changeId))
    .where(
      and(
        eq(runtimeAttempt.id, ctx.attemptID),
        eq(runtimeAttempt.projectId, ctx.config.projectID),
        eq(runtimeAttempt.verificationId, ctx.verificationID),
        eq(runtimeAttempt.isolatedKind, "verification"),
        isNull(runtimeAttempt.workspaceId),
        isNull(runtimeAttempt.changeId),
        eq(runtimeAttempt.generation, ctx.config.generation),
        eq(runtimeAttempt.revision, verification.commitSha),
        eq(runtimeAttempt.state, "starting"),
        isNull(runtimeAttempt.readyAt),
        isNull(runtimeAttempt.stopIntendedAt),
        inArray(verification.state, ["pending", "runner-starting"]),
        eq(verification.runtimeAttemptId, runtimeAttempt.id),
        eq(
          verification.commitSha,
          db
            .select({ commitSHA: changeCommitOperation.commitSha })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, change.id),
                eq(changeCommitOperation.state, "succeeded"),
              ),
            )
            .orderBy(desc(changeCommitOperation.sequence))
            .limit(1),
        ),
      ),
    );
  if (!current)
    throw new CommandError(
      "conflict",
      "Current never-started exact-commit Verification is required for native continuation",
    );
}

export async function createVerificationStartIntentIn(
  ctx: SubstrateExecContext,
  tx: DatabaseTransaction,
  verificationID: string,
  userID: string,
) {
  const db = drizzleTransaction(tx);
  const grant = await substrateVerificationGrantIn(
    tx,
    ctx.config.projectID,
    verificationID,
    ctx.attemptID,
    userID,
  );
  await admitComputeIn(tx, ctx.config.projectID, substrateResourceReservation(ctx.config));
  await db.insert(runtimeAttempt).values({
    id: ctx.attemptID,
    projectId: ctx.config.projectID,
    verificationId: verificationID,
    isolatedKind: "verification",
    generation: ctx.config.generation,
    revision: grant.revision,
    state: "create-intended",
    parentConnectorTokenHash: hashConnectorToken(ctx.tokens.parent),
    createIntendedAt: expression`now()`,
    createdBy: userID,
    atespace: ctx.atespace,
    actorName: ctx.actorName,
    bindingIntent: ctx.retainedIntent,
  });
  await db
    .update(verification)
    .set({
      runtimeAttemptId: ctx.attemptID,
      state: "runner-starting",
      updatedAt: expression`now()`,
    })
    .where(and(eq(verification.id, verificationID), isNull(verification.runtimeAttemptId)));
}

export async function createIsolatedStartIntentIn(
  ctx: SubstrateExecContext,
  tx: DatabaseTransaction,
  isolated: SubstrateIsolatedConfiguration,
  userID: string,
) {
  const db = drizzleTransaction(tx);
  const grant = await substrateIsolatedGrantIn(
    tx,
    ctx.config.projectID,
    isolated,
    ctx.attemptID,
    userID,
  );
  await admitComputeIn(tx, ctx.config.projectID, substrateResourceReservation(ctx.config));
  await db.insert(runtimeAttempt).values({
    id: ctx.attemptID,
    projectId: ctx.config.projectID,
    isolatedKind: isolated.isolatedKind,
    generation: ctx.config.generation,
    revision: grant.revision,
    state: "create-intended",
    parentConnectorTokenHash: hashConnectorToken(ctx.tokens.parent),
    createIntendedAt: expression`now()`,
    createdBy: userID,
    atespace: ctx.atespace,
    actorName: ctx.actorName,
    bindingIntent: ctx.retainedIntent,
  });
  if (isolated.isolatedKind === "publication") {
    const linked = await db
      .update(operationTable)
      .set({
        payload: expression`jsonb_set(${operationTable.payload}, '{runtimeAttemptId}', to_jsonb(${ctx.attemptID}::text))`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operationTable.id, isolated.isolatedID),
          eq(operationTable.kind, "releases.attempt"),
          expression`(${operationTable.payload}->>'runtimeAttemptId') IS NULL`,
          eq(operationTable.state, "running"),
        ),
      )
      .returning({ id: operationTable.id });
    if (linked.length !== 1) throw new Error("Publication execution owner changed before binding");
  } else if (isolated.promotionID) {
    const linked = await db
      .update(operationTable)
      .set({
        payload: expression`jsonb_set(${operationTable.payload}, '{replacementRuntimeAttemptId}', to_jsonb(${ctx.attemptID}::text))`,
        state: "starting",
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operationTable.id, isolated.promotionID),
          eq(operationTable.kind, "delivery.promotion"),
          expression`(${operationTable.payload}->>'replacementRuntimeAttemptId') IS NULL`,
          eq(operationTable.state, "pending"),
        ),
      )
      .returning({ id: operationTable.id });
    if (linked.length !== 1) throw new Error("Promotion execution owner changed before binding");
  } else {
    const predecessor = alias(runtimeAttempt, "predecessor");
    const linked = await db
      .update(operationTable)
      .set({
        state: "attached",
        payload: expression`jsonb_set(${operationTable.payload}, '{runtimeAttemptId}', to_jsonb(${ctx.attemptID}::text))`,
        updatedAt: expression`now()`,
      })
      .where(
        and(
          eq(operationTable.kind, "delivery.staging_preview"),
          eq(operationTable.scopeType, "project"),
          eq(operationTable.scopeId, ctx.config.projectID),
          eq(operationTable.idempotencyKey, `delivery.staging_preview:${ctx.config.projectID}`),
          expression`${operationTable.payload}->>'revision' = ${grant.revision}`,
          or(
            expression`(${operationTable.payload}->>'runtimeAttemptId') IS NULL`,
            exists(
              db
                .select({ id: predecessor.id })
                .from(predecessor)
                .where(
                  and(
                    expression`${predecessor.id}::text = ${operationTable.payload}->>'runtimeAttemptId'`,
                    eq(predecessor.state, "stopped"),
                    isNotNull(predecessor.deletedAt),
                  ),
                ),
            ),
          ),
        ),
      )
      .returning({ projectID: operationTable.scopeId });
    if (linked.length !== 1) throw new Error("Staging Preview changed before binding");
  }
  if (isolated.isolatedKind === "staging") {
    const [provision] = await db
      .select({
        declaration: expression<Record<
          string,
          unknown
        > | null>`${substrateProvision.intent}->'declaration'`,
      })
      .from(substrateProvision)
      .where(
        and(
          eq(substrateProvision.runtimeAttemptId, ctx.attemptID),
          eq(substrateProvision.kind, "staging"),
        ),
      );
    if (
      !provision?.declaration ||
      typeof provision.declaration !== "object" ||
      Array.isArray(provision.declaration)
    )
      throw new Error("Staging declaration is missing");
    await db.insert(operationTable).values({
      id: crypto.randomUUID(),
      kind: "runtime.staging_configuration",
      scopeType: "runtime_attempt",
      scopeId: ctx.attemptID,
      idempotencyKey: `runtime.staging_configuration:${ctx.attemptID}`,
      state: "recorded",
      payload: {
        runtimeAttemptId: ctx.attemptID,
        declaration: provision.declaration,
      },
      createdBy: userID,
      completedAt: expression`now()`,
    });
  }
}
