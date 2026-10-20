import { createHash } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import type {
  TicketDocumentInput,
  TicketFollowUpInput,
} from "../../../../packages/requirement-domain/src/document";
import { canonicalRequirementContent } from "../../../../packages/requirement-domain/src/requirement";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { z } from "zod";
import { requirementContentInput } from "../../../../packages/requirement-domain/src/content";

const proposedDocument = z.object({
  ticket: z.object({ title: z.string(), description: z.string() }),
  requirement: requirementContentInput,
  base: z.object({
    id: z.uuid(),
    version: z.number(),
    documentId: z.uuid().nullable(),
    revisionId: z.uuid().nullable(),
  }),
});

export function createTicketDocumentController(database: ReturnType<typeof createDatabase>) {
  return {
    async followUp(ticketID: string, userID: string, input: TicketFollowUpInput) {
      return database.client.begin(async (sql) => {
        const [ticket] = await sql<
          Array<{ projectID: string; title: string; description: string; epicID: string | null }>
        >`
          SELECT project_id AS "projectID", title, description, epic_id AS "epicID" FROM factory.ticket WHERE id = ${ticketID} AND trashed_at IS NULL FOR UPDATE`;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        const [existing] = await sql<
          Array<{ sourceID: string; documentID: string | null; revisionID: string; userID: string }>
        >`
          SELECT follow.source_ticket_id AS "sourceID", follow.source_document_id AS "documentID", follow.source_revision_id AS "revisionID", ticket.created_by AS "userID"
          FROM factory.ticket_follow_up follow JOIN factory.ticket ticket ON ticket.id = follow.ticket_id WHERE follow.ticket_id = ${input.commandId}`;
        if (existing) {
          if (
            existing.sourceID !== ticketID ||
            existing.documentID !== input.expectedDocumentId ||
            existing.revisionID !== input.requirementRevisionId ||
            existing.userID !== userID
          )
            throw new CommandError("conflict", "This follow-up command belongs to different work");
          return { ticketId: input.commandId };
        }
        const [delivered] = await sql`
          SELECT change.id FROM factory.change change JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
          WHERE change.ticket_id = ${ticketID} AND change.state = 'delivered' AND approval.requirement_revision_id = ${input.requirementRevisionId}`;
        if (!delivered)
          throw new CommandError("conflict", "Follow-up work requires a delivered Ticket");
        const [document] = await sql<Array<{ id: string; canonical: string }>>`
          SELECT id, canonical_content AS canonical FROM factory.ticket_document_revision WHERE ticket_id = ${ticketID} ORDER BY ordinal DESC LIMIT 1`;
        if ((document?.id ?? null) !== input.expectedDocumentId)
          throw new CommandError(
            "conflict",
            "The document changed. Review it before creating follow-up work.",
          );
        const [revision] = await sql<
          Array<{ canonical: string }>
        >`SELECT canonical_content AS canonical FROM factory.requirement_revision WHERE id = ${input.requirementRevisionId} AND ticket_id = ${ticketID}`;
        const canonical = document?.canonical ?? revision?.canonical;
        if (!canonical) throw new CommandError("conflict", "Requirements are unavailable");
        await sql`INSERT INTO factory.ticket(id, project_id, epic_id, title, description, state, created_by)
          VALUES (${input.commandId}, ${ticket.projectID}, ${ticket.epicID}, ${`Follow-up: ${ticket.title}`.slice(0, 200)}, ${ticket.description}, 'ready', ${userID})`;
        await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
          VALUES (${crypto.randomUUID()}, ${input.commandId}, 1, ${canonical}, ${createHash("sha256").update(canonical).digest("hex")}, ${userID})`;
        await sql`INSERT INTO factory.ticket_follow_up(ticket_id, source_ticket_id, source_document_id, source_revision_id)
          VALUES (${input.commandId}, ${ticketID}, ${document?.id ?? null}, ${input.requirementRevisionId})`;
        return { ticketId: input.commandId };
      });
    },
    async save(ticketID: string, userID: string, input: TicketDocumentInput) {
      const complete = requirementContentInput.safeParse(input.requirement);
      const canonical = complete.success
        ? canonicalRequirementContent(complete.data)
        : JSON.stringify(input.requirement);
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const inputDigest = digest(JSON.stringify(input));
      return database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${ticketID}`}))`;
        const tickets = await sql<Array<{ projectID: string; version: number; state: string }>>`
          SELECT project_id AS "projectID", version::integer, state FROM factory.ticket
          WHERE id = ${ticketID} AND trashed_at IS NULL AND converted_to_epic_id IS NULL FOR UPDATE`;
        const ticket = tickets[0];
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        const replay = await sql<
          Array<{
            id: string;
            inputDigest: string;
            ticketID: string;
            userID: string;
            requirementRevisionId: string | null;
          }>
        >`
          SELECT id, input_digest AS "inputDigest", ticket_id AS "ticketID", created_by AS "userID",
            requirement_revision_id AS "requirementRevisionId"
          FROM factory.ticket_document_revision WHERE id = ${input.commandId}`;
        if (replay[0]) {
          if (
            replay[0].inputDigest !== inputDigest ||
            replay[0].ticketID !== ticketID ||
            replay[0].userID !== userID
          )
            throw new CommandError("conflict", "This save command belongs to another document");
          return {
            id: replay[0].id,
            ticketVersion: input.expectedVersion + 1,
            requirementRevisionId: replay[0].requirementRevisionId ?? input.requirementRevisionId,
          };
        }
        const approvals = await sql<Array<{ revisionID: string }>>`
          SELECT requirement_revision_id AS "revisionID" FROM factory.requirement_approval WHERE ticket_id = ${ticketID}`;
        const [latest] = await sql<Array<{ id: string; ordinal: number; canonical: string }>>`
          SELECT id, ordinal, canonical_content AS canonical FROM factory.requirement_revision WHERE ticket_id=${ticketID}
          ORDER BY ordinal DESC LIMIT 1`;
        if ((approvals[0]?.revisionID ?? latest?.id ?? null) !== input.requirementRevisionId)
          throw new CommandError(
            "conflict",
            "The implementation scope changed. Reload the Ticket before saving.",
          );
        const current = await sql<Array<{ id: string; ordinal: number }>>`
          SELECT id, ordinal FROM factory.ticket_document_revision WHERE ticket_id = ${ticketID} ORDER BY ordinal DESC LIMIT 1`;
        if (
          ticket.version !== input.expectedVersion ||
          (current[0]?.id ?? null) !== input.expectedDocumentId
        )
          throw new CommandError(
            "conflict",
            "The document changed elsewhere. Your draft is retained.",
          );
        if (ticket.state === "cancelled")
          throw new CommandError("conflict", "Restore the Ticket before editing");
        if (input.proposalEntryId) {
          if (approvals.length)
            throw new CommandError(
              "conflict",
              "These requirements already have implementation scope",
            );
          const [entry] = await sql<Array<{ payload: Record<string, unknown> }>>`
            SELECT entry.payload FROM factory.conversation_entry entry
            JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
            WHERE entry.id=${input.proposalEntryId} AND conversation.ticket_id=${ticketID}
              AND entry.kind='requirement' AND entry.actor='project-agent'
              AND NOT EXISTS (SELECT 1 FROM factory.conversation_entry newer
                WHERE newer.conversation_id=entry.conversation_id AND newer.kind='requirement'
                  AND newer.ordinal>entry.ordinal)`;
          if (entry?.payload["visibility"] === "developer") {
            const { projectDevelopmentAuthorityIn } = await import("../access/controller");
            await projectDevelopmentAuthorityIn(sql, userID, ticket.projectID);
          }
          const proposal = proposedDocument.safeParse(entry?.payload);
          if (
            !proposal.success ||
            proposal.data.base.id !== ticketID ||
            proposal.data.base.version !== ticket.version ||
            proposal.data.base.documentId !== (current[0]?.id ?? null) ||
            proposal.data.base.revisionId !== (latest?.id ?? null)
          )
            throw new CommandError(
              "conflict",
              "The Ticket changed. Elaborate the proposal against your current text.",
            );
          // Human confirmation accepts the visible, possibly edited proposal. The
          // admitted base above still fences concurrent edits and superseded proposals.
        }
        let revisionID = input.requirementRevisionId;
        if (!approvals.length && complete.success && latest?.canonical !== canonical) {
          revisionID = input.commandId;
          await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
            VALUES (${revisionID}, ${ticketID}, ${(latest?.ordinal ?? 0) + 1}, ${canonical}, ${digest(canonical)}, ${userID})`;
        }
        if (!approvals.length && !complete.success) revisionID = null;
        const ordinal = Math.max(current[0]?.ordinal ?? 0, latest?.ordinal ?? 0) + 1;
        await sql`INSERT INTO factory.ticket_document_revision(
          id, ticket_id, ordinal, title, description, canonical_content, content_digest, requirement_revision_id, input_digest, created_by, author_kind, proposal_entry_id)
          VALUES (${input.commandId}, ${ticketID}, ${ordinal}, ${input.title}, ${input.description}, ${canonical}, ${digest(canonical)}, ${revisionID}, ${inputDigest}, ${userID}, ${input.proposalEntryId ? "ai" : "human"}, ${input.proposalEntryId ?? null})`;
        await sql`UPDATE factory.ticket SET title = ${input.title}, description = ${input.description}, version = version + 1, updated_at = now() WHERE id = ${ticketID}`;
        return {
          id: input.commandId,
          ticketVersion: ticket.version + 1,
          // Partial documents do not produce a complete Requirement Revision,
          // but the next save still fences the previous scope.
          requirementRevisionId: revisionID ?? input.requirementRevisionId,
        };
      });
    },
  };
}
