import { and, asc, desc, eq, sql as expression, max, or } from "drizzle-orm";
import { defaultLibraryCover, libraryCoverInput } from "#conversation-domain/library-covers";
import {
  mcpDefinition,
  mcpLibraryView,
  mcpRevision,
  mcpSaveInput,
} from "#conversation-domain/mcp-library";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  type MCPProjectGrantRecord,
  mcpConnection,
  mcpLibrary,
  mcpRevision as mcpRevisionTable,
  operation,
} from "#db/schema";
import { CommandError } from "../command-error";
import {
  initializeLibraryCoverIn,
  libraryCoversIn,
  saveLibraryCoverIn,
} from "../library-covers/api";
import {
  authorizeIn,
  canEditIn,
  capabilitiesIn,
  hasScopeManagerAccess,
  lockMCPKeyIn,
  MCP_CHOICE_KIND,
  MCP_SHARE_PROPOSAL_KIND,
  MCP_SHARE_PROPOSAL_SCOPE_TYPE,
  type MCPConnection,
  type MCPDatabase,
  mcpDigest,
  mcpRevisionFields,
  NIL_UUID,
} from "./controller-types";

export async function viewMCPLibraryIn(
  sql: DatabaseTransaction,
  userId: string,
  projectId?: string,
) {
  const access = await capabilitiesIn(sql, userId, projectId);
  const db = drizzleTransaction(sql);
  const entries = await db
    .select()
    .from(mcpLibrary)
    .where(
      or(
        eq(mcpLibrary.scope, "system"),
        eq(mcpLibrary.ownerId, userId),
        projectId ? eq(mcpLibrary.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(mcpLibrary.scope), asc(mcpLibrary.id));
  const result = [];
  const covers = await libraryCoversIn(
    sql,
    "mcp",
    entries.map((entry) => entry.id),
  );
  for (const entry of entries) {
    const editable = await canEditIn(sql, entry, userId);
    const revisions = await db
      .select(mcpRevisionFields)
      .from(mcpRevisionTable)
      .where(eq(mcpRevisionTable.libraryId, entry.id))
      .orderBy(desc(mcpRevisionTable.revision));
    const [connection] = await db
      .select({
        id: mcpConnection.id,
        revisionId: mcpConnection.revisionId,
        state: mcpConnection.state,
        version: mcpConnection.version,
        credentialEpoch: mcpConnection.credentialEpoch,
        tools: mcpConnection.tools,
        allowedTools: mcpConnection.allowedTools,
        projectGrants: mcpConnection.projectGrants,
      })
      .from(mcpConnection)
      .where(eq(mcpConnection.id, entry.id));
    const rawGrants = (connection?.projectGrants ?? {}) as Record<string, MCPProjectGrantRecord>;
    const grants = Object.entries(rawGrants)
      .filter(
        ([grantProjectId, grant]) =>
          grant.credentialEpoch === (connection?.credentialEpoch ?? NIL_UUID) &&
          (editable || (projectId !== undefined && grantProjectId === projectId)),
      )
      .map(([grantProjectId]) => grantProjectId)
      .sort();
    const visible =
      editable ||
      entry.projectId === projectId ||
      (projectId !== undefined && grants.includes(projectId));
    result.push({
      ...entry,
      cover: covers.get(entry.id) ?? null,
      editable,
      revisions: revisions.map((revision) => mcpRevision.parse(revision)),
      connection:
        connection && visible
          ? {
              ...connection,
              allowedTools: (connection.allowedTools as MCPConnection["allowedTools"]).map(
                (tool) => tool.name,
              ),
              projectGrants: grants,
              editable,
            }
          : null,
    });
  }
  const choices = await db
    .select({
      libraryId: expression<string>`${operation.payload}->>'libraryId'`,
      revisionId: expression<string>`${operation.payload}->>'revisionId'`,
      scope: operation.scopeType,
      role: expression<"planning" | "build">`${operation.payload}->>'role'`,
      state: operation.state,
      version: expression<number>`(${operation.payload}->>'version')::bigint::float8`,
    })
    .from(operation)
    .where(
      and(
        eq(operation.kind, MCP_CHOICE_KIND),
        or(
          eq(operation.scopeType, "system"),
          and(
            eq(operation.scopeId, projectId ?? NIL_UUID),
            or(
              eq(operation.scopeType, "project"),
              and(
                eq(operation.scopeType, "personal"),
                eq(expression<string>`${operation.payload}->>'userId'`, userId),
              ),
            ),
          ),
        ),
      ),
    );
  const proposals = await db
    .select({
      id: operation.id,
      target: expression<"project" | "system">`${operation.payload}->>'target'`,
      projectId: expression<string | null>`${operation.payload}->>'projectId'`,
      revision: mcpRevisionFields,
    })
    .from(operation)
    .innerJoin(
      mcpRevisionTable,
      eq(expression<string>`${mcpRevisionTable.id}::text`, operation.scopeId),
    )
    .where(
      and(
        eq(operation.kind, MCP_SHARE_PROPOSAL_KIND),
        eq(operation.scopeType, MCP_SHARE_PROPOSAL_SCOPE_TYPE),
        eq(operation.state, "proposed"),
        or(
          eq(expression<string>`${operation.payload}->>'proposedBy'`, userId),
          access.canManageSystem
            ? eq(expression<string>`${operation.payload}->>'target'`, "system")
            : undefined,
          projectId && access.canManageProject
            ? eq(expression<string>`${operation.payload}->>'projectId'`, projectId)
            : undefined,
        ),
      ),
    )
    .orderBy(asc(operation.id));
  return mcpLibraryView.parse({
    ...access,
    entries: result,
    choices: choices.filter((choice) => entries.some((entry) => entry.id === choice.libraryId)),
    proposals,
  });
}

export async function saveMCPLibraryEntry(database: MCPDatabase, value: unknown, userId: string) {
  const input = mcpSaveInput.parse(value);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const access = await capabilitiesIn(sql, userId, input.projectId);
    if (!hasScopeManagerAccess(access, input.scope, input.projectId))
      throw new CommandError("forbidden", "Manager access is required for shared MCP entries");
    await lockMCPKeyIn(sql, `mcp-entry:${input.libraryId}`);
    const [old] = await db.select().from(mcpLibrary).where(eq(mcpLibrary.id, input.libraryId));
    if (old) {
      await authorizeIn(sql, old.id, userId);
      if (
        old.scope !== input.scope ||
        old.projectId !== (input.scope === "project" ? input.projectId : null)
      )
        throw new CommandError(
          "conflict",
          "MCP ownership cannot change; create a separate shared definition",
        );
    } else {
      await db.insert(mcpLibrary).values({
        id: input.libraryId,
        scope: input.scope,
        ownerId: input.scope === "personal" ? userId : null,
        projectId: input.scope === "project" ? (input.projectId ?? null) : null,
      });
      if (input.content.provider === "custom")
        await initializeLibraryCoverIn(
          sql,
          "mcp",
          input.libraryId,
          defaultLibraryCover(input.libraryId),
          userId,
        );
    }
    const content = mcpDefinition.parse(input.content);
    const digest = mcpDigest(content);
    const [replay] = await db
      .select({ digest: mcpRevisionTable.digest, libraryId: mcpRevisionTable.libraryId })
      .from(mcpRevisionTable)
      .where(eq(mcpRevisionTable.id, input.revisionId));
    if (replay) {
      if (replay.digest !== digest || replay.libraryId !== input.libraryId)
        throw new CommandError("conflict", "MCP save identity was reused with different content");
      return { saved: true };
    }
    const [latest] = await db
      .select({ revision: max(mcpRevisionTable.revision) })
      .from(mcpRevisionTable)
      .where(eq(mcpRevisionTable.libraryId, input.libraryId));
    if ((latest?.revision ?? 0) !== input.expectedRevision)
      throw new CommandError("conflict", "The MCP entry changed. Reload before saving");
    await db.insert(mcpRevisionTable).values({
      id: input.revisionId,
      libraryId: input.libraryId,
      revision: input.expectedRevision + 1,
      content,
      digest,
      createdBy: userId,
    });
    return { saved: true };
  });
}

export async function saveMCPLibraryCover(database: MCPDatabase, value: unknown, userId: string) {
  const input = libraryCoverInput.parse(value);
  return database.client.begin(async (sql) => {
    await lockMCPKeyIn(sql, `mcp-entry:${input.libraryId}`);
    await authorizeIn(sql, input.libraryId, userId);
    return saveLibraryCoverIn(sql, "mcp", input, userId);
  });
}
