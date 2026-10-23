import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { createMCPLibrary } from "../mcp/controller";
import { resolveMCPChoice } from "../../../../packages/conversation-domain/src/mcp-library";
import {
  defaultAutofixInstructions,
  type inputDelegation,
} from "../../../../packages/conversation-domain/src/monitoring";
import type { z } from "zod";
import { monitoringDigest } from "./payload";

type Database = ReturnType<typeof createDatabase>;
export type MonitoringAuthority = {
  id: string;
  projectId: string;
  policyId: string;
  userId: string;
  assignments: MCPAssignment[];
  sourceIds: string[];
  instructions: string;
  delegation: z.infer<typeof inputDelegation>;
};
export async function manageMonitoringIn(
  sql: AgentTurnTransaction,
  userId: string,
  projectId: string,
  delegation: MonitoringAuthority["delegation"] = "application-fix-and-delivery",
) {
  await projectAuthorityIn(sql, userId, projectId, true);
  if (delegation === "application-fix-and-delivery")
    await projectDevelopmentAuthorityIn(sql, userId, projectId);
}
export async function monitoringAssignmentIn(
  database: Database,
  sql: AgentTurnTransaction,
  connectionId: string,
  projectId: string,
  userId: string,
): Promise<MCPAssignment> {
  const library = createMCPLibrary(database);
  const [entry] = await sql<
    { scope: string }[]
  >`SELECT scope FROM factory.mcp_library WHERE id=${connectionId}`;
  if (!entry || entry.scope === "personal")
    throw new CommandError(
      "conflict",
      "Inputs use Project or Factory connections, never personal credentials",
    );
  const connection = await library.connectionIn(sql, connectionId);
  await library.usableIn(sql, connection, projectId, userId);
  const revision = await library.revisionIn(sql, connection.revisionId);
  if (!revision.content.roles.includes("planning") || !revision.content.roles.includes("build"))
    throw new CommandError("conflict", "Enable this source for both planning and Build work");
  const tools = connection.tools.filter((tool) =>
    connection.allowedTools.some(
      (allowed) => allowed.name === tool.name && allowed.digest === tool.digest,
    ),
  );
  if (!tools.length)
    throw new CommandError("conflict", "Review at least one read-only source tool first");
  return {
    connectionId,
    credentialEpoch: connection.credentialEpoch,
    revisionId: connection.revisionId,
    policyVersion: connection.version,
    tools,
    required: true,
  };
}

export async function inputAssignmentsIn(
  database: Database,
  sql: AgentTurnTransaction,
  ids: string[],
  projectId: string,
  userId: string,
) {
  if (ids.length)
    return Promise.all(
      ids.map((id) => monitoringAssignmentIn(database, sql, id, projectId, userId)),
    );
  const library = createMCPLibrary(database);
  const view = await library.viewIn(sql, userId, projectId);
  const assignments: MCPAssignment[] = [];
  for (const entry of view.entries) {
    if (entry.scope === "personal") continue;
    const choice = resolveMCPChoice(view.choices, entry.id, "planning", false);
    if (!choice || choice.state === "disable") continue;
    try {
      if (entry.connection?.revisionId !== choice.revisionId)
        throw new CommandError("conflict", "A Project source needs version adoption");
      assignments.push({
        ...(await monitoringAssignmentIn(database, sql, entry.id, projectId, userId)),
        required: choice.state === "required",
      });
    } catch (cause) {
      if (!(cause instanceof CommandError) || choice.state === "required") throw cause;
    }
  }
  return assignments;
}

export function retainedInputAssignments(value: {
  sourceAssignments: MCPAssignment[] | null;
  assignment: MCPAssignment | null;
}) {
  // Old immutable Autofix policies retain their original single-source snapshot.
  return value.sourceAssignments ?? (value.assignment ? [value.assignment] : []);
}

export async function validateInputAssignmentsIn(
  database: Database,
  sql: AgentTurnTransaction,
  assignments: MCPAssignment[],
  projectId: string,
  userId: string,
) {
  for (const assignment of assignments) {
    const current = await monitoringAssignmentIn(
      database,
      sql,
      assignment.connectionId,
      projectId,
      userId,
    );
    if (
      monitoringDigest({ ...current, required: assignment.required }) !==
      monitoringDigest(assignment)
    )
      throw new CommandError(
        "conflict",
        "A connected source changed. Review and enable the Input again",
      );
  }
}

export async function inputTicketAssignmentsIn(
  database: Database,
  sql: AgentTurnTransaction,
  ticketId: string,
  projectId: string,
  userId: string,
) {
  const [policy] = await sql<
    {
      sourceAssignments: MCPAssignment[] | null;
      assignment: MCPAssignment | null;
    }[]
  >`SELECT policy.source_assignments AS "sourceAssignments",policy.assignment
    FROM factory.monitoring_incident event JOIN factory.monitoring_policy policy ON policy.id=event.policy_id
    WHERE event.ticket_id=${ticketId} AND event.project_id=${projectId}`;
  const assignments = policy ? retainedInputAssignments(policy) : [];
  await validateInputAssignmentsIn(database, sql, assignments, projectId, userId);
  return assignments;
}

export async function monitoringAuthorityIn(
  database: Database,
  sql: AgentTurnTransaction,
  incidentId: string,
): Promise<MonitoringAuthority> {
  const [incident] = await sql<
    (Omit<MonitoringAuthority, "assignments"> & {
      hookId: string;
      hookVersion: number;
      assignment: MCPAssignment | null;
      sourceAssignments: MCPAssignment[] | null;
    })[]
  >`
    SELECT incident.id,incident.project_id AS "projectId",incident.policy_id AS "policyId",
      incident.hook_id AS "hookId",incident.hook_version::float8 AS "hookVersion",
      policy.delegated_by AS "userId",policy.assignment,policy.source_assignments AS "sourceAssignments",
      policy.source_ids AS "sourceIds",coalesce(policy.instructions,${defaultAutofixInstructions}) AS instructions,
      policy.delegation
    FROM factory.monitoring_incident incident JOIN factory.monitoring_policy policy ON policy.id=incident.policy_id
    WHERE incident.id=${incidentId} AND incident.state IN ('queued','diagnosing','implementing')`;
  if (!incident) throw new CommandError("not-found", "Monitoring incident not found");
  const [hook] = await sql`SELECT id FROM factory.monitoring_hook WHERE id=${incident.hookId}
    AND project_id=${incident.projectId} AND enabled AND version=${incident.hookVersion}
    AND policy_id=${incident.policyId} FOR SHARE`;
  if (!hook) throw new CommandError("conflict", "Monitoring delegation changed or was disabled");
  await manageMonitoringIn(sql, incident.userId, incident.projectId, incident.delegation);
  const assignments = retainedInputAssignments(incident);
  await validateInputAssignmentsIn(database, sql, assignments, incident.projectId, incident.userId);
  if (incident.delegation === "application-fix-and-delivery" && !assignments.length)
    throw new CommandError("conflict", "Automatic fixes require a connected read-only source");
  const [active] = await sql`SELECT id FROM factory.monitoring_incident WHERE id=${incidentId}
    AND state IN ('queued','diagnosing','implementing')`;
  if (!active) throw new CommandError("conflict", "Monitoring work was stopped");
  return { ...incident, assignments };
}

export async function monitoringChangeAuthorityIn(
  database: Database,
  sql: AgentTurnTransaction,
  changeId: string,
  incidentId: string,
) {
  const [basis] = await sql`SELECT change.id FROM factory.change change
    JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
    JOIN factory.monitoring_incident incident ON incident.id=approval.monitoring_incident_id
    WHERE change.id=${changeId} AND incident.id=${incidentId}
      AND incident.ticket_id=change.ticket_id AND incident.project_id=change.project_id
      AND incident.policy_id=approval.monitoring_policy_id`;
  if (!basis)
    throw new CommandError("conflict", "Autofix no longer matches its delegated requirements");
  const authority = await monitoringAuthorityIn(database, sql, incidentId);
  if (authority.delegation !== "application-fix-and-delivery")
    throw new CommandError("forbidden", "This Input does not delegate implementation or Delivery");
  return authority;
}
