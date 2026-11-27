import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { createDatabase } from "#db/client";
import {
  administrator,
  agentTurn,
  changeAgentSession,
  changeCommitOperation,
  change as changeTable,
  changeWriter,
  deliveryApproval,
  developmentWorkspace,
  operation as operationTable,
  projectMembership,
  runtimeAttempt,
  verification,
} from "#db/schema";
import type { ChangeView } from "./types";

type Database = ReturnType<typeof createDatabase>;

function currentBuildTurn(db: Database["db"]) {
  // A confirmed human submission can supersede terminal Coding history, not
  // create a completed turn. Keep history and native/Stop identities untouched.
  // Select the latest turn first so newer work or review can never fall back
  // to an older, apparently successful input.
  // The retained Coding Session can own an earlier runtime of this Workspace.
  // A human Source submission does not rebind that native identity.
  const turn = db
    .select({
      id: agentTurn.id,
      state: agentTurn.state,
      input: agentTurn.input,
      createdAt: agentTurn.createdAt,
      updatedAt: agentTurn.updatedAt,
    })
    .from(agentTurn)
    .where(eq(agentTurn.changeId, changeTable.id))
    .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
    .limit(1)
    .as("turn");
  const submitted = db
    .select({
      id: changeCommitOperation.id,
      source: changeCommitOperation.source,
      state: changeCommitOperation.state,
      commitSha: changeCommitOperation.commitSha,
      observedRemoteSha: changeCommitOperation.observedRemoteSha,
      completedAt: changeCommitOperation.completedAt,
      runtimeAttemptId: changeCommitOperation.runtimeAttemptId,
    })
    .from(changeCommitOperation)
    .where(eq(changeCommitOperation.changeId, changeTable.id))
    .orderBy(desc(changeCommitOperation.sequence))
    .limit(1)
    .as("submitted");
  const codingRuntime = alias(runtimeAttempt, "coding_runtime");
  const submissionOp = alias(operationTable, "workspace_submission");
  return db
    .select({
      state: turn.state,
      purpose: query<string>`CASE WHEN ${turn.input}->>'kind'='change-review'
        THEN 'review' ELSE 'implementation' END`.as("purpose"),
    })
    .from(turn)
    .where(
      notExists(
        db
          .select({ id: submitted.id })
          .from(submitted)
          .innerJoin(
            submissionOp,
            and(
              eq(submissionOp.id, submitted.id),
              eq(submissionOp.kind, "workspace.submission"),
              eq(submissionOp.scopeType, "workspace"),
            ),
          )
          .innerJoin(
            developmentWorkspace,
            and(
              eq(
                developmentWorkspace.id,
                query<string>`(${submissionOp.payload}->>'workspaceId')::uuid`,
              ),
              eq(developmentWorkspace.changeId, changeTable.id),
            ),
          )
          .innerJoin(
            changeWriter,
            and(
              eq(changeWriter.changeId, changeTable.id),
              eq(
                changeWriter.epoch,
                query<number>`(${submissionOp.payload}->>'writerEpoch')::bigint`,
              ),
              eq(changeWriter.state, "unassigned"),
              eq(changeWriter.fenceRequired, false),
            ),
          )
          .where(
            and(
              eq(submitted.source, "workspace"),
              eq(submitted.state, "succeeded"),
              eq(submitted.commitSha, submitted.observedRemoteSha),
              isNotNull(submitted.completedAt),
              eq(submitted.runtimeAttemptId, changeTable.runtimeAttemptId),
              exists(
                db
                  .select({ id: codingRuntime.id })
                  .from(codingRuntime)
                  .where(
                    and(
                      eq(codingRuntime.id, changeAgentSession.runtimeAttemptId),
                      eq(codingRuntime.workspaceId, developmentWorkspace.id),
                      eq(codingRuntime.changeId, changeTable.id),
                    ),
                  ),
              ),
              eq(changeAgentSession.state, "committed"),
              eq(changeAgentSession.stopPending, false),
              isNull(changeAgentSession.activeInboxId),
              isNull(changeAgentSession.lastError),
              or(
                isNull(changeAgentSession.activeTurnId),
                eq(changeAgentSession.activeTurnId, turn.id),
              ),
              or(isNull(changeAgentSession.stopTurnId), eq(changeAgentSession.stopTurnId, turn.id)),
              gte(changeAgentSession.updatedAt, submitted.completedAt),
              ne(query<string>`${turn.input}->>'kind'`, "change-review"),
              inArray(turn.state, ["completed", "failed", "stopped"]),
              lt(turn.createdAt, submissionOp.createdAt),
              lt(turn.updatedAt, submissionOp.createdAt),
              isNull(changeTable.cancelRequestedAt),
              notExists(
                db
                  .select({ id: agentTurn.id })
                  .from(agentTurn)
                  .where(
                    and(
                      eq(agentTurn.changeId, changeTable.id),
                      inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
                    ),
                  ),
              ),
              notExists(
                db
                  .select({ id: changeCommitOperation.id })
                  .from(changeCommitOperation)
                  .where(
                    and(
                      eq(changeCommitOperation.changeId, changeTable.id),
                      notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
                    ),
                  ),
              ),
            ),
          ),
      ),
    )
    .as("build");
}

function changeViewQuery(db: Database["db"]) {
  const build = currentBuildTurn(db);
  const committed = db
    .select({ commitSha: changeCommitOperation.commitSha })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, changeTable.id),
        eq(changeCommitOperation.state, "succeeded"),
      ),
    )
    .orderBy(desc(changeCommitOperation.sequence))
    .limit(1);
  const verified = db
    .select({
      id: verification.id,
      state: verification.state,
      commitSha: verification.commitSha,
      runtimeAttemptId: verification.runtimeAttemptId,
    })
    .from(verification)
    .where(and(eq(verification.changeId, changeTable.id), eq(verification.commitSha, committed)))
    .orderBy(desc(verification.createdAt))
    .limit(1)
    .as("verification");
  const failedVerification = alias(runtimeAttempt, "failed_verification");
  const branchOp = alias(operationTable, "branch_op");
  const mergeOp = alias(operationTable, "merge_op");
  const merge = db
    .select({
      state: mergeOp.state,
      deliveryApprovalId: query<string>`(${mergeOp.payload}->>'approvalId')::uuid`.as(
        "delivery_approval_id",
      ),
    })
    .from(mergeOp)
    .where(
      and(
        eq(mergeOp.kind, "delivery.merge"),
        eq(mergeOp.scopeType, "change"),
        eq(mergeOp.scopeId, query<string>`${changeTable.id}::text`),
        eq(query<string>`${mergeOp.payload}->>'commitSha'`, verified.commitSha),
      ),
    )
    .orderBy(desc(ne(mergeOp.state, "failed")), desc(mergeOp.createdAt), desc(mergeOp.id))
    .limit(1)
    .as("merge");
  const approval = db
    .select({
      approvedAt: query<string>`${deliveryApproval.approvedAt}::text`.as("approved_at"),
    })
    .from(deliveryApproval)
    .where(
      and(
        eq(deliveryApproval.verificationId, verified.id),
        or(isNull(merge.deliveryApprovalId), eq(deliveryApproval.id, merge.deliveryApprovalId)),
      ),
    )
    .orderBy(desc(deliveryApproval.approvedAt), desc(deliveryApproval.id))
    .limit(1)
    .as("approval");
  return (
    db
      .select({
        id: changeTable.id,
        projectId: changeTable.projectId,
        ticketId: changeTable.ticketId,
        requirementApprovalId: changeTable.requirementApprovalId,
        branchName: changeTable.branchName,
        baseSha: changeTable.baseSha,
        state: changeTable.state,
        // Retain the existing Postgres.js bigint representation in this DTO.
        version: query<number>`${changeTable.version}`,
        runtimeAttemptId: changeTable.runtimeAttemptId,
        failure: changeTable.failure,
        branchState: branchOp.state,
        branchHeadSha: query<string | null>`${branchOp.result}->>'observedHeadSha'`,
        runtimeState: runtimeAttempt.state,
        verificationState: query<string | null>`CASE WHEN ${isNotNull(failedVerification.id)}
        THEN 'failed' ELSE ${verified.state}::text END`,
        buildTurnState: build.state,
        buildTurnPurpose: build.purpose,
        implementationState: changeAgentSession.state,
        deliveryApprovedAt: approval.approvedAt,
        mergeState: merge.state,
        promotionState: query<string | null>`promotion.state`,
      })
      .from(changeTable)
      .innerJoin(
        branchOp,
        and(
          eq(branchOp.kind, "delivery.branch_create"),
          eq(branchOp.scopeType, "change"),
          eq(branchOp.scopeId, query<string>`${changeTable.id}::text`),
        ),
      )
      .leftJoin(runtimeAttempt, eq(runtimeAttempt.id, changeTable.runtimeAttemptId))
      .leftJoin(changeAgentSession, eq(changeAgentSession.changeId, changeTable.id))
      .leftJoinLateral(build, query`true`)
      .leftJoinLateral(verified, query`true`)
      .leftJoin(
        failedVerification,
        and(
          eq(failedVerification.id, verified.runtimeAttemptId),
          inArray(verified.state, ["pending", "runner-starting", "running"]),
          or(
            inArray(failedVerification.state, ["failed", "cleanup-failed"]),
            and(eq(failedVerification.state, "stopped"), isNotNull(failedVerification.failure)),
          ),
        ),
      )
      .leftJoinLateral(merge, query`true`)
      .leftJoinLateral(approval, query`true`)
      // This native projection has no Drizzle model. Keep its database-owned policy.
      .leftJoin(
        query`factory.current_promotion promotion`,
        query`promotion.change_id=${changeTable.id}`,
      )
  );
}

export async function getChangeView(
  database: Database,
  changeID: string,
): Promise<ChangeView | null> {
  const rows: ChangeView[] = await changeViewQuery(database.db).where(eq(changeTable.id, changeID));
  return rows[0] ?? null;
}

export async function listChangeViews(
  database: Database,
  projectID: string | undefined,
  userID: string,
): Promise<ChangeView[]> {
  const rows: ChangeView[] = await changeViewQuery(database.db)
    .where(
      and(
        projectID === undefined || projectID === null
          ? undefined
          : eq(changeTable.projectId, projectID),
        or(
          exists(
            database.db
              .select({ userId: administrator.userId })
              .from(administrator)
              .where(eq(administrator.userId, userID)),
          ),
          exists(
            database.db
              .select({ userId: projectMembership.userId })
              .from(projectMembership)
              .where(
                and(
                  eq(projectMembership.projectId, changeTable.projectId),
                  eq(projectMembership.userId, userID),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(desc(changeTable.createdAt));
  return rows;
}
