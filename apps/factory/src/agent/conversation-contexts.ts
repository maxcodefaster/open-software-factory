import { and, eq, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import { change, changeAgentSession, ticketConversation } from "../../../../packages/db/src/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import {
  activateCodingContextIn,
  archiveContextIn,
  contextCommandIn,
  ensureConversationIn,
  insertContextIn,
} from "../conversations/api";

/** Rotates only conversational context. Source, Sandbox and approved scope stay unchanged. */
export function createCodingContexts(database: ReturnType<typeof createDatabase>) {
  return async (
    changeID: string,
    userID: string,
    commandID: string,
    expectedContextID: string | null,
    transcript: { turn?: { id: string } | null; [key: string]: unknown },
  ) =>
    database.client.begin(async (sql) => {
      const writer = await lockChangeWriterIn(sql, changeID);
      const db = drizzleTransaction(sql);
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      const [currentChange] = await db
        .select({ ticketID: change.ticketId })
        .from(change)
        .where(eq(change.id, changeID));
      if (!currentChange) throw new CommandError("not-found", "Change not found");
      await ensureConversationIn(sql, writer.projectID, currentChange.ticketID, userID);
      const selectedConversation = alias(ticketConversation, "conversation");
      const [conversation] = await db
        .select({
          id: selectedConversation.id,
          contextID: selectedConversation.activeCodingContextId,
        })
        .from(selectedConversation)
        .innerJoin(change, eq(change.ticketId, selectedConversation.ticketId))
        .where(and(eq(change.id, changeID), eq(selectedConversation.mode, "build")))
        .for("update", { of: selectedConversation });
      if (!conversation)
        throw new CommandError("conflict", "Open this Ticket's Coding conversation first.");
      const previous = await contextCommandIn(sql, {
        conversationID: conversation.id,
        commandID,
        createdBy: userID,
        kind: "coding",
        changeID,
        previousContextID: expectedContextID,
      });
      if (previous) return previous;
      if (
        !writer.available ||
        conversation.contextID !== expectedContextID ||
        writer.state === "handoff" ||
        (writer.state === "human" && writer.userID !== userID)
      )
        throw new CommandError(
          "conflict",
          "The shared Coding or editing context changed. Keep your draft and check its current owner.",
        );
      const [settled] = await sql<{ session: unknown; nativeID: string | null }[]>`
      SELECT to_jsonb(session) AS session,
        COALESCE(session.implementation_session_id,session.opencode_session_id) AS "nativeID"
      FROM factory.change_agent_session session
      WHERE change_id=${changeID} AND state IN ('committed','stopped') AND NOT stop_pending
        AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=${changeID} AND state IN ('pending','dispatching','running','uncertain'))
        AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=${changeID} AND state NOT IN ('succeeded','failed'))
        AND NOT EXISTS(SELECT 1 FROM factory.candidate_review WHERE change_id=${changeID} AND state IN ('pending','running'))
        AND (SELECT turn.id::text FROM factory.agent_turn turn WHERE turn.change_id=${changeID}
          AND turn.input->>'contextId' IS NOT DISTINCT FROM ${expectedContextID}
          ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1) IS NOT DISTINCT FROM ${transcript.turn?.id ?? null}
      FOR UPDATE`;
      if (!settled)
        throw new CommandError(
          "conflict",
          "Finish Coding or use Stop and wait for confirmation before starting a new conversation.",
        );
      if (conversation.contextID) {
        await archiveContextIn(sql, conversation.id, conversation.contextID, {
          session: settled.session,
          transcript,
        });
      } else {
        await insertContextIn(sql, {
          id: crypto.randomUUID(),
          conversationID: conversation.id,
          commandID: crypto.randomUUID(),
          kind: "coding",
          title: "Original Coding conversation",
          createdBy: userID,
          changeID,
          nativeSessionID: settled.nativeID,
          original: true,
          archive: { session: settled.session, transcript },
          mode: "build",
        });
      }
      const id = crypto.randomUUID();
      const nativeID = `ses_factory_${id.replaceAll("-", "")}`;
      await insertContextIn(sql, {
        id,
        conversationID: conversation.id,
        commandID,
        kind: "coding",
        title: "New Coding conversation",
        createdBy: userID,
        changeID,
        nativeSessionID: nativeID,
        previousContextID: expectedContextID,
        mode: "build",
      });
      await activateCodingContextIn(sql, conversation.id, id);
      await db
        .update(changeAgentSession)
        .set({
          state: "stopped",
          opencodeSessionId: nativeID,
          nativeSessionConfirmedAt: null,
          implementationSessionId: nativeID,
          implementationSessionConfirmedAt: null,
          activeTurnId: null,
          activeInboxId: null,
          lastError: null,
          stopId: null,
          stopTurnId: null,
          stopDispatched: false,
          updatedAt: query`now()`,
        })
        .where(eq(changeAgentSession.changeId, changeID));
      return id;
    });
}
