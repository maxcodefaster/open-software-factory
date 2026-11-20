import type { createDatabase } from "../../../../packages/db/src/client";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  activateCodingContextIn,
  archiveContextIn,
  contextCommandIn,
  insertContextIn,
} from "../conversations/contexts";
import { ensureConversationIn } from "../conversations/store";

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
      await projectDevelopmentAuthorityIn(sql, userID, writer.projectID);
      const [change] = await sql<
        { ticketID: string }[]
      >`SELECT ticket_id AS "ticketID" FROM factory.change WHERE id=${changeID}`;
      if (!change) throw new CommandError("not-found", "Change not found");
      await ensureConversationIn(sql, writer.projectID, change.ticketID, userID);
      const [conversation] = await sql<{ id: string; contextID: string | null }[]>`
      SELECT conversation.id,conversation.active_coding_context_id AS "contextID"
      FROM factory.ticket_conversation conversation JOIN factory.change change ON change.ticket_id=conversation.ticket_id
      WHERE change.id=${changeID} AND conversation.mode='build' FOR UPDATE OF conversation`;
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
      await sql`UPDATE factory.change_agent_session SET state='stopped',opencode_session_id=${nativeID},
      native_session_confirmed_at=NULL,implementation_session_id=${nativeID},implementation_session_confirmed_at=NULL,
      active_turn_id=NULL,active_inbox_id=NULL,last_error=NULL,stop_id=NULL,stop_turn_id=NULL,
      stop_dispatched=false,updated_at=now() WHERE change_id=${changeID}`;
      return id;
    });
}
