import { eq, sql as query } from "drizzle-orm";
import { verificationDiagnosisInput } from "#conversation-domain/verification";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { auditEvent, verification } from "#db/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { submittedCandidate } from "../agent/candidate-api";
import { CommandError } from "../command-error";

// Retry only a queued workflow whose environment failed before accepting work.
// Forgejo still owns the original run; this does not retry executed checks.
export async function retryVerificationBootstrap(
  database: ReturnType<typeof createDatabase>,
  changeID: string,
  userID: string,
  commandID: string,
  verificationID: string,
  runtimeAttemptID: string,
) {
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const scope = `checks-bootstrap-retry:${changeID}`;
    const dedupeKey = `usage.policy_command:${commandID}`;
    const input = { changeID, verificationID, runtimeAttemptID };
    const [replay] = await db
      .select({
        scope: auditEvent.scopeId,
        actor: auditEvent.actorId,
        input: query<typeof input>`${auditEvent.payload}->'input'`,
      })
      .from(auditEvent)
      .where(eq(auditEvent.dedupeKey, dedupeKey));
    if (replay) {
      if (
        replay.scope !== scope ||
        replay.actor !== userID ||
        replay.input.changeID !== changeID ||
        replay.input.verificationID !== verificationID ||
        replay.input.runtimeAttemptID !== runtimeAttemptID
      )
        throw new CommandError("conflict", "Checks retry changed target");
      return false;
    }
    const [candidate] = await sql<
      {
        diagnosis: unknown;
        summary: string | null;
        actionRunID: string;
        completedAt: Date;
      }[]
    >`SELECT verification.diagnosis,verification.summary,
        verification.action_run_id AS "actionRunID",verification.completed_at AS "completedAt"
      FROM factory.verification verification
      JOIN factory.change change ON change.id=verification.change_id
      LEFT JOIN factory.change_agent_session session ON session.change_id=change.id
      JOIN factory.change_writer writer ON writer.change_id=change.id
      JOIN LATERAL (
        SELECT id,commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1
      ) commit ON commit.commit_sha=verification.commit_sha
      JOIN factory.runtime_attempt attempt ON attempt.id=verification.runtime_attempt_id
        AND attempt.verification_id=verification.id AND attempt.state='stopped'
      WHERE verification.id=${verificationID} AND change.id=${changeID}
        AND change.state='active'
        AND (session.change_id IS NULL OR (session.state='committed' AND NOT session.stop_pending))
        AND ${submittedCandidate(sql)}
        AND verification.state='failed' AND verification.runtime_attempt_id=${runtimeAttemptID}
        AND verification.runner_id IS NULL AND verification.action_run_id IS NOT NULL
        AND verification.repair_prompted_at IS NULL AND verification.completed_at IS NOT NULL
        AND attempt.deleted_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE change_id=change.id
          AND kind='thread' AND state<>'resolved')
      FOR UPDATE OF verification`;
    const diagnosis = verificationDiagnosisInput.safeParse(candidate?.diagnosis);
    if (
      !writer.available ||
      !["agent", "unassigned"].includes(writer.state) ||
      !candidate ||
      !diagnosis.success ||
      diagnosis.data.kind !== "execution-failed" ||
      diagnosis.data.runtimeAttemptId !== runtimeAttemptID ||
      diagnosis.data.jobs.length !== 0
    )
      throw new CommandError(
        "conflict",
        "Retry checks only after the failed queued environment is cleaned up and the current implementation is submitted",
      );
    // Keep the failed outcome and its exact Runtime identity with the explicit
    // decision before releasing the Verification's pending bootstrap reference.
    const result = {
      verificationID,
      runtimeAttemptID,
      actionRunID: candidate.actionRunID,
      state: "failed",
      summary: candidate.summary,
      diagnosis: diagnosis.data,
      completedAt: candidate.completedAt,
    };
    await db.insert(auditEvent).values({
      id: commandID,
      kind: "usage.policy_command",
      scopeType: "execution_policy",
      scopeId: scope,
      actorId: userID,
      dedupeKey,
      payload: {
        commandId: commandID,
        scope,
        actorId: userID,
        input,
        result,
      },
    });
    await db
      .update(verification)
      .set({
        state: "pending",
        runtimeAttemptId: null,
        runnerUuid: null,
        runnerToken: null,
        summary: null,
        diagnosis: null,
        completedAt: null,
        updatedAt: query`now()`,
      })
      .where(eq(verification.id, verificationID));
    return true;
  });
}
