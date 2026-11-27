import { and, desc, eq, exists, inArray, notInArray, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { change as changeTable, deliveryApproval, operation as operationTable } from "#db/schema";
import type { ForgeRepository } from "#forge/contracts";
import { ForgeAmbiguousWriteError } from "#forge/forge";
import { forgeRepositoryFromURL } from "#forge/repository";
import { CommandError } from "../command-error";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import type { DeliveryChangeRow } from "./controller-projection";
import {
  bounded,
  type Database,
  type DrizzleDB,
  type ForgeClient,
  failureMessage,
} from "./controller-types";
import { deliveryDelegationIn } from "./coordination";
import { verificationWorkflowPath } from "./verification";

const DELIVERY_PULL_REQUEST_KIND = "delivery.pull_request";
const DELIVERY_MERGE_KIND = "delivery.merge";
const DELIVERY_PROMOTION_KIND = "delivery.promotion";
const DELIVERY_STAGING_PREVIEW_KIND = "delivery.staging_preview";

export async function recoverDeliveryOperations(db: DrizzleDB) {
  await db
    .update(operationTable)
    .set({ state: "ambiguous", updatedAt: query`now()` })
    .where(
      and(
        eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
        eq(operationTable.state, "executing"),
      ),
    );
  await db
    .update(operationTable)
    .set({ state: "ambiguous", updatedAt: query`now()` })
    .where(
      and(eq(operationTable.kind, DELIVERY_MERGE_KIND), eq(operationTable.state, "executing")),
    );
}

export async function ensurePullRequest(
  db: DrizzleDB,
  forge: ForgeClient,
  allowedOwner: string,
  change: DeliveryChangeRow,
) {
  const repository = forgeRepositoryFromURL(change.repositoryURL);
  if (repository.owner !== allowedOwner) {
    throw new Error("Project Forge owner is not allowed");
  }
  const selection = {
    id: operationTable.id,
    state: operationTable.state,
    number: query<string | null>`${operationTable.result}->>'number'`,
    url: query<string | null>`${operationTable.result}->>'url'`,
  };
  const readOperation = () =>
    db
      .select(selection)
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
          eq(operationTable.scopeType, "change"),
          eq(operationTable.scopeId, change.id),
        ),
      )
      .limit(1);
  let operations = await readOperation();
  if (!operations[0]) {
    operations = await db
      .insert(operationTable)
      .values({
        id: crypto.randomUUID(),
        kind: DELIVERY_PULL_REQUEST_KIND,
        scopeType: "change",
        scopeId: change.id,
        idempotencyKey: `${DELIVERY_PULL_REQUEST_KIND}:change:${change.id}:pull-request`,
        activeKey: `${DELIVERY_PULL_REQUEST_KIND}:${change.id}`,
        state: "pending",
        payload: {
          changeId: change.id,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          baseBranch: change.defaultBranch,
          headBranch: change.branchName,
          commitSha: change.commitSHA,
          firstHeadSha: change.commitSHA,
          title: change.title,
          body: bounded(change.description, 10_000),
        },
        createdBy: change.userID,
      })
      .onConflictDoNothing({ target: operationTable.idempotencyKey })
      .returning(selection);
    if (!operations[0]) operations = await readOperation();
  }
  const operation = operations[0];
  if (!operation) throw new Error("Pull request intent was not created");
  if (operation.state === "failed") throw new Error("Pull request creation failed");
  if (operation.state !== "succeeded") {
    await db
      .update(operationTable)
      .set({ state: "executing", updatedAt: query`now()` })
      .where(
        and(
          eq(operationTable.id, operation.id),
          eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
          inArray(operationTable.state, ["pending", "ambiguous"]),
        ),
      );
    try {
      const protectedWorkflow = await forge.getFile(
        repository,
        verificationWorkflowPath,
        change.defaultBranch,
      );
      if (!protectedWorkflow.trim()) throw new Error("Factory Verification workflow is empty");
      await forge.ensureDefaultBranchProtection(repository, change.defaultBranch);
      const pullRequest = await forge.ensurePullRequest({
        repository,
        baseBranch: change.defaultBranch,
        headBranch: change.branchName,
        expectedHeadSha: change.commitSHA ?? "",
        title: change.title,
        body: bounded(change.description, 10_000),
      });
      await db
        .update(operationTable)
        .set({
          state: "succeeded",
          activeKey: null,
          result: { number: pullRequest.number, url: pullRequest.url },
          completedAt: query`now()`,
          updatedAt: query`now()`,
          error: null,
        })
        .where(
          and(
            eq(operationTable.id, operation.id),
            eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
            eq(operationTable.state, "executing"),
          ),
        );
      return { repository, pullRequest };
    } catch (cause) {
      const message = failureMessage(cause, "Pull request failed");
      if (cause instanceof ForgeAmbiguousWriteError) {
        await db
          .update(operationTable)
          .set({ state: "ambiguous", error: message, updatedAt: query`now()` })
          .where(
            and(
              eq(operationTable.id, operation.id),
              eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
              eq(operationTable.state, "executing"),
            ),
          );
        return null;
      }
      await db
        .update(operationTable)
        .set({
          state: "failed",
          activeKey: null,
          error: message,
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(operationTable.id, operation.id),
            eq(operationTable.kind, DELIVERY_PULL_REQUEST_KIND),
            eq(operationTable.state, "executing"),
          ),
        );
      throw cause;
    }
  }
  const pullRequest = await forge.getPullRequest(
    repository,
    change.defaultBranch,
    change.branchName,
  );
  if (!pullRequest) throw new Error("Persisted pull request is missing in Forgejo");
  return { repository, pullRequest };
}

export async function reconcileMerge(
  database: Database,
  db: DrizzleDB,
  forge: ForgeClient,
  change: DeliveryChangeRow,
  repository: ForgeRepository,
) {
  const rows = await db
    .select({
      id: operationTable.id,
      state: operationTable.state,
      commitSHA: query<string>`${operationTable.payload}->>'commitSha'`,
      baseSHA: query<string>`${operationTable.payload}->>'baseSha'`,
      pullRequestNumber: query<string>`${operationTable.payload}->>'pullRequestNumber'`,
      monitoringIncidentID: deliveryApproval.monitoringIncidentId,
      deliveryPolicyID: deliveryApproval.deliveryPolicyId,
    })
    .from(operationTable)
    .innerJoin(
      deliveryApproval,
      eq(
        query<string>`${deliveryApproval.id}::text`,
        query<string>`${operationTable.payload}->>'approvalId'`,
      ),
    )
    .where(
      and(
        eq(operationTable.kind, DELIVERY_MERGE_KIND),
        eq(operationTable.scopeType, "change"),
        eq(operationTable.scopeId, change.id),
      ),
    )
    .orderBy(
      desc(query<boolean>`${operationTable.state}<>'failed'`),
      desc(operationTable.createdAt),
      desc(operationTable.id),
    )
    .limit(1);
  const operation = rows[0];
  if (!operation || operation.state === "failed") return;
  const ensurePromotion = async (transaction: DatabaseTransaction) => {
    // Imported Projects need not have opened Main Preview before their first
    // Delivery. Initialize only its empty selection, never replace an
    // existing Preview, and persist the Promotion before starting compute.
    const tx = drizzleTransaction(transaction);
    const confirmedMerge = and(
      eq(operationTable.id, operation.id),
      eq(operationTable.kind, DELIVERY_MERGE_KIND),
      eq(operationTable.state, "succeeded"),
    );
    const previewKey = `${DELIVERY_STAGING_PREVIEW_KIND}:${change.projectID}`;
    await tx
      .insert(operationTable)
      .select(
        tx
          .select({
            id: query<string>`${crypto.randomUUID()}::uuid`.as("id"),
            kind: query<string>`${DELIVERY_STAGING_PREVIEW_KIND}::text`.as("kind"),
            scopeType: query<string>`'project'::text`.as("scope_type"),
            scopeId: query<string>`${change.projectID}::text`.as("scope_id"),
            idempotencyKey: query<string>`${previewKey}::text`.as("idempotency_key"),
            activeKey: query<null>`NULL::text`.as("active_key"),
            state: query<string>`'pending'::text`.as("state"),
            payload: query<Record<string, unknown>>`jsonb_build_object(
              'projectId', ${change.projectID}::text,
              'revision', ${operation.commitSHA}::text,
              'runtimeAttemptId', NULL::text
            )`.as("payload"),
            result: query<null>`NULL::jsonb`.as("result"),
            error: query<null>`NULL::text`.as("error"),
            createdBy: query<null>`NULL::uuid`.as("created_by"),
            leaseOwner: query<null>`NULL::text`.as("lease_owner"),
            leaseExpiresAt: query<null>`NULL::timestamptz`.as("lease_expires_at"),
            createdAt: query<Date>`now()`.as("created_at"),
            updatedAt: query<Date>`now()`.as("updated_at"),
            completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
          })
          .from(operationTable)
          .where(confirmedMerge),
      )
      .onConflictDoNothing({ target: operationTable.idempotencyKey });
    const preview = alias(operationTable, "staging_preview");
    await tx
      .insert(operationTable)
      .select(
        tx
          .select({
            id: query<string>`${crypto.randomUUID()}::uuid`.as("id"),
            kind: query<string>`${DELIVERY_PROMOTION_KIND}::text`.as("kind"),
            scopeType: query<string>`'change'::text`.as("scope_type"),
            scopeId: query<string>`${change.id}::text`.as("scope_id"),
            idempotencyKey: query<string>`${`${DELIVERY_PROMOTION_KIND}:${change.id}:1`}::text`.as(
              "idempotency_key",
            ),
            activeKey: query<string>`${`${DELIVERY_PROMOTION_KIND}:${change.projectID}`}::text`.as(
              "active_key",
            ),
            state: query<string>`'pending'::text`.as("state"),
            payload: query<Record<string, unknown>>`jsonb_build_object(
              'changeId', ${change.id}::text,
              'projectId', ${change.projectID}::text,
              'commitSha', ${operation.commitSHA}::text,
              'previousRuntimeAttemptId', (${preview.payload}->>'runtimeAttemptId')::text,
              'replacementRuntimeAttemptId', NULL::text,
              'ordinal', 1,
              'supersedesId', NULL::text,
              'retryCommandId', NULL::text
            )`.as("payload"),
            result: query<null>`NULL::jsonb`.as("result"),
            error: query<null>`NULL::text`.as("error"),
            createdBy: query<string>`${change.userID}::uuid`.as("created_by"),
            leaseOwner: query<null>`NULL::text`.as("lease_owner"),
            leaseExpiresAt: query<null>`NULL::timestamptz`.as("lease_expires_at"),
            createdAt: query<Date>`now()`.as("created_at"),
            updatedAt: query<Date>`now()`.as("updated_at"),
            completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
          })
          .from(preview)
          .where(
            and(
              eq(preview.kind, DELIVERY_STAGING_PREVIEW_KIND),
              eq(preview.scopeType, "project"),
              eq(preview.scopeId, change.projectID),
              eq(preview.idempotencyKey, previewKey),
              exists(
                tx.select({ id: operationTable.id }).from(operationTable).where(confirmedMerge),
              ),
            ),
          ),
      )
      .onConflictDoNothing();
  };
  if (operation.state === "succeeded") {
    // Continue the confirmed outcome without repeating its external merge.
    // The same insert also closes an interrupted first-Delivery admission.
    await database.client.begin(ensurePromotion);
    return;
  }
  const outcomeUnknown = operation.state === "ambiguous" || operation.state === "executing";
  const pullRequest = await forge.getPullRequest(
    repository,
    change.defaultBranch,
    change.branchName,
  );
  const base = await forge.getDefaultBranch(repository);
  if (
    base.headSha !== operation.commitSHA &&
    (!pullRequest ||
      pullRequest.headSha !== operation.commitSHA ||
      base.headSha !== operation.baseSHA)
  ) {
    if (outcomeUnknown) {
      // A later default-branch commit cannot prove whether the earlier
      // merge happened. Keep the Project fenced rather than replaying it.
      await db
        .update(operationTable)
        .set({
          state: "ambiguous",
          error: "Default branch moved before the earlier merge outcome was confirmed",
          completedAt: null,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(operationTable.id, operation.id),
            eq(operationTable.kind, DELIVERY_MERGE_KIND),
            inArray(operationTable.state, ["executing", "ambiguous"]),
          ),
        );
      return;
    }
    await db
      .update(operationTable)
      .set({
        state: "failed",
        activeKey: null,
        error: "Delivery gate moved before merge",
        completedAt: query`now()`,
        updatedAt: query`now()`,
      })
      .where(
        and(
          eq(operationTable.id, operation.id),
          eq(operationTable.kind, DELIVERY_MERGE_KIND),
          notInArray(operationTable.state, ["succeeded", "failed"]),
        ),
      );
    await db
      .update(changeTable)
      .set({
        state: "active",
        failure: "Delivery basis changed before merge",
        version: query`${changeTable.version}+1`,
      })
      .where(and(eq(changeTable.id, change.id), eq(changeTable.state, "delivering")));
    return;
  }
  await db
    .update(operationTable)
    .set({ state: "executing", updatedAt: query`now()` })
    .where(
      and(
        eq(operationTable.id, operation.id),
        eq(operationTable.kind, DELIVERY_MERGE_KIND),
        inArray(operationTable.state, ["pending", "ambiguous"]),
      ),
    );
  try {
    const pullRequestNumber = operation.pullRequestNumber;
    const commitSHA = operation.commitSHA;
    const deliveryPolicyID = operation.deliveryPolicyID;
    const monitoringIncidentID = operation.monitoringIncidentID;
    async function performMerge() {
      return forge.mergeFastForward(
        repository,
        Number(pullRequestNumber),
        commitSHA,
        change.defaultBranch,
      );
    }
    async function delegatedMerge() {
      const coordination = database.coordination();
      try {
        return await coordination.begin(async (sql) => {
          // Revocation and this irreversible command serialize on the
          // same authority rows, without holding the application pool.
          await drizzleTransaction(sql)
            .select({ id: changeTable.id })
            .from(changeTable)
            .where(eq(changeTable.id, change.id))
            .for("update");
          if (deliveryPolicyID) await deliveryDelegationIn(sql, change.projectID, deliveryPolicyID);
          else if (monitoringIncidentID)
            await monitoringChangeAuthorityIn(database, sql, change.id, monitoringIncidentID);
          return performMerge();
        });
      } finally {
        await coordination.end();
      }
    }
    const merged =
      base.headSha === operation.commitSHA
        ? { headSha: base.headSha }
        : operation.monitoringIncidentID || operation.deliveryPolicyID
          ? await delegatedMerge()
          : await performMerge();
    await database.client.begin(async (transaction) => {
      const tx = drizzleTransaction(transaction);
      await tx
        .update(operationTable)
        .set({
          state: "succeeded",
          activeKey: null,
          result: { mergeSha: merged.headSha },
          completedAt: query`now()`,
          updatedAt: query`now()`,
          error: null,
        })
        .where(
          and(eq(operationTable.id, operation.id), eq(operationTable.kind, DELIVERY_MERGE_KIND)),
        );
      await ensurePromotion(transaction);
      await tx
        .update(changeTable)
        .set({
          state: "delivering",
          failure: null,
          version: query`${changeTable.version}+1`,
        })
        .where(eq(changeTable.id, change.id));
    });
  } catch (cause) {
    const message = failureMessage(cause, "Merge failed");
    if (
      cause instanceof CommandError &&
      (operation.monitoringIncidentID || operation.deliveryPolicyID) &&
      !outcomeUnknown
    ) {
      await db
        .update(operationTable)
        .set({
          state: "failed",
          activeKey: null,
          error: message,
          completedAt: query`now()`,
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(operationTable.id, operation.id),
            eq(operationTable.kind, DELIVERY_MERGE_KIND),
            eq(operationTable.state, "executing"),
          ),
        );
      await db
        .update(changeTable)
        .set({ state: "active", failure: message, version: query`${changeTable.version}+1` })
        .where(and(eq(changeTable.id, change.id), eq(changeTable.state, "delivering")));
      return;
    }
    await db
      .update(operationTable)
      .set({
        state: "ambiguous",
        error: message,
        completedAt: null,
        updatedAt: query`now()`,
      })
      .where(
        and(eq(operationTable.id, operation.id), eq(operationTable.kind, DELIVERY_MERGE_KIND)),
      );
  }
}
