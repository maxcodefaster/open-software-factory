import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

export async function contextIn(
  sql: AgentTurnTransaction,
  conversationID: string,
  contextID: string,
) {
  const [context] = await sql<
    {
      id: string;
      kind: "research" | "coding";
      original: boolean;
      nativeSessionID: string | null;
      mode: "investigate" | "plan" | "build";
    }[]
  >`SELECT id,kind,original,native_session_id AS "nativeSessionID",mode
    FROM factory.conversation_context WHERE id=${contextID} AND conversation_id=${conversationID}`;
  if (!context) throw new CommandError("not-found", "Conversation not found.");
  return context;
}

export async function contextsIn(sql: AgentTurnTransaction, conversationID: string) {
  return sql<
    {
      id: string;
      kind: "research" | "coding";
      title: string;
      ordinal: number;
      original: boolean;
      createdAt: string;
    }[]
  >`
    SELECT context.id,context.kind,COALESCE(
      (SELECT left(regexp_replace(entry.body,'[[:space:]]+',' ','g'),80)
        FROM factory.conversation_entry entry WHERE entry.conversation_id=context.conversation_id
          AND entry.actor='user' AND entry.kind='user-message' AND entry.payload->>'contextId'
            IS NOT DISTINCT FROM CASE WHEN context.original THEN NULL ELSE context.id::text END
        ORDER BY entry.ordinal LIMIT 1),
      (SELECT left(regexp_replace(turn.input->>'text','[[:space:]]+',' ','g'),80)
        FROM factory.agent_turn turn WHERE turn.input->>'contextId'=context.id::text
          AND turn.created_by IS NOT NULL AND turn.input->>'text' IS NOT NULL ORDER BY turn.created_at,turn.id LIMIT 1),
      context.title) AS title,context.ordinal,context.original,context.created_at AS "createdAt"
    FROM factory.conversation_context context WHERE context.conversation_id=${conversationID} ORDER BY context.ordinal DESC`;
}
