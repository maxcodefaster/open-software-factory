import { createHash } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  confirmEpicProposalInput,
  epicProposalInput,
} from "../../../../packages/conversation-domain/src/epic-proposal";
import { canonicalRequirementContent } from "../../../../packages/requirement-domain/src/requirement";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";

export function proposalIdentity(entryID: string, key: string) {
  const hex = createHash("sha256").update(`epic-proposal:${entryID}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const baseInput = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    documentId: z.uuid().nullable(),
    revisionId: z.uuid().nullable(),
  })
  .loose();
export function createEpicConfirmation(database: ReturnType<typeof createDatabase>) {
  return async (projectID: string, entryID: string, userID: string, value: unknown) => {
    const input = confirmEpicProposalInput.parse(value);
    const digest = createHash("sha256").update(JSON.stringify(input.proposal)).digest("hex");
    return database.client.begin(async (sql) => {
      await projectAuthorityIn(sql, userID, projectID);
      // Same order as dependency admission and Ticket decisions. Serialize before row locks.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('ticket-dependencies:' || ${projectID},0))`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`epic-confirmation:${entryID}`}))`;
      const [replay] = await sql<
        Array<{
          id: string;
          epicID: string;
          inputDigest: string;
          userID: string;
          members: string[];
        }>
      >`
        SELECT id,epic_id AS "epicID",input_digest AS "inputDigest",created_by AS "userID",members
        FROM factory.epic_confirmation WHERE id=${input.commandId} OR proposal_entry_id=${entryID}`;
      if (replay) {
        if (
          replay.id !== input.commandId ||
          replay.inputDigest !== digest ||
          replay.userID !== userID
        )
          throw new CommandError(
            "conflict",
            "This proposal was already confirmed with another decision",
          );
        return { epicId: replay.epicID, ticketIds: replay.members };
      }
      const [entry] = await sql<
        Array<{
          payload: Record<string, unknown>;
          ticketID: string | null;
          conversationID: string;
          createdBy: string;
          ordinal: number;
        }>
      >`
        SELECT e.payload,c.ticket_id AS "ticketID",c.id AS "conversationID",c.created_by AS "createdBy",e.ordinal::integer
        FROM factory.conversation_entry e JOIN factory.ticket_conversation c ON c.id=e.conversation_id
        WHERE e.id=${entryID} AND e.kind='requirement' AND c.project_id=${projectID}
          AND (c.ticket_id IS NOT NULL OR c.created_by=${userID})`;
      if (!entry) throw new CommandError("not-found", "Epic proposal not found");
      const boundary = entry.ticketID
        ? `agent-turn:${projectID}:ticket:${entry.ticketID}`
        : `agent-turn:${projectID}:draft:${entry.createdBy}`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${boundary}))`;
      await sql`SELECT id FROM factory.ticket_conversation WHERE id=${entry.conversationID} FOR UPDATE`;
      const [active] =
        await sql`SELECT id FROM factory.agent_turn WHERE conversation_id=${entry.conversationID} AND state IN ('pending','dispatching','running') LIMIT 1`;
      if (active)
        throw new CommandError("conflict", "Wait for the current clarification before confirming");
      const original = epicProposalInput.safeParse(entry.payload["epicProposal"]);
      if (!original.success) throw new CommandError("conflict", "This is not an Epic proposal");
      if (entry.payload["visibility"] === "developer") {
        const { projectDevelopmentAuthorityIn } = await import("../access/controller");
        await projectDevelopmentAuthorityIn(sql, userID, projectID);
      }
      const [newer] =
        await sql`SELECT id FROM factory.conversation_entry WHERE conversation_id=${entry.conversationID} AND kind='requirement' AND ordinal>${entry.ordinal} LIMIT 1`;
      if (newer) throw new CommandError("conflict", "Review the latest proposal before confirming");
      const reused = input.proposal.members.flatMap((member) =>
        member.existingTicketId ? [member.existingTicketId] : [],
      );
      const ticketIDs = [
        ...new Set([...reused, ...(entry.ticketID ? [entry.ticketID] : [])]),
      ].sort();
      for (const id of ticketIDs)
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${id}`}))`;
      const tickets = await sql<
        Array<{
          id: string;
          version: number;
          epicID: string | null;
          converted: string | null;
          state: string;
          title: string;
        }>
      >`
        SELECT id,version::integer,epic_id AS "epicID",converted_to_epic_id AS converted,state,title
        FROM factory.ticket WHERE id=ANY(${ticketIDs}::uuid[]) AND project_id=${projectID} AND trashed_at IS NULL ORDER BY id FOR UPDATE`;
      const existing = new Map(tickets.map((ticket) => [ticket.id, ticket]));
      for (const member of input.proposal.members) {
        if (!member.existingTicketId) continue;
        const ticket = existing.get(member.existingTicketId);
        if (
          !ticket ||
          ticket.state === "cancelled" ||
          ticket.converted ||
          ticket.version !== member.expectedVersion
        )
          throw new CommandError("conflict", "A reused Ticket changed. Review its current version");
        if (ticket.epicID)
          throw new CommandError("conflict", "A reused Ticket already belongs to an Epic");
      }
      let convertOrigin = false;
      if (entry.ticketID) {
        const base = baseInput.safeParse(entry.payload["base"]);
        const origin = existing.get(entry.ticketID);
        const [document] =
          await sql`SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${entry.ticketID} ORDER BY ordinal DESC LIMIT 1`;
        const [revision] =
          await sql`SELECT id FROM factory.requirement_revision WHERE ticket_id=${entry.ticketID} ORDER BY ordinal DESC LIMIT 1`;
        if (
          !base.success ||
          base.data.id !== entry.ticketID ||
          !origin ||
          origin.converted ||
          origin.state === "cancelled" ||
          origin.version !== base.data.version ||
          (document?.["id"] ?? null) !== base.data.documentId ||
          (revision?.["id"] ?? null) !== base.data.revisionId
        )
          throw new CommandError(
            "conflict",
            "The originating Ticket changed. Clarify against its current text",
          );
        const [admitted] =
          await sql`SELECT id FROM factory.change WHERE ticket_id=${entry.ticketID}`;
        convertOrigin = !admitted;
        if (convertOrigin && reused.includes(entry.ticketID))
          throw new CommandError(
            "conflict",
            "The original intent becomes the Epic, not a duplicate aggregate Ticket",
          );
        if (!convertOrigin && !reused.includes(entry.ticketID))
          throw new CommandError("conflict", "Keep the implemented original as an existing member");
        const [relationships] =
          await sql`SELECT ticket_id FROM factory.ticket_dependency WHERE ticket_id=${entry.ticketID} OR prerequisite_id=${entry.ticketID} LIMIT 1`;
        if (convertOrigin && (origin.epicID || relationships))
          throw new CommandError(
            "conflict",
            "Remove the original intent's Epic and prerequisite links before converting it",
          );
      }
      const epicID = proposalIdentity(entryID, "epic");
      await sql`INSERT INTO factory.epic(id,project_id,title,description,created_by)
        VALUES(${epicID},${projectID},${input.proposal.epic.title},${input.proposal.epic.description},${userID})`;
      const identities = new Map(
        input.proposal.members.map((member) => [
          member.key,
          member.existingTicketId ?? proposalIdentity(entryID, member.key),
        ]),
      );
      function memberIdentity(key: string) {
        const id = identities.get(key);
        if (!id) throw new Error("Proposal member identity is unavailable");
        return id;
      }
      for (const member of input.proposal.members) {
        const id = memberIdentity(member.key);
        if (member.existingTicketId) {
          await sql`UPDATE factory.ticket SET epic_id=${epicID},version=version+1,updated_at=now() WHERE id=${id}`;
        } else {
          const canonical = canonicalRequirementContent(member.requirement);
          const contentDigest = createHash("sha256").update(canonical).digest("hex");
          const revisionID = proposalIdentity(entryID, `${member.key}:revision`);
          await sql`INSERT INTO factory.ticket(id,project_id,epic_id,title,description,state,created_by)
            VALUES(${id},${projectID},${epicID},${member.title},${member.description},'ready',${userID})`;
          await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
            VALUES(${revisionID},${id},1,${canonical},${contentDigest},${userID})`;
          await sql`INSERT INTO factory.ticket_document_revision(id,ticket_id,ordinal,title,description,canonical_content,content_digest,requirement_revision_id,input_digest,created_by,author_kind)
            VALUES(${proposalIdentity(entryID, `${member.key}:document`)},${id},1,${member.title},${member.description},${canonical},${contentDigest},${revisionID},${digest},${userID},'ai')`;
        }
      }
      for (const member of input.proposal.members) {
        const id = memberIdentity(member.key);
        const [admitted] = await sql`SELECT id FROM factory.change WHERE ticket_id=${id}`;
        for (const key of member.dependsOn) {
          const prerequisite = memberIdentity(key);
          const [edge] =
            await sql`SELECT ticket_id FROM factory.ticket_dependency WHERE project_id=${projectID} AND ticket_id=${id} AND prerequisite_id=${prerequisite}`;
          if (edge) continue;
          if (admitted)
            throw new CommandError(
              "conflict",
              "Do not change dependencies of admitted implementation",
            );
          await sql`INSERT INTO factory.ticket_dependency(project_id,ticket_id,prerequisite_id,created_by) VALUES(${projectID},${id},${prerequisite},${userID})`;
        }
      }
      if (convertOrigin)
        await sql`UPDATE factory.ticket SET converted_to_epic_id=${epicID},version=version+1,updated_at=now() WHERE id=${entry.ticketID}`;
      const members = [...identities.values()];
      await sql`INSERT INTO factory.epic_confirmation(id,project_id,proposal_entry_id,epic_id,origin_ticket_id,input_digest,decision,members,created_by)
        VALUES(${input.commandId},${projectID},${entryID},${epicID},${entry.ticketID},${digest},${JSON.stringify(input.proposal)}::jsonb,${JSON.stringify(members)}::jsonb,${userID})`;
      return { epicId: epicID, ticketIds: members };
    });
  };
}
