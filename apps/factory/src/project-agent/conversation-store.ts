import type { z } from "zod";
import type {
  ConversationMode,
  sourceCitationInput,
} from "../../../../packages/conversation-domain/src/conversation";
import type { AgentTurnTransaction } from "../agent/turn-store";

export type ConversationRow = {
  id: string;
  projectId: string;
  ticketId: string | null;
  mode: ConversationMode;
  version: number;
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

export async function appendConversationEntry(
  transaction: AgentTurnTransaction,
  conversationID: string,
  entry: Omit<ConversationEntry, "id" | "ordinal" | "createdAt"> & { createdBy?: string },
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
      ${JSON.stringify(entry.payload)}::jsonb, ${JSON.stringify(entry.citations)}::jsonb,
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

export async function lockConversation(transaction: AgentTurnTransaction, conversationID: string) {
  const rows = await transaction<ConversationRow[]>`
    SELECT id, project_id AS "projectId", ticket_id AS "ticketId", mode, version::integer AS version
    FROM factory.ticket_conversation WHERE id = ${conversationID} FOR UPDATE
  `;
  return rows[0];
}
