import { and, eq, gt, inArray, isNotNull, isNull, max, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  agentTurn,
  change,
  conversationEntry,
  operation,
  requirementApproval,
  technicalDesignRevision,
  ticket,
  ticketConversation,
  ticketDocumentRevision,
} from "#db/schema";
import type { AttentionCapability } from "#ticket-domain/attention";
import {
  type AttentionSource,
  type InboxQueryContext,
  latestRequirementRevisionId,
  plainPreview,
} from "./attention-types";

export async function collectPlanningSources(
  context: InboxQueryContext,
): Promise<AttentionSource[]> {
  const { db, userID, projectIDs } = context;
  const sources: AttentionSource[] = [];

  const answer = alias(conversationEntry, "answer");
  const newerEntry = alias(conversationEntry, "newer_entry");
  const questions = await db
    .select({
      id: sql<string>`${conversationEntry.kind}::text||':'||${conversationEntry.id}::text`,
      eventId: conversationEntry.id,
      projectId: ticketConversation.projectId,
      ticketId: ticketConversation.ticketId,
      title: sql<string>`case when ${conversationEntry.kind}='question' then 'Answer the Agent’s question' else 'Confirm proposed requirements' end`,
      preview: conversationEntry.body,
      createdAt: conversationEntry.createdAt,
      target: sql<AttentionSource["target"]>`'conversation'`,
      targetId: conversationEntry.id,
      contextId: sql<string | null>`(${conversationEntry.payload}->>'contextId')::uuid`,
      capability: sql<AttentionCapability>`case when ${conversationEntry.payload}->>'visibility'='developer' then 'develop' else 'contribute' end`,
      addressedTo: sql<
        string | null
      >`case when ${ticketConversation.ticketId} is null then ${ticketConversation.createdBy} end`,
    })
    .from(conversationEntry)
    .innerJoin(ticketConversation, eq(ticketConversation.id, conversationEntry.conversationId))
    .where(
      and(
        inArray(ticketConversation.projectId, projectIDs),
        or(isNotNull(ticketConversation.ticketId), eq(ticketConversation.createdBy, userID)),
        inArray(conversationEntry.kind, ["question", "requirement"]),
        notExists(
          db
            .select({ id: answer.id })
            .from(answer)
            .where(
              and(eq(answer.inReplyToEntryId, conversationEntry.id), eq(answer.kind, "answer")),
            ),
        ),
        notExists(
          db
            .select({ id: ticketDocumentRevision.id })
            .from(ticketDocumentRevision)
            .where(eq(ticketDocumentRevision.proposalEntryId, conversationEntry.id)),
        ),
        notExists(
          db
            .select({ id: newerEntry.id })
            .from(newerEntry)
            .where(
              and(
                eq(newerEntry.conversationId, conversationEntry.conversationId),
                gt(newerEntry.ordinal, conversationEntry.ordinal),
                sql<boolean>`${newerEntry.payload}->>'contextId' is not distinct from ${conversationEntry.payload}->>'contextId'`,
                or(
                  inArray(newerEntry.kind, ["question", "requirement"]),
                  and(
                    eq(newerEntry.kind, "user-message"),
                    sql<boolean>`coalesce(${newerEntry.payload}->>'intent','')!='project-research'`,
                  ),
                ),
              ),
            ),
        ),
      ),
    );
  for (const row of questions) {
    if (!row.ticketId && row.title === "Confirm proposed requirements") continue;
    sources.push(row);
  }

  const newestDesign = alias(technicalDesignRevision, "newest_design");
  const designs = await db
    .select({
      id: sql<string>`'design:'||${technicalDesignRevision.id}::text`,
      eventId: technicalDesignRevision.id,
      projectId: ticket.projectId,
      ticketId: ticket.id,
      title: sql<string>`'Review the technical design'`,
      preview: sql<string>`'Technical planning is complete. Review the design before approving implementation.'`,
      createdAt: technicalDesignRevision.createdAt,
      target: sql<AttentionSource["target"]>`'ticket'`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(technicalDesignRevision)
    .innerJoin(ticket, eq(ticket.id, technicalDesignRevision.ticketId))
    .where(
      and(
        inArray(ticket.projectId, projectIDs),
        eq(ticket.state, "ready"),
        eq(
          technicalDesignRevision.ordinal,
          db
            .select({ ordinal: max(newestDesign.ordinal) })
            .from(newestDesign)
            .where(eq(newestDesign.ticketId, ticket.id)),
        ),
        eq(
          technicalDesignRevision.requirementRevisionId,
          latestRequirementRevisionId(db, ticket.id),
        ),
        notExists(
          db
            .select({ id: requirementApproval.id })
            .from(requirementApproval)
            .where(eq(requirementApproval.technicalDesignRevisionId, technicalDesignRevision.id)),
        ),
        notExists(db.select({ id: change.id }).from(change).where(eq(change.ticketId, ticket.id))),
        notExists(
          db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.ticketId, ticket.id),
                inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
              ),
            ),
        ),
      ),
    );
  sources.push(...designs);

  const newerTurn = alias(agentTurn, "newer_turn");
  const failures = await db
    .select({
      id: sql<string>`'turn:'||${agentTurn.id}::text`,
      eventId: agentTurn.id,
      projectId: agentTurn.projectId,
      ticketId: agentTurn.ticketId,
      title: sql<string>`'Agent work needs attention'`,
      preview: sql<string>`coalesce(${agentTurn.outcomeSummary},'Work stopped without a confirmed result. Inspect before retrying.')`,
      createdAt: agentTurn.updatedAt,
      target: sql<AttentionSource["target"]>`'conversation'`,
      contextId: sql<string | null>`(${agentTurn.input}->>'contextId')::uuid`,
      capability: sql<AttentionCapability>`case when ${agentTurn.authority}->>'mode'='build' or ${agentTurn.authority}->>'visibility'='developer'
      or ${agentTurn.input}->>'intent' in ('technical-planning','full-planning') then 'develop' else 'contribute' end`,
      addressedTo: sql<
        string | null
      >`case when ${agentTurn.ticketId} is null then ${agentTurn.createdBy} end`,
    })
    .from(agentTurn)
    .where(
      and(
        inArray(agentTurn.projectId, projectIDs),
        inArray(agentTurn.state, ["failed", "uncertain"]),
        or(isNotNull(agentTurn.ticketId), eq(agentTurn.createdBy, userID)),
        notExists(
          db
            .select({ id: operation.id })
            .from(operation)
            .where(
              and(
                eq(operation.kind, "usage.coding_pause"),
                eq(operation.scopeType, "agent_turn"),
                eq(operation.scopeId, sql`${agentTurn.id}::text`),
                eq(operation.state, "paused"),
                sql`(${operation.payload}->>'resumedByTurnId') IS NULL`,
              ),
            ),
        ),
        notExists(
          db
            .select({ id: change.id })
            .from(change)
            .where(and(eq(change.id, agentTurn.changeId), eq(change.state, "failed"))),
        ),
        notExists(
          db
            .select({ id: newerTurn.id })
            .from(newerTurn)
            .where(
              and(
                or(
                  and(isNotNull(agentTurn.changeId), eq(newerTurn.changeId, agentTurn.changeId)),
                  and(
                    isNull(agentTurn.changeId),
                    eq(newerTurn.conversationId, agentTurn.conversationId),
                    sql<boolean>`${newerTurn.input}->>'contextId' is not distinct from ${agentTurn.input}->>'contextId'`,
                  ),
                ),
                sql<boolean>`(${newerTurn.createdAt},${newerTurn.id})>(${agentTurn.createdAt},${agentTurn.id})`,
              ),
            ),
        ),
      ),
    );
  for (const row of failures) sources.push(plainPreview(row));

  return sources;
}
