import type { createDatabase } from "../../../../packages/db/src/client";
import { lockChangeWriterIn, workspaceWriteAuthorityIn } from "../access/change-writer";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import { type AgentTurnTransaction, createAgentTurnStore } from "../agent/turn-store";
import { CommandError } from "../command-error";

export const substrateBootstrapContinuationBlocked =
  "Initial startup has an unsettled outcome with Source retained in its original Actor. Reconcile the startup outcome before continuing; no Feature or lifecycle hook was repeated.";

export async function substrateUnsettledBootstrapIn(
  sql: ReturnType<typeof createDatabase>["client"] | AgentTurnTransaction,
  workspaceID: string,
  attemptID: string,
) {
  const [row] = await sql<
    { state: string }[]
  >`SELECT a.state::text AS state FROM factory.runtime_attempt a
    JOIN factory.development_workspace w ON w.id=a.workspace_id AND w.project_id=a.project_id
    WHERE a.id=${attemptID} AND w.id=${workspaceID} AND a.substrate AND w.substrate AND w.kind='personal'
      AND a.change_id IS NULL AND w.change_id IS NULL AND a.ready_at IS NULL AND a.failure IS NOT NULL
      AND a.state IN ('failed','pausing','paused') AND a.stop_intended_at IS NULL`;
  return row;
}

// Derived retention facts, not another runtime or input-settlement state.
export async function substrateBootstrapRetentionIn(
  sql: ReturnType<typeof createDatabase>["client"] | AgentTurnTransaction,
  workspaceID: string,
  attemptID: string,
) {
  const [row] = await sql<
    { state: string }[]
  >`SELECT a.state::text AS state FROM factory.runtime_attempt a
    JOIN factory.development_workspace w ON w.id=a.workspace_id AND w.project_id=a.project_id
    JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
    JOIN factory.substrate_source s ON s.workspace_id=w.id AND s.actor_uid=b.actor_uid
    WHERE a.id=${attemptID} AND w.id=${workspaceID} AND w.kind='personal' AND a.substrate AND w.substrate
      AND a.change_id IS NULL AND w.change_id IS NULL AND a.ready_at IS NULL
      AND a.state IN ('starting','failed','pausing','paused') AND a.stop_intended_at IS NULL
      AND s.owner='actor' AND s.writable AND s.writer_epoch=1 AND s.generation=0
      AND s.checkpoint_id IS NULL AND s.checkpoint IS NULL
      AND NOT EXISTS(SELECT 1 FROM factory.change_agent_turn_intent i WHERE i.runtime_attempt_id=a.id)`;
  return row;
}

// Connector/restore capabilities identify an Attempt, not its original creator
// as a permanent writer. A recorded handoff keeps creation attribution immutable
// while the existing Change writer determines the current execution principal.
export async function substrateRuntimePrincipalIn(
  sql: AgentTurnTransaction,
  attemptID: string,
  retainedSourceParent = false,
) {
  const [principal] = await sql<{ userID: string | null }[]>`
    SELECT CASE WHEN w.kind='personal' THEN w.owner_user_id
      WHEN writer.state='human' THEN writer.user_id
      WHEN writer.state='agent' THEN turn.created_by END AS "userID"
    FROM factory.runtime_attempt a JOIN factory.development_workspace w
      ON w.id=a.workspace_id AND w.substrate AND w.project_id=a.project_id
        AND w.change_id IS NOT DISTINCT FROM a.change_id
    LEFT JOIN factory.change c ON c.id=w.change_id AND c.runtime_attempt_id=a.id
    LEFT JOIN factory.change_writer writer ON writer.change_id=c.id
    LEFT JOIN factory.agent_turn turn ON turn.id=writer.turn_id AND turn.change_id=c.id
    WHERE a.id=${attemptID} AND a.substrate AND a.stop_intended_at IS NULL
       AND (a.state IN ('starting','ready') OR (${retainedSourceParent} AND a.state IN ('failed','pausing')
         AND w.kind='personal'
         AND EXISTS(SELECT 1 FROM factory.substrate_source s JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
           WHERE s.workspace_id=w.id AND s.actor_uid=b.actor_uid AND s.owner='actor'
             AND ((a.ready_at IS NULL AND a.failure IS NOT NULL)
               OR (a.state='pausing' AND a.ready_at IS NOT NULL AND NOT s.writable AND s.checkpoint_id IS NOT NULL)))))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=w.id AND n.generation>a.generation)`;
  if (!principal?.userID)
    throw new CommandError("forbidden", "Current native execution principal is unavailable");
  return principal.userID;
}

// Runtime access is not permission to dispatch a prompt. Fresh Ticket execution
// additionally uses the existing commissioned turn's authority and live lease.
export async function substrateWorkspaceGrantIn(
  database: ReturnType<typeof createDatabase>,
  sql: AgentTurnTransaction,
  workspaceID: string,
  userID: string,
  newExecution = false,
) {
  const [workspace] = await sql<
    {
      projectID: string;
      kind: string;
      ownerID: string | null;
      changeID: string | null;
    }[]
  >`SELECT project_id AS "projectID",kind,owner_user_id AS "ownerID",change_id AS "changeID"
    FROM factory.development_workspace WHERE id=${workspaceID} AND substrate`;
  if (!workspace) throw new CommandError("forbidden", "Current native Workspace grant required");
  if (workspace.kind === "personal") {
    if (workspace.ownerID !== userID)
      throw new CommandError("forbidden", "Current personal Workspace grant required");
    await projectDevelopmentAuthorityIn(sql, userID, workspace.projectID);
    return workspace;
  }
  if (!workspace.changeID) throw new CommandError("forbidden", "Ticket Workspace identity missing");
  const writer = await lockChangeWriterIn(sql, workspace.changeID);
  if (!writer.available) throw new CommandError("conflict", "Ticket execution is no longer active");
  if (writer.state === "human") {
    await workspaceWriteAuthorityIn(sql, workspaceID, userID);
    return workspace;
  }
  await projectAuthorityIn(sql, userID, workspace.projectID);
  const [turn] = await sql<{ id: string; ownerToken: string | null }[]>`
    SELECT t.id,t.owner_token AS "ownerToken" FROM factory.agent_turn t
    JOIN factory.change c ON c.id=t.change_id
    JOIN factory.requirement_approval approval ON approval.id=c.requirement_approval_id
    WHERE t.id=${writer.turnID} AND t.change_id=${workspace.changeID} AND t.created_by=${userID}
      AND t.project_id=${workspace.projectID} AND t.ticket_id=c.ticket_id
      AND t.authority->>'mode'='build'
      AND t.authority->>'requirementRevisionId'=approval.requirement_revision_id::text
      AND t.state IN ('pending','dispatching','running','completed')
      AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session s WHERE s.change_id=c.id AND s.stop_pending)`;
  if (writer.state !== "agent" || !turn)
    throw new CommandError("forbidden", "Current commissioned Ticket writer required");
  if (
    newExecution &&
    (!turn.ownerToken ||
      !(await createAgentTurnStore(database).validateExecutionIn(sql, turn.id, turn.ownerToken)))
  ) {
    // Delivery's existing Git owner can reopen the SAME retained runtime after
    // inference completed. This is not a new Coding grant: require the exact
    // pending integration, submitted parent, queue and completed current writer.
    // Without an already confirmed Actor it cannot provision or adopt anything.
    const [integration] = await sql`
      SELECT operation.id FROM factory.change_commit_operation operation
      JOIN factory.change c ON c.id=operation.change_id
      JOIN factory.ticket ticket ON ticket.id=c.ticket_id AND ticket.trashed_at IS NULL
      JOIN factory.requirement_approval approval ON approval.id=c.requirement_approval_id
      JOIN factory.change_agent_session session ON session.change_id=c.id
      JOIN factory.agent_turn completed ON completed.id=session.active_turn_id
      JOIN factory.runtime_attempt attempt ON attempt.id=c.runtime_attempt_id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      JOIN factory.project_delivery_queue queue ON queue.project_id=c.project_id AND queue.change_id=c.id
      WHERE c.id=${workspace.changeID} AND c.project_id=${workspace.projectID}
        AND c.state='active' AND c.cancel_requested_at IS NULL
        AND operation.source='integration' AND operation.state IN ('commit-intended','push-intended')
        AND operation.created_by=${userID} AND operation.branch_name=c.branch_name
        AND operation.runtime_attempt_id=attempt.id AND attempt.workspace_id=${workspaceID}
        AND attempt.substrate AND attempt.stop_intended_at IS NULL
        AND attempt.state IN ('starting','ready','paused','resuming')
        AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL
        AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL AND NOT binding.create_rejected
        AND session.runtime_attempt_id=attempt.id AND session.state='committed' AND NOT session.stop_pending
        AND completed.id=${turn.id} AND completed.change_id=c.id AND completed.state='completed'
        AND operation.expected_parent_sha=(SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id=c.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
        AND approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision
          WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM factory.agent_turn active WHERE active.change_id=c.id
          AND active.state IN ('pending','dispatching','running','uncertain'))
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
          WHERE newer.workspace_id=${workspaceID} AND newer.generation>attempt.generation)`;
    if (!integration)
      throw new CommandError("forbidden", "Ticket execution requires its current admitted turn");
  }
  return workspace;
}

export async function substrateTicketSourceIn(
  database: ReturnType<typeof createDatabase>,
  sql: AgentTurnTransaction,
  attemptID: string,
) {
  const [scope] = await sql<{ workspaceID: string; repository: string }[]>`
    SELECT w.id AS "workspaceID",project.repository_url AS repository
    FROM factory.runtime_attempt a JOIN factory.development_workspace w
      ON w.id=a.workspace_id AND w.substrate AND w.kind='ticket'
        AND w.project_id=a.project_id AND w.change_id=a.change_id
    JOIN factory.project project ON project.id=a.project_id
    JOIN factory.substrate_workspace provision ON provision.workspace_id=w.id
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=a.id
    WHERE a.id=${attemptID} AND a.substrate AND a.state='starting' AND a.ready_at IS NULL AND a.stop_intended_at IS NULL
      AND provision.intent->>'repositoryURL'=project.repository_url
      AND provision.intent->>'revision'=a.revision AND provision.intent->>'branch'=w.source_branch
      AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=w.id AND newer.generation>a.generation)`;
  if (!scope)
    throw new CommandError("forbidden", "Current commissioned native Ticket Source grant required");
  const principal = await substrateRuntimePrincipalIn(sql, attemptID);
  await substrateWorkspaceGrantIn(database, sql, scope.workspaceID, principal, true);
  return scope.repository;
}
