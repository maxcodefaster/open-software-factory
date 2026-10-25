import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { implementationInput } from "../../../../packages/change-domain/src/implementation";
import type { RequirementContent } from "../../../../packages/requirement-domain/src/content";
import type {
  TicketDocumentInput,
  TicketFollowUpInput,
} from "../../../../packages/requirement-domain/src/document";
import type { createAccessController } from "../access/controller";
import type { createAgentController } from "../agent/controller";
import { ticketDetailSchema, requirementRevisionSchema, changeSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { createChangeController } from "./controller";
import type { createTicketDocumentController } from "./document";
import type { createTicketTrashController } from "./trash";

export function createTicketService(options: {
  database: ReturnType<typeof createDatabase>;
  access: Pick<
    ReturnType<typeof createAccessController>,
    "requireTicket" | "requireDevelopment" | "canDevelop"
  >;
  documents: Pick<ReturnType<typeof createTicketDocumentController>, "save" | "followUp">;
  trash: Pick<ReturnType<typeof createTicketTrashController>, "trash" | "restore">;
  changes: Pick<ReturnType<typeof createChangeController>, "start" | "createRevision" | "approve">;
  agent: Pick<ReturnType<typeof createAgentController>, "admitStartIn">;
}) {
  const { database, access } = options;
  // JSON used to serialize SQL Dates at the HTTP boundary. Keep the same
  // application DTO when the native transport can otherwise retain a Date.
  const revisionDTO = (row: Record<string, unknown>) => ({
    ...row,
    createdAt: row["createdAt"] instanceof Date ? row["createdAt"].toISOString() : row["createdAt"],
    approvedAt:
      row["approvedAt"] instanceof Date ? row["approvedAt"].toISOString() : row["approvedAt"],
  });
  return {
    async createRevision(userID: string, ticketID: string, input: RequirementContent) {
      await access.requireTicket(userID, ticketID);
      const value = await options.changes.createRevision(ticketID, input, userID);
      if (!value)
        throw new CommandError(
          "unavailable",
          "Requirement response is unconfirmed. Refresh the saved Ticket.",
        );
      return requirementRevisionSchema.parse(revisionDTO(value));
    },
    async approveRevision(userID: string, ticketID: string, revisionID: string) {
      await access.requireTicket(userID, ticketID);
      const value = await options.changes.approve(ticketID, revisionID, userID);
      if (!value)
        throw new CommandError(
          "unavailable",
          "Approval response is unconfirmed. Refresh the saved Ticket.",
        );
      const at: unknown = value.approvedAt;
      return at instanceof Date ? { ...value, approvedAt: at.toISOString() } : value;
    },
    async startChange(userID: string, ticketID: string) {
      await access.requireTicket(userID, ticketID);
      return changeSchema.parse(await options.changes.start(ticketID, userID));
    },
    async detail(userID: string, ticketID: string) {
      await access.requireTicket(userID, ticketID);
      const [ticket] = await database.client<Array<Record<string, unknown>>>`
        SELECT id, project_id AS "projectId", epic_id AS "epicId", converted_to_epic_id AS "convertedToEpicId", title, description, state, version::integer AS version,
          trashed_at AS "trashedAt", trash_stop_pending AS "trashStopPending", trash_error AS "trashError"
        FROM factory.ticket WHERE id = ${ticketID}`;
      if (!ticket) throw new CommandError("not-found", "Ticket not found");
      const revisions = await database.client<Array<Record<string, unknown>>>`
        SELECT revision.id, revision.ticket_id AS "ticketId", revision.ordinal,
          revision.canonical_content AS "canonicalContent",
          revision.content_digest AS "contentDigest", revision.created_at AS "createdAt",
          approval.id AS "approvalId", approval.approved_at AS "approvedAt",
          approval.monitoring_incident_id AS "monitoringIncidentId",author.name AS author
        FROM factory.requirement_revision revision
        LEFT JOIN auth."user" author ON author.id = revision.created_by
        LEFT JOIN factory.requirement_approval approval ON approval.requirement_revision_id = revision.id
        WHERE revision.ticket_id = ${ticketID} ORDER BY revision.ordinal DESC`;
      const documentRevisions = await database.client<Array<Record<string, unknown>>>`
        SELECT revision.id, revision.ordinal, revision.title, revision.description,
          revision.canonical_content AS "canonicalContent", revision.content_digest AS "contentDigest",
          revision.requirement_revision_id AS "requirementRevisionId", revision.created_at AS "createdAt", author.name AS author,
          revision.author_kind AS "authorKind", revision.proposal_entry_id AS "proposalEntryId",
          approval.id AS "approvalId",approval.monitoring_incident_id AS "monitoringIncidentId"
        FROM factory.ticket_document_revision revision LEFT JOIN auth."user" author ON author.id = revision.created_by
        LEFT JOIN factory.requirement_approval approval ON approval.requirement_revision_id = revision.requirement_revision_id
          AND EXISTS(SELECT 1 FROM factory.requirement_revision scope WHERE scope.id=revision.requirement_revision_id AND scope.canonical_content=revision.canonical_content)
        WHERE revision.ticket_id = ${ticketID} ORDER BY revision.ordinal DESC`;
      const [origin] = await database.client<Array<{ id: string; title: string }>>`
        SELECT ticket.id, ticket.title FROM factory.ticket_follow_up follow JOIN factory.ticket ticket ON ticket.id = follow.source_ticket_id WHERE follow.ticket_id = ${ticketID}`;
      const followUps = await database.client<Array<{ id: string; title: string }>>`
        SELECT ticket.id, ticket.title FROM factory.ticket_follow_up follow JOIN factory.ticket ticket ON ticket.id = follow.ticket_id WHERE follow.source_ticket_id = ${ticketID}`;
      const [proposal] = await database.client<
        Array<{ id: string; payload: Record<string, unknown> }>
      >`
        SELECT entry.id,entry.payload FROM factory.conversation_entry entry
        JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
        WHERE conversation.ticket_id=${ticketID} AND entry.kind='requirement'
          AND NOT EXISTS(SELECT 1 FROM factory.ticket_document_revision document WHERE document.proposal_entry_id=entry.id)
          AND NOT EXISTS(SELECT 1 FROM factory.conversation_entry newer WHERE newer.conversation_id=entry.conversation_id
            AND newer.kind='requirement' AND newer.ordinal>entry.ordinal)
        ORDER BY entry.ordinal DESC LIMIT 1`;
      const visibleProposal =
        proposal?.payload["visibility"] !== "developer" ||
        (typeof ticket["projectId"] === "string" &&
          (await access.canDevelop(userID, ticket["projectId"])));
      return ticketDetailSchema.parse({
        ticket: {
          ...ticket,
          trashedAt:
            ticket["trashedAt"] instanceof Date
              ? ticket["trashedAt"].toISOString()
              : ticket["trashedAt"],
        },
        revisions: revisions.map(revisionDTO),
        documentRevisions: documentRevisions.map(revisionDTO),
        proposal:
          visibleProposal && proposal?.payload["base"] && proposal.payload["requirement"]
            ? { ...proposal.payload, id: proposal.id }
            : null,
        origin: origin ?? null,
        followUps,
      });
    },
    async save(userID: string, ticketID: string, input: TicketDocumentInput) {
      await access.requireTicket(userID, ticketID);
      return options.documents.save(ticketID, userID, input);
    },
    async followUp(userID: string, ticketID: string, input: TicketFollowUpInput) {
      await access.requireTicket(userID, ticketID);
      return options.documents.followUp(ticketID, userID, input);
    },
    async trash(userID: string, ticketID: string) {
      await access.requireTicket(userID, ticketID);
      await options.trash.trash(ticketID, userID);
    },
    async restore(userID: string, ticketID: string, expectedVersion: number) {
      await access.requireTicket(userID, ticketID);
      await options.trash.restore(ticketID, userID, expectedVersion);
    },
    async implement(userID: string, ticketID: string, input: z.output<typeof implementationInput>) {
      await access.requireTicket(userID, ticketID);
      if (input.codingReasoning) {
        const [ticket] = await database.client<Array<{ projectID: string }>>`
          SELECT project_id AS "projectID" FROM factory.ticket WHERE id=${ticketID}`;
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await access.requireDevelopment(userID, ticket.projectID);
      }
      const change = await options.changes.start(ticketID, userID, {
        commandID: input.commandId,
        revisionID: input.revisionId,
        ...(input.codingReasoning ? { codingReasoning: input.codingReasoning } : {}),
        admitBuild: (sql, changeID) =>
          options.agent.admitStartIn(sql, changeID, userID, input.commandId, input.codingReasoning),
      });
      return { id: z.uuid().parse(change?.id) };
    },
  };
}
