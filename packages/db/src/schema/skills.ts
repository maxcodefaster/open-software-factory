import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const skillLibrary = factorySchema.table(
  "skill_library",
  {
    id: uuid("id").primaryKey().notNull(),
    storageKey: text("storage_key").notNull(),
    scope: text("scope").notNull(),
    ownerId: uuid("owner_id"),
    projectId: uuid("project_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "skill_library_owner_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "skill_library_project_id_fkey",
    }),
    unique("skill_library_storage_key_key").on(table.storageKey),
    check(
      "skill_library_check",
      sql`((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL))`,
    ),
    check(
      "skill_library_scope_check",
      sql`scope = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])`,
    ),
  ],
);

export const skillLibraryRevision = factorySchema.table(
  "skill_library_revision",
  {
    libraryId: uuid("library_id").notNull(),
    revisionId: uuid("revision_id").primaryKey().notNull(),
    copiedFrom: uuid("copied_from"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.copiedFrom],
      foreignColumns: [skillRevision.id],
      name: "skill_library_revision_copied_from_fkey",
    }),
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [skillLibrary.id],
      name: "skill_library_revision_library_id_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [skillRevision.id],
      name: "skill_library_revision_revision_id_fkey",
    }),
  ],
);

export const skillRevision = factorySchema.table(
  "skill_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    skillKey: text("skill_key").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    content: jsonb("content").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "skill_revision_created_by_fkey",
    }),
    unique("skill_revision_skill_key_revision_key").on(table.skillKey, table.revision),
    check("skill_revision_skill_key_check", sql`skill_key ~ '^[a-z][a-z0-9-]{1,63}$'::text`),
    check(
      "skill_revision_content_check",
      sql`(jsonb_typeof(content) = 'object'::text) AND (octet_length((content)::text) <= 2100000)`,
    ),
    check("skill_revision_content_digest_check", sql`content_digest ~ '^[a-f0-9]{64}$'::text`),
    check("skill_revision_revision_check", sql`revision > 0`),
  ],
);

export const projectSkillSettings = factorySchema.table(
  "project_skill_settings",
  {
    projectId: uuid("project_id").primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    planning: jsonb("planning").notNull(),
    build: jsonb("build").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_skill_settings_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "project_skill_settings_updated_by_fkey",
    }),
    check("project_skill_settings_build_check", sql`jsonb_typeof(build) = 'object'::text`),
    check("project_skill_settings_planning_check", sql`jsonb_typeof(planning) = 'object'::text`),
    check("project_skill_settings_version_check", sql`version > 0`),
  ],
);

export const skillLibraryCover = factorySchema.table(
  "skill_library_cover",
  {
    libraryId: uuid("library_id").primaryKey().notNull(),
    coverKey: text("cover_key").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [skillLibrary.id],
      name: "skill_library_cover_library_id_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "skill_library_cover_updated_by_fkey",
    }),
    check("skill_library_cover_cover_key_check", sql`cover_key ~ '^[a-z][a-z-]{1,63}$'::text`),
    check("skill_library_cover_version_check", sql`version > 0`),
  ],
);

export const skillPublication = factorySchema.table(
  "skill_publication",
  {
    revisionId: uuid("revision_id").primaryKey().notNull(),
    published: boolean("published").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [skillRevision.id],
      name: "skill_publication_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "skill_publication_updated_by_fkey",
    }),
  ],
);

export const skillShareProposal = factorySchema.table(
  "skill_share_proposal",
  {
    id: uuid("id").primaryKey().notNull(),
    revisionId: uuid("revision_id").notNull(),
    proposedBy: uuid("proposed_by").notNull(),
    target: text("target").notNull(),
    projectId: uuid("project_id"),
    acceptedLibraryId: uuid("accepted_library_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.acceptedLibraryId],
      foreignColumns: [skillLibrary.id],
      name: "skill_share_proposal_accepted_library_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "skill_share_proposal_project_id_fkey",
    }),
    foreignKey({
      columns: [table.proposedBy],
      foreignColumns: [authUser.id],
      name: "skill_share_proposal_proposed_by_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [skillRevision.id],
      name: "skill_share_proposal_revision_id_fkey",
    }),
    check("skill_share_proposal_check", sql`(target = 'project'::text) = (project_id IS NOT NULL)`),
    check(
      "skill_share_proposal_target_check",
      sql`target = ANY (ARRAY['system'::text, 'project'::text])`,
    ),
  ],
);

export const systemSkillSettings = factorySchema.table(
  "system_skill_settings",
  {
    singleton: boolean("singleton").default(true).primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    planning: jsonb("planning").notNull(),
    build: jsonb("build").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "system_skill_settings_updated_by_fkey",
    }),
    check("system_skill_settings_build_check", sql`jsonb_typeof(build) = 'object'::text`),
    check("system_skill_settings_planning_check", sql`jsonb_typeof(planning) = 'object'::text`),
    check("system_skill_settings_singleton_check", sql`(singleton)`),
    check("system_skill_settings_version_check", sql`version > 0`),
  ],
);

export const personalSkillSettings = factorySchema.table(
  "personal_skill_settings",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    planning: jsonb("planning"),
    build: jsonb("build"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "personal_skill_settings_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "personal_skill_settings_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.userId], name: "personal_skill_settings_pkey" }),
    check(
      "personal_skill_settings_build_check",
      sql`(build IS NULL) OR (jsonb_typeof(build) = 'array'::text)`,
    ),
    check(
      "personal_skill_settings_planning_check",
      sql`(planning IS NULL) OR (jsonb_typeof(planning) = 'array'::text)`,
    ),
    check("personal_skill_settings_version_check", sql`version > 0`),
  ],
);

export const skillLibraryChoice = factorySchema.table(
  "skill_library_choice",
  {
    libraryId: uuid("library_id").notNull(),
    scope: text("scope").notNull(),
    contextId: uuid("context_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    state: text("state").notNull(),
    revisionId: uuid("revision_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [skillLibrary.id],
      name: "skill_library_choice_library_id_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [skillRevision.id],
      name: "skill_library_choice_revision_id_fkey",
    }),
    primaryKey({
      columns: [table.libraryId, table.scope, table.contextId, table.userId, table.role],
      name: "skill_library_choice_pkey",
    }),
    check(
      "skill_library_choice_check",
      sql`(state <> 'required'::text) OR (scope <> 'personal'::text)`,
    ),
    check(
      "skill_library_choice_role_check",
      sql`role = ANY (ARRAY['planning'::text, 'build'::text])`,
    ),
    check(
      "skill_library_choice_scope_check",
      sql`scope = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])`,
    ),
    check(
      "skill_library_choice_state_check",
      sql`state = ANY (ARRAY['inherit'::text, 'enable'::text, 'disable'::text, 'required'::text])`,
    ),
    check("skill_library_choice_version_check", sql`version > 0`),
  ],
);
