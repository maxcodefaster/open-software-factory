import { and, eq, inArray, isNotNull, notInArray, or, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeCommitOperation,
  changeWriter,
  developmentWorkspace,
  runtimeAttempt,
  workspaceSharedDocument,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./authority";
import { workspaceAuthorityIn } from "./workspace";
import { writerActivity } from "./writer-activity";

export async function lockChangeWriterIn(sql: DatabaseTransaction, changeID: string) {
  // Admission already orders Change before membership. Source and handoff use
  // the same order, including when a save waits for an admitted Agent turn.
  const [change] = await sql<{ projectID: string; available: boolean }[]>`
    SELECT change.project_id AS "projectID",change.state IN ('starting','active','failed')
      AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL AS available
    FROM factory.change change JOIN factory.ticket ticket ON ticket.id=change.ticket_id
    WHERE change.id=${changeID} FOR UPDATE OF change,ticket`;
  if (!change) throw new CommandError("not-found", "Change not found");
  const [writer] = await sql<
    {
      state: "unassigned" | "agent-preparing" | "agent" | "handoff" | "human";
      epoch: string;
      userID: string | null;
      turnID: string | null;
      fenceAttemptID: string | null;
      fenceRequired: boolean;
      requestedBy: string | null;
      requestID: string | null;
      handoffKind: "takeover" | "release";
    }[]
  >`SELECT state,epoch::text, user_id AS "userID",turn_id AS "turnID"
    ,fence_attempt_id AS "fenceAttemptID",fence_required AS "fenceRequired",
    requested_by AS "requestedBy",request_id AS "requestID",handoff_kind AS "handoffKind"
    FROM factory.change_writer WHERE change_id=${changeID} FOR UPDATE`;
  if (!writer) throw new CommandError("unavailable", "Change writing authority is unavailable");
  return { ...writer, ...change };
}

export async function claimAgentWriterIn(
  sql: DatabaseTransaction,
  changeID: string,
  turnID: string,
  commissionerID: string,
) {
  const writer = await lockChangeWriterIn(sql, changeID);
  const db = drizzleTransaction(sql);
  const [sharedDraft] = await db
    .select({ path: workspaceSharedDocument.path })
    .from(workspaceSharedDocument)
    .innerJoin(
      developmentWorkspace,
      eq(developmentWorkspace.id, workspaceSharedDocument.workspaceId),
    )
    .where(
      and(
        eq(developmentWorkspace.changeId, changeID),
        or(workspaceSharedDocument.dirty, workspaceSharedDocument.conflict),
      ),
    )
    .limit(1);
  if (sharedDraft)
    throw new CommandError(
      "conflict",
      "Save or resolve shared editor buffers before commissioning background Coding.",
    );
  const [integration] = await db
    .select({ id: changeCommitOperation.id })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, changeID),
        eq(changeCommitOperation.source, "integration"),
        notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
      ),
    )
    .limit(1);
  if (integration)
    throw new CommandError(
      "conflict",
      "Wait for the retained integration outcome before starting another Agent turn.",
    );
  if (writer.state === "human" && writer.userID !== commissionerID) {
    let activeHolder = true;
    try {
      if (!writer.userID)
        throw new CommandError("conflict", "Human writer identity is unavailable");
      await projectDevelopmentAuthorityIn(sql, writer.userID, writer.projectID);
    } catch (cause) {
      if (!(cause instanceof CommandError) || !["forbidden", "not-found"].includes(cause.code))
        throw cause;
      activeHolder = false;
    }
    if (activeHolder)
      throw new CommandError(
        "conflict",
        "Another developer holds editing. Request editing or wait for release before commissioning Coding. Your draft is unchanged.",
      );
  }
  let fencePrevious = writer.state === "human";
  if (writer.state === "handoff")
    throw new CommandError("conflict", "Wait for editing takeover before starting the Agent");
  if (["agent", "agent-preparing"].includes(writer.state) && writer.turnID !== turnID) {
    const [settled] = await sql<{ requiresFence: boolean | null }[]>`SELECT previous.id,
        ((session.state='failed' AND previous.state='failed' AND NOT EXISTS(
          SELECT 1 FROM factory.coding_pause pause WHERE pause.turn_id=previous.id AND pause.resumed_by_turn_id IS NULL))
          OR (session.change_id IS NOT NULL AND intent.runtime_attempt_id IS NULL
            AND previous.state IN ('failed','stopped'))
          OR (session.state='waiting' AND previous.state='completed')) AS "requiresFence"
        FROM factory.agent_turn previous
        LEFT JOIN factory.change_agent_session session ON session.change_id=previous.change_id
        LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id=previous.id
        WHERE previous.id=${writer.turnID} AND previous.change_id=${changeID}
          AND ((NOT session.stop_pending AND (session.state IN ('committed','stopped')
          OR (session.state='failed' AND session.active_turn_id=${writer.turnID}
            AND previous.state='failed')
          OR (session.state='waiting' AND session.active_turn_id=previous.id
            AND previous.state='completed' AND session.runtime_attempt_id=intent.runtime_attempt_id
            AND session.opencode_session_id=intent.session_id
            AND EXISTS(SELECT 1 FROM factory.change_commit_operation operation
              WHERE operation.id=previous.id AND operation.change_id=${changeID}
                AND operation.source='agent' AND operation.runtime_attempt_id=intent.runtime_attempt_id
                AND operation.state='failed' AND operation.commit_sha IS NULL AND operation.completed_at IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation operation
              WHERE operation.change_id=${changeID} AND operation.state NOT IN ('succeeded','failed')))))
          OR (previous.state IN ('failed','stopped')
            AND intent.turn_id IS NOT NULL AND intent.runtime_attempt_id IS NULL
            AND (session.change_id IS NULL OR NOT session.stop_pending)))
          AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${changeID} AND id<>${turnID} AND state IN ('pending','dispatching','running','uncertain'))`;
    // Known failures and completed empty turns can still own hooks or background
    // processes. A completed no-change commit permits another explicit prompt,
    // but its previous runtime must be fully fenced before the next writer grant.
    // Uncertain work and unconfirmed Stop remain ineligible.
    const [previous] = writer.turnID
      ? await db
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, writer.turnID),
              inArray(agentTurn.state, ["completed", "stopped", "failed"]),
            ),
          )
      : [];
    if (!settled || !previous)
      throw new CommandError("conflict", "The previous Agent writer has not been safely released");
    fencePrevious ||= Boolean(settled.requiresFence);
  }
  await db
    .update(changeWriter)
    .set({
      state: "agent-preparing",
      turnId: turnID,
      userId: null,
      fenceRequired: query`${changeWriter.fenceRequired} OR ${fencePrevious}`,
      fenceAttemptId: query`CASE WHEN ${changeWriter.fenceRequired} THEN ${changeWriter.fenceAttemptId}
      ELSE (${db.select({ id: change.runtimeAttemptId }).from(change).where(eq(change.id, changeID))}) END`,
      requestedBy: null,
      requestId: null,
      handoffKind: "takeover",
      epoch: query`${changeWriter.epoch}+1`,
      updatedAt: query`now()`,
    })
    .where(eq(changeWriter.changeId, changeID));
}

export async function workspaceWriteAuthorityIn(
  sql: DatabaseTransaction,
  workspaceID: string,
  userID: string,
) {
  const [workspace] = await drizzleTransaction(sql)
    .select({
      projectID: developmentWorkspace.projectId,
      kind: developmentWorkspace.kind,
      ownerID: developmentWorkspace.ownerUserId,
      changeID: developmentWorkspace.changeId,
    })
    .from(developmentWorkspace)
    .where(eq(developmentWorkspace.id, workspaceID));
  if (!workspace) throw new CommandError("not-found", "Workspace not found");
  const writer = workspace.changeID ? await lockChangeWriterIn(sql, workspace.changeID) : null;
  const access = await workspaceAuthorityIn(sql, workspaceID, userID, true);
  if (
    writer &&
    (!writer.available ||
      writer.state !== "human" ||
      (!access.collaborative && writer.userID !== userID))
  )
    throw new CommandError(
      "conflict",
      "This Workspace is observation-only. Take over editing before changing files or running commands.",
    );
  if (writer && workspace.changeID)
    writerActivity.observe(workspace.changeID, userID, writer.epoch, "edit");
  return { ...workspace, writerEpoch: writer?.epoch, accessVersion: access.accessVersion };
}

export async function runtimeWriteAuthorityIn(
  sql: DatabaseTransaction,
  attemptID: string,
  userID: string,
) {
  const [attempt] = await drizzleTransaction(sql)
    .select({ workspaceID: runtimeAttempt.workspaceId })
    .from(runtimeAttempt)
    .where(
      and(
        eq(runtimeAttempt.id, attemptID),
        eq(runtimeAttempt.state, "ready"),
        isNotNull(runtimeAttempt.workspaceId),
      ),
    );
  if (!attempt?.workspaceID)
    throw new CommandError("conflict", "Runtime writing authority is unavailable");
  return workspaceWriteAuthorityIn(sql, attempt.workspaceID, userID);
}
