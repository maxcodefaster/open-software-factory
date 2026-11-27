import { and, eq, sql as expression } from "drizzle-orm";
import { defaultLibraryCover } from "#conversation-domain/library-covers";
import { mcpChoiceInput } from "#conversation-domain/mcp-library";
import { drizzleTransaction } from "#db/client";
import { mcpLibrary, mcpRevision as mcpRevisionTable, operation } from "#db/schema";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";
import { initializeLibraryCoverIn, libraryCoversIn } from "../library-covers/api";
import { viewMCPLibraryIn } from "./controller-library";
import {
  authorizeIn,
  capabilitiesIn,
  connectionIn,
  hasScopeManagerAccess,
  lockMCPKeyIn,
  MCP_CHOICE_KIND,
  MCP_SHARE_PROPOSAL_KIND,
  MCP_SHARE_PROPOSAL_SCOPE_TYPE,
  type MCPDatabase,
  mcpChoiceIdempotencyKey,
  mcpShareProposalIdempotencyKey,
  NIL_UUID,
  revisionIn,
  usableIn,
} from "./controller-types";

export async function chooseMCPDefault(database: MCPDatabase, value: unknown, userId: string) {
  const input = mcpChoiceInput.parse(value);
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const access = await capabilitiesIn(sql, userId, input.projectId);
    if (!input.projectId && input.scope !== "system")
      throw new CommandError("conflict", "Select a Project before choosing MCP connections");
    if (
      !hasScopeManagerAccess(access, input.scope, input.projectId) ||
      (input.scope === "personal" && input.state === "required")
    )
      throw new CommandError("forbidden", "You cannot change these MCP defaults");
    const view = await viewMCPLibraryIn(sql, userId, input.projectId);
    const entry = view.entries.find((item) => item.id === input.libraryId);
    const revision = entry?.revisions.find((item) => item.id === input.revisionId);
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
    const contextId = input.scope === "system" ? NIL_UUID : input.projectId;
    if (!contextId) throw new CommandError("conflict", "MCP choices require a Project context");
    const ownerId = input.scope === "personal" ? userId : NIL_UUID;
    await lockMCPKeyIn(
      sql,
      `mcp-choice:${input.libraryId}:${contextId}:${ownerId}:${input.role}:${input.scope}`,
    );
    const choiceKey = mcpChoiceIdempotencyKey(
      input.libraryId,
      input.scope,
      contextId,
      ownerId,
      input.role,
    );
    const [current] = await db
      .select({
        version: expression<number>`(${operation.payload}->>'version')::bigint::float8`,
      })
      .from(operation)
      .where(and(eq(operation.kind, MCP_CHOICE_KIND), eq(operation.idempotencyKey, choiceKey)));
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
      .insert(operation)
      .values({
        id: crypto.randomUUID(),
        kind: MCP_CHOICE_KIND,
        scopeType: input.scope,
        scopeId: contextId,
        idempotencyKey: choiceKey,
        activeKey: null,
        state: values.state,
        payload: values,
      })
      .onConflictDoUpdate({
        target: operation.idempotencyKey,
        set: {
          state: values.state,
          payload: values,
          updatedAt: expression`now()`,
        },
      });
    return { saved: true };
  });
}

export async function proposeMCPShare(
  database: MCPDatabase,
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
    const targetProjectId = target === "project" ? (projectId ?? null) : null;
    const [previous] = await db
      .select({
        kind: operation.kind,
        payload: operation.payload,
      })
      .from(operation)
      .where(eq(operation.id, id));
    if (previous) {
      const payload = previous.payload;
      if (
        previous.kind !== MCP_SHARE_PROPOSAL_KIND ||
        payload["revisionId"] !== revisionId ||
        payload["target"] !== target ||
        (payload["projectId"] ?? null) !== targetProjectId ||
        payload["proposedBy"] !== userId
      )
        throw new CommandError("conflict", "Sharing identity was reused");
      return;
    }
    await db.insert(operation).values({
      id,
      kind: MCP_SHARE_PROPOSAL_KIND,
      scopeType: MCP_SHARE_PROPOSAL_SCOPE_TYPE,
      scopeId: revisionId,
      idempotencyKey: mcpShareProposalIdempotencyKey(id),
      state: "proposed",
      createdBy: userId,
      payload: {
        revisionId,
        proposedBy: userId,
        target,
        projectId: targetProjectId,
        acceptedLibraryId: null,
        acceptedBy: null,
        acceptedAt: null,
      },
    });
  });
  return { saved: true };
}

export async function acceptMCPShare(database: MCPDatabase, id: string, userId: string) {
  return database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const [proposalRow] = await db
      .select({
        payload: operation.payload,
      })
      .from(operation)
      .where(
        and(
          eq(operation.id, id),
          eq(operation.kind, MCP_SHARE_PROPOSAL_KIND),
          eq(operation.scopeType, MCP_SHARE_PROPOSAL_SCOPE_TYPE),
        ),
      )
      .for("update");
    if (!proposalRow) throw new CommandError("not-found", "MCP sharing proposal not found");
    const payload = proposalRow.payload;
    const proposal = {
      revisionId: String(payload["revisionId"]),
      target: payload["target"] as "project" | "system",
      projectId: (payload["projectId"] as string | null) ?? null,
      accepted: (payload["acceptedLibraryId"] as string | null) ?? null,
    };
    const access = await capabilitiesIn(sql, userId, proposal.projectId ?? undefined);
    if (!hasScopeManagerAccess(access, proposal.target, proposal.projectId ?? undefined))
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
    const cover = (await libraryCoversIn(sql, "mcp", [revision.libraryId])).get(revision.libraryId);
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
      .update(operation)
      .set({
        state: "accepted",
        payload: {
          ...payload,
          acceptedLibraryId: libraryId,
          acceptedBy: userId,
          acceptedAt: new Date().toISOString(),
        },
        updatedAt: expression<Date>`now()`,
        completedAt: expression<Date>`now()`,
      })
      .where(eq(operation.id, id));
    return { libraryId };
  });
}
