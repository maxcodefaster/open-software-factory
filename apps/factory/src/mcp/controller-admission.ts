import { and, asc, eq, sql as expression, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  type MCPAssignment,
  type MCPRole,
  type MCPTool,
  mcpTool,
  resolveMCPChoice,
  validateMCPSelection,
} from "#conversation-domain/mcp-library";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { auditEvent, type MCPProjectGrantRecord, mcpConnection, operation } from "#db/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { viewMCPLibraryIn } from "./controller-library";
import {
  authorizeIn,
  CODING_TURN_MCP_KIND,
  CODING_TURN_MCP_SCOPE_TYPE,
  codingTurnMCPIdempotencyKey,
  connectionIn,
  lockMCPKeyIn,
  MCP_OAUTH_FLOW_KIND,
  type MCPDatabase,
  recordAccessDecisionIn,
  selectApprovedTools,
  usableIn,
} from "./controller-types";

export async function reviewMCPConnection(
  database: MCPDatabase,
  id: string,
  userId: string,
  version: number,
  selected: Array<{ name: string; digest: string }>,
) {
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await authorizeIn(sql, id, userId);
    await lockMCPKeyIn(sql, `mcp-connect:${id}`);
    const connection = await connectionIn(sql, id);
    if (connection.version !== version || !["review", "ready"].includes(connection.state))
      throw new CommandError("conflict", "Reconnect and review the current MCP tools");
    try {
      validateMCPSelection(z.array(mcpTool).parse(connection.tools), selected);
    } catch (cause) {
      throw new CommandError(
        "conflict",
        cause instanceof Error ? cause.message : "Review the current MCP tool contracts",
      );
    }
    await db.insert(auditEvent).values({
      id: crypto.randomUUID(),
      kind: "mcp.policy_approval",
      scopeType: "connection",
      scopeId: id,
      dedupeKey: `mcp.policy_approval:${id}:${connection.version + 1}`,
      actorId: userId,
      payload: {
        revisionId: connection.revisionId,
        credentialEpoch: connection.credentialEpoch,
        version: connection.version + 1,
        tools: selectApprovedTools(connection.tools, selected),
      },
    });
    await db
      .update(mcpConnection)
      .set({
        state: "ready",
        allowedTools: selected,
        version: expression<number>`${mcpConnection.version}+1`,
        updatedAt: expression<Date>`now()`,
      })
      .where(eq(mcpConnection.id, id));
  });
  return { saved: true };
}

export async function grantMCPConnection(
  database: MCPDatabase,
  id: string,
  projectId: string,
  userId: string,
  enabled: boolean,
  expectedVersion: number,
) {
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const entry = await authorizeIn(sql, id, userId);
    if (entry.scope !== "system")
      throw new CommandError(
        "conflict",
        "Only Factory-owned connections may be granted to other Projects",
      );
    await projectAuthorityIn(sql, userId, projectId, true);
    const [connection] = await db
      .select({
        state: mcpConnection.state,
        version: mcpConnection.version,
        credentialEpoch: mcpConnection.credentialEpoch,
      })
      .from(mcpConnection)
      .where(eq(mcpConnection.id, id))
      .for("update");
    if (!connection) throw new CommandError("not-found", "MCP connection not found");
    if (enabled && (connection.state !== "ready" || connection.version !== expectedVersion))
      throw new CommandError(
        "conflict",
        "Review the current connection before granting Project access",
      );
    if (enabled) {
      const grantPayload: MCPProjectGrantRecord = {
        credentialEpoch: connection.credentialEpoch,
        grantedBy: userId,
        grantedAt: new Date().toISOString(),
      };
      await db
        .update(mcpConnection)
        .set({
          projectGrants: expression<
            Record<string, MCPProjectGrantRecord>
          >`jsonb_set(${mcpConnection.projectGrants}, ARRAY[${projectId}::text], ${JSON.stringify(grantPayload)}::jsonb, true)`,
        })
        .where(eq(mcpConnection.id, id));
    } else {
      await db
        .update(mcpConnection)
        .set({
          projectGrants: expression<
            Record<string, MCPProjectGrantRecord>
          >`${mcpConnection.projectGrants} - ${projectId}::text`,
        })
        .where(eq(mcpConnection.id, id));
    }
    await recordAccessDecisionIn(sql, {
      connectionId: id,
      actorId: userId,
      credentialEpoch: connection.credentialEpoch,
      projectId,
      action: enabled ? "grant" : "revoke",
    });
  });
  return { saved: true };
}

export async function disconnectMCPConnection(database: MCPDatabase, id: string, userId: string) {
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await authorizeIn(sql, id, userId);
    await db
      .update(mcpConnection)
      .set({
        state: "revoked",
        secretKey: null,
        allowedTools: [],
        version: expression<number>`${mcpConnection.version}+1`,
        updatedAt: expression<Date>`now()`,
      })
      .where(eq(mcpConnection.id, id));
    await db
      .update(operation)
      .set({
        state: "failed",
        updatedAt: expression<Date>`now()`,
        completedAt: expression<Date>`now()`,
      })
      .where(
        and(
          eq(operation.kind, MCP_OAUTH_FLOW_KIND),
          eq(operation.scopeType, "connection"),
          eq(operation.scopeId, id),
          inArray(operation.state, ["pending", "exchanging"]),
        ),
      );
    const [connection] = await db
      .select({ epoch: mcpConnection.credentialEpoch })
      .from(mcpConnection)
      .where(eq(mcpConnection.id, id));
    if (connection)
      await recordAccessDecisionIn(sql, {
        connectionId: id,
        actorId: userId,
        credentialEpoch: connection.epoch,
        projectId: null,
        action: "disconnect",
      });
  });
  return { saved: true };
}

export async function admitMCPTurnIn(
  sql: DatabaseTransaction,
  turnId: string,
  projectId: string,
  userId: string,
  role: MCPRole,
  personal = true,
) {
  const view = await viewMCPLibraryIn(sql, userId, projectId);
  for (const entry of view.entries) {
    const choice = resolveMCPChoice(view.choices, entry.id, role, personal);
    if (!choice || choice.state === "disable") continue;
    const connection = entry.connection;
    if (
      !connection ||
      connection.revisionId !== choice.revisionId ||
      connection.state !== "ready"
    ) {
      if (choice.state === "required")
        throw new CommandError(
          "conflict",
          `Required MCP connection "${entry.revisions[0]?.content.name}" is unavailable`,
        );
      continue;
    }
    const full = await connectionIn(sql, connection.id);
    await usableIn(sql, full, projectId, userId);
    await drizzleTransaction(sql)
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: CODING_TURN_MCP_KIND,
        scopeType: CODING_TURN_MCP_SCOPE_TYPE,
        scopeId: turnId,
        idempotencyKey: codingTurnMCPIdempotencyKey(turnId, full.id),
        activeKey: null,
        state: "bound",
        payload: {
          turnId,
          connectionId: full.id,
          credentialEpoch: full.credentialEpoch,
          revisionId: full.revisionId,
          policyVersion: full.version,
          tools: selectApprovedTools(full.tools, full.allowedTools),
          required: choice.state === "required",
        },
      })
      .onConflictDoNothing({ target: operation.idempotencyKey });
  }
}

export async function listMCPTurnAssignments(
  database: MCPDatabase,
  turnId: string,
): Promise<MCPAssignment[]> {
  return database.db
    .select({
      connectionId: expression<string>`${operation.payload}->>'connectionId'`,
      credentialEpoch: expression<string>`${operation.payload}->>'credentialEpoch'`,
      revisionId: expression<string>`${operation.payload}->>'revisionId'`,
      policyVersion: expression<number>`(${operation.payload}->>'policyVersion')::bigint::float8`,
      tools: expression<MCPTool[]>`${operation.payload}->'tools'`,
      required: expression<boolean>`(${operation.payload}->>'required')::boolean`,
    })
    .from(operation)
    .where(
      and(
        eq(operation.kind, CODING_TURN_MCP_KIND),
        eq(operation.scopeType, CODING_TURN_MCP_SCOPE_TYPE),
        eq(operation.scopeId, turnId),
      ),
    )
    .orderBy(asc(expression`${operation.payload}->>'connectionId'`));
}
