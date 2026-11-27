import { createHash } from "node:crypto";
import { eq, sql as expression } from "drizzle-orm";
import { type MCPTool, mcpRevision } from "#conversation-domain/mcp-library";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  administrator,
  auditEvent,
  type MCPProjectGrantRecord,
  mcpConnection,
  mcpLibrary,
  mcpRevision as mcpRevisionTable,
} from "#db/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";

export function canonicalMCPJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMCPJSON).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMCPJSON(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export const mcpDigest = (value: unknown) =>
  createHash("sha256").update(canonicalMCPJSON(value)).digest("hex");

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const MCP_CHOICE_KIND = "mcp.choice";
export const MCP_SHARE_PROPOSAL_KIND = "mcp.share_proposal";
export const MCP_SHARE_PROPOSAL_SCOPE_TYPE = "mcp_revision";
export const MCP_OAUTH_FLOW_KIND = "mcp.oauth_flow";
export const CODING_TURN_MCP_KIND = "coding.turn_mcp";
export const CODING_TURN_MCP_SCOPE_TYPE = "agent_turn";

export const mcpChoiceIdempotencyKey = (
  libraryId: string,
  scope: string,
  contextId: string,
  ownerId: string,
  role: string,
) => `${MCP_CHOICE_KIND}:${libraryId}:${scope}:${contextId}:${ownerId}:${role}`;

export const mcpShareProposalIdempotencyKey = (id: string) => `${MCP_SHARE_PROPOSAL_KIND}:${id}`;

export const codingTurnMCPIdempotencyKey = (turnId: string, connectionId: string) =>
  `${CODING_TURN_MCP_KIND}:${turnId}:${connectionId}`;

export type MCPDatabase = ReturnType<typeof createDatabase>;
export type MCPEntry = typeof mcpLibrary.$inferSelect;
export type MCPCapabilities = {
  canManageSystem: boolean;
  canManageProject: boolean;
};

export type MCPConnection = {
  id: string;
  revisionId: string;
  state: "disconnected" | "authorizing" | "review" | "ready" | "reconnect" | "revoked";
  version: number;
  secretKey: string | null;
  credentialEpoch: string;
  tools: MCPTool[];
  allowedTools: Array<{ name: string; digest: string }>;
  authorizedBy: string;
  projectGrants: Record<string, MCPProjectGrantRecord>;
};

export const mcpRevisionFields = {
  id: mcpRevisionTable.id,
  revision: mcpRevisionTable.revision,
  content: mcpRevisionTable.content,
  digest: mcpRevisionTable.digest,
};

export function selectApprovedTools(
  tools: MCPTool[],
  allowed: Array<{ name: string; digest: string }>,
) {
  return tools.filter((tool) =>
    allowed.some((approved) => approved.name === tool.name && approved.digest === tool.digest),
  );
}

export function hasScopeManagerAccess(
  access: MCPCapabilities,
  scope: "personal" | "project" | "system",
  projectId?: string,
) {
  if (scope === "system") return access.canManageSystem;
  if (scope === "project") return Boolean(projectId) && access.canManageProject;
  return true;
}

export async function lockMCPKeyIn(sql: DatabaseTransaction, key: string) {
  await drizzleTransaction(sql).execute(expression`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function isAdministratorIn(sql: DatabaseTransaction, userId: string) {
  const [admin] = await drizzleTransaction(sql)
    .select({ userId: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userId))
    .for("share");
  return Boolean(admin);
}

export async function capabilitiesIn(
  sql: DatabaseTransaction,
  userId: string,
  projectId?: string,
): Promise<MCPCapabilities> {
  await requireActiveAccountIn(sql, userId);
  return {
    canManageSystem: await isAdministratorIn(sql, userId),
    canManageProject: projectId ? await projectAuthorityIn(sql, userId, projectId) : false,
  };
}

export async function entryIn(sql: DatabaseTransaction, id: string): Promise<MCPEntry> {
  const [entry] = await drizzleTransaction(sql)
    .select()
    .from(mcpLibrary)
    .where(eq(mcpLibrary.id, id));
  if (!entry) throw new CommandError("not-found", "MCP library entry not found");
  return entry;
}

export async function canEditIn(sql: DatabaseTransaction, entry: MCPEntry, userId: string) {
  const access = await capabilitiesIn(sql, userId, entry.projectId ?? undefined);
  return entry.scope === "personal"
    ? entry.ownerId === userId
    : entry.scope === "system"
      ? access.canManageSystem
      : access.canManageProject;
}

export async function authorizeIn(sql: DatabaseTransaction, id: string, userId: string) {
  const entry = await entryIn(sql, id);
  if (!(await canEditIn(sql, entry, userId)))
    throw new CommandError("forbidden", "You cannot manage this MCP connection");
  return entry;
}

export async function connectionIn(sql: DatabaseTransaction, id: string): Promise<MCPConnection> {
  const [connection] = await drizzleTransaction(sql)
    .select({
      id: mcpConnection.id,
      revisionId: mcpConnection.revisionId,
      state: mcpConnection.state,
      version: mcpConnection.version,
      secretKey: mcpConnection.secretKey,
      credentialEpoch: mcpConnection.credentialEpoch,
      tools: mcpConnection.tools,
      allowedTools: mcpConnection.allowedTools,
      authorizedBy: mcpConnection.authorizedBy,
      projectGrants: mcpConnection.projectGrants,
    })
    .from(mcpConnection)
    .where(eq(mcpConnection.id, id))
    .for("share");
  if (!connection) throw new CommandError("not-found", "MCP connection not found");
  return {
    ...connection,
    state: connection.state as MCPConnection["state"],
    tools: connection.tools as MCPTool[],
    allowedTools: connection.allowedTools as MCPConnection["allowedTools"],
    projectGrants: (connection.projectGrants ?? {}) as Record<string, MCPProjectGrantRecord>,
  };
}

export async function revisionIn(sql: DatabaseTransaction, id: string) {
  const [revision] = await drizzleTransaction(sql)
    .select({
      ...mcpRevisionFields,
      libraryId: mcpRevisionTable.libraryId,
    })
    .from(mcpRevisionTable)
    .where(eq(mcpRevisionTable.id, id));
  if (!revision) throw new CommandError("not-found", "MCP revision not found");
  return { ...mcpRevision.parse(revision), libraryId: revision.libraryId };
}

export async function usableIn(
  sql: DatabaseTransaction,
  connection: MCPConnection,
  projectId: string,
  userId: string,
) {
  await projectAuthorityIn(sql, userId, projectId);
  await requireActiveAccountIn(sql, connection.authorizedBy);
  const entry = await entryIn(sql, connection.id);
  // Sharing a definition does not share credentials. Even system connections
  // require an explicit grant before Project work can read external data.
  if (entry.scope === "personal") {
    if (entry.ownerId !== userId)
      throw new CommandError("forbidden", "Personal MCP access is private");
  } else if (entry.scope === "project") {
    if (entry.projectId !== projectId)
      throw new CommandError("forbidden", "MCP connection belongs to another Project");
    await projectAuthorityIn(sql, connection.authorizedBy, projectId, true);
  } else {
    const manager = await isAdministratorIn(sql, connection.authorizedBy);
    const grant = connection.projectGrants[projectId];
    if (!manager || !grant || grant.credentialEpoch !== connection.credentialEpoch)
      throw new CommandError(
        "forbidden",
        "This MCP connection has not been granted to the Project",
      );
  }
  if (connection.state !== "ready")
    throw new CommandError("conflict", "Reconnect or review the MCP connection before using it");
}

export async function recordAccessDecisionIn(
  sql: DatabaseTransaction,
  decision: {
    connectionId: string;
    actorId: string;
    credentialEpoch: string;
    projectId: string | null;
    action: "grant" | "revoke" | "disconnect";
  },
) {
  await drizzleTransaction(sql)
    .insert(auditEvent)
    .values({
      id: crypto.randomUUID(),
      kind: "mcp.access_decision",
      scopeType: "connection",
      scopeId: decision.connectionId,
      actorId: decision.actorId,
      payload: {
        credentialEpoch: decision.credentialEpoch,
        projectId: decision.projectId,
        action: decision.action,
      },
    });
}
