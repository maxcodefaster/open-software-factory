import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { knowledgePageState, knowledgeRevisionKind } from "./enums";
import { factorySchema } from "./namespaces";
import { operation } from "./operations";
import { project } from "./projects";

export const knowledgeRevision = factorySchema.table(
  "knowledge_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    pageId: uuid("page_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: knowledgeRevisionKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    generatedBody: text("generated_body").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    citations: jsonb("citations").default([]).notNull(),
    generationId: uuid("generation_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "knowledge_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.generationId],
      foreignColumns: [operation.id],
      name: "knowledge_revision_generation_id_fkey",
    }),
    foreignKey({
      columns: [table.pageId],
      foreignColumns: [knowledgePage.id],
      name: "knowledge_revision_page_id_fkey",
    }),
    unique("knowledge_revision_id_page_id_key").on(table.id, table.pageId),
    unique("knowledge_revision_page_id_ordinal_key").on(table.pageId, table.ordinal),
    check(
      "knowledge_revision_body_check",
      sql`(length(${table.body}) >= 1) AND (length(${table.body}) <= 120000)`,
    ),
    check(
      "knowledge_revision_citations_check",
      sql`jsonb_typeof(${table.citations}) = 'array'::text`,
    ),
    check(
      "knowledge_revision_generated_body_check",
      sql`(length(${table.generatedBody}) >= 1) AND (length(${table.generatedBody}) <= 120000)`,
    ),
    check("knowledge_revision_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "knowledge_revision_source_commit_sha_check",
      sql`${table.sourceCommitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "knowledge_revision_title_check",
      sql`(length(btrim(${table.title})) >= 1) AND (length(btrim(${table.title})) <= 200)`,
    ),
  ],
);

export const knowledgePage = factorySchema.table(
  "knowledge_page",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    state: knowledgePageState("state").default("active").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    currentRevisionId: uuid("current_revision_id"),
    currentBody: text("current_body").notNull(),
    generatedBody: text("generated_body").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    citations: jsonb("citations")
      .$type<Array<{ path: string; commitSha: string }>>()
      .default([])
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").default(0).notNull(),
    icon: text("icon")
      .$type<"knowledge" | "home" | "ticket" | "ide" | "preview" | "settings">()
      .default("knowledge")
      .notNull(),
    metadataVersion: bigint("metadata_version", { mode: "number" }).default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("knowledge_page_parent_order").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.parentId.asc().nullsLast(),
      table.sortOrder.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("knowledge_page_search_idx").using(
      "gin",
      sql`to_tsvector('simple'::regconfig, (title || ' '::text) || current_body) tsvector_ops`,
    ),
    index("knowledge_research_idx").using(
      "gin",
      sql`research_vector(title, current_body) tsvector_ops`,
    ),
    index("knowledge_title_trgm_idx").using("gin", sql`lower(title) gin_trgm_ops`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "knowledge_page_created_by_fkey",
    }),
    foreignKey({
      columns: [table.currentRevisionId, table.id],
      foreignColumns: [knowledgeRevision.id, knowledgeRevision.pageId],
      name: "knowledge_page_current_revision_fk",
    }),
    foreignKey({
      columns: [table.projectId, table.parentId],
      foreignColumns: [knowledgePage.projectId, knowledgePage.id],
      name: "knowledge_page_parent_project",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "knowledge_page_project_id_fkey",
    }),
    unique("knowledge_page_id_project_id_key").on(table.id, table.projectId),
    unique("knowledge_page_project_identity").on(table.projectId, table.id),
    unique("knowledge_page_project_id_slug_key").on(table.projectId, table.slug),
    check(
      "knowledge_page_generated_body_check",
      sql`(length(${table.generatedBody}) >= 1) AND (length(${table.generatedBody}) <= 120000)`,
    ),
    check("knowledge_page_citations_check", sql`jsonb_typeof(${table.citations}) = 'array'::text`),
    check(
      "knowledge_page_current_body_check",
      sql`(length(${table.currentBody}) >= 1) AND (length(${table.currentBody}) <= 120000)`,
    ),
    check(
      "knowledge_page_icon_check",
      sql`${table.icon} = ANY (ARRAY['knowledge'::text, 'home'::text, 'ticket'::text, 'ide'::text, 'preview'::text, 'settings'::text])`,
    ),
    check("knowledge_page_metadata_version_check", sql`${table.metadataVersion} > 0`),
    check("knowledge_page_not_own_parent", sql`${table.parentId} IS DISTINCT FROM ${table.id}`),
    check("knowledge_page_slug_check", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text`),
    check("knowledge_page_sort_order_check", sql`${table.sortOrder} >= 0`),
    check(
      "knowledge_page_source_commit_sha_check",
      sql`${table.sourceCommitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "knowledge_page_title_check",
      sql`(length(btrim(${table.title})) >= 1) AND (length(btrim(${table.title})) <= 200)`,
    ),
    check("knowledge_page_version_check", sql`${table.version} > 0`),
  ],
);

export const knowledgePageOutline = factorySchema.table(
  "knowledge_page_outline",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    parentId: uuid("parent_id"),
    sortOrder: integer("sort_order").notNull(),
    icon: text("icon").notNull(),
    metadataVersion: bigint("metadata_version", { mode: "number" }).notNull(),
    state: knowledgePageState("state").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    currentRevisionId: uuid("current_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("knowledge_page_outline_project").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.state.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.id],
      foreignColumns: [knowledgePage.id],
      name: "knowledge_page_outline_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "knowledge_page_outline_project_id_fkey",
    }).onDelete("cascade"),
  ],
);
