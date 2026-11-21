import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  accountAccess,
  administrator,
  agentTurn,
  authUser,
  candidateReview,
  change,
  changeAgentSession,
  changeAgentTurnIntent,
  changeCommitOperation,
  changeEditingRequest,
  changeWriter,
  codingPause,
  conversationEntry,
  deliveryApproval,
  inboxReceipt,
  monitoringIncident,
  project,
  projectMembership,
  requirementApproval,
  requirementRevision,
  reviewFeedback,
  reviewFeedbackMessage,
  technicalDesignRevision,
  ticket,
  ticketConversation,
  ticketDocumentRevision,
  ticketFollow,
  ticketResponsibility,
  ticketResponsibilityEvent,
  verification,
} from "../../../../packages/db/src/schema";
import {
  type AttentionCapability,
  type AttentionMember,
  mentionedPeople,
  receivesAttention,
} from "../../../../packages/ticket-domain/src/attention";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError, plainFailureMessage } from "../command-error";
import {
  type AttentionPerson,
  type InboxItem,
  type InboxView,
  type inboxReceiptInput,
  inboxViewSchema,
  type responsibilityInput,
  ticketAttentionSchema,
} from "./contracts";

type Scope = {
  id: string;
  name: string;
  develop: boolean;
  manage: boolean;
};
type Ticket = {
  id: string;
  projectId: string;
  title: string;
  responsibleId: string | null;
  following: boolean;
  state: string;
};
type Source = {
  id: string;
  eventId: string;
  projectId: string;
  ticketId: string | null;
  title: string;
  preview: string;
  createdAt: Date | string;
  target: InboxItem["target"];
  targetId: string | null;
  contextId: string | null;
  capability: AttentionCapability;
  addressedTo?: string | null;
  authorID?: string | null;
};

// Stored failure text can still carry provider codes or bookkeeping words from before it was reworded.
const plainPreview = (source: Source): Source => ({
  ...source,
  preview: plainFailureMessage(source.preview),
});

async function peopleIn(
  transaction: DatabaseTransaction,
  projectID: string,
): Promise<AttentionPerson[]> {
  return drizzleTransaction(transaction)
    .select({
      id: authUser.id,
      name: authUser.name,
      develop: sql<boolean>`${projectMembership.role}='developer' OR ${administrator.userId} IS NOT NULL`,
      manage: sql<boolean>`${projectMembership.manageProject} OR ${administrator.userId} IS NOT NULL`,
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

async function ticketsIn(
  transaction: DatabaseTransaction,
  userID: string,
  projects: string[],
): Promise<Ticket[]> {
  const db = drizzleTransaction(transaction);
  const participated = or(
    eq(ticket.createdBy, userID),
    eq(ticketResponsibility.userId, userID),
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
        .select({ id: reviewFeedbackMessage.id })
        .from(reviewFeedbackMessage)
        .innerJoin(reviewFeedback, eq(reviewFeedback.id, reviewFeedbackMessage.feedbackId))
        .innerJoin(change, eq(change.id, reviewFeedback.changeId))
        .where(and(eq(change.ticketId, ticket.id), eq(reviewFeedbackMessage.authorId, userID))),
    ),
  );
  return db
    .select({
      id: ticket.id,
      projectId: ticket.projectId,
      title: ticket.title,
      state: ticket.state,
      responsibleId: ticketResponsibility.userId,
      following: sql<boolean>`coalesce(${ticketFollow.following}, ${participated}, false)`,
    })
    .from(ticket)
    .leftJoin(ticketResponsibility, eq(ticketResponsibility.ticketId, ticket.id))
    .leftJoin(
      ticketFollow,
      and(eq(ticketFollow.ticketId, ticket.id), eq(ticketFollow.userId, userID)),
    )
    .where(
      and(
        inArray(ticket.projectId, projects),
        isNull(ticket.trashedAt),
        isNull(ticket.convertedToEpicId),
      ),
    );
}

// The Inbox projects retained source records. It cannot approve, retry, dispatch,
// or invent work. Resolved/superseded source state removes an obligation for all
// recipients, independently of their personal read receipts.
async function listIn(transaction: DatabaseTransaction, userID: string): Promise<InboxView> {
  const db = drizzleTransaction(transaction);
  await requireActiveAccountIn(transaction, userID);
  const [admin] = await db
    .select({ userId: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userID))
    .for("share");
  const memberships = await db
    .select({
      projectId: projectMembership.projectId,
      role: projectMembership.role,
      manage: projectMembership.manageProject,
    })
    .from(projectMembership)
    .where(eq(projectMembership.userId, userID))
    .for("share");
  const projects = await db
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(
      admin
        ? undefined
        : inArray(
            project.id,
            memberships.map((row) => row.projectId),
          ),
    );
  if (!projects.length) return { items: [], count: 0 };
  const scopes = new Map<string, Scope>(
    projects.map((project) => {
      const membership = memberships.find((row) => row.projectId === project.id);
      return [
        project.id,
        {
          ...project,
          develop: Boolean(admin || membership?.role === "developer"),
          manage: Boolean(admin || membership?.manage),
        },
      ];
    }),
  );
  const projectIDs = projects.map((project) => project.id);
  const tickets = new Map(
    (await ticketsIn(transaction, userID, projectIDs)).map((row) => [row.id, row]),
  );
  const followedIDs = [...tickets.values()]
    .filter((ticket) => ticket.following)
    .map((ticket) => ticket.id);
  const responsibleIDs = [
    ...new Set(
      [...tickets.values()].flatMap((row) => (row.responsibleId ? [row.responsibleId] : [])),
    ),
  ];
  const responsibleMembers: (AttentionMember & { projectId: string })[] = await db
    .select({
      id: projectMembership.userId,
      projectId: projectMembership.projectId,
      develop: sql<boolean>`${projectMembership.role}='developer' OR ${administrator.userId} IS NOT NULL`,
      manage: sql<boolean>`${projectMembership.manageProject} OR ${administrator.userId} IS NOT NULL`,
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
  const receipts = new Map(
    (
      await db
        .select({
          itemId: inboxReceipt.itemId,
          seen: inboxReceipt.seenEventId,
          archived: inboxReceipt.archived,
        })
        .from(inboxReceipt)
        .where(eq(inboxReceipt.userId, userID))
    ).map((row) => [row.itemId, row]),
  );
  const items = new Map<string, InboxItem>();
  function append(source: Source, needsAction: boolean) {
    const scope = scopes.get(source.projectId);
    const ticket = source.ticketId ? tickets.get(source.ticketId) : undefined;
    if (!scope || (source.ticketId && (!ticket || !tickets.has(source.ticketId)))) return;
    if (needsAction && ticket && ["done", "cancelled"].includes(ticket.state)) return;
    if (source.capability === "develop" && !scope.develop && source.authorID !== userID) return;
    if (source.capability === "manage" && !scope.manage) return;
    if (
      needsAction &&
      !receivesAttention({
        viewer: { id: userID, develop: scope.develop, manage: scope.manage },
        responsible: ticket
          ? responsibleMembers.find(
              (member) => member.id === ticket.responsibleId && member.projectId === scope.id,
            )
          : undefined,
        capability: source.capability,
        addressedTo: source.addressedTo,
        authorID: source.authorID,
      })
    )
      return;
    const receipt = receipts.get(source.id);
    const previous = items.get(source.id);
    items.set(source.id, {
      id: source.id,
      eventId: source.eventId,
      projectId: scope.id,
      projectName: scope.name,
      ticketId: source.ticketId,
      ticketTitle:
        ticket?.title ?? (source.target === "inputs" ? "Project inputs" : "Personal Project chat"),
      title: source.title,
      preview: source.preview,
      createdAt: (source.createdAt instanceof Date
        ? source.createdAt
        : new Date(source.createdAt)
      ).toISOString(),
      needsAction,
      unread: receipt?.seen !== source.eventId,
      archived: !needsAction && receipt?.archived === true && receipt.seen === source.eventId,
      updates: (previous?.updates ?? 0) + 1,
      target: source.target,
      targetId: source.targetId,
      contextId: source.contextId,
    });
  }

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
      target: sql<Source["target"]>`'conversation'`,
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
  for (const row of conversations) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if (row.visibility === "developer" && !scopes.get(row.projectId)?.develop) continue;
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in Ticket chat" : row.title }, false);
  }
  const coding = await db
    .select({
      id: sql<string>`'coding:'||${change.id}::text||':'||coalesce(${agentTurn.input}->>'contextId','original')`,
      eventId: agentTurn.id,
      projectId: agentTurn.projectId,
      ticketId: agentTurn.ticketId,
      title: sql<string>`'New Coding discussion'`,
      preview: sql<string>`${agentTurn.input}->>'text'`,
      createdAt: agentTurn.createdAt,
      target: sql<Source["target"]>`'coding'`,
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
  for (const row of coding) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in Coding" : row.title }, false);
  }
  const discussions = await db
    .select({
      id: sql<string>`'feedback:'||${reviewFeedback.id}::text`,
      eventId: reviewFeedbackMessage.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'New review discussion'`,
      preview: reviewFeedbackMessage.body,
      createdAt: reviewFeedbackMessage.createdAt,
      target: sql<Source["target"]>`'review'`,
      targetId: reviewFeedback.id,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(reviewFeedbackMessage)
    .innerJoin(reviewFeedback, eq(reviewFeedback.id, reviewFeedbackMessage.feedbackId))
    .innerJoin(change, eq(change.id, reviewFeedback.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        ne(reviewFeedbackMessage.authorId, userID),
        or(
          inArray(change.ticketId, followedIDs),
          sql<boolean>`position(${userID} IN ${reviewFeedbackMessage.body})>0`,
        ),
      ),
    )
    .orderBy(reviewFeedbackMessage.createdAt, reviewFeedbackMessage.id);
  for (const row of discussions) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in review" : row.title }, false);
  }
  const assignments = await db
    .select({
      id: sql<string>`'responsibility:'||${ticketResponsibilityEvent.ticketId}::text`,
      eventId: ticketResponsibilityEvent.id,
      projectId: ticket.projectId,
      ticketId: ticket.id,
      title: sql<string>`'You are responsible for this Ticket'`,
      preview: sql<string>`${authUser.name}||' assigned you responsibility. This does not start Agent work.'`,
      createdAt: ticketResponsibilityEvent.createdAt,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(ticketResponsibilityEvent)
    .innerJoin(ticket, eq(ticket.id, ticketResponsibilityEvent.ticketId))
    .innerJoin(authUser, eq(authUser.id, ticketResponsibilityEvent.actorId))
    .where(
      and(
        inArray(ticket.projectId, projectIDs),
        eq(ticketResponsibilityEvent.userId, userID),
        ne(ticketResponsibilityEvent.actorId, userID),
      ),
    )
    .orderBy(ticketResponsibilityEvent.createdAt, ticketResponsibilityEvent.id);
  for (const row of assignments) append(row, false);

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
      target: sql<Source["target"]>`'conversation'`,
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
    append(row, true);
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
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
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
          db
            .select({ id: requirementRevision.id })
            .from(requirementRevision)
            .where(eq(requirementRevision.ticketId, ticket.id))
            .orderBy(desc(requirementRevision.ordinal))
            .limit(1),
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
  for (const row of designs) append(row, true);
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
      target: sql<Source["target"]>`'conversation'`,
      targetId: sql<string | null>`null::uuid`,
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
            .select({ id: codingPause.turnId })
            .from(codingPause)
            .where(and(eq(codingPause.turnId, agentTurn.id), isNull(codingPause.resumedByTurnId))),
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
  for (const row of failures) {
    const ticket = row.ticketId && tickets.get(row.ticketId);
    if (ticket && ["done", "cancelled"].includes(ticket.state)) continue;
    append(plainPreview(row), true);
  }
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
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
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
  for (const row of changes) append(plainPreview(row), true);
  const pauses = await db
    .select({
      id: sql<string>`'pause:'||${codingPause.turnId}::text`,
      eventId: codingPause.turnId,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Coding is paused'`,
      preview: codingPause.reason,
      createdAt: agentTurn.updatedAt,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(codingPause)
    .innerJoin(agentTurn, eq(agentTurn.id, codingPause.turnId))
    .innerJoin(change, eq(change.id, agentTurn.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        isNull(codingPause.resumedByTurnId),
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
  for (const row of pauses) append(plainPreview(row), true);

  const feedback = await db
    .select({
      id: sql<string>`'recheck:'||${reviewFeedback.id}::text`,
      eventId: sql<string>`${reviewFeedback.id}::text||':'||${reviewFeedback.version}::text`,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Recheck implemented feedback'`,
      preview: sql<string>`'The Agent reports this Thread implemented. Inspect the result and resolve it or request changes.'`,
      createdAt: reviewFeedback.createdAt,
      target: sql<Source["target"]>`'review'`,
      targetId: reviewFeedback.id,
      contextId: sql<string | null>`null::uuid`,
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
  for (const row of feedback) append(row, true);
  const editing = await db
    .select({
      id: sql<string>`'editing:'||${changeEditingRequest.id}::text`,
      eventId: changeEditingRequest.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Editing transfer requested'`,
      preview: sql<string>`${authUser.name}||' would like to edit this Ticket Workspace.'`,
      createdAt: changeEditingRequest.createdAt,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'develop'`,
      addressedTo: changeEditingRequest.ownerId,
    })
    .from(changeEditingRequest)
    .innerJoin(change, eq(change.id, changeEditingRequest.changeId))
    .innerJoin(changeWriter, eq(changeWriter.changeId, change.id))
    .innerJoin(authUser, eq(authUser.id, changeEditingRequest.requesterId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(changeEditingRequest.state, "requested"),
        eq(changeEditingRequest.ownerId, userID),
        eq(changeWriter.userId, changeEditingRequest.ownerId),
        eq(changeWriter.epoch, changeEditingRequest.writerEpoch),
        eq(changeWriter.state, "human"),
      ),
    );
  for (const row of editing) append(row, true);

  // Exact current verification/review, settled writer and no open Threads.
  // The destination command still rechecks its complete immutable-candidate gate.
  const newestReview = alias(candidateReview, "newest_review");
  const currentCommit = db
    .select({ commitSha: changeCommitOperation.commitSha })
    .from(changeCommitOperation)
    .where(
      and(
        eq(changeCommitOperation.changeId, change.id),
        eq(changeCommitOperation.state, "succeeded"),
      ),
    )
    .orderBy(desc(changeCommitOperation.sequence))
    .limit(1);
  const delivery = await db
    .select({
      id: sql<string>`'delivery:'||${candidateReview.id}::text`,
      eventId: candidateReview.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Review and approve Delivery'`,
      preview: sql<string>`coalesce(${candidateReview.result}->>'summary','Verification and independent review passed. Inspect the exact candidate before Delivery.')`,
      createdAt: sql<Date | string>`${candidateReview.completedAt}`,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(change)
    .innerJoin(
      changeAgentSession,
      and(eq(changeAgentSession.changeId, change.id), eq(changeAgentSession.state, "committed")),
    )
    .innerJoin(
      verification,
      and(eq(verification.changeId, change.id), eq(verification.state, "succeeded")),
    )
    .innerJoin(
      candidateReview,
      and(eq(candidateReview.verificationId, verification.id), eq(candidateReview.state, "passed")),
    )
    .innerJoin(requirementApproval, eq(requirementApproval.id, change.requirementApprovalId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        isNull(change.cancelRequestedAt),
        eq(changeAgentSession.stopPending, false),
        eq(verification.commitSha, currentCommit),
        eq(
          candidateReview.ordinal,
          db
            .select({ ordinal: max(newestReview.ordinal) })
            .from(newestReview)
            .where(eq(newestReview.verificationId, verification.id)),
        ),
        eq(
          requirementApproval.requirementRevisionId,
          db
            .select({ id: requirementRevision.id })
            .from(requirementRevision)
            .where(eq(requirementRevision.ticketId, change.ticketId))
            .orderBy(desc(requirementRevision.ordinal))
            .limit(1),
        ),
        notExists(
          db
            .select({ id: deliveryApproval.id })
            .from(deliveryApproval)
            .where(eq(deliveryApproval.verificationId, verification.id)),
        ),
        notExists(
          db
            .select({ id: reviewFeedback.id })
            .from(reviewFeedback)
            .where(
              and(
                eq(reviewFeedback.changeId, change.id),
                eq(reviewFeedback.kind, "thread"),
                ne(reviewFeedback.state, "resolved"),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, change.id),
                inArray(agentTurn.state, ["pending", "dispatching", "running", "uncertain"]),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: changeWriter.changeId })
            .from(changeWriter)
            .where(
              and(
                eq(changeWriter.changeId, change.id),
                notInArray(changeWriter.state, ["agent", "unassigned"]),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: changeCommitOperation.id })
            .from(changeCommitOperation)
            .where(
              and(
                eq(changeCommitOperation.changeId, change.id),
                notInArray(changeCommitOperation.state, ["succeeded", "failed"]),
              ),
            ),
        ),
      ),
    );
  for (const row of delivery) append(row, true);
  const reviewFailures = await db
    .select({
      id: sql<string>`'review:'||${candidateReview.id}::text`,
      eventId: candidateReview.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Independent review needs attention'`,
      preview: sql<string>`coalesce(${candidateReview.result}->>'summary','Independent review is incomplete. Inspect its evidence before retrying.')`,
      createdAt: sql<
        Date | string
      >`coalesce(${candidateReview.completedAt},${candidateReview.createdAt})`,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'contribute'`,
    })
    .from(candidateReview)
    .innerJoin(change, eq(change.id, candidateReview.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        eq(candidateReview.state, "incomplete"),
        eq(
          candidateReview.ordinal,
          db
            .select({ ordinal: max(newestReview.ordinal) })
            .from(newestReview)
            .where(eq(newestReview.verificationId, candidateReview.verificationId)),
        ),
        eq(candidateReview.commitSha, currentCommit),
        notExists(
          db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, change.id),
                inArray(agentTurn.state, ["pending", "dispatching", "running"]),
              ),
            ),
        ),
      ),
    );
  for (const row of reviewFailures) append(row, true);
  const newerVerification = alias(verification, "newer_verification");
  const checks = await db
    .select({
      id: sql<string>`'verification:'||${verification.id}::text`,
      eventId: verification.id,
      projectId: change.projectId,
      ticketId: change.ticketId,
      title: sql<string>`'Verification needs attention'`,
      preview: sql<string>`coalesce(${verification.summary},'Verification failed after the correction attempt. Inspect the checks before continuing.')`,
      createdAt: verification.updatedAt,
      target: sql<Source["target"]>`'ticket'`,
      targetId: sql<string | null>`null::uuid`,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'develop'`,
    })
    .from(verification)
    .innerJoin(change, eq(change.id, verification.changeId))
    .where(
      and(
        inArray(change.projectId, projectIDs),
        eq(change.state, "active"),
        eq(verification.state, "failed"),
        isNotNull(verification.repairPromptedAt),
        eq(verification.commitSha, currentCommit),
        notExists(
          db
            .select({ id: newerVerification.id })
            .from(newerVerification)
            .where(
              and(
                eq(newerVerification.changeId, change.id),
                sql<boolean>`(${newerVerification.createdAt},${newerVerification.id})>(${verification.createdAt},${verification.id})`,
              ),
            ),
        ),
        notExists(
          db
            .select({ id: agentTurn.id })
            .from(agentTurn)
            .where(
              and(
                eq(agentTurn.changeId, change.id),
                inArray(agentTurn.state, ["pending", "dispatching", "running"]),
              ),
            ),
        ),
      ),
    );
  for (const row of checks) append(row, true);
  const inputs = await db
    .select({
      id: sql<string>`'input:'||${monitoringIncident.id}::text`,
      eventId: sql<string>`${monitoringIncident.id}::text||':'||${monitoringIncident.state}`,
      projectId: monitoringIncident.projectId,
      ticketId: monitoringIncident.ticketId,
      title: sql<string>`'Project Input needs attention'`,
      preview: sql<string>`coalesce(${monitoringIncident.reason},'This external request could not continue. Inspect its retained outcome before retrying.')`,
      createdAt: monitoringIncident.lastSeenAt,
      target: sql<Source["target"]>`'inputs'`,
      targetId: monitoringIncident.id,
      contextId: sql<string | null>`null::uuid`,
      capability: sql<AttentionCapability>`'manage'`,
    })
    .from(monitoringIncident)
    .where(
      and(
        inArray(monitoringIncident.projectId, projectIDs),
        inArray(monitoringIncident.state, ["blocked", "uncertain"]),
      ),
    );
  // Inputs retain terminal outcomes but have no per-event resolve/retry command.
  // Notify their managers without manufacturing an unresolvable shared request.
  for (const row of inputs) append(row, false);
  const values = [...items.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  return inboxViewSchema.parse({
    items: values,
    count: values.filter((item) => item.needsAction || (!item.archived && item.unread)).length,
  });
}

export function createInboxService(database: ReturnType<typeof createDatabase>) {
  async function attentionIn(
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
        userId: ticketResponsibility.userId,
        version: ticketResponsibility.version,
      })
      .from(ticketResponsibility)
      .where(eq(ticketResponsibility.ticketId, ticketID));
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
  return {
    async list(userID: string) {
      return database.client.begin((transaction) => listIn(transaction, userID));
    },
    async people(userID: string, projectID: string) {
      return database.client.begin(async (transaction) => {
        await projectAuthorityIn(transaction, userID, projectID);
        return peopleIn(transaction, projectID);
      });
    },
    async ticket(userID: string, ticketID: string) {
      return database.client.begin(
        async (transaction) => (await attentionIn(transaction, userID, ticketID)).view,
      );
    },
    async responsibility(
      userID: string,
      ticketID: string,
      input: z.output<typeof responsibilityInput>,
    ) {
      return database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const current = await attentionIn(transaction, userID, ticketID, true);
        const [receipt] = await db
          .select({
            ticketId: ticketResponsibilityEvent.ticketId,
            actorId: ticketResponsibilityEvent.actorId,
            userId: ticketResponsibilityEvent.userId,
            expectedVersion: ticketResponsibilityEvent.expectedVersion,
          })
          .from(ticketResponsibilityEvent)
          .where(eq(ticketResponsibilityEvent.id, input.commandId));
        if (receipt) {
          if (
            receipt.ticketId !== ticketID ||
            receipt.actorId !== userID ||
            receipt.userId !== input.responsibleId ||
            receipt.expectedVersion !== input.expectedVersion
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
        const responsibility = {
          userId: input.responsibleId,
          version: input.expectedVersion + 1,
        };
        await db
          .insert(ticketResponsibility)
          .values({ ticketId: ticketID, ...responsibility })
          .onConflictDoUpdate({ target: ticketResponsibility.ticketId, set: responsibility });
        await db.insert(ticketResponsibilityEvent).values({
          id: input.commandId,
          ticketId: ticketID,
          userId: input.responsibleId,
          actorId: userID,
          expectedVersion: input.expectedVersion,
        });
        if (input.responsibleId && input.responsibleId !== current.view.responsibleId)
          await db
            .insert(ticketFollow)
            .values({
              ticketId: ticketID,
              userId: input.responsibleId,
              following: true,
            })
            .onConflictDoUpdate({
              target: [ticketFollow.ticketId, ticketFollow.userId],
              set: { following: true },
            });
        return (await attentionIn(transaction, userID, ticketID)).view;
      });
    },
    async follow(userID: string, ticketID: string, following: boolean) {
      return database.client.begin(async (transaction) => {
        await attentionIn(transaction, userID, ticketID, true);
        await drizzleTransaction(transaction)
          .insert(ticketFollow)
          .values({
            ticketId: ticketID,
            userId: userID,
            following,
          })
          .onConflictDoUpdate({
            target: [ticketFollow.ticketId, ticketFollow.userId],
            set: { following },
          });
        return (await attentionIn(transaction, userID, ticketID)).view;
      });
    },
    async receipt(userID: string, input: z.output<typeof inboxReceiptInput>) {
      return database.client.begin(async (transaction) => {
        const item = (await listIn(transaction, userID)).items.find(
          (row) => row.id === input.itemId,
        );
        if (!item || item.eventId !== input.eventId)
          throw new CommandError("conflict", "This Inbox item changed. Refresh before marking it.");
        if (item.needsAction && input.action === "archive")
          throw new CommandError(
            "conflict",
            "Resolve this request in its source. Reading does not complete it.",
          );
        const receipt = {
          seenEventId: input.action === "unread" ? null : input.eventId,
          archived: input.action === "archive",
        };
        await drizzleTransaction(transaction)
          .insert(inboxReceipt)
          .values({
            userId: userID,
            itemId: input.itemId,
            ...receipt,
          })
          .onConflictDoUpdate({
            target: [inboxReceipt.userId, inboxReceipt.itemId],
            set: receipt,
          });
      });
    },
  };
}
