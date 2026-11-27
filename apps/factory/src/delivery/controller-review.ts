import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql as query,
} from "drizzle-orm";
import { candidateReviewResultInput } from "#conversation-domain/candidate-review";
import { drizzleTransaction } from "#db/client";
import {
  agentTurn,
  auditEvent,
  candidateReview,
  changeAgentSession,
  changeCommitOperation,
  change as changeTable,
  runtimeAttempt,
  verification as verificationTable,
} from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { submittedCandidate } from "../agent/candidate-api";
import { CommandError } from "../command-error";
import type { DeliveryChangeRow } from "./controller-projection";
import type {
  AgentController,
  Database,
  DeliveryVerificationChecks,
  DrizzleDB,
} from "./controller-types";

function pendingReviewColumns() {
  // INSERT SELECT must supply every model column in model order. Reset the
  // fields omitted by the original insert to their native fresh-review defaults.
  return {
    ...getTableColumns(candidateReview),
    supersedesId: query<null>`NULL::uuid`.as("supersedes_id"),
    findingChecks: query<null>`NULL::jsonb`.as("finding_checks"),
    turnId: query<null>`NULL::uuid`.as("turn_id"),
    state: query<string>`'pending'::text`.as("state"),
    uiRequired: query<boolean>`false`.as("ui_required"),
    result: query<null>`NULL::jsonb`.as("result"),
    evidence: query<unknown[]>`'[]'::jsonb`.as("evidence"),
    repairCommandId: query<string>`gen_random_uuid()`.as("repair_command_id"),
    repairPromptedAt: query<null>`NULL::timestamptz`.as("repair_prompted_at"),
    createdAt: query<Date>`now()`.as("created_at"),
    completedAt: query<null>`NULL::timestamptz`.as("completed_at"),
  };
}

export async function ensureCandidateReview(
  db: DrizzleDB,
  agent: AgentController,
  verificationChecks: DeliveryVerificationChecks,
  failedCorrections: (changeID: string) => Promise<number>,
  change: DeliveryChangeRow,
) {
  const [verification] = await db
    .select({ id: verificationTable.id })
    .from(verificationTable)
    .where(
      and(
        eq(verificationTable.changeId, change.id),
        eq(verificationTable.commitSha, query`${change.commitSHA}`),
        eq(verificationTable.state, "succeeded"),
      ),
    );
  if (!verification || !(await verificationChecks.cleanupConfirmed(verification.id))) return;
  const focusReview = db
    .select({ id: candidateReview.id })
    .from(candidateReview)
    .innerJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
    .where(
      and(
        eq(candidateReview.changeId, change.id),
        ne(candidateReview.commitSha, query`${change.commitSHA}`),
        inArray(candidateReview.state, ["passed", "changes-requested"]),
        eq(agentTurn.state, "completed"),
        or(eq(candidateReview.state, "passed"), isNotNull(candidateReview.repairPromptedAt)),
      ),
    )
    .orderBy(desc(candidateReview.createdAt), desc(candidateReview.ordinal))
    .limit(1);
  await db
    .insert(candidateReview)
    .values({
      id: crypto.randomUUID(),
      verificationId: verification.id,
      changeId: change.id,
      commitSha: query`${change.commitSHA}`,
      baseSha: change.baseSHA,
      createdBy: change.userID,
      focusReviewId: query<string | null>`(${focusReview})`,
    })
    .onConflictDoNothing({ target: [candidateReview.verificationId, candidateReview.ordinal] });
  const [review] = await db
    .select({
      id: candidateReview.id,
      turnID: candidateReview.turnId,
      state: candidateReview.state,
      result: candidateReview.result,
      repairCommandID: candidateReview.repairCommandId,
      repaired: query<boolean>`${candidateReview.repairPromptedAt} IS NOT NULL`,
      userID: candidateReview.createdBy,
      findingSourceID: candidateReview.findingSourceId,
    })
    .from(candidateReview)
    .where(
      and(
        eq(candidateReview.verificationId, verification.id),
        eq(candidateReview.commitSha, query`${change.commitSHA}`),
      ),
    )
    .orderBy(desc(candidateReview.ordinal))
    .limit(1);
  if (!review) return;
  const [session] = await db
    .select({ state: changeAgentSession.state, stopping: changeAgentSession.stopPending })
    .from(changeAgentSession)
    .where(eq(changeAgentSession.changeId, change.id));
  if (session?.stopping || (session && session.state !== "committed")) return;
  const [work] = await db
    .select({ id: agentTurn.id })
    .from(agentTurn)
    .where(
      and(
        eq(agentTurn.changeId, change.id),
        inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
      ),
    );
  if (work) return;
  if (!review.turnID) {
    if (!agent.review) throw new Error("Independent candidate review is not configured");
    await agent.review(change.id, review.id, review.userID);
    return;
  }
  if (review.state !== "changes-requested" || review.repaired) return;
  if (!review.findingSourceID) {
    // One fresh, batched check only when discovery proposes blockers. Its
    // separate row retains the original report and uses all existing lifecycle gates.
    const [created] = await db
      .insert(candidateReview)
      .select(
        db
          .select({
            ...pendingReviewColumns(),
            id: query<string>`${crypto.randomUUID()}::uuid`.as("id"),
            ordinal: query<number>`${candidateReview.ordinal}+1`.as("ordinal"),
            findingSourceId: candidateReview.id,
          })
          .from(candidateReview)
          .where(
            and(
              eq(candidateReview.id, review.id),
              exists(
                db
                  .select({ id: agentTurn.id })
                  .from(agentTurn)
                  .where(
                    and(eq(agentTurn.id, candidateReview.turnId), eq(agentTurn.state, "completed")),
                  ),
              ),
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ id: candidateReview.id });
    if (created)
      await ensureCandidateReview(db, agent, verificationChecks, failedCorrections, change);
    return;
  }
  if ((await failedCorrections(change.id)) >= 3)
    throw new Error(
      "Automatic correction paused after three failed candidates. Review the findings and resume Build manually.",
    );
  const result = candidateReviewResultInput.parse(review.result);
  const findings = result.findings.filter((finding) => finding.severity === "blocking");
  await agent.prompt(
    change.id,
    [
      `Independent review of commit ${change.commitSHA} found these reproducible defects within the approved scope:`,
      ...findings.map(
        (finding, index) =>
          `${index + 1}. ${finding.title}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}\n${finding.explanation}\nReproduction: ${finding.reproduction}`,
      ),
      "Add or extend regression coverage for each fixed defect where the existing test toolchain supports it. Do not replace failing checks with skipped or weaker tests.",
      "Fix these defects in the retained checkout, preserve unrelated human edits and run the relevant checks. Do not weaken tests, expand scope for cosmetic preferences, commit or push. Factory will submit the corrected candidate for new exact Verification and independent review.",
    ].join("\n\n"),
    change.userID,
    review.repairCommandID,
    true,
  );
  await db
    .update(candidateReview)
    .set({ repairPromptedAt: query`now()` })
    .where(and(eq(candidateReview.id, review.id), isNull(candidateReview.repairPromptedAt)));
}

export async function resumeDeliveryChecks(
  database: Database,
  changeID: string,
  userID: string,
  commandID: string,
  verificationID: string,
  stopID: string,
) {
  await database.client.begin(async (sql) => {
    const writer = await lockChangeWriterIn(sql, changeID);
    await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
    const input = { changeID, verificationID, stopID };
    const scope = `checks-resume:${changeID}`;
    const dedupeKey = `usage.policy_command:${commandID}`;
    const tx = drizzleTransaction(sql);
    const [previous] = await tx
      .select({
        scope: auditEvent.scopeId,
        userID: auditEvent.actorId,
        input: query<typeof input>`${auditEvent.payload}->'input'`,
      })
      .from(auditEvent)
      .where(eq(auditEvent.dedupeKey, dedupeKey));
    if (previous) {
      if (
        previous.scope !== scope ||
        previous.userID !== userID ||
        previous.input.changeID !== changeID ||
        previous.input.verificationID !== verificationID ||
        previous.input.stopID !== stopID
      )
        throw new CommandError("conflict", "Checks resume changed target");
      return;
    }
    const [candidate] = await sql<
      { state: string; stopping: boolean; stopID: string | null; submitted: boolean }[]
    >`
      SELECT session.state,session.stop_pending AS stopping,session.stop_id AS "stopID",
        ${submittedCandidate(sql)} AS submitted
      FROM factory.verification verification
      JOIN factory.change change ON change.id=verification.change_id
      JOIN factory.change_agent_session session ON session.change_id=change.id
      JOIN factory.change_writer writer ON writer.change_id=change.id
      JOIN LATERAL (
        SELECT id,commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1
      ) commit ON commit.commit_sha=verification.commit_sha
      WHERE verification.id=${verificationID} AND change.id=${changeID}
        AND verification.state<>'cancelled' AND change.state='active'`;
    if (
      !writer.available ||
      !["agent", "unassigned"].includes(writer.state) ||
      !candidate?.submitted ||
      candidate.state !== "stopped" ||
      candidate.stopping ||
      candidate.stopID !== stopID
    )
      throw new CommandError(
        "conflict",
        "Resume checks only after Stop is confirmed and the current implementation is submitted",
      );
    // Restore only the submitted candidate's delivery eligibility. No turn,
    // prompt, source edit or Stop confirmation is created or replayed here.
    await tx
      .update(changeAgentSession)
      .set({ state: "committed", lastError: null, updatedAt: query`now()` })
      .where(eq(changeAgentSession.changeId, changeID));
    await tx.insert(auditEvent).values({
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
        result: {},
      },
    });
  });
}

export async function retryCandidateReview(
  database: Database,
  agent: AgentController,
  changeID: string,
  userID: string,
  commandID: string,
  previousReviewID: string,
) {
  if (!agent.review)
    throw new CommandError("unavailable", "Independent candidate review is not configured");
  await database.client.begin(async (sql) => {
    await lockChangeWriterIn(sql, changeID);
    const tx = drizzleTransaction(sql);
    const commit = tx
      .select({
        sha: changeCommitOperation.commitSha,
        base: changeCommitOperation.integrationBaseSha,
      })
      .from(changeCommitOperation)
      .where(
        and(
          eq(changeCommitOperation.changeId, changeTable.id),
          eq(changeCommitOperation.state, "succeeded"),
        ),
      )
      .orderBy(desc(changeCommitOperation.sequence))
      .limit(1)
      .as("commit");
    const [change] = await tx
      .select({
        projectID: changeTable.projectId,
        base: query<string>`COALESCE(${commit.base},${changeTable.baseSha})`,
        state: changeTable.state,
        runtimeState: runtimeAttempt.state,
        sha: commit.sha,
      })
      .from(changeTable)
      .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
      .leftJoinLateral(commit, query`true`)
      .where(eq(changeTable.id, changeID));
    if (!change) throw new CommandError("not-found", "Change not found");
    await projectAuthorityIn(sql, userID, change.projectID);
    const [old] = await tx
      .select({
        changeID: candidateReview.changeId,
        userID: candidateReview.createdBy,
        previousID: candidateReview.supersedesId,
      })
      .from(candidateReview)
      .where(eq(candidateReview.id, commandID));
    if (old) {
      if (old.changeID !== changeID || old.userID !== userID || old.previousID !== previousReviewID)
        throw new CommandError("conflict", "Review retry changed target");
      return;
    }
    const [previous] = await tx
      .select({
        id: candidateReview.id,
        verificationID: candidateReview.verificationId,
        ordinal: candidateReview.ordinal,
        state: candidateReview.state,
        turnState: agentTurn.state,
      })
      .from(candidateReview)
      .leftJoin(agentTurn, eq(agentTurn.id, candidateReview.turnId))
      .innerJoin(verificationTable, eq(verificationTable.id, candidateReview.verificationId))
      .where(
        and(
          eq(candidateReview.changeId, changeID),
          eq(candidateReview.commitSha, query`${change.sha}`),
          eq(verificationTable.state, "succeeded"),
        ),
      )
      .orderBy(desc(candidateReview.ordinal))
      .limit(1);
    const [session] = await tx
      .select({ stopping: changeAgentSession.stopPending })
      .from(changeAgentSession)
      .where(eq(changeAgentSession.changeId, changeID));
    const [active] = await tx
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.changeId, changeID),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
        ),
      );
    if (
      !(
        change.state === "active" ||
        (["starting", "failed"].includes(change.state) &&
          ["stopped", "failed"].includes(change.runtimeState ?? ""))
      ) ||
      !previous ||
      previous.id !== previousReviewID ||
      active ||
      session?.stopping ||
      !(previous.state === "incomplete" || ["failed", "stopped"].includes(previous.turnState ?? ""))
    )
      throw new CommandError(
        "conflict",
        "Resolve active, stale or uncertain work before retrying an incomplete review",
      );
    await tx.insert(candidateReview).select(
      tx
        .select({
          ...pendingReviewColumns(),
          id: query<string>`${commandID}::uuid`.as("id"),
          verificationId: query<string>`${previous.verificationID}::uuid`.as("verification_id"),
          ordinal: query<number>`${previous.ordinal + 1}::integer`.as("ordinal"),
          changeId: query<string>`${changeID}::uuid`.as("change_id"),
          commitSha: query<string>`${change.sha}::text`.as("commit_sha"),
          baseSha: query<string>`${change.base}::text`.as("base_sha"),
          createdBy: query<string>`${userID}::uuid`.as("created_by"),
          supersedesId: query<string>`${previousReviewID}::uuid`.as("supersedes_id"),
        })
        .from(candidateReview)
        .where(eq(candidateReview.id, previousReviewID)),
    );
  });
  await agent.review(changeID, commandID, userID);
}
