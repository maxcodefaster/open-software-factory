import { and, eq, inArray, sql as query } from "drizzle-orm";
import type { z } from "zod";
import type { MCPAssignment } from "#conversation-domain/mcp-library";
import { resolveMCPChoice } from "#conversation-domain/mcp-library";
import { defaultAutofixInstructions, type inputDelegation } from "#conversation-domain/monitoring";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  change,
  mcpLibrary,
  monitoringHook,
  monitoringIncident,
  monitoringPolicy,
  requirementApproval,
} from "#db/schema";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { createMCPLibrary } from "../mcp/library-api";
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
  sql: DatabaseTransaction,
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
  sql: DatabaseTransaction,
  connectionId: string,
  projectId: string,
  userId: string,
): Promise<MCPAssignment> {
  const library = createMCPLibrary(database);
  const [entry] = await drizzleTransaction(sql)
    .select({ scope: mcpLibrary.scope })
    .from(mcpLibrary)
    .where(eq(mcpLibrary.id, connectionId));
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
  sql: DatabaseTransaction,
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

export function retainedInputAssignments(value: { sourceAssignments: MCPAssignment[] | null }) {
  return value.sourceAssignments ?? [];
}

export async function validateInputAssignmentsIn(
  database: Database,
  sql: DatabaseTransaction,
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
  sql: DatabaseTransaction,
  ticketId: string,
  projectId: string,
  userId: string,
) {
  const [policy] = await drizzleTransaction(sql)
    .select({
      sourceAssignments: monitoringPolicy.sourceAssignments,
    })
    .from(monitoringIncident)
    .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringIncident.policyId))
    .where(
      and(eq(monitoringIncident.ticketId, ticketId), eq(monitoringIncident.projectId, projectId)),
    );
  const assignments = policy
    ? retainedInputAssignments({
        sourceAssignments: policy.sourceAssignments,
      })
    : [];
  await validateInputAssignmentsIn(database, sql, assignments, projectId, userId);
  return assignments;
}

export async function monitoringAuthorityIn(
  database: Database,
  sql: DatabaseTransaction,
  incidentId: string,
): Promise<MonitoringAuthority> {
  const db = drizzleTransaction(sql);
  const [incident] = await db
    .select({
      id: monitoringIncident.id,
      projectId: monitoringIncident.projectId,
      policyId: monitoringIncident.policyId,
      hookId: monitoringIncident.hookId,
      hookVersion: monitoringIncident.hookVersion,
      userId: monitoringPolicy.delegatedBy,
      sourceAssignments: monitoringPolicy.sourceAssignments,
      sourceIds: monitoringPolicy.sourceIds,
      instructions: query<string>`coalesce(${monitoringPolicy.instructions},${defaultAutofixInstructions})`,
      delegation: monitoringPolicy.delegation,
    })
    .from(monitoringIncident)
    .innerJoin(monitoringPolicy, eq(monitoringPolicy.id, monitoringIncident.policyId))
    .where(
      and(
        eq(monitoringIncident.id, incidentId),
        inArray(monitoringIncident.state, ["queued", "diagnosing", "implementing"]),
      ),
    );
  if (!incident) throw new CommandError("not-found", "Monitoring incident not found");
  const [hook] = await db
    .select({ id: monitoringHook.id })
    .from(monitoringHook)
    .where(
      and(
        eq(monitoringHook.id, incident.hookId),
        eq(monitoringHook.projectId, incident.projectId),
        eq(monitoringHook.enabled, true),
        eq(monitoringHook.version, incident.hookVersion),
        eq(monitoringHook.policyId, incident.policyId),
      ),
    )
    .for("share");
  if (!hook) throw new CommandError("conflict", "Monitoring delegation changed or was disabled");
  const delegation = incident.delegation as MonitoringAuthority["delegation"];
  await manageMonitoringIn(sql, incident.userId, incident.projectId, delegation);
  const assignments = retainedInputAssignments({
    sourceAssignments: incident.sourceAssignments,
  });
  await validateInputAssignmentsIn(database, sql, assignments, incident.projectId, incident.userId);
  if (incident.delegation === "application-fix-and-delivery" && !assignments.length)
    throw new CommandError("conflict", "Automatic fixes require a connected read-only source");
  const [active] = await db
    .select({ id: monitoringIncident.id })
    .from(monitoringIncident)
    .where(
      and(
        eq(monitoringIncident.id, incidentId),
        inArray(monitoringIncident.state, ["queued", "diagnosing", "implementing"]),
      ),
    );
  if (!active) throw new CommandError("conflict", "Monitoring work was stopped");
  return { ...incident, delegation, assignments };
}

export async function monitoringChangeAuthorityIn(
  database: Database,
  sql: DatabaseTransaction,
  changeId: string,
  incidentId: string,
) {
  const [basis] = await drizzleTransaction(sql)
    .select({ id: change.id })
    .from(change)
    .innerJoin(requirementApproval, eq(requirementApproval.id, change.requirementApprovalId))
    .innerJoin(
      monitoringIncident,
      eq(monitoringIncident.id, requirementApproval.monitoringIncidentId),
    )
    .where(
      and(
        eq(change.id, changeId),
        eq(monitoringIncident.id, incidentId),
        eq(monitoringIncident.ticketId, change.ticketId),
        eq(monitoringIncident.projectId, change.projectId),
        eq(monitoringIncident.policyId, requirementApproval.monitoringPolicyId),
      ),
    );
  if (!basis)
    throw new CommandError("conflict", "Autofix no longer matches its delegated requirements");
  const authority = await monitoringAuthorityIn(database, sql, incidentId);
  if (authority.delegation !== "application-fix-and-delivery")
    throw new CommandError("forbidden", "This Input does not delegate implementation or Delivery");
  return authority;
}
