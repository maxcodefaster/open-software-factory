import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { knowledgeGenerationState, knowledgePageState, knowledgeRevisionKind } from "./enums";
import { modelConnectionVersion } from "./models";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const knowledgeGeneration = factorySchema.table(
  "knowledge_generation",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    sourceCommitSha: text("source_commit_sha").notNull(),
    state: knowledgeGenerationState("state").default("pending").notNull(),
    pageCount: integer("page_count"),
    conflictCount: integer("conflict_count"),
    failure: text("failure"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    modelId: text("model_id"),
    attemptId: uuid("attempt_id"),
    modelConnectionId: uuid("model_connection_id"),
    modelConnectionVersion: bigint("model_connection_version", { mode: "number" }),
    progress: jsonb("progress"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("knowledge_generation_one_active_per_project")
      .using("btree", table.projectId.asc().nullsLast())
      .where(
        sql`(${table.state} = ANY (ARRAY['pending'::knowledge_generation_state, 'running'::knowledge_generation_state]))`,
      ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "knowledge_generation_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "knowledge_generation_project_id_fkey",
    }),
    foreignKey({
      columns: [table.modelConnectionId, table.modelConnectionVersion],
      foreignColumns: [modelConnectionVersion.connectionId, modelConnectionVersion.version],
      name: "knowledge_model_connection",
    }),
    check(
      "knowledge_generation_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::knowledge_generation_state, 'failed'::knowledge_generation_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "knowledge_generation_conflict_count_check",
      sql`(${table.conflictCount} IS NULL) OR (${table.conflictCount} >= 0)`,
    ),
    check(
      "knowledge_generation_failure_check",
      sql`(${table.failure} IS NULL) OR (length(${table.failure}) <= 4000)`,
    ),
    check(
      "knowledge_generation_model_id_check",
      sql`(${table.modelId} IS NULL) OR ((length(${table.modelId}) >= 1) AND (length(${table.modelId}) <= 200))`,
    ),
    check(
      "knowledge_generation_page_count_check",
      sql`(${table.pageCount} IS NULL) OR (${table.pageCount} >= 0)`,
    ),
    check(
      "knowledge_generation_progress_shape",
      sql`(${table.progress} IS NULL) OR ((jsonb_typeof(${table.progress}) = 'object'::text) AND ((${table.progress} ->> 'phase'::text) = ANY (ARRAY['planning'::text, 'writing'::text, 'publishing'::text, 'done'::text])) AND (jsonb_typeof((${table.progress} -> 'topicsTotal'::text)) = 'number'::text) AND (jsonb_typeof((${table.progress} -> 'topicsDone'::text)) = 'number'::text) AND ((((${table.progress} ->> 'topicsTotal'::text))::numeric >= (0)::numeric) AND (((${table.progress} ->> 'topicsTotal'::text))::numeric <= (100)::numeric)) AND ((((${table.progress} ->> 'topicsDone'::text))::numeric >= (0)::numeric) AND (((${table.progress} ->> 'topicsDone'::text))::numeric <= (100)::numeric)) AND (jsonb_typeof((${table.progress} -> 'currentTopic'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (octet_length((${table.progress})::text) <= 1000))`,
    ),
    check(
      "knowledge_generation_source_commit_sha_check",
      sql`${table.sourceCommitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "knowledge_model_connection_pair",
      sql`(${table.modelConnectionId} IS NULL) = (${table.modelConnectionVersion} IS NULL)`,
    ),
  ],
);

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
      foreignColumns: [knowledgeGeneration.id],
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

export const wikiSourceUpdate = factorySchema.table(
  "wiki_source_update",
  {
    projectId: uuid("project_id").primaryKey().notNull(),
    targetUrl: text("target_url").notNull(),
    hookId: bigint("hook_id", { mode: "number" }),
    hookState: text("hook_state")
      .$type<"create-intended" | "ready" | "failed">()
      .default("create-intended")
      .notNull(),
    hookLease: uuid("hook_lease"),
    hookLeaseUntil: timestamp("hook_lease_until", { withTimezone: true }),
    eventVersion: bigint("event_version", { mode: "number" }).default(0).notNull(),
    handledVersion: bigint("handled_version", { mode: "number" }).default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "wiki_source_update_project_id_fkey",
    }),
    check(
      "wiki_source_update_check",
      sql`(${table.handledVersion} >= 0) AND (${table.handledVersion} <= ${table.eventVersion})`,
    ),
    check("wiki_source_update_event_version_check", sql`${table.eventVersion} >= 0`),
    check(
      "wiki_source_update_hook_state_check",
      sql`${table.hookState} = ANY (ARRAY['create-intended'::text, 'ready'::text, 'failed'::text])`,
    ),
  ],
);

export const knowledgePageAlias = factorySchema.table(
  "knowledge_page_alias",
  {
    projectId: uuid("project_id").notNull(),
    slug: text("slug").notNull(),
    pageId: uuid("page_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.pageId, table.projectId],
      foreignColumns: [knowledgePage.id, knowledgePage.projectId],
      name: "knowledge_page_alias_page_id_project_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "knowledge_page_alias_project_id_fkey",
    }),
    primaryKey({ columns: [table.projectId, table.slug], name: "knowledge_page_alias_pkey" }),
    check("knowledge_page_alias_slug_check", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text`),
  ],
);
