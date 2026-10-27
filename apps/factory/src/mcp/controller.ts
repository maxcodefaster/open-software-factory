import { createHash } from "node:crypto";
import { z } from "zod";
import {
  mcpChoiceInput,
  mcpDefinition,
  mcpLibraryView,
  mcpRevision,
  mcpSaveInput,
  mcpTool,
  resolveMCPChoice,
  validateMCPSelection,
  type MCPAssignment,
  type MCPChoice,
  type MCPRole,
  type MCPTool,
} from "../../../../packages/conversation-domain/src/mcp-library";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import {
  defaultLibraryCover,
  libraryCoverInput,
} from "../../../../packages/conversation-domain/src/library-covers";
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
type Entry = {
  id: string;
  scope: "personal" | "project" | "system";
  ownerId: string | null;
  projectId: string | null;
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
};

export function createMCPLibrary(database: Database) {
  async function capabilities(sql: AgentTurnTransaction, userId: string, projectId?: string) {
    await requireActiveAccountIn(sql, userId);
    const [admin] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userId} FOR SHARE`;
    return {
      canManageSystem: Boolean(admin),
      canManageProject: projectId ? await projectAuthorityIn(sql, userId, projectId) : false,
    };
  }
  async function entryIn(sql: AgentTurnTransaction, id: string): Promise<Entry> {
    const [entry] = await sql<
      Entry[]
    >`SELECT id,scope,owner_id AS "ownerId",project_id AS "projectId" FROM factory.mcp_library WHERE id=${id}`;
    if (!entry) throw new CommandError("not-found", "MCP library entry not found");
    return entry;
  }
  async function canEditIn(sql: AgentTurnTransaction, entry: Entry, userId: string) {
    const access = await capabilities(sql, userId, entry.projectId ?? undefined);
    return entry.scope === "personal"
      ? entry.ownerId === userId
      : entry.scope === "system"
        ? access.canManageSystem
        : access.canManageProject;
  }
  async function authorizeIn(sql: AgentTurnTransaction, id: string, userId: string) {
    const entry = await entryIn(sql, id);
    if (!(await canEditIn(sql, entry, userId)))
      throw new CommandError("forbidden", "You cannot manage this MCP connection");
    return entry;
  }
  async function connectionIn(sql: AgentTurnTransaction, id: string) {
    const [connection] = await sql<MCPConnection[]>`SELECT id,revision_id AS "revisionId",state,
      version::float8 AS version,secret_key AS "secretKey",credential_epoch AS "credentialEpoch",tools,allowed_tools AS "allowedTools",
      authorized_by AS "authorizedBy" FROM factory.mcp_connection WHERE id=${id} FOR SHARE`;
    if (!connection) throw new CommandError("not-found", "MCP connection not found");
    return connection;
  }
  async function revisionIn(sql: AgentTurnTransaction, id: string) {
    const [revision] =
      await sql`SELECT id,library_id AS "libraryId",revision::float8 AS revision,content,digest
      FROM factory.mcp_revision WHERE id=${id}`;
    if (!revision) throw new CommandError("not-found", "MCP revision not found");
    return { ...mcpRevision.parse(revision), libraryId: String(revision["libraryId"]) };
  }
  async function viewIn(sql: AgentTurnTransaction, userId: string, projectId?: string) {
    const access = await capabilities(sql, userId, projectId);
    const entries = await sql<
      Entry[]
    >`SELECT id,scope,owner_id AS "ownerId",project_id AS "projectId"
      FROM factory.mcp_library WHERE scope='system' OR owner_id=${userId} OR project_id=${projectId ?? null}
      ORDER BY scope,id`;
    const result = [];
    const covers = await libraryCoversIn(
      sql,
      "mcp",
      entries.map((entry) => entry.id),
    );
    for (const entry of entries) {
      const editable = await canEditIn(sql, entry, userId);
      const revisions =
        await sql`SELECT id,revision::float8 AS revision,content,digest FROM factory.mcp_revision
        WHERE library_id=${entry.id} ORDER BY revision DESC`;
      const [connection] = await sql<MCPConnection[]>`SELECT id,revision_id AS "revisionId",state,
        version::float8 AS version,credential_epoch AS "credentialEpoch",tools,allowed_tools AS "allowedTools" FROM factory.mcp_connection WHERE id=${entry.id}`;
      const grants = await sql<
        Array<{ id: string }>
      >`SELECT project_id AS id FROM factory.mcp_project_grant
        WHERE connection_id=${entry.id} AND credential_epoch=${connection?.credentialEpoch ?? nil}
          AND (${editable} OR project_id=${projectId ?? null}) ORDER BY project_id`;
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
                allowedTools: connection.allowedTools.map((tool) => tool.name),
                projectGrants: grants.map((grant) => grant.id),
                editable,
              }
            : null,
      });
    }
    const choices = await sql<
      MCPChoice[]
    >`SELECT library_id AS "libraryId",revision_id AS "revisionId",scope,role,state,version::float8 AS version
      FROM factory.mcp_choice WHERE scope='system' OR
      (context_id=${projectId ?? nil} AND (scope='project' OR (scope='personal' AND user_id=${userId})))`;
    const proposals =
      await sql`SELECT proposal.id,proposal.target,proposal.project_id AS "projectId",
      jsonb_build_object('id',revision.id,'revision',revision.revision,'content',revision.content,'digest',revision.digest) AS revision
      FROM factory.mcp_share_proposal proposal JOIN factory.mcp_revision revision ON revision.id=proposal.revision_id
      WHERE proposal.accepted_library_id IS NULL AND
      (proposal.proposed_by=${userId} OR (proposal.target='system' AND ${access.canManageSystem})
        OR (proposal.project_id=${projectId ?? null} AND ${access.canManageProject})) ORDER BY proposal.id`;
    return mcpLibraryView.parse({
      ...access,
      entries: result,
      choices: choices.filter((choice) => entries.some((entry) => entry.id === choice.libraryId)),
      proposals,
    });
  }
  async function usableIn(
    sql: AgentTurnTransaction,
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
      const [manager] =
        await sql`SELECT user_id FROM factory.administrator WHERE user_id=${connection.authorizedBy} FOR SHARE`;
      const [grant] = await sql`SELECT connection_id FROM factory.mcp_project_grant
        WHERE connection_id=${entry.id} AND credential_epoch=${connection.credentialEpoch} AND project_id=${projectId} FOR SHARE`;
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
        const access = await capabilities(sql, userId, input.projectId);
        if (
          (input.scope === "system" && !access.canManageSystem) ||
          (input.scope === "project" && (!input.projectId || !access.canManageProject))
        )
          throw new CommandError("forbidden", "Manager access is required for shared MCP entries");
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-entry:${input.libraryId}`}))`;
        const [old] = await sql<
          Entry[]
        >`SELECT id,scope,owner_id AS "ownerId",project_id AS "projectId"
          FROM factory.mcp_library WHERE id=${input.libraryId}`;
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
          await sql`INSERT INTO factory.mcp_library(id,scope,owner_id,project_id)
            VALUES(${input.libraryId},${input.scope},${input.scope === "personal" ? userId : null},
              ${input.scope === "project" ? (input.projectId ?? null) : null})`;
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
        const [replay] =
          await sql`SELECT digest,library_id AS "libraryId" FROM factory.mcp_revision WHERE id=${input.revisionId}`;
        if (replay) {
          if (replay["digest"] !== digest || replay["libraryId"] !== input.libraryId)
            throw new CommandError(
              "conflict",
              "MCP save identity was reused with different content",
            );
          return { saved: true };
        }
        const [latest] =
          await sql`SELECT COALESCE(max(revision),0)::float8 AS revision FROM factory.mcp_revision WHERE library_id=${input.libraryId}`;
        if (latest?.["revision"] !== input.expectedRevision)
          throw new CommandError("conflict", "The MCP entry changed. Reload before saving");
        await sql`INSERT INTO factory.mcp_revision(id,library_id,revision,content,digest,created_by)
          VALUES(${input.revisionId},${input.libraryId},${input.expectedRevision + 1},${JSON.stringify(content)}::jsonb,${digest},${userId})`;
        return { saved: true };
      });
    },
    async cover(value: unknown, userId: string) {
      const input = libraryCoverInput.parse(value);
      return database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-entry:${input.libraryId}`}))`;
        await authorizeIn(sql, input.libraryId, userId);
        return saveLibraryCoverIn(sql, "mcp", input, userId);
      });
    },
    async choose(value: unknown, userId: string) {
      const input = mcpChoiceInput.parse(value);
      return database.client.begin(async (sql) => {
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
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-choice:${input.libraryId}:${contextId}:${ownerId}:${input.role}:${input.scope}`}))`;
        const [current] = await sql`SELECT version::float8 AS version FROM factory.mcp_choice
          WHERE library_id=${input.libraryId} AND scope=${input.scope} AND context_id=${contextId} AND user_id=${ownerId} AND role=${input.role}`;
        if ((current?.["version"] ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "The MCP choice changed. Reload before saving");
        await sql`INSERT INTO factory.mcp_choice(library_id,scope,context_id,user_id,role,state,revision_id,version)
          VALUES(${input.libraryId},${input.scope},${contextId},${ownerId},${input.role},${input.state},${input.revisionId},${input.expectedVersion + 1})
          ON CONFLICT(library_id,scope,context_id,user_id,role) DO UPDATE SET
          state=EXCLUDED.state,revision_id=EXCLUDED.revision_id,version=EXCLUDED.version`;
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
        await requireActiveAccountIn(sql, userId);
        const revision = await revisionIn(sql, revisionId);
        const entry = await authorizeIn(sql, revision.libraryId, userId);
        if (entry.scope !== "personal")
          throw new CommandError("conflict", "Only personal definitions need sharing review");
        if (target === "project") {
          if (!projectId) throw new CommandError("conflict", "Choose a Project for sharing");
          await projectAuthorityIn(sql, userId, projectId);
        }
        const [previous] =
          await sql`SELECT revision_id,target,project_id,proposed_by FROM factory.mcp_share_proposal WHERE id=${id}`;
        if (previous) {
          if (
            previous["revision_id"] !== revisionId ||
            previous["target"] !== target ||
            previous["project_id"] !== (target === "project" ? projectId : null) ||
            previous["proposed_by"] !== userId
          )
            throw new CommandError("conflict", "Sharing identity was reused");
          return;
        }
        await sql`INSERT INTO factory.mcp_share_proposal(id,revision_id,proposed_by,target,project_id)
          VALUES(${id},${revisionId},${userId},${target},${target === "project" ? (projectId ?? null) : null})`;
      });
      return { saved: true };
    },
    async accept(id: string, userId: string) {
      return database.client.begin(async (sql) => {
        const [proposal] = await sql<
          Array<{
            revisionId: string;
            target: "project" | "system";
            projectId: string | null;
            accepted: string | null;
          }>
        >`
          SELECT revision_id AS "revisionId",target,project_id AS "projectId",accepted_library_id AS accepted
          FROM factory.mcp_share_proposal WHERE id=${id} FOR UPDATE`;
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
        await sql`INSERT INTO factory.mcp_library(id,scope,project_id) VALUES(${libraryId},${proposal.target},${proposal.projectId})`;
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
        await sql`INSERT INTO factory.mcp_revision(id,library_id,revision,content,digest,created_by)
          VALUES(${crypto.randomUUID()},${libraryId},1,${JSON.stringify(revision.content)}::jsonb,${revision.digest},${userId})`;
        await sql`UPDATE factory.mcp_share_proposal SET accepted_library_id=${libraryId},accepted_by=${userId},accepted_at=now() WHERE id=${id}`;
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
        await authorizeIn(sql, id, userId);
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-connect:${id}`}))`;
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
        await sql`INSERT INTO factory.mcp_policy_approval(id,connection_id,revision_id,credential_epoch,version,tools,reviewed_by)
          VALUES(${crypto.randomUUID()},${id},${connection.revisionId},${connection.credentialEpoch},${connection.version + 1},${JSON.stringify(connection.tools.filter((tool) => selected.some((approved) => approved.name === tool.name && approved.digest === tool.digest)))}::jsonb,${userId})`;
        await sql`UPDATE factory.mcp_connection SET state='ready',allowed_tools=${JSON.stringify(selected)}::jsonb,
          version=version+1,updated_at=now() WHERE id=${id}`;
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
          await sql`INSERT INTO factory.mcp_project_grant(connection_id,credential_epoch,project_id,granted_by)
            VALUES(${id},${connection.credentialEpoch},${projectId},${userId})
            ON CONFLICT(connection_id,project_id) DO UPDATE SET credential_epoch=EXCLUDED.credential_epoch,
              granted_by=EXCLUDED.granted_by,granted_at=now()`;
        else
          await sql`DELETE FROM factory.mcp_project_grant WHERE connection_id=${id} AND project_id=${projectId}`;
        await sql`INSERT INTO factory.mcp_access_decision(id,connection_id,credential_epoch,project_id,action,decided_by)
          VALUES(${crypto.randomUUID()},${id},${connection.credentialEpoch},${projectId},${enabled ? "grant" : "revoke"},${userId})`;
      });
      return { saved: true };
    },
    async disconnect(id: string, userId: string) {
      await database.client.begin(async (sql) => {
        await authorizeIn(sql, id, userId);
        await sql`UPDATE factory.mcp_connection SET state='revoked',secret_key=NULL,allowed_tools='[]',version=version+1,updated_at=now() WHERE id=${id}`;
        await sql`UPDATE factory.mcp_oauth_flow SET state='failed' WHERE connection_id=${id} AND state IN ('pending','exchanging')`;
        const [connection] = await sql<
          Array<{ epoch: string }>
        >`SELECT credential_epoch AS epoch FROM factory.mcp_connection WHERE id=${id}`;
        if (connection)
          await sql`INSERT INTO factory.mcp_access_decision(id,connection_id,credential_epoch,action,decided_by)
            VALUES(${crypto.randomUUID()},${id},${connection.epoch},'disconnect',${userId})`;
      });
      return { saved: true };
    },
    async admitIn(
      sql: AgentTurnTransaction,
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
        await sql`INSERT INTO factory.agent_turn_mcp(turn_id,connection_id,credential_epoch,revision_id,policy_version,tools,required)
          VALUES(${turnId},${full.id},${full.credentialEpoch},${full.revisionId},${full.version},${JSON.stringify(full.tools.filter((tool) => full.allowedTools.some((approved) => approved.name === tool.name && approved.digest === tool.digest)))}::jsonb,${choice.state === "required"})
          ON CONFLICT DO NOTHING`;
      }
    },
    async assignments(turnId: string): Promise<MCPAssignment[]> {
      return database.client<
        MCPAssignment[]
      >`SELECT connection_id AS "connectionId",credential_epoch AS "credentialEpoch",revision_id AS "revisionId",
        policy_version::float8 AS "policyVersion",tools,required FROM factory.agent_turn_mcp WHERE turn_id=${turnId} ORDER BY connection_id`;
    },
  };
}
