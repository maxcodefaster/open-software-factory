import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { projectDevelopmentAuthorityIn } from "./controller";

export async function lockChangeWriterIn(sql: AgentTurnTransaction, changeID: string) {
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
    }[]
  >`SELECT state,epoch::text, user_id AS "userID",turn_id AS "turnID"
    ,fence_attempt_id AS "fenceAttemptID",fence_required AS "fenceRequired",
    requested_by AS "requestedBy",request_id AS "requestID"
    FROM factory.change_writer WHERE change_id=${changeID} FOR UPDATE`;
  if (!writer) throw new CommandError("unavailable", "Change writing authority is unavailable");
  return { ...writer, ...change };
}

export async function claimAgentWriterIn(
  sql: AgentTurnTransaction,
  changeID: string,
  turnID: string,
) {
  const writer = await lockChangeWriterIn(sql, changeID);
  if (writer.state === "handoff")
    throw new CommandError("conflict", "Wait for editing takeover before starting the Agent");
  if (["agent", "agent-preparing"].includes(writer.state) && writer.turnID !== turnID) {
    const [settled] = await sql`SELECT previous.id FROM factory.agent_turn previous
        LEFT JOIN factory.change_agent_session session ON session.change_id=previous.change_id
        LEFT JOIN factory.change_agent_turn_intent intent ON intent.turn_id=previous.id
        WHERE previous.id=${writer.turnID} AND previous.change_id=${changeID}
          AND ((NOT session.stop_pending AND (session.state IN ('committed','stopped')
          OR (session.state='failed' AND session.active_turn_id=${writer.turnID} AND EXISTS(
            SELECT 1 FROM factory.coding_pause pause JOIN factory.agent_turn turn ON turn.id=pause.turn_id
            WHERE turn.id=${writer.turnID} AND turn.state='failed' AND pause.resumed_by_turn_id IS NULL))))
          OR (session.change_id IS NULL AND previous.state IN ('failed','stopped')
            AND intent.turn_id IS NOT NULL AND intent.runtime_attempt_id IS NULL))
          AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${changeID} AND id<>${turnID} AND state IN ('pending','dispatching','running','uncertain'))`;
    // Runtime assignment and Session intent precede any OpenCode mutation.
    // A failed or stopped, unassigned input never acquired an external writer. Exclude
    // the newly inserted pending turn when proving the prior owner.
    const [previous] =
      await sql`SELECT id FROM factory.agent_turn WHERE id=${writer.turnID} AND state IN ('completed','stopped','failed')`;
    if (!settled || !previous)
      throw new CommandError("conflict", "The previous Agent writer has not been safely released");
  }
  await sql`UPDATE factory.change_writer SET state='agent-preparing',turn_id=${turnID},user_id=NULL,
    fence_required=fence_required OR state='human',fence_attempt_id=CASE WHEN fence_required THEN fence_attempt_id ELSE (SELECT runtime_attempt_id FROM factory.change WHERE id=${changeID}) END,
    requested_by=NULL,request_id=NULL,
    epoch=epoch+1,updated_at=now() WHERE change_id=${changeID}`;
}

export async function workspaceWriteAuthorityIn(
  sql: AgentTurnTransaction,
  workspaceID: string,
  userID: string,
) {
  const [workspace] = await sql<
    {
      projectID: string;
      kind: string;
      ownerID: string | null;
      changeID: string | null;
    }[]
  >`SELECT project_id AS "projectID",kind,owner_user_id AS "ownerID",change_id AS "changeID"
    FROM factory.development_workspace WHERE id=${workspaceID}`;
  if (!workspace || (workspace.kind === "personal" && workspace.ownerID !== userID))
    throw new CommandError("not-found", "Workspace not found");
  const writer = workspace.changeID ? await lockChangeWriterIn(sql, workspace.changeID) : null;
  await projectDevelopmentAuthorityIn(sql, userID, workspace.projectID);
  if (writer && (!writer.available || writer.state !== "human" || writer.userID !== userID))
    throw new CommandError(
      "conflict",
      "This Workspace is observation-only. Take over editing before changing files or running commands.",
    );
  return { ...workspace, writerEpoch: writer?.epoch };
}

export async function runtimeWriteAuthorityIn(
  sql: AgentTurnTransaction,
  attemptID: string,
  userID: string,
) {
  const [attempt] = await sql<{ workspaceID: string }[]>`SELECT workspace_id AS "workspaceID"
    FROM factory.runtime_attempt WHERE id=${attemptID} AND state='ready' AND workspace_id IS NOT NULL`;
  if (!attempt) throw new CommandError("conflict", "Runtime writing authority is unavailable");
  return workspaceWriteAuthorityIn(sql, attempt.workspaceID, userID);
}
