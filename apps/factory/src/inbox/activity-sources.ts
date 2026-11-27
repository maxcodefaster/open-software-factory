import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  agentTurn,
  auditEvent,
  authUser,
  change,
  changeAgentTurnIntent,
  conversationEntry,
  monitoringIncident,
  reviewFeedback,
  ticket,
  ticketConversation,
} from "#db/schema";
import { type AttentionCapability, mentionedPeople } from "#ticket-domain/attention";
import type { AttentionSource, InboxQueryContext } from "./attention-types";

function collectDiscussionSources(
  rows: AttentionSource[],
  context: InboxQueryContext,
  mentionTitle: string,
): AttentionSource[] {
  const sources: AttentionSource[] = [];
  for (const row of rows) {
    const mentioned = mentionedPeople(row.preview).includes(context.userID);
    if ((row.ticketId && context.tickets.get(row.ticketId)?.following) || mentioned) {
      sources.push({ ...row, title: mentioned ? mentionTitle : row.title });
    }
  }
  return sources;
}

export async function collectActivitySources(
  context: InboxQueryContext,
): Promise<AttentionSource[]> {
  const { db, userID, projectIDs, followedIDs, scopes } = context;
  const sources: AttentionSource[] = [];

  // Shared Ticket chat only. Private Project histories never become team activity.
  const conversations = await db
    .select({
      id: sql<string>`'conversation:'||${ticketConversation.id}::text||':'||coalesce(${conversationEntry.payload}->>'contextId','original')`,
      eventId: conversationEntry.id,
      projectId: ticketConversation.projectId,
      ticketId: ticketConversation.ticketId,
      title: sql<string>`'New Ticket discussion'`,
      preview: conversationEntry.body,
      createdAt: conversationEntry.createdAt,
      target: sql<AttentionSource["target"]>`'conversation'`,
      targetId: conversationEntry.id,
      contextId: sql<string | null>`(${conversationEntry.payload}->>'contextId')::uuid`,
      capability: sql<AttentionCapability>`'contribute'`,
      visibility: sql<string | null>`${conversationEntry.payload}->>'visibility'`,
    })
    .from(conversationEntry)
    .innerJoin(ticketConversation, eq(ticketConversation.id, conversationEntry.conversationId))
    .where(
      and(
        inArray(ticketConversation.projectId, projectIDs),
        isNotNull(ticketConversation.ticketId),
        eq(conversationEntry.actor, "user"),
        inArray(conversationEntry.kind, ["user-message", "answer"]),
        ne(conversationEntry.createdBy, userID),
        or(
          inArray(ticketConversation.ticketId, followedIDs),
          sql<boolean>`position(${userID} IN ${conversationEntry.body})>0`,
        ),
      ),
    )
    .orderBy(conversationEntry.createdAt, conversationEntry.ordinal);
  sources.push(
    ...collectDiscussionSources(
      conversations.filter(
        (row) => row.visibility !== "developer" || scopes.get(row.projectId)?.develop,
      ),
      context,
      "You were mentioned in Ticket chat",
    ),
  );

  const coding = await db
    .select({
      id: sql<string>`'coding:'||${change.id}::text||':'||coalesce(${agentTurn.input}->>'contextId','original')`,
      eventId: agentTurn.id,
      projectId: agentTurn.projectId,
      ticketId: agentTurn.ticketId,
      title: sql<string>`'New Coding discussion'`,
      preview: sql<string>`${agentTurn.input}->>'text'`,
      createdAt: agentTurn.createdAt,
      target: sql<AttentionSource["target"]>`'coding'`,
      targetId: changeAgentTurnIntent.promptId,
      contextId: sql<string | null>`(${agentTurn.input}->>'contextId')::uuid`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(agentTurn)
    .innerJoin(change, eq(change.id, agentTurn.changeId))
    .innerJoin(changeAgentTurnIntent, eq(changeAgentTurnIntent.turnId, agentTurn.id))
    .where(
      and(
        inArray(agentTurn.projectId, projectIDs),
        sql<boolean>`${agentTurn.input}->>'kind'='change-prompt'`,
        ne(agentTurn.createdBy, userID),
        or(
          inArray(agentTurn.ticketId, followedIDs),
          sql<boolean>`position(${userID} IN ${agentTurn.input}->>'text')>0`,
        ),
      ),
    )
    .orderBy(agentTurn.createdAt, agentTurn.id);
  sources.push(...collectDiscussionSources(coding, context, "You were mentioned in Coding"));

  const discussions = await db
    .select({
      id: sql<string>`'feedback:'||${reviewFeedback.id}::text`,
      eventId: auditEvent.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'New review discussion'`,
      preview: sql<string>`${auditEvent.payload}->>'body'`,
      createdAt: auditEvent.createdAt,
      target: sql<AttentionSource["target"]>`'review'`,
      targetId: reviewFeedback.id,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(auditEvent)
    .innerJoin(reviewFeedback, eq(sql`${reviewFeedback.id}::text`, auditEvent.scopeId))
    .innerJoin(change, eq(change.id, reviewFeedback.changeId))
    .where(
      and(
        eq(auditEvent.kind, "review.feedback_message"),
        eq(auditEvent.scopeType, "review_feedback"),
        inArray(change.projectId, projectIDs),
        ne(auditEvent.actorId, userID),
        or(
          inArray(change.ticketId, followedIDs),
          sql<boolean>`position(${userID} IN (${auditEvent.payload}->>'body'))>0`,
        ),
      ),
    )
    .orderBy(auditEvent.createdAt, auditEvent.id);
  sources.push(...collectDiscussionSources(discussions, context, "You were mentioned in review"));

  const assignments = await db
    .select({
      id: sql<string>`'responsibility:'||${auditEvent.scopeId}`,
      eventId: auditEvent.id,
      projectId: ticket.projectId,
      ticketId: ticket.id,
      title: sql<string>`'You are responsible for this Ticket'`,
      preview: sql<string>`${authUser.name}||' assigned you responsibility. This does not start Agent work.'`,
      createdAt: auditEvent.createdAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(auditEvent)
    .innerJoin(ticket, sql`${ticket.id}::text = ${auditEvent.scopeId}`)
    .innerJoin(authUser, eq(authUser.id, auditEvent.actorId))
    .where(
      and(
        eq(auditEvent.kind, "tickets.responsibility_event"),
        eq(auditEvent.scopeType, "ticket"),
        inArray(ticket.projectId, projectIDs),
        sql`${auditEvent.payload}->>'userId' = ${userID}`,
        ne(auditEvent.actorId, userID),
      ),
    )
    .orderBy(auditEvent.createdAt, auditEvent.id);
  sources.push(...assignments);

  // Inputs retain terminal outcomes but have no per-event resolve/retry command.
  // Notify their managers without manufacturing an unresolvable shared request.
  const inputs = await db
    .select({
      id: sql<string>`'input:'||${monitoringIncident.id}::text`,
      eventId: sql<string>`${monitoringIncident.id}::text||':'||${monitoringIncident.state}`,
      projectId: monitoringIncident.projectId,
      ticketId: monitoringIncident.ticketId,
      title: sql<string>`'Project Input needs attention'`,
      preview: sql<string>`coalesce(${monitoringIncident.reason},'This external request could not continue. Inspect its retained outcome before retrying.')`,
      createdAt: monitoringIncident.lastSeenAt,
      target: sql<AttentionSource["target"]>`'inputs'`,
      targetId: monitoringIncident.id,
      capability: sql<AttentionCapability>`'manage'`,
    })
    .from(monitoringIncident)
    .where(
      and(
        inArray(monitoringIncident.projectId, projectIDs),
        inArray(monitoringIncident.state, ["blocked", "uncertain"]),
      ),
    );
  sources.push(...inputs);

  return sources;
}
