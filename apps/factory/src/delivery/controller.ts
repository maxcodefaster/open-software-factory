import { and, desc, eq, exists, ne, notInArray, sql as query } from "drizzle-orm";
import type { z } from "zod";
import type { deliveryDelegationInput } from "#change-domain/delivery";
import { drizzleTransaction } from "#db/client";
import {
  candidateReview,
  change as changeTable,
  operation as operationTable,
  verification as verificationTable,
} from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { forgeRepositoryFromURL } from "#forge/repository";
import { publishWorkspaceCandidate } from "../agent/candidate-api";
import { CommandError } from "../command-error";
import { approveDelivery } from "./controller-approval";
import { ensurePullRequest, reconcileMerge, recoverDeliveryOperations } from "./controller-pr";
import {
  countFailedCorrections,
  getDeliveryView,
  hasOpenReviewThread,
  isChangeBlockedForDelivery,
  listReconcilableChanges,
  readDeliveryChange,
} from "./controller-projection";
import {
  ensureCandidateReview,
  resumeDeliveryChecks,
  retryCandidateReview,
} from "./controller-review";
import {
  type AgentController,
  type Database,
  type DeliveryIntegration,
  failureMessage,
  type RuntimeController,
} from "./controller-types";
import { createDeliveryCoordination } from "./coordination";
import { createDeliveryPromotion } from "./promotion";
import { retryPromotion } from "./promotion-retry";
import { createDeliveryVerification } from "./verification";
import { retryVerificationBootstrap } from "./verification-retry";

export function createDeliveryController(
  database: Database,
  runtime: RuntimeController,
  agent: AgentController,
  retireBranch: (changeID: string) => Promise<void>,
  forgeOverride?: { client: ReturnType<typeof createForgejoClient>; owner: string },
  integration?: DeliveryIntegration,
) {
  const db = drizzleTransaction(database.client);
  const { FACTORY_FORGEJO_API_URL, FACTORY_FORGEJO_TOKEN, FACTORY_FORGEJO_OWNER } = process.env;
  function configuredForge() {
    if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER)
      throw new Error("Forgejo configuration is required");
    return {
      client: createForgejoClient({
        apiURL: FACTORY_FORGEJO_API_URL,
        token: FACTORY_FORGEJO_TOKEN,
      }),
      owner: FACTORY_FORGEJO_OWNER,
    };
  }
  const { client: forge, owner: allowedOwner } = forgeOverride ?? configuredForge();
  const reconcilePromotion = createDeliveryPromotion(database, runtime, forge, retireBranch);
  const running = new Set<string>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let reconcilingAll = false;
  const coordination = createDeliveryCoordination(database);
  const failedCorrections = (changeID: string) => countFailedCorrections(db, changeID);
  const verificationChecks = createDeliveryVerification(
    database,
    runtime,
    forge,
    agent,
    failedCorrections,
  );
  const changeRow = (changeID: string) => readDeliveryChange(db, changeID);
  const ensureReview = (change: NonNullable<Awaited<ReturnType<typeof changeRow>>>) =>
    ensureCandidateReview(db, agent, verificationChecks, failedCorrections, change);

  function reconcile(changeID: string): Promise<void> {
    if (closed) return Promise.resolve();
    const task = reconcileChange(changeID);
    pending.add(task);
    const settled = () => {
      pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  async function reconcileChange(changeID: string) {
    if (running.has(changeID)) return;
    running.add(changeID);
    let projectLock: ReturnType<Database["coordination"]> | undefined;
    let projectLockID: string | undefined;
    try {
      let change = await changeRow(changeID);
      if (!change) return;
      if (integration) {
        projectLock = database.coordination();
        const key = `delivery-project:${change.projectID}`;
        const [claim] = await projectLock<{ held: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS held`;
        if (!claim?.held) return;
        projectLockID = key;
        // The snapshot used to find the immutable Project is not authority for
        // source or merge work after another process finished reconciliation.
        change = await changeRow(changeID);
        if (!change) return;
      }
      if (change.trashed || ["cancelling", "cancelled"].includes(change.state)) {
        if (integration) await coordination.release(change.id);
        await verificationChecks.cancel(change.id, forgeRepositoryFromURL(change.repositoryURL));
        return;
      }
      if (!change.commitSHA || change.state === "failed") {
        if (integration) await coordination.release(change.id);
        return;
      }
      await publishWorkspaceCandidate(database, change.id);
      await verificationChecks.cancel(
        change.id,
        forgeRepositoryFromURL(change.repositoryURL),
        change.commitSHA,
      );
      if (change.state === "delivered") {
        await reconcilePromotion(change, forgeRepositoryFromURL(change.repositoryURL));
        if (integration) await coordination.release(change.id);
        return;
      }
      if (integration) {
        if (change.state === "active" && change.deliveryWaitingSHA === change.commitSHA) {
          const policy = await coordination.activePolicy(change.projectID);
          if ((policy?.id ?? null) === change.deliveryWaitingPolicyID) {
            await coordination.release(changeID);
            return;
          }
          await db
            .update(changeTable)
            .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
            .where(
              and(
                eq(changeTable.id, changeID),
                eq(changeTable.deliveryWaitingSha, change.commitSHA),
              ),
            );
        }
        const blocked = await isChangeBlockedForDelivery(database, changeID, change.commitSHA);
        if (blocked && change.state !== "delivering") {
          await coordination.release(changeID);
          return;
        }
        if ((await hasOpenReviewThread(db, changeID)) && change.state !== "delivering") {
          // A human needs exact-candidate checks and QA to recheck a correction.
          // Do not integrate or hold the Project Delivery slot while they decide.
          await coordination.release(changeID);
          const pull = await ensurePullRequest(db, forge, allowedOwner, change);
          if (pull) {
            await verificationChecks.ensure(change, pull.repository, pull.pullRequest);
            if (pull.pullRequest.headSha === change.commitSHA && !pull.pullRequest.merged)
              await ensureReview(change);
          }
          return;
        }
        if (!(await coordination.claim(change.projectID, change.id))) return;
        if (change.state === "active") {
          const currentBase = await forge.getDefaultBranch(
            forgeRepositoryFromURL(change.repositoryURL),
          );
          if (currentBase.headSha !== change.baseSHA) {
            if (!(await integration.reconcile(changeID, currentBase.headSha))) {
              await coordination.release(changeID);
              return;
            }
            change = await changeRow(changeID);
            if (!change) return;
            if (change.baseSHA !== currentBase.headSha) return;
          }
        }
      }
      const pull = await ensurePullRequest(db, forge, allowedOwner, change);
      if (!pull) return;
      const merge = await db
        .select({
          exists: exists(
            db
              .select({ id: operationTable.id })
              .from(operationTable)
              .where(
                and(
                  eq(operationTable.kind, "delivery.merge"),
                  eq(operationTable.scopeType, "change"),
                  eq(operationTable.scopeId, change.id),
                  ne(operationTable.state, "failed"),
                ),
              ),
          ),
        })
        .from(changeTable)
        .where(eq(changeTable.id, change.id));
      if (merge[0]?.exists) {
        await reconcileMerge(database, db, forge, change, pull.repository);
        await reconcilePromotion(change, pull.repository);
        if (integration) {
          const [terminal] = await db
            .select({ id: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "delivery.merge"),
                eq(operationTable.scopeType, "change"),
                eq(operationTable.scopeId, changeID),
                eq(operationTable.state, "failed"),
              ),
            );
          if (terminal) await coordination.release(changeID);
        }
        return;
      }
      await verificationChecks.ensure(change, pull.repository, pull.pullRequest);
      if (pull.pullRequest.headSha === change.commitSHA && !pull.pullRequest.merged)
        await ensureReview(change);
      if (integration) {
        const [review] = await db
          .select({ state: candidateReview.state })
          .from(candidateReview)
          .innerJoin(verificationTable, eq(verificationTable.id, candidateReview.verificationId))
          .where(
            and(
              eq(candidateReview.changeId, changeID),
              eq(candidateReview.commitSha, query`${change.commitSHA}`),
              eq(candidateReview.baseSha, change.baseSHA),
              eq(verificationTable.state, "succeeded"),
            ),
          )
          .orderBy(desc(candidateReview.createdAt), desc(candidateReview.ordinal))
          .limit(1);
        if (review?.state === "passed") {
          const policy = await coordination.activePolicy(change.projectID);
          if (policy) {
            try {
              await api.approve(changeID, policy.userID, undefined, policy.id);
              return;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              await db
                .update(changeTable)
                .set({ failure: cause.message.slice(0, 2000) })
                .where(
                  and(
                    eq(changeTable.id, changeID),
                    eq(changeTable.state, "active"),
                    query`${changeTable.failure} IS DISTINCT FROM ${cause.message.slice(0, 2000)}`,
                  ),
                );
            }
          }
          await db
            .update(changeTable)
            .set({
              deliveryWaitingSha: change.commitSHA,
              deliveryWaitingPolicyId: policy?.id ?? null,
            })
            .where(
              and(
                eq(changeTable.id, changeID),
                eq(changeTable.state, "active"),
                query`ROW(${changeTable.deliveryWaitingSha},${changeTable.deliveryWaitingPolicyId}) IS DISTINCT FROM ROW(${change.commitSHA}::text,${policy?.id ?? null}::uuid)`,
              ),
            );
          await coordination.release(changeID);
        } else if (review && !["pending", "running"].includes(review.state)) {
          await coordination.release(changeID);
        }
      }
    } catch (cause) {
      if (integration) await coordination.release(changeID);
      const message = failureMessage(cause, "Delivery failed");
      await db
        .update(changeTable)
        .set({ failure: message, version: query`${changeTable.version}+1` })
        .where(
          and(
            eq(changeTable.id, changeID),
            notInArray(changeTable.state, ["cancelled", "delivered"]),
            query`${changeTable.failure} IS DISTINCT FROM ${message}`,
          ),
        );
    } finally {
      running.delete(changeID);
      if (projectLock) {
        try {
          if (projectLockID)
            await projectLock`SELECT pg_advisory_unlock(hashtextextended(${projectLockID},0))`;
        } finally {
          await projectLock.end();
        }
      }
    }
  }

  async function reconcileAll() {
    if (closed || reconcilingAll) return;
    reconcilingAll = true;
    try {
      const changes = await listReconcilableChanges(db);
      // Let blocked work release its slot before the next independent candidate
      // competes for it. Overlapping sweeps cannot repeatedly starve that candidate.
      const projects = new Map<string, string[]>();
      for (const change of changes)
        projects.set(change.projectID, [...(projects.get(change.projectID) ?? []), change.id]);
      await Promise.all(
        [...projects.values()].map(async (ids) => {
          for (const id of ids) await reconcile(id);
        }),
      );
    } finally {
      reconcilingAll = false;
    }
  }

  const api = {
    settings: coordination.settings.bind(coordination),
    configure: (
      projectID: string,
      userID: string,
      input: z.input<typeof deliveryDelegationInput>,
    ) => coordination.configure(projectID, userID, input),
    async recover() {
      await recoverDeliveryOperations(db);
    },
    sweep: reconcileAll,
    close() {
      closed = true;
      closing ??= Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
    async approve(
      changeID: string,
      userID: string,
      monitoringIncidentID?: string,
      deliveryPolicyID?: string,
    ) {
      await approveDelivery(
        { database, db, forge, coordination, integration, reconcile },
        changeID,
        userID,
        monitoringIncidentID,
        deliveryPolicyID,
      );
      return this.get(changeID);
    },
    async cancel(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = forgeRepositoryFromURL(change.repositoryURL);
      await verificationChecks.cancel(changeID, repository);
    },
    async retryPromotion(changeID: string, userID: string, commandID: string, promotionID: string) {
      const admitted = await retryPromotion(
        database,
        changeID,
        userID,
        commandID,
        promotionID,
        async (url) => (await forge.getDefaultBranch(forgeRepositoryFromURL(url))).headSha,
      );
      if (admitted) await reconcile(changeID);
      return this.get(changeID);
    },
    async retryBootstrap(
      changeID: string,
      userID: string,
      commandID: string,
      verificationID: string,
      runtimeAttemptID: string,
    ) {
      const admitted = await retryVerificationBootstrap(
        database,
        changeID,
        userID,
        commandID,
        verificationID,
        runtimeAttemptID,
      );
      if (admitted) await reconcile(changeID);
      return this.get(changeID);
    },
    async resumeChecks(
      changeID: string,
      userID: string,
      commandID: string,
      verificationID: string,
      stopID: string,
    ) {
      await resumeDeliveryChecks(database, changeID, userID, commandID, verificationID, stopID);
      await reconcile(changeID);
      return this.get(changeID);
    },
    async retryReview(
      changeID: string,
      userID: string,
      commandID: string,
      previousReviewID: string,
    ) {
      await retryCandidateReview(database, agent, changeID, userID, commandID, previousReviewID);
      return this.get(changeID);
    },
    async stopForTrash(changeID: string) {
      const change = await changeRow(changeID);
      if (!change) return;
      const repository = forgeRepositoryFromURL(change.repositoryURL);
      await verificationChecks.cancel(changeID, repository);
      const deadline = Date.now() + 60_000;
      while (running.has(changeID) && Date.now() < deadline) await Bun.sleep(50);
      if (running.has(changeID)) throw new Error("Verification stop is not confirmed");
      // Observe late runner registration before allowing Restore, then revoke it.
      await verificationChecks.cancel(changeID, repository);
      await verificationChecks.revokeRetainedRunners(changeID, repository);
    },
    get(changeID: string) {
      return getDeliveryView(database, changeID);
    },
    reconcile,
  };
  return api;
}
