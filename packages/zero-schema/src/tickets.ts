import {
  defineMutatorsWithType,
  defineMutatorWithType,
  defineQueriesWithType,
  defineQueryWithType,
  type ReadonlyJSONObject,
} from "@rocicorp/zero";
import { z } from "zod";
import { canPlanTicket } from "../../ticket-domain/src/ticket";
import { dependencyMutators } from "./dependencies";
import { assignTicketEpicMutator, epicMutators } from "./epics";
import { knowledgeMutators } from "./knowledge";
import { projectMutators } from "./projects";
import { readVersionQueries } from "./reads";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";
import { integer, record, text, uuid, validator } from "./validation";

type Json<T> = ReadonlyJSONObject & T;
type CreateArgs = Json<{
  id: string;
  projectId: string;
  title: string;
  description: string;
  state?: "inbox" | "ready";
}>;
type UpdateArgs = Json<{
  projectId: string;
  ticketId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
}>;
type MoveArgs = Json<{
  projectId: string;
  ticketId: string;
  expectedVersion: number;
  state: "inbox" | "backlog" | "ready" | "cancelled";
}>;

function field(input: Readonly<Record<string, unknown>>, name: string) {
  return input[name];
}

export const createTicketValidator = validator<CreateArgs>((value) => {
  const input = record(value);
  const state = field(input, "state");
  if (state !== undefined && state !== "inbox" && state !== "ready")
    throw new TypeError("Unsupported initial Ticket stage");
  return {
    ...(state === undefined ? {} : { state }),
    id: uuid(field(input, "id"), "id"),
    projectId: uuid(field(input, "projectId"), "projectId"),
    title: text(field(input, "title"), "title", false).trim(),
    description:
      field(input, "description") === undefined
        ? ""
        : text(field(input, "description"), "description"),
  };
});

function versioned(value: unknown) {
  const input = record(value);
  return {
    projectId: uuid(field(input, "projectId"), "projectId"),
    ticketId: uuid(field(input, "ticketId"), "ticketId"),
    expectedVersion: integer(field(input, "expectedVersion"), "expectedVersion"),
  };
}

export const updateTicketValidator = validator<UpdateArgs>((value) => {
  const input = record(value);
  const title =
    field(input, "title") === undefined
      ? undefined
      : text(field(input, "title"), "title", false).trim();
  const description =
    field(input, "description") === undefined
      ? undefined
      : text(field(input, "description"), "description");
  if (title === undefined && description === undefined)
    throw new TypeError("Ticket update is empty");
  return {
    ...versioned(value),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
});

export const moveTicketValidator = validator<MoveArgs>((value) => {
  const input = record(value);
  const state = field(input, "state");
  if (!(["inbox", "backlog", "ready", "cancelled"] as unknown[]).includes(state)) {
    throw new TypeError("Ticket planning state is unsupported");
  }
  return { ...versioned(value), state: state as MoveArgs["state"] };
});

const defineMutator = defineMutatorWithType<FactoryZeroSchema, FactoryZeroContext>();
const defineMutators = defineMutatorsWithType<FactoryZeroSchema>();

async function ticketFor(
  tx: Parameters<Parameters<typeof defineMutator>[1]>[0]["tx"],
  projectId: string,
  ticketId: string,
) {
  const ticket = await tx.run(zql.ticket.where("id", ticketId).where("projectId", projectId).one());
  if (ticket?.trashedAt) throw new Error("Restore the Ticket before editing");
  if (ticket?.convertedToEpicId)
    throw new Error("Open the Epic instead of editing the original intent");
  return ticket;
}

export const zeroMutators = defineMutators({
  projects: projectMutators,
  knowledge: knowledgeMutators,
  epics: epicMutators,
  dependencies: dependencyMutators,
  tickets: {
    assignEpic: assignTicketEpicMutator,
    create: defineMutator(createTicketValidator, async ({ tx, ctx, args }) => {
      const project = await tx.run(zql.project.where("id", args.projectId).one());
      if (!project) throw new Error("Project not found");
      const existing = await tx.run(zql.ticket.where("id", args.id).one());
      if (existing) {
        // Cached collisions may already have been removed on the server. Do not
        // overwrite them optimistically or prevent the authoritative retry.
        // The server validates identity, ownership and the exact saved content.
        return;
      }
      const now = Date.now();
      await tx.mutate.ticket.insert({
        id: args.id,
        projectId: args.projectId,
        title: args.title,
        description: args.description,
        state: args.state ?? "inbox",
        version: 1,
        createdBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
    }),
    update: defineMutator(updateTicketValidator, async ({ tx, args }) => {
      const ticket = await ticketFor(tx, args.projectId, args.ticketId);
      if (!ticket) return;
      await tx.mutate.ticket.update({
        id: ticket.id,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.description === undefined ? {} : { description: args.description }),
        version: Math.max(ticket.version + 1, args.expectedVersion + 1),
        updatedAt: Date.now(),
      });
    }),
    move: defineMutator(moveTicketValidator, async ({ tx, args }) => {
      const ticket = await ticketFor(tx, args.projectId, args.ticketId);
      if (!ticket) return;
      if (!canPlanTicket(ticket.state, args.state))
        throw new Error("Ticket state is lifecycle-protected");
      await tx.mutate.ticket.update({
        id: ticket.id,
        state: args.state,
        version: Math.max(ticket.version + 1, args.expectedVersion + 1),
        updatedAt: Date.now(),
      });
    }),
  },
});

const defineQuery = defineQueryWithType<FactoryZeroSchema, FactoryZeroContext>();
const defineQueries = defineQueriesWithType<FactoryZeroSchema>();
const projectIdValidator = validator<Json<{ projectId: string }>>((value) => {
  const input = record(value);
  return { projectId: uuid(field(input, "projectId"), "projectId") };
});

export const zeroQueries = defineQueries({
  readVersions: readVersionQueries,
  dependencies: {
    list: defineQuery(projectIdValidator, ({ args, ctx }) => {
      const query = zql.ticketDependency.where("projectId", args.projectId);
      return ctx.systemManager
        ? query
        : query.whereExists("members", (member) => member.where("userId", ctx.userId));
    }),
  },
  epics: {
    list: defineQuery(projectIdValidator, ({ args, ctx }) => {
      const query = zql.epic.where("projectId", args.projectId).orderBy("title", "asc");
      return ctx.systemManager
        ? query
        : query.whereExists("members", (member) => member.where("userId", ctx.userId));
    }),
  },
  memberships: {
    list: defineQuery(({ ctx }) => zql.projectMembership.where("userId", ctx.userId)),
  },
  projects: {
    list: defineQuery(({ ctx }) => {
      const query = zql.project.orderBy("createdAt", "desc");
      return ctx.systemManager
        ? query
        : query.whereExists("members", (member) => member.where("userId", ctx.userId));
    }),
  },
  tickets: {
    active: defineQuery(
      z.object({ projectId: z.uuid(), limit: z.number().int().positive() }),
      ({ args, ctx }) => {
        const query = zql.ticket
          .where("projectId", args.projectId)
          .where("trashedAt", "IS", null)
          .where("convertedToEpicId", "IS", null)
          .where("state", "NOT IN", ["done", "cancelled"])
          .orderBy("updatedAt", "desc")
          .limit(args.limit);
        return ctx.systemManager
          ? query
          : query.whereExists("members", (member) => member.where("userId", ctx.userId));
      },
    ),
    history: defineQuery(
      z.object({ projectId: z.uuid(), limit: z.number().int().positive() }),
      ({ args, ctx }) => {
        const query = zql.ticket
          .where("projectId", args.projectId)
          .where("trashedAt", "IS", null)
          .where("convertedToEpicId", "IS", null)
          .where("state", "IN", ["done", "cancelled"])
          .orderBy("updatedAt", "desc")
          .limit(args.limit);
        return ctx.systemManager
          ? query
          : query.whereExists("members", (member) => member.where("userId", ctx.userId));
      },
    ),
    trash: defineQuery(
      z.object({ projectId: z.uuid(), limit: z.number().int().positive() }),
      ({ args, ctx }) => {
        const query = zql.ticket
          .where("projectId", args.projectId)
          .where("trashedAt", "IS NOT", null)
          .orderBy("trashedAt", "desc")
          .limit(args.limit);
        return ctx.systemManager
          ? query
          : query.whereExists("members", (member) => member.where("userId", ctx.userId));
      },
    ),
    prerequisites: defineQuery(projectIdValidator, ({ args, ctx }) => {
      const query = zql.ticket
        .where("projectId", args.projectId)
        .whereExists("dependents", (edge) => edge.where("projectId", args.projectId));
      return ctx.systemManager
        ? query
        : query.whereExists("members", (member) => member.where("userId", ctx.userId));
    }),
    find: defineQuery(
      z.object({ projectId: z.uuid(), text: z.string().max(200) }),
      ({ args, ctx }) => {
        let query = zql.ticket
          .where("projectId", args.projectId)
          .where("trashedAt", "IS", null)
          .where("convertedToEpicId", "IS", null);
        for (const term of args.text.trim().split(/\s+/).filter(Boolean)) {
          if (/^tck-?$/i.test(term)) continue;
          const reference =
            /^tck-([0-9a-f]{1,6})$/i.exec(term)?.[1]?.toLowerCase() ??
            (/^[0-9a-f]{6}$/i.test(term) ? term.toLowerCase() : undefined);
          const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
          if (reference) {
            const uuidFor = (value: string) =>
              `${value.padEnd(8, "0")}-0000-0000-0000-000000000000`;
            const end = (parseInt(reference, 16) + 1).toString(16).padStart(reference.length, "0");
            query = query.where(({ cmp, or, and }) =>
              or(
                cmp("title", "ILIKE", pattern),
                end.length > reference.length
                  ? cmp("id", ">=", uuidFor(reference))
                  : and(cmp("id", ">=", uuidFor(reference)), cmp("id", "<", uuidFor(end))),
              ),
            );
          } else query = query.where("title", "ILIKE", pattern);
        }
        const result = query.orderBy("updatedAt", "desc").limit(51);
        return ctx.systemManager
          ? result
          : result.whereExists("members", (member) => member.where("userId", ctx.userId));
      },
    ),
  },
  knowledge: {
    outline: defineQuery(projectIdValidator, ({ args, ctx }) => {
      const query = zql.knowledgePageOutline
        .where("projectId", args.projectId)
        .where("state", "active")
        .orderBy("title", "asc");
      return ctx.systemManager
        ? query
        : query.whereExists("members", (member) => member.where("userId", ctx.userId));
    }),
    page: defineQuery(z.object({ projectId: z.uuid(), pageId: z.uuid() }), ({ args, ctx }) => {
      const query = zql.knowledgePage
        .where("projectId", args.projectId)
        .where("id", args.pageId)
        .where("state", "active");
      return (
        ctx.systemManager
          ? query
          : query.whereExists("members", (member) => member.where("userId", ctx.userId))
      ).one();
    }),
  },
});
