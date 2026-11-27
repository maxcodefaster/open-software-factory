import { and, desc, eq, gt, inArray, isNull, notExists, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  auditEvent,
  change,
  conversationEntry,
  requirementApproval,
  requirementRevision,
  ticketConversation,
  ticketDocumentRevision,
  ticket as ticketTable,
} from "#db/schema";
import { requirementContentInput } from "#requirement-domain/content";
import type { TicketDocumentInput, TicketFollowUpInput } from "#requirement-domain/document";
import { canonicalRequirementContent, requirementDigest } from "#requirement-domain/requirement";
import { appendTicketAuthoringIn, insertInitialTicketIn } from "#ticket-authoring/authoring";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";

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

export function createTicketDocumentController(
  database: ReturnType<typeof createDatabase>,
  continuePlanning?: (
    sql: DatabaseTransaction,
    input: {
      commandID: string;
      projectID: string;
      ticketID: string;
      userID: string;
      sourceCommit: string;
      contextID?: string;
    },
  ) => Promise<unknown>,
) {
  return {
    async followUp(ticketID: string, userID: string, input: TicketFollowUpInput) {
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [ticket] = await db
          .select({
            projectID: ticketTable.projectId,
            title: ticketTable.title,
            description: ticketTable.description,
            epicID: ticketTable.epicId,
          })
          .from(ticketTable)
          .where(and(eq(ticketTable.id, ticketID), isNull(ticketTable.trashedAt)))
          .for("update");
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        const [existing] = await db
          .select({
            sourceID: query<string>`(${auditEvent.payload}->>'sourceTicketId')::uuid`,
            documentID: query<string | null>`(${auditEvent.payload}->>'sourceDocumentId')::uuid`,
            revisionID: query<string>`(${auditEvent.payload}->>'sourceRevisionId')::uuid`,
            userID: ticketTable.createdBy,
          })
          .from(auditEvent)
          .innerJoin(ticketTable, query`${ticketTable.id}::text = ${auditEvent.scopeId}`)
          .where(
            and(
              eq(auditEvent.kind, "tickets.follow_up"),
              eq(auditEvent.scopeType, "ticket"),
              eq(auditEvent.scopeId, input.commandId),
              eq(auditEvent.dedupeKey, `tickets.follow_up:${input.commandId}`),
            ),
          );
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
        if (input.commandId === ticketID)
          throw new CommandError("conflict", "This follow-up command belongs to different work");
        const [delivered] = await db
          .select({ id: change.id })
          .from(change)
          .innerJoin(requirementApproval, eq(requirementApproval.id, change.requirementApprovalId))
          .where(
            and(
              eq(change.ticketId, ticketID),
              eq(change.state, "delivered"),
              eq(requirementApproval.requirementRevisionId, input.requirementRevisionId),
            ),
          );
        if (!delivered)
          throw new CommandError("conflict", "Follow-up work requires a delivered Ticket");
        const [document] = await db
          .select({
            id: ticketDocumentRevision.id,
            canonical: ticketDocumentRevision.canonicalContent,
          })
          .from(ticketDocumentRevision)
          .where(eq(ticketDocumentRevision.ticketId, ticketID))
          .orderBy(desc(ticketDocumentRevision.ordinal))
          .limit(1);
        if ((document?.id ?? null) !== input.expectedDocumentId)
          throw new CommandError(
            "conflict",
            "The document changed. Review it before creating follow-up work.",
          );
        const [revision] = await db
          .select({ canonical: requirementRevision.canonicalContent })
          .from(requirementRevision)
          .where(
            and(
              eq(requirementRevision.id, input.requirementRevisionId),
              eq(requirementRevision.ticketId, ticketID),
            ),
          );
        const canonical = document?.canonical ?? revision?.canonical;
        if (!canonical) throw new CommandError("conflict", "Requirements are unavailable");
        await insertInitialTicketIn(db, {
          id: input.commandId,
          projectId: ticket.projectID,
          epicId: ticket.epicID,
          title: `Follow-up: ${ticket.title}`.slice(0, 200),
          description: ticket.description,
          state: "ready",
          createdBy: userID,
          authoring: {
            requirement: { id: crypto.randomUUID(), canonicalContent: canonical },
          },
        });
        await db.insert(auditEvent).values({
          id: input.commandId,
          kind: "tickets.follow_up",
          scopeType: "ticket",
          scopeId: input.commandId,
          dedupeKey: `tickets.follow_up:${input.commandId}`,
          actorId: userID,
          payload: {
            ticketId: input.commandId,
            sourceTicketId: ticketID,
            sourceDocumentId: document?.id ?? null,
            sourceRevisionId: input.requirementRevisionId,
          },
        });
        return { ticketId: input.commandId };
      });
    },
    async save(ticketID: string, userID: string, input: TicketDocumentInput) {
      const complete = requirementContentInput.safeParse(input.requirement);
      const canonical = complete.success
        ? canonicalRequirementContent(complete.data)
        : JSON.stringify(input.requirement);
      const inputDigest = requirementDigest(JSON.stringify(input));
      return database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${input.commandId}`}))`;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${ticketID}`}))`;
        const db = drizzleTransaction(sql);
        const tickets = await db
          .select({
            projectID: ticketTable.projectId,
            version: ticketTable.version,
            state: ticketTable.state,
          })
          .from(ticketTable)
          .where(
            and(
              eq(ticketTable.id, ticketID),
              isNull(ticketTable.trashedAt),
              isNull(ticketTable.convertedToEpicId),
            ),
          )
          .for("update");
        const ticket = tickets[0];
        if (!ticket) throw new CommandError("not-found", "Ticket not found");
        await projectAuthorityIn(sql, userID, ticket.projectID);
        const replay = await db
          .select({
            id: ticketDocumentRevision.id,
            inputDigest: ticketDocumentRevision.inputDigest,
            ticketID: ticketDocumentRevision.ticketId,
            userID: ticketDocumentRevision.createdBy,
            requirementRevisionId: ticketDocumentRevision.requirementRevisionId,
          })
          .from(ticketDocumentRevision)
          .where(eq(ticketDocumentRevision.id, input.commandId));
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
        const approvals = await db
          .select({ revisionID: requirementApproval.requirementRevisionId })
          .from(requirementApproval)
          .where(eq(requirementApproval.ticketId, ticketID));
        const [latest] = await db
          .select({
            id: requirementRevision.id,
            ordinal: requirementRevision.ordinal,
            canonical: requirementRevision.canonicalContent,
          })
          .from(requirementRevision)
          .where(eq(requirementRevision.ticketId, ticketID))
          .orderBy(desc(requirementRevision.ordinal))
          .limit(1);
        if ((approvals[0]?.revisionID ?? latest?.id ?? null) !== input.requirementRevisionId)
          throw new CommandError(
            "conflict",
            "The implementation scope changed. Reload the Ticket before saving.",
          );
        const current = await db
          .select({ id: ticketDocumentRevision.id, ordinal: ticketDocumentRevision.ordinal })
          .from(ticketDocumentRevision)
          .where(eq(ticketDocumentRevision.ticketId, ticketID))
          .orderBy(desc(ticketDocumentRevision.ordinal))
          .limit(1);
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
        let fullPlanningSource: string | undefined;
        let planningContextID: string | undefined;
        if (input.proposalEntryId) {
          if (approvals.length)
            throw new CommandError(
              "conflict",
              "These requirements already have implementation scope",
            );
          const newer = alias(conversationEntry, "newer");
          const [entry] = await db
            .select({ payload: conversationEntry.payload })
            .from(conversationEntry)
            .innerJoin(
              ticketConversation,
              eq(ticketConversation.id, conversationEntry.conversationId),
            )
            .where(
              and(
                eq(conversationEntry.id, input.proposalEntryId),
                eq(ticketConversation.ticketId, ticketID),
                eq(conversationEntry.kind, "requirement"),
                eq(conversationEntry.actor, "project-agent"),
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
            );
          const payload = entry?.payload;
          if (payload?.["visibility"] === "developer") {
            const { projectDevelopmentAuthorityIn } = await import("../access/authority");
            await projectDevelopmentAuthorityIn(sql, userID, ticket.projectID);
          }
          if (payload?.["fullPlanning"] === true) {
            fullPlanningSource = z
              .string()
              .regex(/^[a-f0-9]{40}$/)
              .parse(payload["sourceCommit"]);
            planningContextID = z.uuid().optional().parse(payload["contextId"]);
            if (!complete.success || !continuePlanning)
              throw new CommandError(
                "conflict",
                "Complete the product specification before continuing Technical Planning.",
              );
          }
          const proposal = proposedDocument.safeParse(payload);
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
        let requirement: { id: string; ordinal: number } | undefined;
        if (!approvals.length && complete.success && latest?.canonical !== canonical) {
          revisionID = input.commandId;
          requirement = { id: revisionID, ordinal: (latest?.ordinal ?? 0) + 1 };
        }
        if (!approvals.length && !complete.success) revisionID = null;
        const ordinal = Math.max(current[0]?.ordinal ?? 0, latest?.ordinal ?? 0) + 1;
        await appendTicketAuthoringIn(db, {
          ticketId: ticketID,
          createdBy: userID,
          title: input.title,
          description: input.description,
          canonicalContent: canonical,
          ...(requirement ? { requirement } : {}),
          document: {
            id: input.commandId,
            ordinal,
            requirementRevisionId: revisionID,
            inputDigest,
            authorKind: input.proposalEntryId ? "ai" : "human",
            ...(input.proposalEntryId ? { proposalEntryId: input.proposalEntryId } : {}),
          },
        });
        await db
          .update(ticketTable)
          .set({
            title: input.title,
            description: input.description,
            state: complete.success
              ? query`CASE WHEN ${inArray(ticketTable.state, ["inbox", "backlog"])}
                  THEN 'ready'::factory.ticket_state ELSE ${ticketTable.state} END`
              : ticketTable.state,
            version: query`${ticketTable.version} + 1`,
            updatedAt: query`now()`,
          })
          .where(eq(ticketTable.id, ticketID));
        if (fullPlanningSource && revisionID)
          await continuePlanning?.(sql, {
            commandID: input.commandId,
            projectID: ticket.projectID,
            ticketID,
            userID,
            sourceCommit: fullPlanningSource,
            ...(planningContextID ? { contextID: planningContextID } : {}),
          });
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
