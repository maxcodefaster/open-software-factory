import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, max, or, sql as expression } from "drizzle-orm";
import { z } from "zod";
import {
  defaultLibraryCover,
  libraryCoverInput,
} from "../../../../packages/conversation-domain/src/library-covers";
import {
  type MCPAssignment,
  type MCPRole,
  type MCPTool,
  mcpChoiceInput,
  mcpDefinition,
  mcpLibraryView,
  mcpRevision,
  mcpSaveInput,
  mcpTool,
  resolveMCPChoice,
  validateMCPSelection,
} from "../../../../packages/conversation-domain/src/mcp-library";
import {
  type DatabaseTransaction,
  type createDatabase,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  agentTurnMcp,
  mcpAccessDecision,
  mcpChoice as mcpChoiceTable,
  mcpConnection,
  mcpLibrary,
  mcpOauthFlow,
  mcpPolicyApproval,
  mcpProjectGrant,
  mcpRevision as mcpRevisionTable,
  mcpShareProposal,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  initializeLibraryCoverIn,
  libraryCoversIn,
  saveLibraryCoverIn,
} from "../library-covers/store";

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
const nil = "00000000-0000-0000-0000-000000000000";
type Database = ReturnType<typeof createDatabase>;
type Entry = typeof mcpLibrary.$inferSelect;
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
};

export function createMCPLibrary(database: Database) {
  async function capabilities(sql: DatabaseTransaction, userId: string, projectId?: string) {
    await requireActiveAccountIn(sql, userId);
    const [admin] = await drizzleTransaction(sql)
      .select({ userId: administrator.userId })
      .from(administrator)
      .where(eq(administrator.userId, userId))
      .for("share");
    return {
      canManageSystem: Boolean(admin),
      canManageProject: projectId ? await projectAuthorityIn(sql, userId, projectId) : false,
    };
  }
  async function entryIn(sql: DatabaseTransaction, id: string): Promise<Entry> {
    const [entry] = await drizzleTransaction(sql)
      .select()
      .from(mcpLibrary)
      .where(eq(mcpLibrary.id, id));
    if (!entry) throw new CommandError("not-found", "MCP library entry not found");
    return entry;
  }
  async function canEditIn(sql: DatabaseTransaction, entry: Entry, userId: string) {
    const access = await capabilities(sql, userId, entry.projectId ?? undefined);
    return entry.scope === "personal"
      ? entry.ownerId === userId
      : entry.scope === "system"
        ? access.canManageSystem
        : access.canManageProject;
  }
  async function authorizeIn(sql: DatabaseTransaction, id: string, userId: string) {
    const entry = await entryIn(sql, id);
    if (!(await canEditIn(sql, entry, userId)))
      throw new CommandError("forbidden", "You cannot manage this MCP connection");
    return entry;
  }
  async function connectionIn(sql: DatabaseTransaction, id: string): Promise<MCPConnection> {
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
    };
  }
  async function revisionIn(sql: DatabaseTransaction, id: string) {
    const [revision] = await drizzleTransaction(sql)
      .select({
        id: mcpRevisionTable.id,
        libraryId: mcpRevisionTable.libraryId,
        revision: mcpRevisionTable.revision,
        content: mcpRevisionTable.content,
        digest: mcpRevisionTable.digest,
      })
      .from(mcpRevisionTable)
      .where(eq(mcpRevisionTable.id, id));
    if (!revision) throw new CommandError("not-found", "MCP revision not found");
    return { ...mcpRevision.parse(revision), libraryId: revision.libraryId };
  }
  async function viewIn(sql: DatabaseTransaction, userId: string, projectId?: string) {
    const access = await capabilities(sql, userId, projectId);
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
        .select({
          id: mcpRevisionTable.id,
          revision: mcpRevisionTable.revision,
          content: mcpRevisionTable.content,
          digest: mcpRevisionTable.digest,
        })
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
        })
        .from(mcpConnection)
        .where(eq(mcpConnection.id, entry.id));
      const grants = await db
        .select({ id: mcpProjectGrant.projectId })
        .from(mcpProjectGrant)
        .where(
          and(
            eq(mcpProjectGrant.connectionId, entry.id),
            eq(mcpProjectGrant.credentialEpoch, connection?.credentialEpoch ?? nil),
            editable ? undefined : inArray(mcpProjectGrant.projectId, projectId ? [projectId] : []),
          ),
        )
        .orderBy(asc(mcpProjectGrant.projectId));
      const visible =
        editable || entry.projectId === projectId || grants.some((grant) => grant.id === projectId);
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
                projectGrants: grants.map((grant) => grant.id),
                editable,
              }
            : null,
      });
    }
    const choices = await db
      .select({
        libraryId: mcpChoiceTable.libraryId,
        revisionId: mcpChoiceTable.revisionId,
        scope: mcpChoiceTable.scope,
        role: mcpChoiceTable.role,
        state: mcpChoiceTable.state,
        version: mcpChoiceTable.version,
      })
      .from(mcpChoiceTable)
      .where(
        or(
          eq(mcpChoiceTable.scope, "system"),
          and(
            eq(mcpChoiceTable.contextId, projectId ?? nil),
            or(
              eq(mcpChoiceTable.scope, "project"),
              and(eq(mcpChoiceTable.scope, "personal"), eq(mcpChoiceTable.userId, userId)),
            ),
          ),
        ),
      );
    const proposals = await db
      .select({
        id: mcpShareProposal.id,
        target: mcpShareProposal.target,
        projectId: mcpShareProposal.projectId,
        revision: {
          id: mcpRevisionTable.id,
          revision: mcpRevisionTable.revision,
          content: mcpRevisionTable.content,
          digest: mcpRevisionTable.digest,
        },
      })
      .from(mcpShareProposal)
      .innerJoin(mcpRevisionTable, eq(mcpRevisionTable.id, mcpShareProposal.revisionId))
      .where(
        and(
          isNull(mcpShareProposal.acceptedLibraryId),
          or(
            eq(mcpShareProposal.proposedBy, userId),
            access.canManageSystem ? eq(mcpShareProposal.target, "system") : undefined,
            projectId && access.canManageProject
              ? eq(mcpShareProposal.projectId, projectId)
              : undefined,
          ),
        ),
      )
      .orderBy(asc(mcpShareProposal.id));
    return mcpLibraryView.parse({
      ...access,
      entries: result,
      choices: choices.filter((choice) => entries.some((entry) => entry.id === choice.libraryId)),
      proposals,
    });
  }
  async function usableIn(
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
      const db = drizzleTransaction(sql);
      const [manager] = await db
        .select({ userId: administrator.userId })
        .from(administrator)
        .where(eq(administrator.userId, connection.authorizedBy))
        .for("share");
      const [grant] = await db
        .select({ connectionId: mcpProjectGrant.connectionId })
        .from(mcpProjectGrant)
        .where(
          and(
            eq(mcpProjectGrant.connectionId, entry.id),
            eq(mcpProjectGrant.credentialEpoch, connection.credentialEpoch),
            eq(mcpProjectGrant.projectId, projectId),
          ),
        )
        .for("share");
      if (!manager || !grant)
        throw new CommandError(
          "forbidden",
          "This MCP connection has not been granted to the Project",
        );
    }
    if (connection.state !== "ready")
      throw new CommandError("conflict", "Reconnect or review the MCP connection before using it");
  }
  return {
    authorizeIn,
    connectionIn,
    revisionIn,
    usableIn,
    viewIn,
    view: (userId: string, projectId?: string) =>
      database.client.begin((sql) => viewIn(sql, userId, projectId)),
    async save(value: unknown, userId: string) {
      const input = mcpSaveInput.parse(value);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const access = await capabilities(sql, userId, input.projectId);
        if (
          (input.scope === "system" && !access.canManageSystem) ||
          (input.scope === "project" && (!input.projectId || !access.canManageProject))
        )
          throw new CommandError("forbidden", "Manager access is required for shared MCP entries");
        await db.execute(
          expression`SELECT pg_advisory_xact_lock(hashtext(${`mcp-entry:${input.libraryId}`}))`,
        );
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
            throw new CommandError(
              "conflict",
              "MCP save identity was reused with different content",
            );
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
    },
    async cover(value: unknown, userId: string) {
      const input = libraryCoverInput.parse(value);
      return database.client.begin(async (sql) => {
        await drizzleTransaction(sql).execute(
          expression`SELECT pg_advisory_xact_lock(hashtext(${`mcp-entry:${input.libraryId}`}))`,
        );
        await authorizeIn(sql, input.libraryId, userId);
        return saveLibraryCoverIn(sql, "mcp", input, userId);
      });
    },
    async choose(value: unknown, userId: string) {
      const input = mcpChoiceInput.parse(value);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const access = await capabilities(sql, userId, input.projectId);
        if (!input.projectId && input.scope !== "system")
          throw new CommandError("conflict", "Select a Project before choosing MCP connections");
        if (
          (input.scope === "system" && !access.canManageSystem) ||
          (input.scope === "project" && !access.canManageProject) ||
          (input.scope === "personal" && input.state === "required")
        )
          throw new CommandError("forbidden", "You cannot change these MCP defaults");
        const view = await viewIn(sql, userId, input.projectId);
        const entry = view.entries.find((entry) => entry.id === input.libraryId);
        const revision = entry?.revisions.find((revision) => revision.id === input.revisionId);
        if (!entry || !revision) throw new CommandError("not-found", "MCP revision not found");
        if (input.scope !== "personal" && entry.scope === "personal")
          throw new CommandError(
            "conflict",
            "Create a shared definition before setting shared defaults",
          );
        if (input.scope === "system" && entry.scope !== "system")
          throw new CommandError("conflict", "Factory defaults require a Factory-owned entry");
        if (!revision.content.roles.includes(input.role))
          throw new CommandError("conflict", "MCP entry is unavailable for this work type");
        if (input.state === "enable" || input.state === "required") {
          const connection = await connectionIn(sql, input.libraryId);
          if (connection.state !== "ready" || connection.revisionId !== input.revisionId)
            throw new CommandError(
              "conflict",
              "Connect and review this exact MCP version before enabling it",
            );
          if (input.projectId) await usableIn(sql, connection, input.projectId, userId);
        }
        const contextId = input.scope === "system" ? nil : input.projectId;
        if (!contextId) throw new CommandError("conflict", "MCP choices require a Project context");
        const ownerId = input.scope === "personal" ? userId : nil;
        await db.execute(
          expression`SELECT pg_advisory_xact_lock(hashtext(${`mcp-choice:${input.libraryId}:${contextId}:${ownerId}:${input.role}:${input.scope}`}))`,
        );
        const [current] = await db
          .select({ version: mcpChoiceTable.version })
          .from(mcpChoiceTable)
          .where(
            and(
              eq(mcpChoiceTable.libraryId, input.libraryId),
              eq(mcpChoiceTable.scope, input.scope),
              eq(mcpChoiceTable.contextId, contextId),
              eq(mcpChoiceTable.userId, ownerId),
              eq(mcpChoiceTable.role, input.role),
            ),
          );
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "The MCP choice changed. Reload before saving");
        const values = {
          libraryId: input.libraryId,
          scope: input.scope,
          contextId,
          userId: ownerId,
          role: input.role,
          state: input.state,
          revisionId: input.revisionId,
          version: input.expectedVersion + 1,
        };
        await db
          .insert(mcpChoiceTable)
          .values(values)
          .onConflictDoUpdate({
            target: [
              mcpChoiceTable.libraryId,
              mcpChoiceTable.scope,
              mcpChoiceTable.contextId,
              mcpChoiceTable.userId,
              mcpChoiceTable.role,
            ],
            set: { state: values.state, revisionId: values.revisionId, version: values.version },
          });
        return { saved: true };
      });
    },
    async propose(
      id: string,
      revisionId: string,
      target: "project" | "system",
      projectId: string | undefined,
      userId: string,
    ) {
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await requireActiveAccountIn(sql, userId);
        const revision = await revisionIn(sql, revisionId);
        const entry = await authorizeIn(sql, revision.libraryId, userId);
        if (entry.scope !== "personal")
          throw new CommandError("conflict", "Only personal definitions need sharing review");
        if (target === "project") {
          if (!projectId) throw new CommandError("conflict", "Choose a Project for sharing");
          await projectAuthorityIn(sql, userId, projectId);
        }
        const [previous] = await db
          .select({
            revisionId: mcpShareProposal.revisionId,
            target: mcpShareProposal.target,
            projectId: mcpShareProposal.projectId,
            proposedBy: mcpShareProposal.proposedBy,
          })
          .from(mcpShareProposal)
          .where(eq(mcpShareProposal.id, id));
        if (previous) {
          if (
            previous.revisionId !== revisionId ||
            previous.target !== target ||
            previous.projectId !== (target === "project" ? projectId : null) ||
            previous.proposedBy !== userId
          )
            throw new CommandError("conflict", "Sharing identity was reused");
          return;
        }
        await db.insert(mcpShareProposal).values({
          id,
          revisionId,
          proposedBy: userId,
          target,
          projectId: target === "project" ? (projectId ?? null) : null,
        });
      });
      return { saved: true };
    },
    async accept(id: string, userId: string) {
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [proposal] = await db
          .select({
            revisionId: mcpShareProposal.revisionId,
            target: mcpShareProposal.target,
            projectId: mcpShareProposal.projectId,
            accepted: mcpShareProposal.acceptedLibraryId,
          })
          .from(mcpShareProposal)
          .where(eq(mcpShareProposal.id, id))
          .for("update");
        if (!proposal) throw new CommandError("not-found", "MCP sharing proposal not found");
        const access = await capabilities(sql, userId, proposal.projectId ?? undefined);
        if (proposal.target === "system" ? !access.canManageSystem : !access.canManageProject)
          throw new CommandError(
            "forbidden",
            "Manager access is required to accept shared definitions",
          );
        if (proposal.accepted) return { libraryId: proposal.accepted };
        const revision = await revisionIn(sql, proposal.revisionId);
        const libraryId = crypto.randomUUID();
        await db.insert(mcpLibrary).values({
          id: libraryId,
          scope: proposal.target,
          projectId: proposal.projectId,
        });
        const cover = (await libraryCoversIn(sql, "mcp", [revision.libraryId])).get(
          revision.libraryId,
        );
        if (cover || revision.content.provider === "custom")
          await initializeLibraryCoverIn(
            sql,
            "mcp",
            libraryId,
            cover?.key ?? defaultLibraryCover(libraryId),
            userId,
          );
        await db.insert(mcpRevisionTable).values({
          id: crypto.randomUUID(),
          libraryId,
          revision: 1,
          content: revision.content,
          digest: revision.digest,
          createdBy: userId,
        });
        await db
          .update(mcpShareProposal)
          .set({
            acceptedLibraryId: libraryId,
            acceptedBy: userId,
            acceptedAt: expression<Date>`now()`,
          })
          .where(eq(mcpShareProposal.id, id));
        return { libraryId };
      });
    },
    async review(
      id: string,
      userId: string,
      version: number,
      selected: Array<{ name: string; digest: string }>,
    ) {
      await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await authorizeIn(sql, id, userId);
        await db.execute(
          expression`SELECT pg_advisory_xact_lock(hashtext(${`mcp-connect:${id}`}))`,
        );
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
        await db.insert(mcpPolicyApproval).values({
          id: crypto.randomUUID(),
          connectionId: id,
          revisionId: connection.revisionId,
          credentialEpoch: connection.credentialEpoch,
          version: connection.version + 1,
          tools: connection.tools.filter((tool) =>
            selected.some(
              (approved) => approved.name === tool.name && approved.digest === tool.digest,
            ),
          ),
          reviewedBy: userId,
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
    },
    async grant(
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
        const connection = await connectionIn(sql, id);
        if (enabled && (connection.state !== "ready" || connection.version !== expectedVersion))
          throw new CommandError(
            "conflict",
            "Review the current connection before granting Project access",
          );
        if (enabled)
          await db
            .insert(mcpProjectGrant)
            .values({
              connectionId: id,
              credentialEpoch: connection.credentialEpoch,
              projectId,
              grantedBy: userId,
            })
            .onConflictDoUpdate({
              target: [mcpProjectGrant.connectionId, mcpProjectGrant.projectId],
              set: {
                credentialEpoch: connection.credentialEpoch,
                grantedBy: userId,
                grantedAt: expression<Date>`now()`,
              },
            });
        else
          await db
            .delete(mcpProjectGrant)
            .where(
              and(eq(mcpProjectGrant.connectionId, id), eq(mcpProjectGrant.projectId, projectId)),
            );
        await db.insert(mcpAccessDecision).values({
          id: crypto.randomUUID(),
          connectionId: id,
          credentialEpoch: connection.credentialEpoch,
          projectId,
          action: enabled ? "grant" : "revoke",
          decidedBy: userId,
        });
      });
      return { saved: true };
    },
    async disconnect(id: string, userId: string) {
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
          .update(mcpOauthFlow)
          .set({ state: "failed" })
          .where(
            and(
              eq(mcpOauthFlow.connectionId, id),
              inArray(mcpOauthFlow.state, ["pending", "exchanging"]),
            ),
          );
        const [connection] = await db
          .select({ epoch: mcpConnection.credentialEpoch })
          .from(mcpConnection)
          .where(eq(mcpConnection.id, id));
        if (connection)
          await db.insert(mcpAccessDecision).values({
            id: crypto.randomUUID(),
            connectionId: id,
            credentialEpoch: connection.epoch,
            action: "disconnect",
            decidedBy: userId,
          });
      });
      return { saved: true };
    },
    async admitIn(
      sql: DatabaseTransaction,
      turnId: string,
      projectId: string,
      userId: string,
      role: MCPRole,
      personal = true,
    ) {
      const view = await viewIn(sql, userId, projectId);
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
          .insert(agentTurnMcp)
          .values({
            turnId,
            connectionId: full.id,
            credentialEpoch: full.credentialEpoch,
            revisionId: full.revisionId,
            policyVersion: full.version,
            tools: full.tools.filter((tool) =>
              full.allowedTools.some(
                (approved) => approved.name === tool.name && approved.digest === tool.digest,
              ),
            ),
            required: choice.state === "required",
          })
          .onConflictDoNothing();
      }
    },
    async assignments(turnId: string): Promise<MCPAssignment[]> {
      const rows = await database.db
        .select({
          connectionId: agentTurnMcp.connectionId,
          credentialEpoch: agentTurnMcp.credentialEpoch,
          revisionId: agentTurnMcp.revisionId,
          policyVersion: agentTurnMcp.policyVersion,
          tools: agentTurnMcp.tools,
          required: agentTurnMcp.required,
        })
        .from(agentTurnMcp)
        .where(eq(agentTurnMcp.turnId, turnId))
        .orderBy(asc(agentTurnMcp.connectionId));
      return rows.map((row) => ({ ...row, tools: row.tools as MCPTool[] }));
    },
  };
}
