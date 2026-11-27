import { and, eq, sql as typedSQL } from "drizzle-orm";
import type { LearningResult } from "#conversation-domain/learning";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, learningProposal as proposalTable } from "#db/schema";
import type { AdmittedTrial, LearningTargets } from "./automation-types";
import { learningEditDigest } from "./targets";

export async function settleTrialOutcome(
  sql: DatabaseTransaction,
  targets: LearningTargets,
  admitted: AdmittedTrial,
  passed: boolean,
  grade: LearningResult,
  authorizeIn: (sql: DatabaseTransaction) => Promise<void>,
) {
  const db = drizzleTransaction(sql);
  const [locked] = await db
    .select({ id: proposalTable.id, application: proposalTable.application })
    .from(proposalTable)
    .where(eq(proposalTable.id, admitted.proposalId))
    .for("update");
  await authorizeIn(sql);
  let decision: "applied" | "reverted" | "kept" = "kept";
  if (passed) {
    if (admitted.phase === "adopt") {
      const saved = await targets.apply(sql, {
        edit: admitted.plan.edit,
        userId: admitted.actorId,
        projectId: admitted.projectId,
        revisionId: crypto.randomUUID(),
      });
      await db
        .update(proposalTable)
        .set({
          state: "applied",
          decisionId: admitted.id,
          decidedBy: admitted.actorId,
          decidedAt: typedSQL`now()`,
          application: {
            id: crypto.randomUUID(),
            proposalId: admitted.proposalId,
            target: admitted.plan.edit.target,
            editDigest: learningEditDigest(admitted.plan.edit),
            activation: saved.activation,
            appliedRevisionId: saved.revisionId,
            appliedVersion: saved.version,
            appliedBy: admitted.actorId,
            comparisonId: admitted.id,
            createdAt: new Date().toISOString(),
            state: "applied",
            revertedRevisionId: null,
            revertedVersion: null,
            revertedBy: null,
            revertedComparisonId: null,
            revertedAt: null,
          },
        })
        .where(and(eq(proposalTable.id, admitted.proposalId), eq(proposalTable.state, "proposed")));
      decision = "applied";
    } else {
      const saved = await targets.revert(sql, {
        target: admitted.plan.edit.target,
        appliedRevisionId: admitted.appliedRevisionId,
        appliedVersion: admitted.appliedVersion,
        activation: admitted.activation,
        userId: admitted.actorId,
        projectId: admitted.projectId,
        revisionId: crypto.randomUUID(),
      });
      const currentApplication = locked?.application;
      if (
        currentApplication &&
        currentApplication.id === admitted.applicationId &&
        currentApplication.state === "applied"
      ) {
        await db
          .update(proposalTable)
          .set({
            application: {
              ...currentApplication,
              state: "reverted",
              revertedRevisionId: saved.revisionId,
              revertedVersion: saved.version,
              revertedBy: admitted.actorId,
              revertedAt: new Date().toISOString(),
              revertedComparisonId: admitted.id,
            },
          })
          .where(
            and(
              eq(proposalTable.id, admitted.proposalId),
              eq(
                typedSQL<string>`${proposalTable.application}->>'id'`,
                typedSQL`${admitted.applicationId}::text`,
              ),
              eq(typedSQL<string>`${proposalTable.application}->>'state'`, "applied"),
            ),
          );
      }
      decision = "reverted";
    }
  }
  const trialResult = { passed, decision, cases: grade.cases };
  await db
    .update(operation)
    .set({
      state: "completed",
      result: trialResult,
      payload: typedSQL`jsonb_set(${operation.payload}, '{result}', ${JSON.stringify(trialResult)}::jsonb, true)`,
      completedAt: typedSQL`now()`,
      updatedAt: typedSQL`now()`,
    })
    .where(
      and(
        eq(operation.id, admitted.id),
        eq(operation.kind, "learning.trial"),
        eq(operation.leaseOwner, admitted.token),
        eq(operation.state, "running"),
      ),
    );
}
