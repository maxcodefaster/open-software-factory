import { defineMutatorsWithType, defineMutatorWithType, type Transaction } from "@rocicorp/zero";
import type { DrizzleTransaction } from "@rocicorp/zero/server/adapters/drizzle";
import { and, eq, sql } from "drizzle-orm";
import type { createDatabase } from "../../db/src/client";
import { epic, project, ticket, ticketDependency } from "../../db/src/schema";
import { dependencyWouldCycle } from "../../ticket-domain/src/dependency";
import { canPlanTicket } from "../../ticket-domain/src/ticket";
import { ticketDependencyValidator } from "./dependencies";
import { assignTicketEpicValidator, createEpicValidator, updateEpicValidator } from "./epics";
import { knowledgePageIconValidator, moveKnowledgePageValidator } from "./knowledge";
import { moveKnowledgePage, setKnowledgePageIcon } from "./knowledge-server";
import type { FactoryZeroContext, FactoryZeroSchema } from "./schema";
import { createTicketValidator, moveTicketValidator, updateTicketValidator } from "./tickets";
import { createPlanningTicketIn } from "../../db/src/planning-ticket";
import { projectBackgroundValidator } from "./projects";

type Database = ReturnType<typeof createDatabase>["db"];
type WrappedTransaction = DrizzleTransaction<Database>;
const defineMutator = defineMutatorWithType<
  FactoryZeroSchema,
  FactoryZeroContext,
  WrappedTransaction
>();
const defineMutators = defineMutatorsWithType<FactoryZeroSchema>();

function drizzleTransaction(tx: Transaction<FactoryZeroSchema, WrappedTransaction>) {
  if (tx.location !== "server") throw new Error("Authoritative Ticket mutation is server-only");
  return tx.dbTransaction.wrappedTransaction;
}

async function requireProjectAccess(
  db: ReturnType<typeof drizzleTransaction>,
  userID: string,
  projectID: string,
) {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    WITH account AS (SELECT user_id FROM factory.account_access WHERE user_id=${userID}::uuid
      AND disabled_at IS NULL AND directory_disabled_at IS NULL FOR SHARE), membership AS (
      SELECT user_id FROM factory.project_membership
      WHERE project_id = ${projectID}::uuid AND user_id = ${userID}::uuid FOR SHARE
    )
    SELECT (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = ${userID}::uuid)
      OR EXISTS(SELECT 1 FROM membership)) AND EXISTS(SELECT 1 FROM account) AS allowed
  `);
  if (!rows[0]?.allowed) throw new Error("Project not found");
}

export const zeroServerMutators = defineMutators({
  projects: {
    setBackground: defineMutator(projectBackgroundValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      const managers = await db.execute<{ allowed: boolean }>(sql`
        WITH administrator AS (SELECT user_id FROM factory.administrator
          WHERE user_id=${ctx.userId}::uuid FOR SHARE)
        SELECT EXISTS(SELECT 1 FROM administrator) OR EXISTS(
          SELECT 1 FROM factory.project_membership
          WHERE project_id=${args.projectId}::uuid AND user_id=${ctx.userId}::uuid
            AND manage_project
        ) AS allowed`);
      if (!managers[0]?.allowed) throw new Error("Project Manager access required");
      const changed = await db
        .update(project)
        .set({ desktopBackgroundKey: args.desktopBackgroundKey, updatedAt: new Date() })
        .where(eq(project.id, args.projectId))
        .returning({ id: project.id });
      if (!changed.length) throw new Error("Project not found");
    }),
  },
  knowledge: {
    move: defineMutator(moveKnowledgePageValidator, async ({ tx, ctx, args }) => {
      await moveKnowledgePage(drizzleTransaction(tx), ctx.userId, args);
    }),
    setIcon: defineMutator(knowledgePageIconValidator, async ({ tx, ctx, args }) => {
      await setKnowledgePageIcon(drizzleTransaction(tx), ctx.userId, args);
    }),
  },
  dependencies: {
    add: defineMutator(ticketDependencyValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-dependencies:${args.projectId}`}, 0))`,
      );
      const locked = await db.execute<{ version: number }>(sql`
        SELECT version::float8 AS version FROM factory.ticket
        WHERE id = ${args.ticketId}::uuid AND project_id = ${args.projectId}::uuid AND trashed_at IS NULL AND converted_to_epic_id IS NULL FOR UPDATE
      `);
      if (locked[0]?.version !== args.expectedVersion) throw new Error("Ticket version conflict");
      const target = await db.query.ticket.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.id, args.prerequisiteId), eq(row.projectId, args.projectId)),
      });
      if (!target) throw new Error("Prerequisite Ticket not found");
      if (target.trashedAt) throw new Error("Restore the prerequisite Ticket before linking");
      if (target.convertedToEpicId)
        throw new Error("Link an Epic member instead of the original intent");
      const admitted = await db.execute(
        sql`SELECT id FROM factory.change WHERE ticket_id = ${args.ticketId}::uuid`,
      );
      if (admitted.length)
        throw new Error(
          "Implementation has already been admitted. Create a new Ticket for new prerequisites.",
        );
      const duplicate = await db.query.ticketDependency.findFirst({
        where: (row, { and, eq }) =>
          and(
            eq(row.projectId, args.projectId),
            eq(row.ticketId, args.ticketId),
            eq(row.prerequisiteId, args.prerequisiteId),
          ),
      });
      if (duplicate) throw new Error("This prerequisite is already linked");
      const dependencies = await db.query.ticketDependency.findMany({
        where: (row, { eq }) => eq(row.projectId, args.projectId),
      });
      if (dependencyWouldCycle(dependencies, args.ticketId, args.prerequisiteId))
        throw new Error("Ticket dependencies cannot contain a cycle");
      await db.insert(ticketDependency).values({
        projectId: args.projectId,
        ticketId: args.ticketId,
        prerequisiteId: args.prerequisiteId,
        createdBy: ctx.userId,
      });
      await db
        .update(ticket)
        .set({ version: args.expectedVersion + 1, updatedAt: new Date() })
        .where(eq(ticket.id, args.ticketId));
    }),
    remove: defineMutator(ticketDependencyValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-dependencies:${args.projectId}`}, 0))`,
      );
      const locked = await db.execute<{ version: number }>(sql`
        SELECT version::float8 AS version FROM factory.ticket
        WHERE id = ${args.ticketId}::uuid AND project_id = ${args.projectId}::uuid AND trashed_at IS NULL AND converted_to_epic_id IS NULL FOR UPDATE
      `);
      if (locked[0]?.version !== args.expectedVersion) throw new Error("Ticket version conflict");
      const removed = await db
        .delete(ticketDependency)
        .where(
          and(
            eq(ticketDependency.projectId, args.projectId),
            eq(ticketDependency.ticketId, args.ticketId),
            eq(ticketDependency.prerequisiteId, args.prerequisiteId),
          ),
        )
        .returning({ ticketId: ticketDependency.ticketId });
      if (removed.length !== 1) throw new Error("Prerequisite Ticket not found");
      await db
        .update(ticket)
        .set({ version: args.expectedVersion + 1, updatedAt: new Date() })
        .where(eq(ticket.id, args.ticketId));
    }),
  },
  epics: {
    create: defineMutator(createEpicValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      const project = await db.execute(
        sql`SELECT id FROM factory.project WHERE id = ${args.projectId}::uuid FOR UPDATE`,
      );
      if (!project.length) throw new Error("Project not found");
      if (args.parentId) {
        const parent = await db.query.epic.findFirst({
          where: (row, { and, eq }) =>
            and(eq(row.id, args.parentId ?? ""), eq(row.projectId, args.projectId)),
        });
        if (!parent) throw new Error("Parent Epic not found");
      }
      await db.insert(epic).values({ ...args, createdBy: ctx.userId });
    }),
    update: defineMutator(updateEpicValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      await db.execute(
        sql`SELECT id FROM factory.project WHERE id = ${args.projectId}::uuid FOR UPDATE`,
      );
      const current = await db.query.epic.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.id, args.epicId), eq(row.projectId, args.projectId)),
      });
      if (!current || current.version !== args.expectedVersion)
        throw new Error("Epic version conflict");
      if (args.parentId) {
        const parent = await db.query.epic.findFirst({
          where: (row, { and, eq }) =>
            and(eq(row.id, args.parentId ?? ""), eq(row.projectId, args.projectId)),
        });
        if (!parent) throw new Error("Parent Epic not found");
      }
      const changed = await db
        .update(epic)
        .set({
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(epic.id, current.id),
            eq(epic.projectId, args.projectId),
            eq(epic.version, args.expectedVersion),
          ),
        )
        .returning({ id: epic.id });
      if (changed.length !== 1) throw new Error("Epic version conflict");
    }),
  },
  tickets: {
    assignEpic: defineMutator(assignTicketEpicValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      const current = await db.query.ticket.findFirst({
        where: (row, { and, eq }) =>
          and(eq(row.id, args.ticketId), eq(row.projectId, args.projectId)),
      });
      if (!current || current.version !== args.expectedVersion)
        throw new Error("Ticket version conflict");
      if (current.trashedAt) throw new Error("Restore the Ticket before editing");
      if (current.convertedToEpicId)
        throw new Error("Open the Epic instead of editing the original intent");
      if (args.epicId) {
        const target = await db.query.epic.findFirst({
          where: (row, { and, eq }) =>
            and(eq(row.id, args.epicId ?? ""), eq(row.projectId, args.projectId)),
        });
        if (!target) throw new Error("Epic not found");
      }
      const changed = await db
        .update(ticket)
        .set({ epicId: args.epicId, version: current.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(ticket.id, args.ticketId),
            eq(ticket.projectId, args.projectId),
            eq(ticket.version, args.expectedVersion),
          ),
        )
        .returning({ id: ticket.id });
      if (changed.length !== 1) throw new Error("Ticket version conflict");
    }),
    create: defineMutator(createTicketValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await createPlanningTicketIn((statement) => db.execute(statement), ctx.userId, args);
    }),
    update: defineMutator(updateTicketValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      if (args.description !== undefined)
        await db.execute(sql`SELECT factory.bind_attachment_references(
          ${args.projectId}::uuid,${ctx.userId}::uuid,'ticket',${args.ticketId}::uuid,${args.description},true)`);
      const current = await db.query.ticket.findFirst({
        where: (row, { eq }) => eq(row.id, args.ticketId),
      });
      if (current?.trashedAt) throw new Error("Restore the Ticket before editing");
      if (current?.convertedToEpicId)
        throw new Error("Open the Epic instead of editing the original intent");
      if (
        !current ||
        current.projectId !== args.projectId ||
        current.version !== args.expectedVersion
      ) {
        throw new Error("Ticket version conflict");
      }
      const changed = await db
        .update(ticket)
        .set({
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ticket.id, current.id),
            eq(ticket.projectId, args.projectId),
            eq(ticket.version, args.expectedVersion),
          ),
        )
        .returning({ id: ticket.id });
      if (changed.length !== 1) throw new Error("Ticket update failed");
    }),
    move: defineMutator(moveTicketValidator, async ({ tx, ctx, args }) => {
      const db = drizzleTransaction(tx);
      await requireProjectAccess(db, ctx.userId, args.projectId);
      const current = await db.query.ticket.findFirst({
        where: (row, { eq }) => eq(row.id, args.ticketId),
      });
      if (current?.trashedAt) throw new Error("Restore the Ticket before editing");
      if (current?.convertedToEpicId)
        throw new Error("Open the Epic instead of editing the original intent");
      if (
        !current ||
        current.projectId !== args.projectId ||
        current.version !== args.expectedVersion
      ) {
        throw new Error("Ticket version conflict");
      }
      if (!canPlanTicket(current.state, args.state))
        throw new Error("Ticket state is lifecycle-protected");
      const changed = await db
        .update(ticket)
        .set({ state: args.state, version: current.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(ticket.id, current.id),
            eq(ticket.projectId, args.projectId),
            eq(ticket.version, args.expectedVersion),
          ),
        )
        .returning({ id: ticket.id });
      if (changed.length !== 1) throw new Error("Ticket version conflict");
    }),
  },
});
