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
    scope: text("scope").$type<"system" | "project" | "personal">().notNull(),
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
      sql`((${table.scope} = 'personal'::text) AND (${table.ownerId} IS NOT NULL) AND (${table.projectId} IS NULL)) OR ((${table.scope} = 'project'::text) AND (${table.ownerId} IS NULL) AND (${table.projectId} IS NOT NULL)) OR ((${table.scope} = 'system'::text) AND (${table.ownerId} IS NULL) AND (${table.projectId} IS NULL))`,
    ),
    check(
      "skill_library_scope_check",
      sql`${table.scope} = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])`,
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
    check(
      "skill_revision_skill_key_check",
      sql`${table.skillKey} ~ '^[a-z][a-z0-9-]{1,63}$'::text`,
    ),
    check(
      "skill_revision_content_check",
      sql`(jsonb_typeof(${table.content}) = 'object'::text) AND (octet_length((${table.content})::text) <= 2100000)`,
    ),
    check(
      "skill_revision_content_digest_check",
      sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'::text`,
    ),
    check("skill_revision_revision_check", sql`${table.revision} > 0`),
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
    check(
      "skill_library_cover_cover_key_check",
      sql`${table.coverKey} ~ '^[a-z][a-z-]{1,63}$'::text`,
    ),
    check("skill_library_cover_version_check", sql`${table.version} > 0`),
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
    target: text("target").$type<"system" | "project">().notNull(),
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
    check(
      "skill_share_proposal_check",
      sql`(${table.target} = 'project'::text) = (${table.projectId} IS NOT NULL)`,
    ),
    check(
      "skill_share_proposal_target_check",
      sql`${table.target} = ANY (ARRAY['system'::text, 'project'::text])`,
    ),
  ],
);

export const skillLibraryChoice = factorySchema.table(
  "skill_library_choice",
  {
    libraryId: uuid("library_id").notNull(),
    scope: text("scope").$type<"system" | "project" | "personal">().notNull(),
    contextId: uuid("context_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<"planning" | "build">().notNull(),
    state: text("state").$type<"inherit" | "enable" | "disable" | "required">().notNull(),
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
      sql`(${table.state} <> 'required'::text) OR (${table.scope} <> 'personal'::text)`,
    ),
    check(
      "skill_library_choice_role_check",
      sql`${table.role} = ANY (ARRAY['planning'::text, 'build'::text])`,
    ),
    check(
      "skill_library_choice_scope_check",
      sql`${table.scope} = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])`,
    ),
    check(
      "skill_library_choice_state_check",
      sql`${table.state} = ANY (ARRAY['inherit'::text, 'enable'::text, 'disable'::text, 'required'::text])`,
    ),
    check("skill_library_choice_version_check", sql`${table.version} > 0`),
  ],
);
