import type { createDatabase } from "../../../../packages/db/src/client";
import {
  mentionedPeople,
  receivesAttention,
  type AttentionCapability,
  type AttentionMember,
} from "../../../../packages/ticket-domain/src/attention";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  inboxViewSchema,
  ticketAttentionSchema,
  type AttentionPerson,
  type InboxItem,
  type InboxView,
  type inboxReceiptInput,
  type responsibilityInput,
} from "./contracts";
import type { z } from "zod";

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

async function peopleIn(sql: AgentTurnTransaction, projectID: string): Promise<AttentionPerson[]> {
  return sql<AttentionPerson[]>`
    SELECT person.id,person.name,
      (membership.role='developer' OR admin.user_id IS NOT NULL) AS develop,
      (membership.manage_project OR admin.user_id IS NOT NULL) AS manage
    FROM factory.project_membership membership
    JOIN auth."user" person ON person.id=membership.user_id
    JOIN factory.account_access account ON account.user_id=person.id
    LEFT JOIN factory.administrator admin ON admin.user_id=person.id
    WHERE membership.project_id=${projectID}
      AND account.disabled_at IS NULL AND account.directory_disabled_at IS NULL
    ORDER BY lower(person.name),person.id`;
}

async function ticketsIn(sql: AgentTurnTransaction, userID: string, projects: string[]) {
  return sql<Ticket[]>`
    SELECT ticket.id,ticket.project_id AS "projectId",ticket.title,ticket.state,
      responsibility.user_id AS "responsibleId",
      COALESCE(follow.following,
        ticket.created_by=${userID} OR responsibility.user_id=${userID}
        OR EXISTS(SELECT 1 FROM factory.agent_turn WHERE ticket_id=ticket.id AND created_by=${userID})
        OR EXISTS(SELECT 1 FROM factory.conversation_entry entry
          JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
          WHERE conversation.ticket_id=ticket.id AND entry.created_by=${userID} AND entry.actor='user')
        OR EXISTS(SELECT 1 FROM factory.review_feedback_message message
          JOIN factory.review_feedback feedback ON feedback.id=message.feedback_id
          JOIN factory.change change ON change.id=feedback.change_id
          WHERE change.ticket_id=ticket.id AND message.author_id=${userID}),false) AS following
    FROM factory.ticket ticket
    LEFT JOIN factory.ticket_responsibility responsibility ON responsibility.ticket_id=ticket.id
    LEFT JOIN factory.ticket_follow follow ON follow.ticket_id=ticket.id AND follow.user_id=${userID}
    WHERE ticket.project_id=ANY(${projects}::uuid[])
      AND ticket.trashed_at IS NULL AND ticket.converted_to_epic_id IS NULL`;
}

// The Inbox projects retained source records. It cannot approve, retry, dispatch,
// or invent work. Resolved/superseded source state removes an obligation for all
// recipients, independently of their personal read receipts.
async function listIn(sql: AgentTurnTransaction, userID: string): Promise<InboxView> {
  await requireActiveAccountIn(sql, userID);
  const [administrator] =
    await sql`SELECT user_id FROM factory.administrator WHERE user_id=${userID} FOR SHARE`;
  const memberships = await sql<{ projectId: string; role: string; manage: boolean }[]>`
    SELECT project_id AS "projectId",role,manage_project AS manage
    FROM factory.project_membership WHERE user_id=${userID} FOR SHARE`;
  const projects = await sql<{ id: string; name: string }[]>`
    SELECT id,name FROM factory.project
    WHERE ${Boolean(administrator)} OR id=ANY(${memberships.map((row) => row.projectId)}::uuid[])`;
  if (!projects.length) return { items: [], count: 0 };
  const scopes = new Map<string, Scope>(
    projects.map((project) => {
      const membership = memberships.find((row) => row.projectId === project.id);
      return [
        project.id,
        {
          ...project,
          develop: Boolean(administrator || membership?.role === "developer"),
          manage: Boolean(administrator || membership?.manage),
        },
      ];
    }),
  );
  const projectIDs = projects.map((project) => project.id);
  const tickets = new Map((await ticketsIn(sql, userID, projectIDs)).map((row) => [row.id, row]));
  const followedIDs = [...tickets.values()]
    .filter((ticket) => ticket.following)
    .map((ticket) => ticket.id);
  const responsibleIDs = [
    ...new Set(
      [...tickets.values()].flatMap((row) => (row.responsibleId ? [row.responsibleId] : [])),
    ),
  ];
  const responsibleMembers = await sql<(AttentionMember & { projectId: string })[]>`
    SELECT member.user_id AS id,member.project_id AS "projectId",
      (member.role='developer' OR admin.user_id IS NOT NULL) AS develop,
      (member.manage_project OR admin.user_id IS NOT NULL) AS manage
    FROM factory.project_membership member
    JOIN factory.account_access account ON account.user_id=member.user_id
    LEFT JOIN factory.administrator admin ON admin.user_id=member.user_id
    WHERE member.user_id=ANY(${responsibleIDs}::uuid[])
      AND member.project_id=ANY(${projectIDs}::uuid[])
      AND account.disabled_at IS NULL AND account.directory_disabled_at IS NULL`;
  const receipts = new Map(
    (
      await sql<{ itemId: string; seen: string | null; archived: boolean }[]>`
    SELECT item_id AS "itemId",seen_event_id AS seen,archived
    FROM factory.inbox_receipt WHERE user_id=${userID}`
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
  const conversations = await sql<(Source & { actorID: string; visibility: string | null })[]>`
    SELECT 'conversation:'||conversation.id::text||':'||COALESCE(entry.payload->>'contextId','original') AS id,
      entry.id::text AS "eventId",conversation.project_id AS "projectId",
      conversation.ticket_id AS "ticketId",'New Ticket discussion' AS title,entry.body AS preview,
      entry.created_at AS "createdAt",'conversation' AS target,entry.id AS "targetId",
      (entry.payload->>'contextId')::uuid AS "contextId",'contribute' AS capability,
      entry.created_by AS "actorID",entry.payload->>'visibility' AS visibility
    FROM factory.conversation_entry entry
    JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
    WHERE conversation.project_id=ANY(${projectIDs}::uuid[]) AND conversation.ticket_id IS NOT NULL
      AND entry.actor='user' AND entry.kind IN ('user-message','answer')
      AND entry.created_by<>${userID}
      AND (conversation.ticket_id=ANY(${followedIDs}::uuid[]) OR position(${userID} IN entry.body)>0)
    ORDER BY entry.created_at,entry.ordinal`;
  for (const row of conversations) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if (row.visibility === "developer" && !scopes.get(row.projectId)?.develop) continue;
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in Ticket chat" : row.title }, false);
  }
  const coding = await sql<Source[]>`
    SELECT 'coding:'||change.id::text||':'||COALESCE(turn.input->>'contextId','original') AS id,
      turn.id::text AS "eventId",turn.project_id AS "projectId",turn.ticket_id AS "ticketId",
      'New Coding discussion' AS title,turn.input->>'text' AS preview,turn.created_at AS "createdAt",
      'coding' AS target,intent.prompt_id AS "targetId",(turn.input->>'contextId')::uuid AS "contextId",
      'develop' AS capability
    FROM factory.agent_turn turn JOIN factory.change change ON change.id=turn.change_id
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
    WHERE turn.project_id=ANY(${projectIDs}::uuid[]) AND turn.input->>'kind'='change-prompt'
      AND turn.created_by<>${userID}
      AND (turn.ticket_id=ANY(${followedIDs}::uuid[]) OR position(${userID} IN turn.input->>'text')>0)
    ORDER BY turn.created_at,turn.id`;
  for (const row of coding) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in Coding" : row.title }, false);
  }
  const discussions = await sql<Source[]>`
    SELECT 'feedback:'||feedback.id::text AS id,message.id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",
      'New review discussion' AS title,message.body AS preview,message.created_at AS "createdAt",
      'review' AS target,feedback.id AS "targetId",NULL::uuid AS "contextId",'contribute' AS capability
    FROM factory.review_feedback_message message
    JOIN factory.review_feedback feedback ON feedback.id=message.feedback_id
    JOIN factory.change change ON change.id=feedback.change_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND message.author_id<>${userID}
      AND (change.ticket_id=ANY(${followedIDs}::uuid[]) OR position(${userID} IN message.body)>0)
    ORDER BY message.created_at,message.id`;
  for (const row of discussions) {
    const mentioned = mentionedPeople(row.preview).includes(userID);
    if ((row.ticketId && tickets.get(row.ticketId)?.following) || mentioned)
      append({ ...row, title: mentioned ? "You were mentioned in review" : row.title }, false);
  }
  const assignments = await sql<Source[]>`
    SELECT 'responsibility:'||event.ticket_id::text AS id,event.id::text AS "eventId",
      ticket.project_id AS "projectId",ticket.id AS "ticketId",'You are responsible for this Ticket' AS title,
      actor.name||' assigned you responsibility. This does not start Agent work.' AS preview,
      event.created_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'contribute' AS capability
    FROM factory.ticket_responsibility_event event
    JOIN factory.ticket ticket ON ticket.id=event.ticket_id
    JOIN auth."user" actor ON actor.id=event.actor_id
    WHERE ticket.project_id=ANY(${projectIDs}::uuid[]) AND event.user_id=${userID} AND event.actor_id<>${userID}
    ORDER BY event.created_at,event.id`;
  for (const row of assignments) append(row, false);

  const questions = await sql<Source[]>`
    SELECT entry.kind::text||':'||entry.id::text AS id,entry.id::text AS "eventId",
      conversation.project_id AS "projectId",conversation.ticket_id AS "ticketId",
      CASE WHEN entry.kind='question' THEN 'Answer the Agent’s question' ELSE 'Confirm proposed requirements' END AS title,
      entry.body AS preview,entry.created_at AS "createdAt",'conversation' AS target,
      entry.id AS "targetId",(entry.payload->>'contextId')::uuid AS "contextId",
      CASE WHEN entry.payload->>'visibility'='developer' THEN 'develop' ELSE 'contribute' END AS capability,
      CASE WHEN conversation.ticket_id IS NULL THEN conversation.created_by END AS "addressedTo"
    FROM factory.conversation_entry entry
    JOIN factory.ticket_conversation conversation ON conversation.id=entry.conversation_id
    WHERE conversation.project_id=ANY(${projectIDs}::uuid[])
      AND (conversation.ticket_id IS NOT NULL OR conversation.created_by=${userID})
      AND entry.kind IN ('question','requirement')
      AND NOT EXISTS(SELECT 1 FROM factory.conversation_entry answer
        WHERE answer.in_reply_to_entry_id=entry.id AND answer.kind='answer')
      AND NOT EXISTS(SELECT 1 FROM factory.ticket_document_revision revision WHERE revision.proposal_entry_id=entry.id)
      AND NOT EXISTS(SELECT 1 FROM factory.conversation_entry newer
        WHERE newer.conversation_id=entry.conversation_id AND newer.ordinal>entry.ordinal
          AND newer.payload->>'contextId' IS NOT DISTINCT FROM entry.payload->>'contextId'
          AND (newer.kind IN ('question','requirement') OR
            (newer.kind='user-message' AND COALESCE(newer.payload->>'intent','')!='project-research')))`;
  for (const row of questions) {
    if (!row.ticketId && row.title === "Confirm proposed requirements") continue;
    append(row, true);
  }
  const designs = await sql<Source[]>`
    SELECT 'design:'||design.id::text AS id,design.id::text AS "eventId",
      ticket.project_id AS "projectId",ticket.id AS "ticketId",'Review the technical design' AS title,
      'Technical planning is complete. Review the design before approving implementation.' AS preview,
      design.created_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability
    FROM factory.technical_design_revision design JOIN factory.ticket ticket ON ticket.id=design.ticket_id
    WHERE ticket.project_id=ANY(${projectIDs}::uuid[]) AND ticket.state='ready'
      AND design.ordinal=(SELECT max(ordinal) FROM factory.technical_design_revision WHERE ticket_id=ticket.id)
      AND design.requirement_revision_id=(SELECT id FROM factory.requirement_revision WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM factory.requirement_approval WHERE technical_design_revision_id=design.id)
      AND NOT EXISTS(SELECT 1 FROM factory.change WHERE ticket_id=ticket.id)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE ticket_id=ticket.id AND state IN ('pending','dispatching','running','uncertain'))`;
  for (const row of designs) append(row, true);
  const failures = await sql<Source[]>`
    SELECT 'turn:'||turn.id::text AS id,turn.id::text AS "eventId",turn.project_id AS "projectId",
      turn.ticket_id AS "ticketId",'Agent work needs attention' AS title,
      COALESCE(turn.outcome_summary,'Work stopped without a confirmed result. Inspect before retrying.') AS preview,
      turn.updated_at AS "createdAt",'conversation' AS target,NULL::uuid AS "targetId",
      (turn.input->>'contextId')::uuid AS "contextId",
      CASE WHEN turn.authority->>'mode'='build' OR turn.authority->>'visibility'='developer'
        OR turn.input->>'intent' IN ('technical-planning','full-planning') THEN 'develop' ELSE 'contribute' END AS capability,
      CASE WHEN turn.ticket_id IS NULL THEN turn.created_by END AS "addressedTo"
    FROM factory.agent_turn turn
    WHERE turn.project_id=ANY(${projectIDs}::uuid[]) AND turn.state IN ('failed','uncertain')
      AND (turn.ticket_id IS NOT NULL OR turn.created_by=${userID})
      AND NOT EXISTS(SELECT 1 FROM factory.coding_pause pause WHERE pause.turn_id=turn.id AND pause.resumed_by_turn_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM factory.change change WHERE change.id=turn.change_id AND change.state='failed')
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn newer
        WHERE ((turn.change_id IS NOT NULL AND newer.change_id=turn.change_id) OR
          (turn.change_id IS NULL AND newer.conversation_id=turn.conversation_id
            AND newer.input->>'contextId' IS NOT DISTINCT FROM turn.input->>'contextId'))
          AND (newer.created_at,newer.id)>(turn.created_at,turn.id))`;
  for (const row of failures) {
    const ticket = row.ticketId && tickets.get(row.ticketId);
    if (ticket && ["done", "cancelled"].includes(ticket.state)) continue;
    append(row, true);
  }
  const changes = await sql<Source[]>`
    SELECT 'change:'||change.id::text AS id,change.id::text||':'||change.version::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Implementation is blocked' AS title,
      COALESCE(change.failure,'Implementation failed. Inspect the Ticket before retrying.') AS preview,
      change.created_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability
    FROM factory.change change WHERE change.project_id=ANY(${projectIDs}::uuid[])
      AND change.state='failed'
      AND NOT EXISTS(SELECT 1 FROM factory.change newer WHERE newer.ticket_id=change.ticket_id
        AND (newer.created_at,newer.id)>(change.created_at,change.id))`;
  for (const row of changes) append(row, true);
  const pauses = await sql<Source[]>`
    SELECT 'pause:'||pause.turn_id::text AS id,pause.turn_id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Coding is paused' AS title,
      pause.reason AS preview,turn.updated_at AS "createdAt",'ticket' AS target,
      NULL::uuid AS "targetId",NULL::uuid AS "contextId",'contribute' AS capability
    FROM factory.coding_pause pause JOIN factory.agent_turn turn ON turn.id=pause.turn_id
    JOIN factory.change change ON change.id=turn.change_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND pause.resumed_by_turn_id IS NULL
      AND change.state NOT IN ('cancelled','delivered')
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn newer WHERE newer.change_id=change.id
        AND (newer.created_at,newer.id)>(turn.created_at,turn.id))`;
  for (const row of pauses) append(row, true);

  const feedback = await sql<Source[]>`
    SELECT 'recheck:'||feedback.id::text AS id,feedback.id::text||':'||feedback.version::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Recheck implemented feedback' AS title,
      'The Agent reports this Thread implemented. Inspect the result and resolve it or request changes.' AS preview,
      feedback.created_at AS "createdAt",'review' AS target,feedback.id AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability,feedback.author_id AS "authorID"
    FROM factory.review_feedback feedback JOIN factory.change change ON change.id=feedback.change_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND feedback.kind='thread'
      AND feedback.state='implemented' AND change.state NOT IN ('cancelled','delivered')`;
  for (const row of feedback) append(row, true);
  const editing = await sql<Source[]>`
    SELECT 'editing:'||request.id::text AS id,request.id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Editing transfer requested' AS title,
      requester.name||' would like to edit this Ticket Workspace.' AS preview,
      request.created_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability,request.owner_id AS "addressedTo"
    FROM factory.change_editing_request request
    JOIN factory.change change ON change.id=request.change_id
    JOIN factory.change_writer writer ON writer.change_id=change.id
    JOIN auth."user" requester ON requester.id=request.requester_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND request.state='requested'
      AND request.owner_id=${userID} AND writer.user_id=request.owner_id
      AND writer.epoch=request.writer_epoch AND writer.state='human'`;
  for (const row of editing) append(row, true);

  // Exact current verification/review, settled writer and no open Threads.
  // The destination command still rechecks its complete immutable-candidate gate.
  const delivery = await sql<Source[]>`
    SELECT 'delivery:'||review.id::text AS id,review.id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Review and approve Delivery' AS title,
      COALESCE(review.result->>'summary','Verification and independent review passed. Inspect the exact candidate before Delivery.') AS preview,
      review.completed_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability
    FROM factory.change change
    JOIN factory.change_agent_session session ON session.change_id=change.id AND session.state='committed'
    JOIN factory.verification verification ON verification.change_id=change.id AND verification.state='succeeded'
    JOIN factory.candidate_review review ON review.verification_id=verification.id AND review.state='passed'
    JOIN factory.requirement_approval approved ON approved.id=change.requirement_approval_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND change.state='active'
      AND change.cancel_requested_at IS NULL AND NOT session.stop_pending
      AND verification.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
      AND review.ordinal=(SELECT max(ordinal) FROM factory.candidate_review WHERE verification_id=verification.id)
      AND approved.requirement_revision_id=(SELECT id FROM factory.requirement_revision
        WHERE ticket_id=change.ticket_id ORDER BY ordinal DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM factory.delivery_approval WHERE verification_id=verification.id)
      AND NOT EXISTS(SELECT 1 FROM factory.review_feedback WHERE change_id=change.id AND kind='thread' AND state<>'resolved')
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id AND state IN ('pending','dispatching','running','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM factory.change_writer WHERE change_id=change.id AND state NOT IN ('agent','unassigned'))
      AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id AND state NOT IN ('succeeded','failed'))`;
  for (const row of delivery) append(row, true);
  const reviewFailures = await sql<Source[]>`
    SELECT 'review:'||review.id::text AS id,review.id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Independent review needs attention' AS title,
      COALESCE(review.result->>'summary','Independent review is incomplete. Inspect its evidence before retrying.') AS preview,
      COALESCE(review.completed_at,review.created_at) AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'contribute' AS capability
    FROM factory.candidate_review review
    JOIN factory.change change ON change.id=review.change_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND change.state='active' AND review.state='incomplete'
      AND review.ordinal=(SELECT max(ordinal) FROM factory.candidate_review WHERE verification_id=review.verification_id)
      AND review.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id AND state IN ('pending','dispatching','running'))`;
  for (const row of reviewFailures) append(row, true);
  const checks = await sql<Source[]>`
    SELECT 'verification:'||verification.id::text AS id,verification.id::text AS "eventId",
      change.project_id AS "projectId",change.ticket_id AS "ticketId",'Verification needs attention' AS title,
      COALESCE(verification.summary,'Verification failed after the correction attempt. Inspect the checks before continuing.') AS preview,
      verification.updated_at AS "createdAt",'ticket' AS target,NULL::uuid AS "targetId",
      NULL::uuid AS "contextId",'develop' AS capability
    FROM factory.verification verification JOIN factory.change change ON change.id=verification.change_id
    WHERE change.project_id=ANY(${projectIDs}::uuid[]) AND change.state='active'
      AND verification.state='failed' AND verification.repair_prompted_at IS NOT NULL
      AND verification.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
        WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM factory.verification newer WHERE newer.change_id=change.id
        AND (newer.created_at,newer.id)>(verification.created_at,verification.id))
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id AND state IN ('pending','dispatching','running'))`;
  for (const row of checks) append(row, true);
  const inputs = await sql<Source[]>`
    SELECT 'input:'||incident.id::text AS id,incident.id::text||':'||incident.state AS "eventId",
      incident.project_id AS "projectId",incident.ticket_id AS "ticketId",'Project Input needs attention' AS title,
      COALESCE(incident.reason,'This external request could not continue. Inspect its retained outcome before retrying.') AS preview,
      incident.last_seen_at AS "createdAt",'inputs' AS target,incident.id AS "targetId",
      NULL::uuid AS "contextId",'manage' AS capability
    FROM factory.monitoring_incident incident
    WHERE incident.project_id=ANY(${projectIDs}::uuid[]) AND incident.state IN ('blocked','uncertain')`;
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
    sql: AgentTurnTransaction,
    userID: string,
    ticketID: string,
    write = false,
  ) {
    const [ticket] = await sql<{ projectId: string }[]>`
      SELECT project_id AS "projectId" FROM factory.ticket WHERE id=${ticketID}
        AND trashed_at IS NULL AND converted_to_epic_id IS NULL`;
    if (!ticket) throw new CommandError("not-found", "Ticket not found");
    await projectAuthorityIn(sql, userID, ticket.projectId);
    // Match the existing account/membership -> Ticket lock order. Polling takes
    // only a shared lock; metadata writes serialize without fencing Agent work.
    const locked = write
      ? await sql`SELECT id FROM factory.ticket WHERE id=${ticketID} AND project_id=${ticket.projectId}
          AND trashed_at IS NULL AND converted_to_epic_id IS NULL FOR UPDATE`
      : await sql`SELECT id FROM factory.ticket WHERE id=${ticketID} AND project_id=${ticket.projectId}
          AND trashed_at IS NULL AND converted_to_epic_id IS NULL FOR SHARE`;
    if (!locked.length) throw new CommandError("not-found", "Ticket not found");
    const [responsibility] = await sql<{ userId: string | null; version: number }[]>`
      SELECT user_id AS "userId",version FROM factory.ticket_responsibility WHERE ticket_id=${ticketID}`;
    const ticketView = (await ticketsIn(sql, userID, [ticket.projectId])).find(
      (row) => row.id === ticketID,
    );
    return {
      projectID: ticket.projectId,
      view: ticketAttentionSchema.parse({
        responsibleId: responsibility?.userId ?? null,
        version: responsibility?.version ?? 0,
        following: ticketView?.following ?? false,
        people: await peopleIn(sql, ticket.projectId),
      }),
    };
  }
  return {
    async list(userID: string) {
      return database.client.begin((sql) => listIn(sql, userID));
    },
    async people(userID: string, projectID: string) {
      return database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, userID, projectID);
        return peopleIn(sql, projectID);
      });
    },
    async ticket(userID: string, ticketID: string) {
      return database.client.begin(async (sql) => (await attentionIn(sql, userID, ticketID)).view);
    },
    async responsibility(
      userID: string,
      ticketID: string,
      input: z.output<typeof responsibilityInput>,
    ) {
      return database.client.begin(async (sql) => {
        const current = await attentionIn(sql, userID, ticketID, true);
        const [receipt] = await sql<
          { ticketId: string; actorId: string; userId: string | null; expectedVersion: number }[]
        >`
          SELECT ticket_id AS "ticketId",actor_id AS "actorId",user_id AS "userId",expected_version AS "expectedVersion"
          FROM factory.ticket_responsibility_event WHERE id=${input.commandId}`;
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
        await sql`INSERT INTO factory.ticket_responsibility(ticket_id,user_id,version)
          VALUES(${ticketID},${input.responsibleId},${input.expectedVersion + 1})
          ON CONFLICT(ticket_id) DO UPDATE SET user_id=EXCLUDED.user_id,version=EXCLUDED.version`;
        await sql`INSERT INTO factory.ticket_responsibility_event(id,ticket_id,user_id,actor_id,expected_version)
          VALUES(${input.commandId},${ticketID},${input.responsibleId},${userID},${input.expectedVersion})`;
        if (input.responsibleId && input.responsibleId !== current.view.responsibleId)
          await sql`INSERT INTO factory.ticket_follow(ticket_id,user_id,following)
            VALUES(${ticketID},${input.responsibleId},true)
            ON CONFLICT(ticket_id,user_id) DO UPDATE SET following=true`;
        return (await attentionIn(sql, userID, ticketID)).view;
      });
    },
    async follow(userID: string, ticketID: string, following: boolean) {
      return database.client.begin(async (sql) => {
        await attentionIn(sql, userID, ticketID, true);
        await sql`INSERT INTO factory.ticket_follow(ticket_id,user_id,following)
          VALUES(${ticketID},${userID},${following}) ON CONFLICT(ticket_id,user_id)
          DO UPDATE SET following=EXCLUDED.following`;
        return (await attentionIn(sql, userID, ticketID)).view;
      });
    },
    async receipt(userID: string, input: z.output<typeof inboxReceiptInput>) {
      return database.client.begin(async (sql) => {
        const item = (await listIn(sql, userID)).items.find((row) => row.id === input.itemId);
        if (!item || item.eventId !== input.eventId)
          throw new CommandError("conflict", "This Inbox item changed. Refresh before marking it.");
        if (item.needsAction && input.action === "archive")
          throw new CommandError(
            "conflict",
            "Resolve this request in its source. Reading does not complete it.",
          );
        await sql`INSERT INTO factory.inbox_receipt(user_id,item_id,seen_event_id,archived)
          VALUES(${userID},${input.itemId},${input.action === "unread" ? null : input.eventId},${input.action === "archive"})
          ON CONFLICT(user_id,item_id) DO UPDATE
          SET seen_event_id=EXCLUDED.seen_event_id,archived=EXCLUDED.archived`;
      });
    },
  };
}
