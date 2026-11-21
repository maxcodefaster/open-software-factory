import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SourceCitation } from "../../../conversation-domain/src/conversation";
import { authUser } from "./auth";
import { change } from "./delivery";
import { conversationActor, conversationEntryKind, conversationMode } from "./enums";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { requirementRevision, ticket } from "./tickets";

export const conversationEntry = factorySchema.table(
  "conversation_entry",
  {
    id: uuid("id").primaryKey().notNull(),
    conversationId: uuid("conversation_id").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    kind: conversationEntryKind("kind").notNull(),
    actor: conversationActor("actor").notNull(),
    mode: conversationMode("mode").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    citations: jsonb("citations").$type<SourceCitation[]>().default([]).notNull(),
    inReplyToEntryId: uuid("in_reply_to_entry_id"),
    requirementRevisionId: uuid("requirement_revision_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("conversation_entry_question_answer_uidx")
      .using("btree", table.inReplyToEntryId.asc().nullsLast())
      .where(
        sql`((${table.kind} = 'answer'::conversation_entry_kind) AND (${table.inReplyToEntryId} IS NOT NULL))`,
      ),
    uniqueIndex("conversation_entry_requirement_uidx")
      .using("btree", table.requirementRevisionId.asc().nullsLast())
      .where(sql`(${table.requirementRevisionId} IS NOT NULL)`),
    foreignKey({
      columns: [table.conversationId],
      foreignColumns: [ticketConversation.id],
      name: "conversation_entry_conversation_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "conversation_entry_created_by_fkey",
    }),
    foreignKey({
      columns: [table.inReplyToEntryId],
      foreignColumns: [conversationEntry.id],
      name: "conversation_entry_in_reply_to_entry_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.requirementRevisionId],
      foreignColumns: [requirementRevision.id],
      name: "conversation_entry_requirement_revision_id_fkey",
    }).onDelete("restrict"),
    unique("conversation_entry_conversation_id_ordinal_key").on(
      table.conversationId,
      table.ordinal,
    ),
    check("conversation_entry_body_check", sql`length(${table.body}) <= 12000`),
    check("conversation_entry_ordinal_check", sql`${table.ordinal} > 0`),
  ],
);

export const conversationContext = factorySchema.table(
  "conversation_context",
  {
    id: uuid("id").primaryKey().notNull(),
    conversationId: uuid("conversation_id").notNull(),
    commandId: uuid("command_id").notNull(),
    kind: text("kind").$type<"research" | "coding">().notNull(),
    mode: conversationMode("mode").default("investigate").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    changeId: uuid("change_id"),
    nativeSessionId: text("native_session_id"),
    previousContextId: uuid("previous_context_id"),
    original: boolean("original").default(false).notNull(),
    archivedSession: jsonb("archived_session"),
    transcript: jsonb("transcript").default([]).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("conversation_context_original")
      .using("btree", table.conversationId.asc().nullsLast())
      .where(sql`${table.original}`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "conversation_context_change_id_fkey",
    }),
    foreignKey({
      columns: [table.conversationId],
      foreignColumns: [ticketConversation.id],
      name: "conversation_context_conversation_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "conversation_context_created_by_fkey",
    }),
    foreignKey({
      columns: [table.previousContextId],
      foreignColumns: [conversationContext.id],
      name: "conversation_context_previous_context_id_fkey",
    }),
    unique("conversation_context_conversation_id_ordinal_key").on(
      table.conversationId,
      table.ordinal,
    ),
    unique("conversation_context_command_id_key").on(table.commandId),
    check(
      "conversation_context_check",
      sql`(${table.kind} = 'coding'::text) = (${table.changeId} IS NOT NULL)`,
    ),
    check(
      "conversation_context_check1",
      sql`(${table.kind} = 'coding'::text) = (${table.mode} = 'build'::conversation_mode)`,
    ),
    check(
      "conversation_context_check2",
      sql`(${table.kind} = 'coding'::text) OR ((${table.nativeSessionId} IS NULL) AND (${table.archivedSession} IS NULL) AND (NOT ${table.original}))`,
    ),
    check(
      "conversation_context_kind_check",
      sql`${table.kind} = ANY (ARRAY['research'::text, 'coding'::text])`,
    ),
    check("conversation_context_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "conversation_context_title_check",
      sql`(length(${table.title}) >= 1) AND (length(${table.title}) <= 200)`,
    ),
  ],
);

export const ticketConversation = factorySchema.table(
  "ticket_conversation",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id"),
    mode: conversationMode("mode").default("investigate").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    activeCodingContextId: uuid("active_coding_context_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("ticket_conversation_project_draft_uidx")
      .using("btree", table.projectId.asc().nullsLast(), table.createdBy.asc().nullsLast())
      .where(sql`(${table.ticketId} IS NULL)`),
    uniqueIndex("ticket_conversation_ticket_uidx")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(sql`(${table.ticketId} IS NOT NULL)`),
    foreignKey({
      columns: [table.activeCodingContextId],
      foreignColumns: [conversationContext.id],
      name: "ticket_conversation_active_coding_context_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "ticket_conversation_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "ticket_conversation_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_conversation_ticket_id_fkey",
    }).onDelete("restrict"),
    check("ticket_conversation_version_check", sql`${table.version} > 0`),
  ],
);
