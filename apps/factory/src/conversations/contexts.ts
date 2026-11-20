import type postgres from "postgres";
import type { ConversationMode } from "../../../../packages/conversation-domain/src/conversation";
import { CommandError } from "../command-error";

export async function contextIn(
  sql: postgres.TransactionSql,
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

export async function contextsIn(sql: postgres.TransactionSql, conversationID: string) {
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

export async function contextTranscriptIn(
  sql: postgres.Sql | postgres.TransactionSql,
  conversationID: string,
  contextID?: string,
) {
  const [archive] = await sql<{ transcript: Record<string, unknown> }[]>`
    SELECT transcript
    FROM factory.conversation_context WHERE conversation_id=${conversationID} AND
    (id=${contextID ?? null} OR (${contextID ?? null}::uuid IS NULL AND original)) LIMIT 1`;
  return archive;
}

type ContextCommand = {
  conversationID: string;
  commandID: string;
  createdBy: string;
} & ({ kind: "research" } | { kind: "coding"; changeID: string; previousContextID: string | null });

/** Observe a command receipt before an engine admits a new context. Never replay its effects. */
export async function contextCommandIn(sql: postgres.TransactionSql, command: ContextCommand) {
  const [previous] = await sql<
    {
      id: string;
      conversationID: string;
      userID: string;
      kind: "research" | "coding";
      changeID: string | null;
      previousID: string | null;
    }[]
  >`
    SELECT id,conversation_id AS "conversationID",created_by AS "userID",kind,
      change_id AS "changeID",previous_context_id AS "previousID"
    FROM factory.conversation_context WHERE command_id=${command.commandID}`;
  if (!previous) return undefined;
  if (
    previous.conversationID !== command.conversationID ||
    previous.userID !== command.createdBy ||
    previous.kind !== command.kind ||
    (command.kind === "coding" &&
      (previous.changeID !== command.changeID || previous.previousID !== command.previousContextID))
  )
    throw new CommandError("conflict", "This conversation command has different input.");
  return previous.id;
}

type ContextInsert = {
  id: string;
  conversationID: string;
  commandID: string;
  createdBy: string;
  title: string;
} & (
  | { kind: "research"; mode: Exclude<ConversationMode, "build"> }
  | {
      kind: "coding";
      mode: "build";
      changeID: string;
      nativeSessionID: string | null;
      previousContextID?: string | null;
      original?: boolean;
      archive?: { session: unknown; transcript: unknown };
    }
);

/** All context kinds allocate history ordinals under the same Conversation row lock. */
export async function insertContextIn(sql: postgres.TransactionSql, context: ContextInsert) {
  await sql`SELECT id FROM factory.ticket_conversation WHERE id=${context.conversationID} FOR UPDATE`;
  const coding = context.kind === "coding" ? context : undefined;
  await sql`INSERT INTO factory.conversation_context(
    id,conversation_id,command_id,kind,ordinal,title,created_by,mode,
    change_id,native_session_id,previous_context_id,original,archived_session,transcript)
    VALUES(${context.id},${context.conversationID},${context.commandID},${context.kind},
      (SELECT COALESCE(MAX(ordinal),0)+1 FROM factory.conversation_context WHERE conversation_id=${context.conversationID}),
      ${context.title},${context.createdBy},${context.mode},${coding?.changeID ?? null},
      ${coding?.nativeSessionID ?? null},${coding?.previousContextID ?? null},${coding?.original ?? false},
      ${coding?.archive ? JSON.stringify(coding.archive.session) : null}::jsonb,
      ${coding?.archive ? JSON.stringify(coding.archive.transcript) : "[]"}::jsonb)`;
}

export async function archiveContextIn(
  sql: postgres.TransactionSql,
  conversationID: string,
  contextID: string,
  archive: { session: unknown; transcript: unknown },
) {
  const [saved] = await sql<
    { id: string }[]
  >`UPDATE factory.conversation_context SET archived_session=${JSON.stringify(archive.session)}::jsonb,
    transcript=${JSON.stringify(archive.transcript)}::jsonb
    WHERE id=${contextID} AND conversation_id=${conversationID} RETURNING id`;
  if (!saved) throw new CommandError("conflict", "Conversation context changed.");
}

export async function activateCodingContextIn(
  sql: postgres.TransactionSql,
  conversationID: string,
  contextID: string,
) {
  // Context rotation does not change the Conversation version or its writer epoch.
  await sql`UPDATE factory.ticket_conversation SET active_coding_context_id=${contextID},updated_at=now()
    WHERE id=${conversationID}`;
}
