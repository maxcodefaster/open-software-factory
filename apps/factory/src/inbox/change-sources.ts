import { and, eq, inArray, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentTurn, authUser, change, changeWriter, operation, reviewFeedback } from "#db/schema";
import type { AttentionCapability } from "#ticket-domain/attention";
import { type AttentionSource, type InboxQueryContext, plainPreview } from "./attention-types";

export async function collectChangeSources(context: InboxQueryContext): Promise<AttentionSource[]> {
  const { db, userID, projectIDs } = context;
  const sources: AttentionSource[] = [];

  const newerChange = alias(change, "newer_change");
  const changes = await db
    .select({
      id: sql<string>`'change:'||${change.id}::text`,
      eventId: sql<string>`${change.id}::text||':'||${change.version}::text`,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Implementation is blocked'`,
      preview: sql<string>`coalesce(${change.failure},'Implementation failed. Inspect the Ticket before retrying.')`,
      createdAt: change.createdAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(change)
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "failed"),
        notExists(
          db
            .select({ id: newerChange.id })
            .from(newerChange)
            .where(
              and(
                eq(newerChange.ticketId, change.ticketId),
                sql<boolean>`(${newerChange.createdAt},${newerChange.id})>(${change.createdAt},${change.id})`,
              ),
            ),
        ),
      ),
    );
  for (const row of changes) sources.push(plainPreview(row));

  const newerTurn = alias(agentTurn, "newer_turn");
  const pauses = await db
    .select({
      id: sql<string>`'pause:'||${operation.scopeId}`,
      eventId: sql<string>`(${operation.scopeId})::uuid`,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Coding is paused'`,
      preview: sql<string>`${operation.payload}->>'reason'`,
      createdAt: agentTurn.updatedAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(operation)
    .innerJoin(agentTurn, eq(sql`${agentTurn.id}::text`, operation.scopeId))
    .innerJoin(change, eq(change.id, agentTurn.changeId))
    .where(
      and(
        eq(operation.kind, "usage.coding_pause"),
        eq(operation.scopeType, "agent_turn"),
        eq(operation.state, "paused"),
        sql`(${operation.payload}->>'resumedByTurnId') IS NULL`,
        inArray(change.projectId, projectIDs),
        notInArray(change.state, ["cancelled", "delivered"]),
        notExists(
          db
            .select({ id: newerTurn.id })
            .from(newerTurn)
            .where(
              and(
                eq(newerTurn.changeId, change.id),
                sql<boolean>`(${newerTurn.createdAt},${newerTurn.id})>(${agentTurn.createdAt},${agentTurn.id})`,
              ),
            ),
        ),
      ),
    );
  for (const row of pauses) sources.push(plainPreview(row));

  const feedback = await db
    .select({
      id: sql<string>`'recheck:'||${reviewFeedback.id}::text`,
      eventId: sql<string>`${reviewFeedback.id}::text||':'||${reviewFeedback.version}::text`,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Recheck implemented feedback'`,
      preview: sql<string>`'The Agent reports this Thread implemented. Inspect the result and resolve it or request changes.'`,
      createdAt: reviewFeedback.createdAt,
      target: sql<AttentionSource["target"]>`'review'`,
      targetId: reviewFeedback.id,
      capability: sql<AttentionCapability>`'develop'`,
      authorID: reviewFeedback.authorId,
    })
    .from(reviewFeedback)
    .innerJoin(change, eq(change.id, reviewFeedback.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(reviewFeedback.kind, "thread"),
        eq(reviewFeedback.state, "implemented"),
        notInArray(change.state, ["cancelled", "delivered"]),
      ),
    );
  sources.push(...feedback);

  const editing = await db
    .select({
      id: sql<string>`'editing:'||${operation.id}::text`,
      eventId: operation.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Editing transfer requested'`,
      preview: sql<string>`${authUser.name}||' would like to edit this Ticket Workspace.'`,
      createdAt: operation.createdAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'develop'`,
      addressedTo: sql<string>`${operation.payload}->>'ownerId'`,
    })
    .from(operation)
    .innerJoin(change, eq(sql`${change.id}::text`, operation.scopeId))
    .innerJoin(changeWriter, eq(changeWriter.changeId, change.id))
    .innerJoin(authUser, eq(authUser.id, operation.createdBy))
    .where(
      and(
        eq(operation.kind, "access.change_editing_request"),
        eq(operation.scopeType, "change"),
        inArray(change.projectId, projectIDs),
        eq(operation.state, "requested"),
        sql<boolean>`${operation.payload}->>'ownerId' = ${userID}`,
        sql<boolean>`${changeWriter.userId}::text = ${operation.payload}->>'ownerId'`,
        sql<boolean>`${changeWriter.epoch}::text = ${operation.payload}->>'writerEpoch'`,
        eq(changeWriter.state, "human"),
      ),
    );
  sources.push(...editing);

  return sources;
}
