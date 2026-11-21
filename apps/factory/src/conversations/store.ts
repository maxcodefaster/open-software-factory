import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  ConversationMode,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  changeAgentSession,
  changeCommitOperation,
  conversationEntry,
  ticket,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { contextIn } from "./contexts";

type Database = ReturnType<typeof createDatabase>;

export type ConversationRow = {
  id: string;
  projectId: string;
  ticketId: string | null;
  mode: ConversationMode;
  version: number;
  contextId?: string | undefined;
  activeCodingContextId?: string | null;
};

export type Citation = z.infer<typeof sourceCitationInput>;
export type ConversationEntry = {
  id: string;
  ordinal: number;
  kind: "user-message" | "agent-message" | "question" | "answer" | "requirement" | "mode-change";
  actor: "user" | "project-agent" | "change-agent" | "system";
  mode: ConversationMode;
  body: string;
  payload: Record<string, unknown>;
  citations: Citation[];
  inReplyToEntryId: string | null;
  requirementRevisionId: string | null;
  createdAt: string;
};

const conversationFields = {
  id: ticketConversation.id,
  projectId: ticketConversation.projectId,
  ticketId: ticketConversation.ticketId,
  mode: ticketConversation.mode,
  version: ticketConversation.version,
};

const entryFields = {
  id: conversationEntry.id,
  ordinal: conversationEntry.ordinal,
  kind: conversationEntry.kind,
  actor: conversationEntry.actor,
  mode: conversationEntry.mode,
  body: conversationEntry.body,
  payload: conversationEntry.payload,
  citations: conversationEntry.citations,
  inReplyToEntryId: conversationEntry.inReplyToEntryId,
  requirementRevisionId: conversationEntry.requirementRevisionId,
  createdAt: conversationEntry.createdAt,
};

export async function ensureConversationIn(
  transaction: DatabaseTransaction,
  projectID: string,
  ticketID: string | undefined,
  userID: string,
): Promise<ConversationRow> {
  const db = drizzleTransaction(transaction);
  // All Ticket work takes the Ticket before membership and Conversation locks.
  // Research can share this read lock; Coding's short exclusive transition waits.
  if (ticketID) {
    const [row] = await db
      .select({ id: ticket.id })
      .from(ticket)
      .where(
        and(
          eq(ticket.id, ticketID),
          eq(ticket.projectId, projectID),
          isNull(ticket.convertedToEpicId),
        ),
      )
      .for("share");
    if (!row) throw new CommandError("not-found", "Ticket not found");
  }
  await projectAuthorityIn(transaction, userID, projectID);
  await db.execute(
    sql<void>`SELECT pg_advisory_xact_lock(hashtext(${`conversation:${projectID}:${ticketID ?? userID}`}))`,
  );
  const [existing] = await db
    .select({
      ...conversationFields,
      activeCodingContextId: ticketConversation.activeCodingContextId,
    })
    .from(ticketConversation)
    .where(
      and(
        eq(ticketConversation.projectId, projectID),
        ticketID
          ? eq(ticketConversation.ticketId, ticketID)
          : and(isNull(ticketConversation.ticketId), eq(ticketConversation.createdBy, userID)),
      ),
    )
    .limit(1);
  if (existing) return existing;
  if (ticketID) {
    const [unversioned] = await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.ticketId, ticketID),
          isNotNull(agentTurn.changeId),
          isNull(agentTurn.conversationId),
          inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
        ),
      )
      .unionAll(
        db
          .select({ id: changeAgentSession.changeId })
          .from(changeAgentSession)
          .innerJoin(change, eq(change.id, changeAgentSession.changeId))
          .where(and(eq(change.ticketId, ticketID), eq(changeAgentSession.stopPending, true))),
      )
      .unionAll(
        db
          .select({ id: changeCommitOperation.changeId })
          .from(changeCommitOperation)
          .innerJoin(change, eq(change.id, changeCommitOperation.changeId))
          .where(
            and(
              eq(change.ticketId, ticketID),
              notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
            ),
          ),
      )
      .limit(1);
    if (unversioned)
      throw new CommandError(
        "conflict",
        "This earlier Coding work must settle before shared conversations can be added. Its execution has not changed.",
      );
  }
  const [codingChange] = ticketID
    ? await db.select({ id: change.id }).from(change).where(eq(change.ticketId, ticketID)).limit(1)
    : [];
  const [created] = await db
    .insert(ticketConversation)
    .values({
      id: crypto.randomUUID(),
      projectId: projectID,
      ticketId: ticketID ?? null,
      createdBy: userID,
      mode: codingChange ? "build" : "investigate",
    })
    .returning(conversationFields);
  if (!created) throw new Error("Conversation could not be created");
  return created;
}

export async function appendConversationEntry(
  transaction: DatabaseTransaction,
  conversationID: string,
  entry: Omit<ConversationEntry, "id" | "ordinal" | "createdAt"> & {
    createdBy?: string;
    contextId?: string;
  },
): Promise<ConversationEntry> {
  // All conversation writers serialize on this row using the same transaction as their effect.
  const db = drizzleTransaction(transaction);
  await db
    .select({ id: ticketConversation.id })
    .from(ticketConversation)
    .where(eq(ticketConversation.id, conversationID))
    .for("update");
  const ordinal = db
    .select({ next: sql<number>`COALESCE(MAX(${conversationEntry.ordinal}), 0) + 1` })
    .from(conversationEntry)
    .where(eq(conversationEntry.conversationId, conversationID));
  const rows = await db
    .insert(conversationEntry)
    .values({
      id: crypto.randomUUID(),
      conversationId: conversationID,
      ordinal: sql<number>`(${ordinal})`,
      kind: entry.kind,
      actor: entry.actor,
      mode: entry.mode,
      body: entry.body,
      payload: { ...entry.payload, ...(entry.contextId ? { contextId: entry.contextId } : {}) },
      citations: entry.citations,
      inReplyToEntryId: entry.inReplyToEntryId,
      requirementRevisionId: entry.requirementRevisionId,
      createdBy: entry.createdBy ?? null,
    })
    .returning(entryFields);
  const created = rows[0];
  if (!created) throw new Error("Conversation Entry could not be created");
  return { ...created, createdAt: created.createdAt.toISOString() };
}

export async function lockConversation(
  transaction: DatabaseTransaction,
  conversationID: string,
  contextID?: string,
): Promise<ConversationRow | undefined> {
  const rows = await drizzleTransaction(transaction)
    .select(conversationFields)
    .from(ticketConversation)
    .where(eq(ticketConversation.id, conversationID))
    .for("update");
  if (rows[0] && contextID) {
    const context = await contextIn(transaction, conversationID, contextID);
    if (context.kind !== "research") return undefined;
    return { ...rows[0], mode: context.mode, version: 1, contextId: contextID };
  }
  return rows[0];
}

export async function findConversation(
  database: Database,
  projectID: string,
  ticketID: string | undefined,
  userID: string,
): Promise<ConversationRow | undefined> {
  const rows = await drizzleTransaction(database.client)
    .select(conversationFields)
    .from(ticketConversation)
    .where(
      and(
        eq(ticketConversation.projectId, projectID),
        ticketID
          ? eq(ticketConversation.ticketId, ticketID)
          : and(isNull(ticketConversation.ticketId), eq(ticketConversation.createdBy, userID)),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function readConversation(
  database: Database,
  conversationID: string,
  contextID?: string,
): Promise<ConversationRow | undefined> {
  const rows = await drizzleTransaction(database.client)
    .select({
      ...conversationFields,
      activeCodingContextId: ticketConversation.activeCodingContextId,
    })
    .from(ticketConversation)
    .where(eq(ticketConversation.id, conversationID));
  const current = rows[0];
  if (!current || !contextID) return current;
  const context = await database.client.begin((sql) => contextIn(sql, conversationID, contextID));
  return {
    ...current,
    contextId: contextID,
    ...(context.kind === "research" ? { mode: context.mode, version: 1 } : {}),
  };
}

export async function readConversationEntries(
  database: Database,
  conversationID: string,
  contextID?: string,
): Promise<ConversationEntry[]> {
  const context = contextID
    ? await database.client.begin((sql) => contextIn(sql, conversationID, contextID))
    : undefined;
  const rows = await drizzleTransaction(database.client)
    .select(entryFields)
    .from(conversationEntry)
    .where(
      and(
        eq(conversationEntry.conversationId, conversationID),
        sql<boolean>`${conversationEntry.payload}->>'contextId' IS NOT DISTINCT FROM ${context?.original ? null : (contextID ?? null)}`,
      ),
    )
    .orderBy(asc(conversationEntry.ordinal));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}
