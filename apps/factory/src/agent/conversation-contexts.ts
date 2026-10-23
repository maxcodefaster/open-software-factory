import type { createDatabase } from "../../../../packages/db/src/client";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { lockChangeWriterIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import { ensureConversationIn } from "../project-agent/conversation-store";

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
      const [previous] = await sql<
        { id: string; changeID: string; userID: string; previousID: string | null }[]
      >`
      SELECT id,change_id AS "changeID",created_by AS "userID",previous_context_id AS "previousID"
      FROM factory.conversation_context WHERE command_id=${commandID}`;
      if (previous) {
        if (
          previous.changeID !== changeID ||
          previous.userID !== userID ||
          previous.previousID !== expectedContextID
        )
          throw new CommandError("conflict", "This conversation command has different input.");
        return previous.id;
      }
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
        await sql`UPDATE factory.conversation_context SET archived_session=${JSON.stringify(settled.session)}::jsonb,
        transcript=${JSON.stringify(transcript)}::jsonb WHERE id=${conversation.contextID}`;
      } else {
        await sql`INSERT INTO factory.conversation_context(id,conversation_id,command_id,kind,ordinal,title,
        created_by,change_id,native_session_id,original,archived_session,transcript,mode)
        VALUES(${crypto.randomUUID()},${conversation.id},${crypto.randomUUID()},'coding',
          (SELECT COALESCE(MAX(ordinal),0)+1 FROM factory.conversation_context WHERE conversation_id=${conversation.id}),
          'Original Coding conversation',${userID},${changeID},${settled.nativeID},true,
          ${JSON.stringify(settled.session)}::jsonb,${JSON.stringify(transcript)}::jsonb,'build')`;
      }
      const id = crypto.randomUUID();
      const nativeID = `ses_factory_${id.replaceAll("-", "")}`;
      await sql`INSERT INTO factory.conversation_context(id,conversation_id,command_id,kind,ordinal,title,created_by,change_id,native_session_id,mode,previous_context_id)
      VALUES(${id},${conversation.id},${commandID},'coding',
        (SELECT COALESCE(MAX(ordinal),0)+1 FROM factory.conversation_context WHERE conversation_id=${conversation.id}),
        'New Coding conversation',${userID},${changeID},${nativeID},'build',${expectedContextID})`;
      await sql`UPDATE factory.ticket_conversation SET active_coding_context_id=${id},updated_at=now()
      WHERE id=${conversation.id}`;
      await sql`UPDATE factory.change_agent_session SET state='stopped',opencode_session_id=${nativeID},
      native_session_confirmed_at=NULL,implementation_session_id=${nativeID},implementation_session_confirmed_at=NULL,
      active_turn_id=NULL,active_inbox_id=NULL,last_error=NULL,stop_id=NULL,stop_turn_id=NULL,
      stop_dispatched=false,updated_at=now() WHERE change_id=${changeID}`;
      return id;
    });
}
