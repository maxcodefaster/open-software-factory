import { eq, sql } from "drizzle-orm";
import type { ConversationMode } from "#conversation-domain/conversation";
import type { ProjectAgentProgress } from "#conversation-domain/turn-observation";
import { drizzleTransaction } from "#db/client";
import { change, ticketConversation } from "#db/schema";
import type { createAccessController } from "../access/api";
import { type createUsageObservations, readTurnObservation } from "../agent/turns-api";
import { CommandError } from "../command-error";
import {
  appendConversationEntry,
  type ConversationRow,
  contextCommandIn,
  contextsIn,
  contextTranscriptIn,
  ensureConversationIn,
  insertContextIn,
  lockConversation,
  readConversationEntries,
} from "../conversations/api";
import {
  filterVisibleEntries,
  type ProjectAgentDatabase,
  type RetainedMessagesReader,
} from "./turn-types";

export async function buildConversationView(
  deps: {
    database: ProjectAgentDatabase;
    access: ReturnType<typeof createAccessController>;
    usage: ReturnType<typeof createUsageObservations>;
    progress: Map<string, ProjectAgentProgress>;
    retainedMessages?: RetainedMessagesReader;
  },
  current: ConversationRow | undefined,
  userID: string,
) {
  if (!current) return null;
  const { database, access, usage, progress, retainedMessages } = deps;
  let developer = await access.canDevelop(userID, current.projectId);
  const [history, turn] = await Promise.all([
    readConversationEntries(database, current.id, current.contextId),
    readTurnObservation(database, {
      conversationID: current.id,
      ...(current.contextId ? { contextID: current.contextId } : {}),
    }),
  ]);
  let codingHistory: unknown = null;
  if (
    developer &&
    current.mode === "build" &&
    (current.contextId ?? null) !== (current.activeCodingContextId ?? null)
  ) {
    const archive = await contextTranscriptIn(database.client, current.id, current.contextId);
    codingHistory = archive?.transcript ?? null;
    if (archive && archive.transcript["messagesAvailable"] !== true && retainedMessages) {
      const observed = await retainedMessages(current.id, current.contextId);
      if (observed) codingHistory = { ...archive.transcript, ...observed };
    }
  }
  await access.requireProject(userID, current.projectId);
  developer = await access.canDevelop(userID, current.projectId);
  if (!developer) codingHistory = null;
  return {
    ...current,
    contextId: current.contextId ?? null,
    activeCodingContextId: current.activeCodingContextId ?? null,
    contexts: await database.client.begin((tx) => contextsIn(tx, current.id)),
    codingHistory,
    isActiveCoding:
      current.mode === "build" &&
      (current.contextId ?? null) === (current.activeCodingContextId ?? null),
    entries: filterVisibleEntries(history, developer),
    turn: turn
      ? {
          ...turn,
          usage: usage.get(turn.id),
          ...(progress.has(turn.id) ? { progress: progress.get(turn.id) } : {}),
        }
      : undefined,
  };
}

export async function createResearchContext(
  database: ProjectAgentDatabase,
  projectID: string,
  ticketID: string | undefined,
  userID: string,
  commandID: string,
) {
  return database.client.begin(async (tx) => {
    const root = await ensureConversationIn(tx, projectID, ticketID, userID);
    await lockConversation(tx, root.id);
    const previous = await contextCommandIn(tx, {
      conversationID: root.id,
      commandID,
      createdBy: userID,
      kind: "research",
    });
    if (previous) return previous;
    const contextID = crypto.randomUUID();
    await insertContextIn(tx, {
      id: contextID,
      conversationID: root.id,
      commandID,
      kind: "research",
      title: "New conversation",
      createdBy: userID,
      mode: ticketID && root.mode === "build" ? "investigate" : "plan",
    });
    return contextID;
  });
}

export async function updateConversationMode(
  database: ProjectAgentDatabase,
  projectID: string,
  ticketID: string | undefined,
  nextMode: ConversationMode,
  userID: string,
) {
  if (nextMode === "build")
    throw new CommandError(
      "conflict",
      "Use Implement to approve the exact saved requirements and start Coding.",
    );
  return database.client.begin(async (transaction) => {
    const scope = await ensureConversationIn(transaction, projectID, ticketID, userID);
    const current = await lockConversation(transaction, scope.id);
    if (!current) throw new CommandError("not-found", "Conversation not found");
    const db = drizzleTransaction(transaction);
    const [coding] = current.ticketId
      ? await db.select({ id: change.id }).from(change).where(eq(change.ticketId, current.ticketId))
      : [];
    if (coding)
      throw new CommandError(
        "conflict",
        "This Ticket keeps its Coding conversation. Use Ask about this Project for separate research.",
      );
    if (current.mode !== nextMode) {
      await db
        .update(ticketConversation)
        .set({
          mode: nextMode,
          version: sql<number>`${ticketConversation.version}+1`,
          updatedAt: sql<Date>`now()`,
        })
        .where(eq(ticketConversation.id, current.id));
      await appendConversationEntry(transaction, current.id, {
        kind: "mode-change",
        actor: "system",
        mode: nextMode,
        body: `Switched to ${nextMode}.`,
        payload: { from: current.mode, to: nextMode },
        citations: [],
        inReplyToEntryId: null,
        requirementRevisionId: null,
      });
    }
    return current.id;
  });
}
