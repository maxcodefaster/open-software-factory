import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { ConversationMode } from "../../../../packages/conversation-domain/src/conversation";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  conversationContext,
  conversationEntry,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { CommandError } from "../command-error";

export async function contextIn(
  transaction: DatabaseTransaction,
  conversationID: string,
  contextID: string,
) {
  const [context] = await drizzleTransaction(transaction)
    .select({
      id: conversationContext.id,
      kind: conversationContext.kind,
      original: conversationContext.original,
      nativeSessionID: conversationContext.nativeSessionId,
      mode: conversationContext.mode,
    })
    .from(conversationContext)
    .where(
      and(
        eq(conversationContext.id, contextID),
        eq(conversationContext.conversationId, conversationID),
      ),
    );
  if (!context) throw new CommandError("not-found", "Conversation not found.");
  return { ...context, kind: context.kind as "research" | "coding" };
}

export async function contextsIn(transaction: DatabaseTransaction, conversationID: string) {
  const db = drizzleTransaction(transaction);
  const entryTitle = db
    .select({
      title: sql<string>`left(regexp_replace(${conversationEntry.body},'[[:space:]]+',' ','g'),80)`,
    })
    .from(conversationEntry)
    .where(
      and(
        eq(conversationEntry.conversationId, conversationContext.conversationId),
        eq(conversationEntry.actor, "user"),
        eq(conversationEntry.kind, "user-message"),
        sql<boolean>`${conversationEntry.payload}->>'contextId' IS NOT DISTINCT FROM
          CASE WHEN ${conversationContext.original} THEN NULL ELSE ${conversationContext.id}::text END`,
      ),
    )
    .orderBy(asc(conversationEntry.ordinal))
    .limit(1);
  const turnTitle = db
    .select({
      title: sql<string>`left(regexp_replace(${agentTurn.input}->>'text','[[:space:]]+',' ','g'),80)`,
    })
    .from(agentTurn)
    .where(
      and(
        sql<boolean>`${agentTurn.input}->>'contextId'=${conversationContext.id}::text`,
        isNotNull(agentTurn.createdBy),
        sql<boolean>`${agentTurn.input}->>'text' IS NOT NULL`,
      ),
    )
    .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
    .limit(1);
  const rows = await db
    .select({
      id: conversationContext.id,
      kind: conversationContext.kind,
      title: sql<string>`COALESCE((${entryTitle}), (${turnTitle}), ${conversationContext.title})`,
      ordinal: conversationContext.ordinal,
      original: conversationContext.original,
      createdAt: conversationContext.createdAt,
    })
    .from(conversationContext)
    .where(eq(conversationContext.conversationId, conversationID))
    .orderBy(desc(conversationContext.ordinal));
  return rows.map((row) => ({
    ...row,
    kind: row.kind as "research" | "coding",
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function contextTranscriptIn(
  connection: ReturnType<typeof createDatabase>["client"] | DatabaseTransaction,
  conversationID: string,
  contextID?: string,
) {
  const [archive] = await drizzleTransaction(connection)
    .select({ transcript: conversationContext.transcript })
    .from(conversationContext)
    .where(
      and(
        eq(conversationContext.conversationId, conversationID),
        contextID ? eq(conversationContext.id, contextID) : eq(conversationContext.original, true),
      ),
    )
    .limit(1);
  return archive as { transcript: Record<string, unknown> } | undefined;
}

type ContextCommand = {
  conversationID: string;
  commandID: string;
  createdBy: string;
} & ({ kind: "research" } | { kind: "coding"; changeID: string; previousContextID: string | null });

/** Observe a command receipt before an engine admits a new context. Never replay its effects. */
export async function contextCommandIn(transaction: DatabaseTransaction, command: ContextCommand) {
  const [previous] = await drizzleTransaction(transaction)
    .select({
      id: conversationContext.id,
      conversationID: conversationContext.conversationId,
      userID: conversationContext.createdBy,
      kind: conversationContext.kind,
      changeID: conversationContext.changeId,
      previousID: conversationContext.previousContextId,
    })
    .from(conversationContext)
    .where(eq(conversationContext.commandId, command.commandID));
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
export async function insertContextIn(transaction: DatabaseTransaction, context: ContextInsert) {
  const db = drizzleTransaction(transaction);
  await db
    .select({ id: ticketConversation.id })
    .from(ticketConversation)
    .where(eq(ticketConversation.id, context.conversationID))
    .for("update");
  const coding = context.kind === "coding" ? context : undefined;
  const ordinal = db
    .select({ next: sql<number>`COALESCE(MAX(${conversationContext.ordinal}),0)+1` })
    .from(conversationContext)
    .where(eq(conversationContext.conversationId, context.conversationID));
  await db.insert(conversationContext).values({
    id: context.id,
    conversationId: context.conversationID,
    commandId: context.commandID,
    kind: context.kind,
    mode: context.mode,
    ordinal: sql<number>`(${ordinal})`,
    title: context.title,
    createdBy: context.createdBy,
    changeId: coding?.changeID ?? null,
    nativeSessionId: coding?.nativeSessionID ?? null,
    previousContextId: coding?.previousContextID ?? null,
    original: coding?.original ?? false,
    // JSON null is a retained archive value, distinct from SQL NULL and the default transcript.
    archivedSession:
      coding?.archive?.session === null
        ? sql<unknown>`'null'::jsonb`
        : (coding?.archive?.session ?? null),
    transcript:
      coding?.archive?.transcript === null
        ? sql<unknown>`'null'::jsonb`
        : (coding?.archive?.transcript ?? []),
  });
}

export async function archiveContextIn(
  transaction: DatabaseTransaction,
  conversationID: string,
  contextID: string,
  archive: { session: unknown; transcript: unknown },
) {
  const [saved] = await drizzleTransaction(transaction)
    .update(conversationContext)
    .set({
      archivedSession: archive.session === null ? sql<unknown>`'null'::jsonb` : archive.session,
      transcript: archive.transcript === null ? sql<unknown>`'null'::jsonb` : archive.transcript,
    })
    .where(
      and(
        eq(conversationContext.id, contextID),
        eq(conversationContext.conversationId, conversationID),
      ),
    )
    .returning({ id: conversationContext.id });
  if (!saved) throw new CommandError("conflict", "Conversation context changed.");
}

export async function activateCodingContextIn(
  transaction: DatabaseTransaction,
  conversationID: string,
  contextID: string,
) {
  // Context rotation does not change the Conversation version or its writer epoch.
  await drizzleTransaction(transaction)
    .update(ticketConversation)
    .set({ activeCodingContextId: contextID, updatedAt: sql<Date>`now()` })
    .where(eq(ticketConversation.id, conversationID));
}
