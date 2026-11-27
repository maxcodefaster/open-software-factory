import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { administrator, operation, project, projectMembership } from "#db/schema";
import { receivesAttention } from "#ticket-domain/attention";
import { projectAuthorityIn, requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";
import { collectActivitySources } from "./activity-sources";
import {
  type AttentionSource,
  type InboxDatabase,
  type ProjectScope,
  upsertOperation,
} from "./attention-types";
import { collectChangeSources } from "./change-sources";
import {
  type InboxItem,
  type InboxView,
  type inboxReceiptInput,
  inboxViewSchema,
  type responsibilityInput,
} from "./contracts";
import { collectDeliverySources } from "./delivery-sources";
import { collectPlanningSources } from "./planning-sources";
import {
  peopleIn,
  readTicketAttentionIn,
  responsibleMembersIn,
  ticketsIn,
  updateFollowIn,
  updateResponsibilityIn,
} from "./ticket-attention";

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

  const membershipByProject = new Map(memberships.map((row) => [row.projectId, row]));
  const scopes = new Map<string, ProjectScope>(
    projects.map((row) => {
      const membership = membershipByProject.get(row.id);
      return [
        row.id,
        {
          ...row,
          develop: Boolean(admin || membership?.role === "developer"),
          manage: Boolean(admin || membership?.manage),
        },
      ];
    }),
  );
  const projectIDs = projects.map((row) => row.id);
  const tickets = new Map(
    (await ticketsIn(transaction, userID, projectIDs)).map((row) => [row.id, row]),
  );
  const followedIDs = [...tickets.values()].filter((row) => row.following).map((row) => row.id);
  const responsibleIDs = [
    ...new Set(
      [...tickets.values()].flatMap((row) => (row.responsibleId ? [row.responsibleId] : [])),
    ),
  ];
  const responsibleByScope = await responsibleMembersIn(db, projectIDs, responsibleIDs);
  const receipts = new Map(
    (
      await db
        .select({
          itemId: sql<string>`${operation.payload}->>'itemId'`,
          seen: sql<string | null>`${operation.payload}->>'seenEventId'`,
          archived: sql<boolean>`coalesce((${operation.payload}->>'archived')::boolean, false)`,
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, "inbox.receipt"),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, userID),
          ),
        )
    ).map((row) => [row.itemId, row]),
  );

  const items = new Map<string, InboxItem>();
  function append(source: AttentionSource, needsAction: boolean) {
    const scope = scopes.get(source.projectId);
    const foundTicket = source.ticketId ? tickets.get(source.ticketId) : undefined;
    if (!scope || (source.ticketId && !foundTicket)) return;
    if (needsAction && foundTicket && ["done", "cancelled"].includes(foundTicket.state)) return;
    if (source.capability === "develop" && !scope.develop && source.authorID !== userID) return;
    if (source.capability === "manage" && !scope.manage) return;
    if (
      needsAction &&
      !receivesAttention({
        viewer: { id: userID, develop: scope.develop, manage: scope.manage },
        responsible: foundTicket?.responsibleId
          ? responsibleByScope.get(`${scope.id}:${foundTicket.responsibleId}`)
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
        foundTicket?.title ??
        (source.target === "inputs" ? "Project inputs" : "Personal Project chat"),
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
      targetId: source.targetId ?? null,
      contextId: source.contextId ?? null,
    });
  }

  const queryContext = { db, userID, projectIDs, followedIDs, scopes, tickets };
  for (const source of await collectActivitySources(queryContext)) append(source, false);
  for (const source of await collectPlanningSources(queryContext)) append(source, true);
  for (const source of await collectChangeSources(queryContext)) append(source, true);
  for (const source of await collectDeliverySources(queryContext)) append(source, true);

  const values = [...items.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  return inboxViewSchema.parse({
    items: values,
    count: values.filter((item) => item.needsAction || (!item.archived && item.unread)).length,
  });
}

async function saveReceiptIn(
  transaction: DatabaseTransaction,
  userID: string,
  input: z.output<typeof inboxReceiptInput>,
) {
  const item = (await listIn(transaction, userID)).items.find((row) => row.id === input.itemId);
  if (!item || item.eventId !== input.eventId)
    throw new CommandError("conflict", "This Inbox item changed. Refresh before marking it.");
  if (item.needsAction && input.action === "archive")
    throw new CommandError(
      "conflict",
      "Resolve this request in its source. Reading does not complete it.",
    );
  await upsertOperation(drizzleTransaction(transaction), {
    kind: "inbox.receipt",
    scopeType: "user",
    scopeId: userID,
    idempotencyKey: `inbox.receipt:${userID}:${input.itemId}`,
    state: "saved",
    payload: {
      userId: userID,
      itemId: input.itemId,
      seenEventId: input.action === "unread" ? null : input.eventId,
      archived: input.action === "archive",
    },
  });
}

export function createInboxService(database: InboxDatabase) {
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
        async (transaction) => (await readTicketAttentionIn(transaction, userID, ticketID)).view,
      );
    },
    async responsibility(
      userID: string,
      ticketID: string,
      input: z.output<typeof responsibilityInput>,
    ) {
      return database.client.begin((transaction) =>
        updateResponsibilityIn(transaction, userID, ticketID, input),
      );
    },
    async follow(userID: string, ticketID: string, following: boolean) {
      return database.client.begin((transaction) =>
        updateFollowIn(transaction, userID, ticketID, following),
      );
    },
    async receipt(userID: string, input: z.output<typeof inboxReceiptInput>) {
      return database.client.begin((transaction) => saveReceiptIn(transaction, userID, input));
    },
  };
}
