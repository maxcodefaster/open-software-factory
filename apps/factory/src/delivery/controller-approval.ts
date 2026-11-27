import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  auditEvent,
  candidateReview,
  changeAgentSession,
  changeCommitOperation,
  change as changeTable,
  changeWriter,
  deliveryApproval,
  operation as operationTable,
  reviewFeedback,
  ticket,
} from "#db/schema";
import { forgeRepositoryFromURL } from "#forge/repository";
import { createAccessController } from "../access/api";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { monitoringCandidate } from "../monitoring/api";
import { monitoringChangeAuthorityIn } from "../monitoring/authority";
import { readDeliveryChange } from "./controller-projection";
import type {
  Database,
  DeliveryCoordination,
  DeliveryIntegration,
  DrizzleDB,
  ForgeClient,
} from "./controller-types";
import { deliveryDelegationIn } from "./coordination";

export async function approveDelivery(
  deps: {
    database: Database;
    db: DrizzleDB;
    forge: ForgeClient;
    coordination: DeliveryCoordination;
    integration: DeliveryIntegration | undefined;
    reconcile: (changeID: string) => Promise<void>;
  },
  changeID: string,
  userID: string,
  monitoringIncidentID?: string,
  deliveryPolicyID?: string,
) {
  const { database, db, forge, coordination, integration, reconcile } = deps;
  const change = await readDeliveryChange(db, changeID);
  if (change) await createAccessController(database).requireDevelopment(userID, change.projectID);
  if (!change?.commitSHA)
    throw new CommandError("conflict", "Change has no delivered commit candidate");
  if (integration)
    await db
      .update(changeTable)
      .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
      .where(
        and(
          eq(changeTable.id, changeID),
          eq(changeTable.state, "active"),
          eq(changeTable.deliveryWaitingSha, change.commitSHA),
        ),
      );
  if (integration && !(await coordination.claim(change.projectID, changeID)))
    throw new CommandError(
      "conflict",
      "Another Change or its Staging recovery owns Delivery. This candidate stays queued.",
    );
  if (deliveryPolicyID) {
    const delegator = await database.client.begin((sql) =>
      deliveryDelegationIn(sql, change.projectID, deliveryPolicyID),
    );
    if (delegator !== userID)
      throw new CommandError("forbidden", "Use the recorded Delivery delegator.");
  }
  if (monitoringIncidentID) {
    const delegated = await database.client.begin((sql) =>
      monitoringChangeAuthorityIn(database, sql, changeID, monitoringIncidentID),
    );
    if (delegated.userId !== userID)
      throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
  }
  const repository = forgeRepositoryFromURL(change.repositoryURL);
  const pullRequest = await forge.getPullRequest(
    repository,
    change.defaultBranch,
    change.branchName,
  );
  const base = await forge.getDefaultBranch(repository);
  const verifications = await database.client<
    Array<{ id: string; actionRunID: string; commitSHA: string; reviewID: string }>
  >`
    SELECT verification.id,verification.action_run_id AS "actionRunID",verification.commit_sha AS "commitSHA",
      review.id AS "reviewID"
    FROM factory.verification verification
    JOIN factory.candidate_review review ON review.verification_id=verification.id
    JOIN factory.agent_turn turn ON turn.id=review.turn_id
    WHERE verification.change_id = ${changeID} AND verification.commit_sha = ${change.commitSHA}
      AND verification.state = 'succeeded' AND review.state='passed' AND turn.state='completed'
      AND review.change_id=verification.change_id AND review.commit_sha=verification.commit_sha
      AND review.base_sha=${change.baseSHA}
      AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
  `;
  const verification = verifications[0];
  if (deliveryPolicyID && verification) {
    const [eligible] = await db
      .select({ id: candidateReview.id })
      .from(candidateReview)
      .where(
        and(
          eq(candidateReview.id, verification.reviewID),
          query`${candidateReview.result}->>'delivery'='ordinary'`,
        ),
      );
    if (!eligible)
      throw new CommandError("conflict", "This review requires a human Delivery decision.");
  }
  if (
    !verification ||
    !pullRequest ||
    pullRequest.headSha !== verification.commitSHA ||
    base.headSha !== change.baseSHA
  ) {
    if (integration) {
      await db
        .update(changeTable)
        .set({ deliveryWaitingSha: null, deliveryWaitingPolicyId: null })
        .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "active")));
      void reconcile(changeID);
    }
    throw new CommandError("conflict", "Current commit is not eligible for delivery");
  }
  const approvalID = crypto.randomUUID();
  const mergeID = crypto.randomUUID();
  const candidateDigest =
    monitoringIncidentID || deliveryPolicyID
      ? await monitoringCandidate(forge, repository, change.baseSHA, verification.commitSHA)
      : null;
  await database.client.begin(async (transaction) => {
    const tx = drizzleTransaction(transaction);
    await projectDevelopmentAuthorityIn(transaction, userID, change.projectID);
    if (integration) {
      // A waiting reconciler may release our first claim during Forge reads.
      // Reclaim only a vacant slot, then keep it locked through admission.
      // Queue-before-Change matches claim's foreign-key lock order.
      const queueKey = `project.delivery_queue:${change.projectID}`;
      const changeKey = `project.delivery_queue.change:${changeID}`;
      await tx
        .update(operationTable)
        .set({
          activeKey: changeKey,
          state: "active",
          payload: { projectId: change.projectID, changeId: changeID },
          updatedAt: query`now()`,
        })
        .where(
          and(
            eq(operationTable.kind, "project.delivery_queue"),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, change.projectID),
            eq(operationTable.idempotencyKey, queueKey),
            isNull(operationTable.activeKey),
            eq(operationTable.state, "idle"),
          ),
        );
      const [slot] = await tx
        .select({ projectId: operationTable.scopeId })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, "project.delivery_queue"),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, change.projectID),
            eq(operationTable.idempotencyKey, queueKey),
            eq(operationTable.activeKey, changeKey),
          ),
        )
        .for("share");
      if (!slot)
        throw new CommandError(
          "conflict",
          "This candidate no longer owns the Project Delivery slot.",
        );
    }
    // Read scope only after the lock wait. A joined statement's earlier
    // snapshot cannot authorize Requirements committed while it waited.
    const lockedChange = alias(changeTable, "change");
    const lockedTicket = alias(ticket, "ticket");
    await tx
      .select({ id: lockedChange.id })
      .from(lockedChange)
      .innerJoin(lockedTicket, eq(lockedTicket.id, lockedChange.ticketId))
      .where(eq(lockedChange.id, changeID))
      .for("update", { of: [lockedChange, lockedTicket] });
    const delegated = monitoringIncidentID
      ? await monitoringChangeAuthorityIn(database, transaction, changeID, monitoringIncidentID)
      : null;
    if (deliveryPolicyID)
      await deliveryDelegationIn(transaction, change.projectID, deliveryPolicyID);
    if (delegated && delegated.userId !== userID)
      throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
    if (delegated) {
      const [human] = await tx
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(
          and(eq(agentTurn.changeId, changeID), query`${agentTurn.input}->>'kind'='change-prompt'`),
        )
        .limit(1);
      const [writer] = await tx
        .select({ changeId: changeWriter.changeId })
        .from(changeWriter)
        .where(
          and(
            eq(changeWriter.changeId, changeID),
            or(inArray(changeWriter.state, ["human", "handoff"]), isNotNull(changeWriter.userId)),
          ),
        );
      if (human || writer)
        throw new CommandError(
          "conflict",
          "A human took over this Change. Automatic Delivery is disabled.",
        );
    }
    if (deliveryPolicyID) {
      const [human] =
        await transaction`SELECT change_id FROM factory.change_writer WHERE change_id=${changeID}
        AND state IN ('human','handoff')
        UNION ALL SELECT scope_id::uuid FROM factory.audit_event WHERE kind='access.change_editing_decision'
          AND scope_type='change' AND scope_id=${changeID}
          AND payload->>'kind' IN ('takeover','idle-takeover','approve') LIMIT 1`;
      if (human)
        throw new CommandError(
          "conflict",
          "Human editing requires human Delivery approval for this Change.",
        );
    }
    const [current] = await transaction<
      Array<{ state: string; requirementsCurrent: boolean }>
    >`SELECT change.state,approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision
        WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1) AS "requirementsCurrent"
      FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
      WHERE change.id = ${changeID} AND ticket.trashed_at IS NULL`;
    if (current && !current.requirementsCurrent)
      throw new CommandError(
        "conflict",
        "Requirements changed. Verify and review the current approved scope before Delivery.",
      );
    const [thread] = await tx
      .select({ id: reviewFeedback.id })
      .from(reviewFeedback)
      .where(
        and(
          eq(reviewFeedback.changeId, changeID),
          eq(reviewFeedback.kind, "thread"),
          query`${reviewFeedback.state}<>'resolved'`,
        ),
      )
      .limit(1);
    if (thread)
      throw new CommandError("conflict", "Resolve the open review Threads before Delivery.");
    const [work] = await tx
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.changeId, changeID),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
        ),
      );
    const [session] = await tx
      .select({ state: changeAgentSession.state })
      .from(changeAgentSession)
      .where(eq(changeAgentSession.changeId, changeID));
    const [commit] = await tx
      .select({ sha: changeCommitOperation.commitSha })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeID),
          eq(changeCommitOperation.state, "succeeded"),
        ),
      )
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1);
    const [review] = await transaction`
      SELECT review.id FROM factory.candidate_review review
      JOIN factory.verification verification ON verification.id=review.verification_id
      JOIN factory.agent_turn turn ON turn.id=review.turn_id
      WHERE review.id=${verification.reviewID} AND review.change_id=${changeID}
        AND review.commit_sha=${verification.commitSHA} AND review.base_sha=${change.baseSHA}
        AND review.state='passed' AND turn.state='completed' AND verification.state='succeeded'
        AND review.ordinal=(SELECT MAX(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
      FOR SHARE OF review,verification,turn`;
    if (
      current?.state !== "active" ||
      work ||
      (session && session.state !== "committed") ||
      commit?.sha !== verification.commitSHA ||
      !review
    )
      throw new Error("Wait for the current implementation to finish before delivery.");
    await tx
      .insert(deliveryApproval)
      .values({
        id: approvalID,
        changeId: changeID,
        verificationId: verification.id,
        commitSha: verification.commitSHA,
        approvedBy: userID,
        candidateReviewId: verification.reviewID,
        monitoringIncidentId: monitoringIncidentID ?? null,
        monitoringPolicyId: delegated?.policyId ?? null,
        deliveryPolicyId: deliveryPolicyID ?? null,
      })
      .onConflictDoNothing();
    if (delegated && candidateDigest)
      await tx.insert(auditEvent).values({
        id: crypto.randomUUID(),
        kind: "monitoring.evidence",
        scopeType: "incident",
        scopeId: delegated.id,
        actorId: delegated.userId,
        payload: {
          kind: "delivery-candidate",
          digest: candidateDigest,
          path: null,
          commitSha: verification.commitSHA,
        },
      });
    await tx
      .insert(operationTable)
      .select(
        tx
          .select({
            id: query<string>`${mergeID}::uuid`.as("id"),
            kind: query<string>`'delivery.merge'::text`.as("kind"),
            scopeType: query<string>`'change'::text`.as("scope_type"),
            scopeId: query<string>`${changeID}::text`.as("scope_id"),
            idempotencyKey:
              query<string>`${`delivery.merge:change:${changeID}:merge:`} || ${deliveryApproval.id}::text`.as(
                "idempotency_key",
              ),
            activeKey: query<string>`${`delivery.merge:${changeID}`}::text`.as("active_key"),
            state: query<string>`'pending'::text`.as("state"),
            payload: query<Record<string, unknown>>`jsonb_build_object(
              'changeId', ${changeID}::text,
              'commitSha', ${verification.commitSHA}::text,
              'baseSha', ${change.baseSHA}::text,
              'pullRequestNumber', ${pullRequest.number}::bigint,
              'approvalId', ${deliveryApproval.id}::text,
              'deliveryPolicyId', ${deliveryPolicyID ?? null}::text
            )`.as("payload"),
            result: query<null>`NULL::jsonb`.as("result"),
            error: query<null>`NULL::text`.as("error"),
            createdBy: query<string>`${userID}::uuid`.as("created_by"),
            leaseOwner: query<null>`NULL::text`.as("lease_owner"),
            leaseExpiresAt: query<null>`NULL::timestamptz`.as("lease_expires_at"),
            createdAt: query<Date>`now()`.as("created_at"),
            updatedAt: query<Date>`now()`.as("updated_at"),
            completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
          })
          .from(deliveryApproval)
          .where(
            and(
              eq(deliveryApproval.verificationId, verification.id),
              eq(deliveryApproval.candidateReviewId, verification.reviewID),
              eq(deliveryApproval.approvedBy, userID),
              query`${deliveryApproval.monitoringPolicyId} IS NOT DISTINCT FROM ${delegated?.policyId ?? null}::uuid`,
              query`${deliveryApproval.deliveryPolicyId} IS NOT DISTINCT FROM ${deliveryPolicyID ?? null}::uuid`,
              notExists(
                tx
                  .select({ id: operationTable.id })
                  .from(operationTable)
                  .where(
                    and(
                      eq(operationTable.kind, "delivery.merge"),
                      eq(operationTable.scopeType, "change"),
                      eq(operationTable.scopeId, changeID),
                      eq(operationTable.state, "succeeded"),
                    ),
                  ),
              ),
            ),
          ),
      )
      .onConflictDoNothing();
    await tx
      .update(changeTable)
      .set({
        state: "delivering",
        failure: null,
        version: query`${changeTable.version}+1`,
      })
      .where(and(eq(changeTable.id, changeID), eq(changeTable.state, "active")));
  });
  void reconcile(changeID);
}
