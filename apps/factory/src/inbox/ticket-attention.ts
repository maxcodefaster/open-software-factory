import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import {
  accountAccess,
  administrator,
  agentTurn,
  auditEvent,
  authUser,
  change,
  conversationEntry,
  operation,
  projectMembership,
  reviewFeedback,
  ticket,
  ticketConversation,
} from "#db/schema";
import type { AttentionMember } from "#ticket-domain/attention";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { type InboxTicket, type InboxTransactionDB, upsertOperation } from "./attention-types";
import { type AttentionPerson, type responsibilityInput, ticketAttentionSchema } from "./contracts";

const memberCapabilities = {
  develop: sql<boolean>`${projectMembership.role}='developer' OR ${administrator.userId} IS NOT NULL`,
  manage: sql<boolean>`${projectMembership.manageProject} OR ${administrator.userId} IS NOT NULL`,
};

export async function peopleIn(
  transaction: DatabaseTransaction,
  projectID: string,
): Promise<AttentionPerson[]> {
  return drizzleTransaction(transaction)
    .select({
      id: authUser.id,
      name: authUser.name,
      ...memberCapabilities,
    })
    .from(projectMembership)
    .innerJoin(authUser, eq(authUser.id, projectMembership.userId))
    .innerJoin(accountAccess, eq(accountAccess.userId, authUser.id))
    .leftJoin(administrator, eq(administrator.userId, authUser.id))
    .where(
      and(
        eq(projectMembership.projectId, projectID),
        isNull(accountAccess.disabledAt),
        isNull(accountAccess.directoryDisabledAt),
      ),
    )
    .orderBy(sql`lower(${authUser.name})`, authUser.id);
}

export async function responsibleMembersIn(
  db: InboxTransactionDB,
  projectIDs: string[],
  responsibleIDs: string[],
): Promise<Map<string, AttentionMember>> {
  const rows = await db
    .select({
      id: projectMembership.userId,
      projectId: projectMembership.projectId,
      ...memberCapabilities,
    })
    .from(projectMembership)
    .innerJoin(accountAccess, eq(accountAccess.userId, projectMembership.userId))
    .leftJoin(administrator, eq(administrator.userId, projectMembership.userId))
    .where(
      and(
        inArray(projectMembership.userId, responsibleIDs),
        inArray(projectMembership.projectId, projectIDs),
        isNull(accountAccess.disabledAt),
        isNull(accountAccess.directoryDisabledAt),
      ),
    );
  return new Map(rows.map((row) => [`${row.projectId}:${row.id}`, row]));
}

export async function ticketsIn(
  transaction: DatabaseTransaction,
  userID: string,
  projects: string[],
): Promise<InboxTicket[]> {
  const db = drizzleTransaction(transaction);
  const responsibilityOp = alias(operation, "ticket_responsibility");
  const followOp = alias(operation, "ticket_follow");
  const participated = or(
    eq(ticket.createdBy, userID),
    sql<boolean>`(${responsibilityOp.payload}->>'userId') = ${userID}`,
    exists(
      db
        .select({ id: agentTurn.id })
        .from(agentTurn)
        .where(and(eq(agentTurn.ticketId, ticket.id), eq(agentTurn.createdBy, userID))),
    ),
    exists(
      db
        .select({ id: conversationEntry.id })
        .from(conversationEntry)
        .innerJoin(ticketConversation, eq(ticketConversation.id, conversationEntry.conversationId))
        .where(
          and(
            eq(ticketConversation.ticketId, ticket.id),
            eq(conversationEntry.createdBy, userID),
            eq(conversationEntry.actor, "user"),
          ),
        ),
    ),
    exists(
      db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .innerJoin(reviewFeedback, eq(sql`${reviewFeedback.id}::text`, auditEvent.scopeId))
        .innerJoin(change, eq(change.id, reviewFeedback.changeId))
        .where(
          and(
            eq(auditEvent.kind, "review.feedback_message"),
            eq(auditEvent.scopeType, "review_feedback"),
            eq(change.ticketId, ticket.id),
            eq(auditEvent.actorId, userID),
          ),
        ),
    ),
  );
  return db
    .select({
      id: ticket.id,
      projectId: ticket.projectId,
      title: ticket.title,
      state: ticket.state,
      responsibleId: sql<string | null>`(${responsibilityOp.payload}->>'userId')::uuid`,
      following: sql<boolean>`coalesce((${followOp.payload}->>'following')::boolean, ${participated}, false)`,
    })
    .from(ticket)
    .leftJoin(
      responsibilityOp,
      and(
        eq(responsibilityOp.kind, "tickets.responsibility"),
        eq(responsibilityOp.scopeType, "ticket"),
        eq(responsibilityOp.scopeId, sql`${ticket.id}::text`),
        eq(responsibilityOp.idempotencyKey, sql`'tickets.responsibility:' || ${ticket.id}::text`),
      ),
    )
    .leftJoin(
      followOp,
      and(
        eq(followOp.kind, "tickets.follow"),
        eq(followOp.scopeType, "ticket"),
        eq(followOp.scopeId, sql`${ticket.id}::text`),
        eq(
          followOp.idempotencyKey,
          sql`'tickets.follow:' || ${ticket.id}::text || ':' || ${userID}::text`,
        ),
      ),
    )
    .where(
      and(
        inArray(ticket.projectId, projects),
        isNull(ticket.trashedAt),
        isNull(ticket.convertedToEpicId),
      ),
    );
}

export async function readTicketAttentionIn(
  transaction: DatabaseTransaction,
  userID: string,
  ticketID: string,
  write = false,
) {
  const db = drizzleTransaction(transaction);
  const [foundTicket] = await db
    .select({ projectId: ticket.projectId })
    .from(ticket)
    .where(
      and(eq(ticket.id, ticketID), isNull(ticket.trashedAt), isNull(ticket.convertedToEpicId)),
    );
  if (!foundTicket) throw new CommandError("not-found", "Ticket not found");
  await projectAuthorityIn(transaction, userID, foundTicket.projectId);
  // Match the existing account/membership -> Ticket lock order. Polling takes
  // only a shared lock; metadata writes serialize without fencing Agent work.
  const locked = await db
    .select({ id: ticket.id })
    .from(ticket)
    .where(
      and(
        eq(ticket.id, ticketID),
        eq(ticket.projectId, foundTicket.projectId),
        isNull(ticket.trashedAt),
        isNull(ticket.convertedToEpicId),
      ),
    )
    .for(write ? "update" : "share");
  if (!locked.length) throw new CommandError("not-found", "Ticket not found");
  const [responsibility] = await db
    .select({
      userId: sql<string | null>`(${operation.payload}->>'userId')::uuid`,
      version: sql<number>`(${operation.payload}->>'version')::integer`,
    })
    .from(operation)
    .where(
      and(
        eq(operation.kind, "tickets.responsibility"),
        eq(operation.scopeType, "ticket"),
        eq(operation.scopeId, ticketID),
        eq(operation.idempotencyKey, `tickets.responsibility:${ticketID}`),
      ),
    );
  const ticketView = (await ticketsIn(transaction, userID, [foundTicket.projectId])).find(
    (row) => row.id === ticketID,
  );
  return {
    projectID: foundTicket.projectId,
    view: ticketAttentionSchema.parse({
      responsibleId: responsibility?.userId ?? null,
      version: responsibility?.version ?? 0,
      following: ticketView?.following ?? false,
      people: await peopleIn(transaction, foundTicket.projectId),
    }),
  };
}

async function setTicketFollowIn(
  db: InboxTransactionDB,
  ticketID: string,
  userID: string,
  following: boolean,
) {
  await upsertOperation(db, {
    kind: "tickets.follow",
    scopeType: "ticket",
    scopeId: ticketID,
    idempotencyKey: `tickets.follow:${ticketID}:${userID}`,
    state: following ? "following" : "muted",
    payload: { ticketId: ticketID, userId: userID, following },
  });
}

export async function updateResponsibilityIn(
  transaction: DatabaseTransaction,
  userID: string,
  ticketID: string,
  input: z.output<typeof responsibilityInput>,
) {
  const db = drizzleTransaction(transaction);
  const current = await readTicketAttentionIn(transaction, userID, ticketID, true);
  const [receipt] = await db
    .select({
      kind: auditEvent.kind,
      scopeType: auditEvent.scopeType,
      ticketId: auditEvent.scopeId,
      actorId: auditEvent.actorId,
      payload: auditEvent.payload,
    })
    .from(auditEvent)
    .where(eq(auditEvent.id, input.commandId));
  if (receipt) {
    if (
      receipt.kind !== "tickets.responsibility_event" ||
      receipt.scopeType !== "ticket" ||
      receipt.ticketId !== ticketID ||
      receipt.actorId !== userID ||
      (receipt.payload["userId"] ?? null) !== input.responsibleId ||
      receipt.payload["expectedVersion"] !== input.expectedVersion
    )
      throw new CommandError("conflict", "Responsibility command identity changed");
    return current.view;
  }
  if (current.view.version !== input.expectedVersion)
    throw new CommandError("conflict", "Responsibility changed. Reload before assigning.");
  if (
    input.responsibleId &&
    !current.view.people.some((person) => person.id === input.responsibleId)
  )
    throw new CommandError("conflict", "Choose an active member of this Project.");

  await upsertOperation(db, {
    kind: "tickets.responsibility",
    scopeType: "ticket",
    scopeId: ticketID,
    idempotencyKey: `tickets.responsibility:${ticketID}`,
    state: "active",
    payload: {
      ticketId: ticketID,
      userId: input.responsibleId,
      version: input.expectedVersion + 1,
    },
  });
  await db.insert(auditEvent).values({
    id: input.commandId,
    kind: "tickets.responsibility_event",
    scopeType: "ticket",
    scopeId: ticketID,
    actorId: userID,
    payload: {
      userId: input.responsibleId,
      expectedVersion: input.expectedVersion,
    },
  });
  if (input.responsibleId && input.responsibleId !== current.view.responsibleId)
    await setTicketFollowIn(db, ticketID, input.responsibleId, true);
  return (await readTicketAttentionIn(transaction, userID, ticketID)).view;
}

export async function updateFollowIn(
  transaction: DatabaseTransaction,
  userID: string,
  ticketID: string,
  following: boolean,
) {
  await readTicketAttentionIn(transaction, userID, ticketID, true);
  await setTicketFollowIn(drizzleTransaction(transaction), ticketID, userID, following);
  return (await readTicketAttentionIn(transaction, userID, ticketID)).view;
}
