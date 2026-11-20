import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql as query } from "drizzle-orm";
import { z } from "zod";
import {
  confirmEpicProposalInput,
  epicProposalInput,
} from "../../../../packages/conversation-domain/src/epic-proposal";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurn,
  change,
  conversationEntry,
  epic,
  epicConfirmation,
  requirementRevision,
  ticket,
  ticketConversation,
  ticketDependency,
  ticketDocumentRevision,
} from "../../../../packages/db/src/schema";
import { canonicalRequirementContent } from "../../../../packages/requirement-domain/src/requirement";
import { insertInitialTicketIn } from "../../../../packages/ticket-authoring/src/authoring";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { lockConversation } from "../conversations/store";

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
      const db = drizzleTransaction(sql);
      const [replay] = await db
        .select({
          id: epicConfirmation.id,
          epicID: epicConfirmation.epicId,
          inputDigest: epicConfirmation.inputDigest,
          userID: epicConfirmation.createdBy,
          members: epicConfirmation.members,
        })
        .from(epicConfirmation)
        .where(
          or(
            eq(epicConfirmation.id, input.commandId),
            eq(epicConfirmation.proposalEntryId, entryID),
          ),
        );
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
        return { epicId: replay.epicID, ticketIds: replay.members as string[] };
      }
      const [entry] = await db
        .select({
          payload: conversationEntry.payload,
          ticketID: ticketConversation.ticketId,
          conversationID: ticketConversation.id,
          createdBy: ticketConversation.createdBy,
          ordinal: conversationEntry.ordinal,
        })
        .from(conversationEntry)
        .innerJoin(ticketConversation, eq(ticketConversation.id, conversationEntry.conversationId))
        .where(
          and(
            eq(conversationEntry.id, entryID),
            eq(conversationEntry.kind, "requirement"),
            eq(ticketConversation.projectId, projectID),
            or(isNotNull(ticketConversation.ticketId), eq(ticketConversation.createdBy, userID)),
          ),
        );
      if (!entry) throw new CommandError("not-found", "Epic proposal not found");
      const boundary = entry.ticketID
        ? `agent-turn:${projectID}:ticket:${entry.ticketID}`
        : `agent-turn:${projectID}:draft:${entry.createdBy}`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${boundary}))`;
      await lockConversation(sql, entry.conversationID);
      const [active] = await db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(
          and(
            eq(agentTurn.conversationId, entry.conversationID),
            inArray(agentTurn.state, ["pending", "dispatching", "running"]),
          ),
        )
        .limit(1);
      if (active)
        throw new CommandError("conflict", "Wait for the current clarification before confirming");
      const original = epicProposalInput.safeParse(entry.payload["epicProposal"]);
      if (!original.success) throw new CommandError("conflict", "This is not an Epic proposal");
      if (entry.payload["visibility"] === "developer") {
        const { projectDevelopmentAuthorityIn } = await import("../access/controller");
        await projectDevelopmentAuthorityIn(sql, userID, projectID);
      }
      const [newer] = await db
        .select({ id: conversationEntry.id })
        .from(conversationEntry)
        .where(
          and(
            eq(conversationEntry.conversationId, entry.conversationID),
            eq(conversationEntry.kind, "requirement"),
            gt(conversationEntry.ordinal, entry.ordinal),
          ),
        )
        .limit(1);
      if (newer) throw new CommandError("conflict", "Review the latest proposal before confirming");
      const reused = input.proposal.members.flatMap((member) =>
        member.existingTicketId ? [member.existingTicketId] : [],
      );
      const ticketIDs = [
        ...new Set([...reused, ...(entry.ticketID ? [entry.ticketID] : [])]),
      ].sort();
      for (const id of ticketIDs)
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`ticket:${id}`}))`;
      const tickets = await db
        .select({
          id: ticket.id,
          version: ticket.version,
          epicID: ticket.epicId,
          converted: ticket.convertedToEpicId,
          state: ticket.state,
          title: ticket.title,
        })
        .from(ticket)
        .where(
          and(
            inArray(ticket.id, ticketIDs),
            eq(ticket.projectId, projectID),
            isNull(ticket.trashedAt),
          ),
        )
        .orderBy(asc(ticket.id))
        .for("update");
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
        const [document] = await db
          .select({ id: ticketDocumentRevision.id })
          .from(ticketDocumentRevision)
          .where(eq(ticketDocumentRevision.ticketId, entry.ticketID))
          .orderBy(desc(ticketDocumentRevision.ordinal))
          .limit(1);
        const [revision] = await db
          .select({ id: requirementRevision.id })
          .from(requirementRevision)
          .where(eq(requirementRevision.ticketId, entry.ticketID))
          .orderBy(desc(requirementRevision.ordinal))
          .limit(1);
        if (
          !base.success ||
          base.data.id !== entry.ticketID ||
          !origin ||
          origin.converted ||
          origin.state === "cancelled" ||
          origin.version !== base.data.version ||
          (document?.id ?? null) !== base.data.documentId ||
          (revision?.id ?? null) !== base.data.revisionId
        )
          throw new CommandError(
            "conflict",
            "The originating Ticket changed. Clarify against its current text",
          );
        const [admitted] = await db
          .select({ id: change.id })
          .from(change)
          .where(eq(change.ticketId, entry.ticketID));
        convertOrigin = !admitted;
        if (convertOrigin && reused.includes(entry.ticketID))
          throw new CommandError(
            "conflict",
            "The original intent becomes the Epic, not a duplicate aggregate Ticket",
          );
        if (!convertOrigin && !reused.includes(entry.ticketID))
          throw new CommandError("conflict", "Keep the implemented original as an existing member");
        const [relationships] = await db
          .select({ ticketID: ticketDependency.ticketId })
          .from(ticketDependency)
          .where(
            or(
              eq(ticketDependency.ticketId, entry.ticketID),
              eq(ticketDependency.prerequisiteId, entry.ticketID),
            ),
          )
          .limit(1);
        if (convertOrigin && (origin.epicID || relationships))
          throw new CommandError(
            "conflict",
            "Remove the original intent's Epic and prerequisite links before converting it",
          );
      }
      const epicID = proposalIdentity(entryID, "epic");
      await db.insert(epic).values({
        id: epicID,
        projectId: projectID,
        title: input.proposal.epic.title,
        description: input.proposal.epic.description,
        createdBy: userID,
      });
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
          await db
            .update(ticket)
            .set({
              epicId: epicID,
              version: query<number>`${ticket.version}+1`,
              updatedAt: query<Date>`now()`,
            })
            .where(eq(ticket.id, id));
        } else {
          await insertInitialTicketIn(db, {
            id,
            projectId: projectID,
            epicId: epicID,
            title: member.title,
            description: member.description,
            state: "ready",
            createdBy: userID,
            authoring: {
              requirement: {
                id: proposalIdentity(entryID, `${member.key}:revision`),
                canonicalContent: canonicalRequirementContent(member.requirement),
              },
              document: {
                id: proposalIdentity(entryID, `${member.key}:document`),
                inputDigest: digest,
                authorKind: "ai",
              },
            },
          });
        }
      }
      for (const member of input.proposal.members) {
        const id = memberIdentity(member.key);
        const [admitted] = await db
          .select({ id: change.id })
          .from(change)
          .where(eq(change.ticketId, id));
        for (const key of member.dependsOn) {
          const prerequisite = memberIdentity(key);
          const [edge] = await db
            .select({ ticketID: ticketDependency.ticketId })
            .from(ticketDependency)
            .where(
              and(
                eq(ticketDependency.projectId, projectID),
                eq(ticketDependency.ticketId, id),
                eq(ticketDependency.prerequisiteId, prerequisite),
              ),
            );
          if (edge) continue;
          if (admitted)
            throw new CommandError(
              "conflict",
              "Do not change dependencies of admitted implementation",
            );
          await db.insert(ticketDependency).values({
            projectId: projectID,
            ticketId: id,
            prerequisiteId: prerequisite,
            createdBy: userID,
          });
        }
      }
      if (convertOrigin && entry.ticketID)
        await db
          .update(ticket)
          .set({
            convertedToEpicId: epicID,
            version: query<number>`${ticket.version}+1`,
            updatedAt: query<Date>`now()`,
          })
          .where(eq(ticket.id, entry.ticketID));
      const members = [...identities.values()];
      await db.insert(epicConfirmation).values({
        id: input.commandId,
        projectId: projectID,
        proposalEntryId: entryID,
        epicId: epicID,
        originTicketId: entry.ticketID,
        inputDigest: digest,
        decision: input.proposal,
        members,
        createdBy: userID,
      });
      return { epicId: epicID, ticketIds: members };
    });
  };
}
