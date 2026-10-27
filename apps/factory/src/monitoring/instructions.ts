import type { createDatabase } from "../../../../packages/db/src/client";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { inputInstructions } from "../../../../packages/conversation-domain/src/monitoring";
import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";
import {
  manageMonitoringIn,
  retainedInputAssignments,
  validateInputAssignmentsIn,
} from "./authority";

// Change only the saved task. Never renew a delegation, rotate a key, enable a
// Hook or reinterpret an admitted event as a request under different guidance.
export async function editInputInstructionsIn(
  database: ReturnType<typeof createDatabase>,
  sql: AgentTurnTransaction,
  input: {
    hookId: string;
    policyId: string;
    version: number;
    instructions: string;
    revisionId: string;
    userId: string;
  },
) {
  const instructions = inputInstructions.parse(input.instructions);
  const [hook] = await sql<{ projectId: string; policyId: string; version: number }[]>`
    SELECT project_id AS "projectId",policy_id AS "policyId",version::int AS version FROM factory.monitoring_hook
    WHERE id=${input.hookId} FOR UPDATE`;
  if (!hook) throw new CommandError("not-found", "Input not found");
  const [policy] = await sql<
    {
      delegatedBy: string;
      delegation: "prepare-ticket" | "application-fix-and-delivery";
      assignment: MCPAssignment | null;
      sourceAssignments: MCPAssignment[] | null;
      instructions: string | null;
    }[]
  >`
    SELECT delegated_by AS "delegatedBy",delegation,assignment,source_assignments AS "sourceAssignments",instructions
    FROM factory.monitoring_policy WHERE id=${hook.policyId}`;
  if (!policy) throw new CommandError("not-found", "Input policy not found");
  await manageMonitoringIn(sql, input.userId, hook.projectId, policy.delegation);
  await manageMonitoringIn(sql, policy.delegatedBy, hook.projectId, policy.delegation);
  if (hook.version !== input.version || hook.policyId !== input.policyId)
    throw new CommandError(
      "conflict",
      "Input instructions changed. Reload the exact current policy.",
    );
  if (policy.instructions === instructions)
    throw new CommandError("invalid", "The edit does not change the saved Input task.");
  const [busy] = await sql`SELECT id FROM factory.monitoring_incident WHERE hook_id=${input.hookId}
    AND state IN ('queued','diagnosing','implementing') LIMIT 1`;
  if (busy)
    throw new CommandError(
      "conflict",
      "Input work must settle before its saved instructions change.",
    );
  await validateInputAssignmentsIn(
    database,
    sql,
    retainedInputAssignments(policy),
    hook.projectId,
    policy.delegatedBy,
  );
  await sql`INSERT INTO factory.monitoring_policy(id,hook_id,connection_id,assignment,delegated_by,delegated_at,delegation,
    instructions,source_ids,source_assignments)
    SELECT ${input.revisionId},hook_id,connection_id,assignment,delegated_by,delegated_at,delegation,
      ${instructions},source_ids,source_assignments FROM factory.monitoring_policy WHERE id=${input.policyId}`;
  await sql`UPDATE factory.monitoring_hook SET policy_id=${input.revisionId},version=version+1 WHERE id=${input.hookId}`;
  return { revisionId: input.revisionId, version: input.version + 1 };
}
