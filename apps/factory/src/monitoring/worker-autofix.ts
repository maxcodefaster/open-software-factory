import { and, desc, eq, exists, inArray, notExists, notInArray, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  candidateReview,
  changeCommitOperation,
  change as changeTable,
  monitoringIncident,
  operation as operationTable,
  requirementApproval,
} from "#db/schema";
import { lockChangeWriterIn } from "../access/change-writer";
import type { createAgentController } from "../agent/api";
import type { createChangeController } from "../change/api";
import { CommandError } from "../command-error";
import type { createDeliveryController } from "../delivery/api";
import { monitoringAuthorityIn } from "./authority";
import {
  type Database,
  type Incident,
  markIncidentDelivered,
  settleIncidentFailure,
} from "./worker-state";

type AutofixDeps = {
  changes: Pick<ReturnType<typeof createChangeController>, "start">;
  agent: Pick<ReturnType<typeof createAgentController>, "admitStartIn">;
  delivery: Pick<ReturnType<typeof createDeliveryController>, "get" | "approve">;
};

export function createIncidentAutofix(database: Database, deps: AutofixDeps) {
  async function commission(incident: Incident) {
    if (!incident.ticketId || !incident.diagnosis) return;
    const authority = await database.client.begin((sql) =>
      monitoringAuthorityIn(database, sql, incident.id),
    );
    const [revision] = await database.db
      .select({ id: requirementApproval.requirementRevisionId })
      .from(requirementApproval)
      .where(
        and(
          eq(requirementApproval.ticketId, incident.ticketId),
          eq(requirementApproval.monitoringIncidentId, incident.id),
          eq(requirementApproval.monitoringPolicyId, authority.policyId),
        ),
      );
    if (!revision) throw new CommandError("conflict", "Autofix requirements are no longer current");
    const baseSha = incident.diagnosis.code[0]?.commitSha;
    if (!baseSha)
      throw new CommandError("conflict", "Autofix diagnosis has no exact application source");
    await deps.changes.start(incident.ticketId, authority.userId, {
      commandID: incident.id,
      revisionID: revision.id,
      expectedBaseSHA: baseSha,
      admitBuild: (sql, changeId) =>
        deps.agent.admitStartIn(sql, changeId, authority.userId, incident.id),
    });
  }

  async function blockIncompleteReview(incidentId: string, changeId: string, reviewId: string) {
    // Share admission's writer lock before rechecking the exact completed
    // review. A newer candidate or continuation keeps its own authority.
    await database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeId);
      if (!writer.available || writer.state === "human" || writer.state === "handoff") return;
      const db = drizzleTransaction(sql);
      const latestReview = alias(candidateReview, "latest_review");
      await db
        .update(monitoringIncident)
        .set({
          state: "blocked",
          reason:
            "Independent review is incomplete. The retained Change requires a human decision before retrying review or continuing Build.",
          ownerToken: null,
          ownerExpiresAt: null,
          settledAt: query<Date>`now()`,
        })
        .where(
          and(
            eq(monitoringIncident.id, incidentId),
            eq(monitoringIncident.state, "implementing"),
            exists(
              db
                .select({ id: candidateReview.id })
                .from(candidateReview)
                .innerJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
                .where(
                  and(
                    eq(candidateReview.id, reviewId),
                    eq(candidateReview.changeId, changeId),
                    eq(candidateReview.state, "incomplete"),
                    eq(agentTurn.state, "completed"),
                    eq(
                      candidateReview.turnId,
                      db
                        .select({ id: agentTurn.id })
                        .from(agentTurn)
                        .where(eq(agentTurn.changeId, candidateReview.changeId))
                        .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
                        .limit(1),
                    ),
                    eq(
                      candidateReview.id,
                      db
                        .select({ id: latestReview.id })
                        .from(latestReview)
                        .where(eq(latestReview.verificationId, candidateReview.verificationId))
                        .orderBy(desc(latestReview.ordinal))
                        .limit(1),
                    ),
                    eq(
                      candidateReview.commitSha,
                      db
                        .select({ commitSha: changeCommitOperation.commitSha })
                        .from(changeCommitOperation)
                        .where(
                          and(
                            eq(changeCommitOperation.changeId, candidateReview.changeId),
                            eq(changeCommitOperation.state, "succeeded"),
                          ),
                        )
                        .orderBy(desc(changeCommitOperation.sequence))
                        .limit(1),
                    ),
                    notExists(
                      db
                        .select({ id: agentTurn.id })
                        .from(agentTurn)
                        .where(
                          and(
                            eq(agentTurn.changeId, candidateReview.changeId),
                            inArray(agentTurn.state, [
                              "pending",
                              "dispatching",
                              "running",
                              "uncertain",
                            ]),
                          ),
                        ),
                    ),
                    notExists(
                      db
                        .select({ id: changeCommitOperation.id })
                        .from(changeCommitOperation)
                        .where(
                          and(
                            eq(changeCommitOperation.changeId, candidateReview.changeId),
                            notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                          ),
                        ),
                    ),
                    notExists(
                      db
                        .select({ id: operationTable.id })
                        .from(operationTable)
                        .where(
                          and(
                            eq(operationTable.kind, "delivery.merge"),
                            eq(operationTable.scopeType, "change"),
                            eq(
                              operationTable.scopeId,
                              query<string>`${candidateReview.changeId}::text`,
                            ),
                            query`${operationTable.result}->>'mergeSha' IS NOT NULL`,
                          ),
                        ),
                    ),
                  ),
                ),
            ),
          ),
        );
    });
  }

  return async function advanceImplementation(incident: Incident) {
    if (!incident.ticketId) return;
    const [change] = await database.db
      .select({
        id: changeTable.id,
        state: changeTable.state,
        humanWork: exists(
          database.db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, changeTable.id),
                eq(query<string>`${agentTurn.input}->>'kind'`, "change-prompt"),
              ),
            ),
        ),
      })
      .from(changeTable)
      .where(eq(changeTable.ticketId, incident.ticketId));
    if (!change) {
      await commission(incident);
      return;
    }
    const delivery = await deps.delivery.get(change.id);
    if (change.state === "delivered") {
      await markIncidentDelivered(database, incident.id);
      return;
    }
    // An accepted merge is irreversible. Revocation does not abandon its
    // recorded promotion/cleanup or pretend that the default branch did not move.
    if (delivery?.["mergedCommitSha"]) return;
    if (delivery?.["mergeState"] === "failed") {
      await settleIncidentFailure(
        database,
        incident.id,
        "Automatic merge was not confirmed. The retained Change requires a human decision.",
      );
      return;
    }
    try {
      await database.client.begin((sql) => monitoringAuthorityIn(database, sql, incident.id));
    } catch (cause) {
      if (!(cause instanceof CommandError)) throw cause;
      await settleIncidentFailure(database, incident.id, cause.message);
      // Native execution observes the revoked turn authority and stops its
      // exact owner. A stale worker must not stop a newer human's Change turn.
      return;
    }
    if (change.humanWork || ["failed", "cancelled", "cancelling"].includes(change.state)) {
      await settleIncidentFailure(
        database,
        incident.id,
        change.humanWork
          ? "A human took over this Change. Automatic Delivery is disabled."
          : "Autofix stopped. The retained Ticket and source require a human decision.",
      );
      return;
    }
    if (change.state === "branch-pending" || change.state === "starting") return;
    const reviewId = delivery?.["reviewId"];
    if (
      typeof reviewId === "string" &&
      delivery?.["reviewState"] === "incomplete" &&
      delivery["reviewCurrent"] === true
    ) {
      await blockIncompleteReview(incident.id, change.id, reviewId);
      return;
    }
    if (
      delivery?.["verificationState"] === "succeeded" &&
      delivery["reviewState"] === "passed" &&
      !delivery["approvedAt"] &&
      !Number(delivery["openReviewThreads"])
    ) {
      const authority = await database.client.begin((sql) =>
        monitoringAuthorityIn(database, sql, incident.id),
      );
      await deps.delivery.approve(change.id, authority.userId, incident.id);
    }
  };
}
