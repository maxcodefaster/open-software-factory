import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { agentTurn } from "./coding";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const attachment = factorySchema.table(
  "attachment",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    draftId: uuid("draft_id"),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    sha256: text("sha256").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    state: text("state")
      .$type<"uploading" | "ready" | "failed" | "deleting" | "deleted">()
      .notNull(),
    textContent: text("text_content").default("").notNull(),
    objects: jsonb("objects")
      .$type<{ key: string; sha256: string; bytes: number; mediaType: string; name: string }[]>()
      .default([])
      .notNull(),
    failure: text("failure"),
    uploadToken: uuid("upload_token"),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("attachment_project_storage").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.state.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "attachment_owner_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "attachment_project_id_fkey",
    }),
    check("attachment_byte_length_check", sql`${table.byteLength} > 0`),
    check("attachment_check", sql`${table.reservedBytes} >= ${table.byteLength}`),
    check(
      "attachment_name_check",
      sql`(length(${table.name}) >= 1) AND (length(${table.name}) <= 240)`,
    ),
    check("attachment_objects_check", sql`jsonb_typeof(${table.objects}) = 'array'::text`),
    check("attachment_sha256_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'::text`),
    check(
      "attachment_state_check",
      sql`${table.state} = ANY (ARRAY['uploading'::text, 'ready'::text, 'failed'::text, 'deleting'::text, 'deleted'::text])`,
    ),
  ],
);

export const attachmentStorage = factorySchema.table(
  "attachment_storage",
  {
    singleton: boolean("singleton").default(true).primaryKey().notNull(),
    id: uuid("id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("attachment_storage_id_key").on(table.id),
    check("attachment_storage_singleton_check", sql`(${table.singleton})`),
  ],
);

export const attachmentTurnContext = factorySchema.table(
  "attachment_turn_context",
  {
    turnId: uuid("turn_id").notNull(),
    source: text("source").default("admission").notNull(),
    content: text("content").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "attachment_turn_context_turn_id_fkey",
    }),
    primaryKey({ columns: [table.turnId, table.source], name: "attachment_turn_context_pkey" }),
  ],
);

export const attachmentReference = factorySchema.table(
  "attachment_reference",
  {
    attachmentId: uuid("attachment_id").notNull(),
    kind: text("kind")
      .$type<"ticket" | "requirement" | "knowledge" | "conversation" | "feedback" | "turn">()
      .notNull(),
    referenceId: uuid("reference_id").notNull(),
    shared: boolean("shared").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("attachment_reference_target").using(
      "btree",
      table.kind.asc().nullsLast(),
      table.referenceId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.attachmentId],
      foreignColumns: [attachment.id],
      name: "attachment_reference_attachment_id_fkey",
    }),
    primaryKey({
      columns: [table.attachmentId, table.kind, table.referenceId],
      name: "attachment_reference_pkey",
    }),
    check(
      "attachment_reference_kind_check",
      sql`${table.kind} = ANY (ARRAY['ticket'::text, 'requirement'::text, 'knowledge'::text, 'conversation'::text, 'feedback'::text, 'turn'::text])`,
    ),
  ],
);

export const attachmentDraft = factorySchema.table(
  "attachment_draft",
  {
    id: uuid("id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    projectId: uuid("project_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    attachmentIds: uuid("attachment_ids").array().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "attachment_draft_owner_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "attachment_draft_project_id_fkey",
    }),
    primaryKey({ columns: [table.id, table.ownerId], name: "attachment_draft_pkey" }),
    check("attachment_draft_sequence_check", sql`${table.sequence} >= 0`),
  ],
);
