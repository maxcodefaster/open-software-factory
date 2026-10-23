import type { z } from "zod";
import type {
  ConversationMode,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { contextIn } from "./conversation-contexts";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

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

export async function ensureConversationIn(
  sql: AgentTurnTransaction,
  projectID: string,
  ticketID: string | undefined,
  userID: string,
) {
  // All Ticket work takes the Ticket before membership and Conversation locks.
  // Research can share this read lock; Coding's short exclusive transition waits.
  if (ticketID) {
    const [ticket] = await sql`SELECT id FROM factory.ticket WHERE id=${ticketID}
      AND project_id=${projectID} AND converted_to_epic_id IS NULL FOR SHARE`;
    if (!ticket) throw new CommandError("not-found", "Ticket not found");
  }
  await projectAuthorityIn(sql, userID, projectID);
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`conversation:${projectID}:${ticketID ?? userID}`}))`;
  const [existing] = await sql<ConversationRow[]>`SELECT id,project_id AS "projectId",
    ticket_id AS "ticketId",mode,version::integer AS version,active_coding_context_id AS "activeCodingContextId"
    FROM factory.ticket_conversation WHERE project_id=${projectID} AND
      (ticket_id=${ticketID ?? null} OR (${ticketID ?? null}::uuid IS NULL AND ticket_id IS NULL AND created_by=${userID})) LIMIT 1`;
  if (existing) return existing;
  if (ticketID) {
    const [unversioned] = await sql`SELECT id FROM factory.agent_turn WHERE ticket_id=${ticketID}
      AND change_id IS NOT NULL AND conversation_id IS NULL AND state IN ('pending','dispatching','running','uncertain')
      UNION ALL SELECT session.change_id FROM factory.change_agent_session session JOIN factory.change change ON change.id=session.change_id
        WHERE change.ticket_id=${ticketID} AND session.stop_pending
      UNION ALL SELECT operation.change_id FROM factory.change_commit_operation operation JOIN factory.change change ON change.id=operation.change_id
        WHERE change.ticket_id=${ticketID} AND operation.state NOT IN ('succeeded','failed') LIMIT 1`;
    if (unversioned)
      throw new CommandError(
        "conflict",
        "This earlier Coding work must settle before shared conversations can be added. Its execution has not changed.",
      );
  }
  const [created] = await sql<
    ConversationRow[]
  >`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,created_by,mode)
    VALUES(${crypto.randomUUID()},${projectID},${ticketID ?? null},${userID},
      CASE WHEN EXISTS(SELECT 1 FROM factory.change WHERE ticket_id=${ticketID ?? null})
        THEN 'build'::factory.conversation_mode ELSE 'investigate'::factory.conversation_mode END)
    RETURNING id,project_id AS "projectId",ticket_id AS "ticketId",mode,version::integer AS version`;
  if (!created) throw new Error("Conversation could not be created");
  return created;
}

export async function appendConversationEntry(
  transaction: AgentTurnTransaction,
  conversationID: string,
  entry: Omit<ConversationEntry, "id" | "ordinal" | "createdAt"> & {
    createdBy?: string;
    contextId?: string;
  },
) {
  // All conversation writers serialize on this row using the same transaction as their effect.
  await transaction`SELECT id FROM factory.ticket_conversation WHERE id = ${conversationID} FOR UPDATE`;
  const rows = await transaction<ConversationEntry[]>`
    INSERT INTO factory.conversation_entry(
      id, conversation_id, ordinal, kind, actor, mode, body, payload, citations,
      in_reply_to_entry_id, requirement_revision_id, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${conversationID},
      (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM factory.conversation_entry
        WHERE conversation_id = ${conversationID}),
      ${entry.kind}, ${entry.actor}, ${entry.mode}, ${entry.body},
      ${JSON.stringify({ ...entry.payload, ...(entry.contextId ? { contextId: entry.contextId } : {}) })}::jsonb, ${JSON.stringify(entry.citations)}::jsonb,
      ${entry.inReplyToEntryId}, ${entry.requirementRevisionId}, ${entry.createdBy ?? null}
    )
    RETURNING id, ordinal::integer AS ordinal, kind, actor, mode, body, payload, citations,
      in_reply_to_entry_id AS "inReplyToEntryId",
      requirement_revision_id AS "requirementRevisionId", created_at AS "createdAt"
  `;
  const created = rows[0];
  if (!created) throw new Error("Conversation Entry could not be created");
  return created;
}

export async function lockConversation(
  transaction: AgentTurnTransaction,
  conversationID: string,
  contextID?: string,
) {
  const rows = await transaction<ConversationRow[]>`
    SELECT id, project_id AS "projectId", ticket_id AS "ticketId", mode, version::integer AS version
    FROM factory.ticket_conversation WHERE id = ${conversationID} FOR UPDATE
  `;
  if (rows[0] && contextID) {
    const context = await contextIn(transaction, conversationID, contextID);
    if (context.kind !== "research") return undefined;
    return { ...rows[0], mode: context.mode, version: 1, contextId: contextID };
  }
  return rows[0];
}
