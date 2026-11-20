import { and, desc, eq, exists, gt, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { implementationInput } from "../../../../packages/change-domain/src/implementation";
import { sourceCitationInput } from "../../../../packages/conversation-domain/src/conversation";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  authUser,
  conversationEntry,
  implementationOrder,
  requirementApproval,
  requirementRevision,
  technicalDesignRevision,
  ticket,
  ticketConversation,
  ticketDocumentRevision,
  ticketFollowUp,
} from "../../../../packages/db/src/schema";
import type { RequirementContent } from "../../../../packages/requirement-domain/src/content";
import type {
  TicketDocumentInput,
  TicketFollowUpInput,
} from "../../../../packages/requirement-domain/src/document";
import type { saveTechnicalDesignInput } from "../../../../packages/requirement-domain/src/technical-design";
import type { createAccessController } from "../access/controller";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { createAgentController } from "../agent/controller";
import { changeSchema, requirementRevisionSchema, ticketDetailSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import type { createProjectAgentController } from "../project-agent/controller";
import { renderArchitectureDiagrams } from "../technical-design/diagrams";
import { saveTechnicalDesignIn, technicalPlanningOutstandingIn } from "../technical-design/store";
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
  planning?: Pick<ReturnType<typeof createProjectAgentController>, "recover">;
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
      const db = database.db;
      const [savedTicket] = await db
        .select({
          id: ticket.id,
          projectId: ticket.projectId,
          epicId: ticket.epicId,
          convertedToEpicId: ticket.convertedToEpicId,
          title: ticket.title,
          description: ticket.description,
          state: ticket.state,
          version: ticket.version,
          trashedAt: ticket.trashedAt,
          trashStopPending: ticket.trashStopPending,
          trashError: ticket.trashError,
        })
        .from(ticket)
        .where(eq(ticket.id, ticketID));
      if (!savedTicket) throw new CommandError("not-found", "Ticket not found");
      const revisions = await db
        .select({
          id: requirementRevision.id,
          ticketId: requirementRevision.ticketId,
          ordinal: requirementRevision.ordinal,
          canonicalContent: requirementRevision.canonicalContent,
          contentDigest: requirementRevision.contentDigest,
          createdAt: requirementRevision.createdAt,
          approvalId: requirementApproval.id,
          approvedAt: requirementApproval.approvedAt,
          monitoringIncidentId: requirementApproval.monitoringIncidentId,
          author: authUser.name,
        })
        .from(requirementRevision)
        .leftJoin(authUser, eq(authUser.id, requirementRevision.createdBy))
        .leftJoin(
          requirementApproval,
          eq(requirementApproval.requirementRevisionId, requirementRevision.id),
        )
        .where(eq(requirementRevision.ticketId, ticketID))
        .orderBy(desc(requirementRevision.ordinal));
      const documentRevisions = await db
        .select({
          id: ticketDocumentRevision.id,
          ordinal: ticketDocumentRevision.ordinal,
          title: ticketDocumentRevision.title,
          description: ticketDocumentRevision.description,
          canonicalContent: ticketDocumentRevision.canonicalContent,
          contentDigest: ticketDocumentRevision.contentDigest,
          requirementRevisionId: ticketDocumentRevision.requirementRevisionId,
          createdAt: ticketDocumentRevision.createdAt,
          author: authUser.name,
          authorKind: ticketDocumentRevision.authorKind,
          proposalEntryId: ticketDocumentRevision.proposalEntryId,
          approvalId: requirementApproval.id,
          monitoringIncidentId: requirementApproval.monitoringIncidentId,
        })
        .from(ticketDocumentRevision)
        .leftJoin(authUser, eq(authUser.id, ticketDocumentRevision.createdBy))
        .leftJoin(
          requirementApproval,
          and(
            eq(
              requirementApproval.requirementRevisionId,
              ticketDocumentRevision.requirementRevisionId,
            ),
            exists(
              db
                .select({ id: requirementRevision.id })
                .from(requirementRevision)
                .where(
                  and(
                    eq(requirementRevision.id, ticketDocumentRevision.requirementRevisionId),
                    eq(
                      requirementRevision.canonicalContent,
                      ticketDocumentRevision.canonicalContent,
                    ),
                  ),
                ),
            ),
          ),
        )
        .where(eq(ticketDocumentRevision.ticketId, ticketID))
        .orderBy(desc(ticketDocumentRevision.ordinal));
      const [origin] = await db
        .select({ id: ticket.id, title: ticket.title })
        .from(ticketFollowUp)
        .innerJoin(ticket, eq(ticket.id, ticketFollowUp.sourceTicketId))
        .where(eq(ticketFollowUp.ticketId, ticketID));
      const followUps = await db
        .select({ id: ticket.id, title: ticket.title })
        .from(ticketFollowUp)
        .innerJoin(ticket, eq(ticket.id, ticketFollowUp.ticketId))
        .where(eq(ticketFollowUp.sourceTicketId, ticketID));
      const newer = alias(conversationEntry, "newer");
      const [proposal] = await db
        .select({ id: conversationEntry.id, payload: conversationEntry.payload })
        .from(conversationEntry)
        .innerJoin(ticketConversation, eq(ticketConversation.id, conversationEntry.conversationId))
        .where(
          and(
            eq(ticketConversation.ticketId, ticketID),
            eq(conversationEntry.kind, "requirement"),
            notExists(
              db
                .select({ id: ticketDocumentRevision.id })
                .from(ticketDocumentRevision)
                .where(eq(ticketDocumentRevision.proposalEntryId, conversationEntry.id)),
            ),
            notExists(
              db
                .select({ id: newer.id })
                .from(newer)
                .where(
                  and(
                    eq(newer.conversationId, conversationEntry.conversationId),
                    eq(newer.kind, "requirement"),
                    gt(newer.ordinal, conversationEntry.ordinal),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(conversationEntry.ordinal))
        .limit(1);
      const visibleProposal =
        proposal?.payload["visibility"] !== "developer" ||
        (await access.canDevelop(userID, savedTicket.projectId));
      const developer = await access.canDevelop(userID, savedTicket.projectId);
      const [technical] = await db
        .select({ id: technicalDesignRevision.id })
        .from(technicalDesignRevision)
        .where(eq(technicalDesignRevision.ticketId, ticketID))
        .limit(1);
      const technicalDesigns = developer
        ? await db
            .select({
              id: technicalDesignRevision.id,
              ordinal: technicalDesignRevision.ordinal,
              requirementRevisionId: technicalDesignRevision.requirementRevisionId,
              sourceCommit: technicalDesignRevision.sourceCommit,
              canonicalContent: technicalDesignRevision.canonicalContent,
              citations: technicalDesignRevision.citations,
              diagramRenders: technicalDesignRevision.diagramRenders,
              rendererVersion: technicalDesignRevision.rendererVersion,
              authorKind: technicalDesignRevision.authorKind,
              createdAt: technicalDesignRevision.createdAt,
              approved: exists(
                db
                  .select({ id: requirementApproval.id })
                  .from(requirementApproval)
                  .where(
                    eq(requirementApproval.technicalDesignRevisionId, technicalDesignRevision.id),
                  ),
              ),
            })
            .from(technicalDesignRevision)
            .where(eq(technicalDesignRevision.ticketId, ticketID))
            .orderBy(desc(technicalDesignRevision.ordinal))
        : [];
      const technicalPlanningPending = await database.client.begin((sql) =>
        technicalPlanningOutstandingIn(sql, ticketID, revisions[0]?.id ?? null),
      );
      const [order] = await db
        .select({
          commandId: implementationOrder.commandId,
          state: implementationOrder.state,
          reason: implementationOrder.lastError,
          createdBy: implementationOrder.createdBy,
        })
        .from(implementationOrder)
        .where(eq(implementationOrder.ticketId, ticketID))
        .orderBy(desc(implementationOrder.createdAt))
        .limit(1);
      if (developer) await access.requireDevelopment(userID, savedTicket.projectId);
      return ticketDetailSchema.parse({
        ticket: {
          ...savedTicket,
          trashedAt:
            savedTicket.trashedAt instanceof Date
              ? savedTicket.trashedAt.toISOString()
              : savedTicket.trashedAt,
        },
        revisions: revisions.map(revisionDTO),
        documentRevisions: documentRevisions.map(revisionDTO),
        proposal:
          visibleProposal && proposal?.payload["base"] && proposal.payload["requirement"]
            ? { ...proposal.payload, id: proposal.id }
            : null,
        origin: origin ?? null,
        followUps,
        technicalDesignPresent: Boolean(technical),
        technicalPlanningPending,
        technicalDesigns: technicalDesigns.map((design) => ({
          ...revisionDTO(design),
          content: JSON.parse(String(design["canonicalContent"])),
        })),
        implementationOrder: order
          ? {
              ...order,
              canCancel: developer || order.createdBy === userID,
            }
          : null,
      });
    },
    async cancelImplementation(userID: string, ticketID: string, commandID: string) {
      await access.requireTicket(userID, ticketID);
      await database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const [savedTicket] = await db
          .select({ projectID: ticket.projectId })
          .from(ticket)
          .where(eq(ticket.id, ticketID))
          .for("update");
        if (!savedTicket) throw new CommandError("not-found", "Ticket not found.");
        await projectAuthorityIn(transaction, userID, savedTicket.projectID);
        const [order] = await db
          .select({ userID: implementationOrder.createdBy })
          .from(implementationOrder)
          .where(
            and(
              eq(implementationOrder.commandId, commandID),
              eq(implementationOrder.ticketId, ticketID),
              eq(implementationOrder.state, "waiting"),
            ),
          )
          .for("update");
        if (!order)
          throw new CommandError("conflict", "This implementation order is no longer waiting.");
        if (order.userID !== userID) {
          await projectDevelopmentAuthorityIn(transaction, userID, savedTicket.projectID);
        }
        await db
          .update(implementationOrder)
          .set({
            state: "cancelled",
            cancelledBy: userID,
            cancelledAt: sql<Date>`now()`,
            updatedAt: sql<Date>`now()`,
          })
          .where(eq(implementationOrder.commandId, commandID));
      });
    },
    async saveTechnicalDesign(
      userID: string,
      ticketID: string,
      input: z.output<typeof saveTechnicalDesignInput>,
    ) {
      await access.requireTicket(userID, ticketID);
      const [savedTicket] = await database.db
        .select({ projectID: ticket.projectId })
        .from(ticket)
        .where(eq(ticket.id, ticketID));
      if (!savedTicket) throw new CommandError("not-found", "Ticket not found.");
      await access.requireDevelopment(userID, savedTicket.projectID);
      const [previous] = await database.db
        .select({
          requirementRevisionId: technicalDesignRevision.requirementRevisionId,
          sourceCommit: technicalDesignRevision.sourceCommit,
          citations: technicalDesignRevision.citations,
          planningTurnID: technicalDesignRevision.planningTurnId,
        })
        .from(technicalDesignRevision)
        .where(
          and(
            eq(technicalDesignRevision.id, input.expectedRevisionId),
            eq(technicalDesignRevision.ticketId, ticketID),
          ),
        );
      if (!previous) throw new CommandError("conflict", "The technical design is unavailable.");
      const [document] = await database.db
        .select({ id: ticketDocumentRevision.id })
        .from(ticketDocumentRevision)
        .where(eq(ticketDocumentRevision.ticketId, ticketID))
        .orderBy(desc(ticketDocumentRevision.ordinal))
        .limit(1);
      const renders = await renderArchitectureDiagrams(input.content);
      await database.client.begin((sql) =>
        saveTechnicalDesignIn(sql, {
          id: input.commandId,
          ticketID,
          userID,
          content: input.content,
          renders,
          citations: z.array(sourceCitationInput).parse(previous.citations),
          base: {
            requirementRevisionId: previous.requirementRevisionId,
            sourceCommit: previous.sourceCommit,
            previousDesignId: input.expectedRevisionId,
            documentId: document?.id ?? null,
            ...(previous.planningTurnID ? { requestId: previous.planningTurnID } : {}),
          },
        }),
      );
      return { id: input.commandId };
    },
    async save(userID: string, ticketID: string, input: TicketDocumentInput) {
      await access.requireTicket(userID, ticketID);
      const saved = await options.documents.save(ticketID, userID, input);
      if (input.proposalEntryId)
        void options.planning?.recover().catch(reportFailure("Planning recovery"));
      return saved;
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
        const [savedTicket] = await database.db
          .select({ projectID: ticket.projectId })
          .from(ticket)
          .where(eq(ticket.id, ticketID));
        if (!savedTicket) throw new CommandError("not-found", "Ticket not found");
        await access.requireDevelopment(userID, savedTicket.projectID);
      }
      const change = await options.changes.start(ticketID, userID, {
        commandID: input.commandId,
        revisionID: input.revisionId,
        ...(input.technicalDesignRevisionId
          ? { technicalDesignRevisionID: input.technicalDesignRevisionId }
          : {}),
        ...(input.codingReasoning ? { codingReasoning: input.codingReasoning } : {}),
        admitBuild: (sql, changeID) =>
          options.agent.admitStartIn(sql, changeID, userID, input.commandId, input.codingReasoning),
      });
      return { id: z.uuid().parse(change?.id ?? input.commandId) };
    },
  };
}
