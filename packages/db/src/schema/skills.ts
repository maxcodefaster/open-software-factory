import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  type PgTableExtraConfigValue,
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
    coverKey: text("cover_key"),
    coverVersion: bigint("cover_version", { mode: "number" }),
    coverUpdatedBy: uuid("cover_updated_by"),
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
    foreignKey({
      columns: [table.coverUpdatedBy],
      foreignColumns: [authUser.id],
      name: "skill_library_cover_updated_by_fkey",
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
    check(
      "skill_library_cover_nulls_check",
      sql`(${table.coverKey} IS NULL) = (${table.coverVersion} IS NULL AND ${table.coverUpdatedBy} IS NULL)`,
    ),
    check(
      "skill_library_cover_key_check",
      sql`${table.coverKey} IS NULL OR ${table.coverKey} ~ '^[a-z][a-z-]{1,63}$'::text`,
    ),
    check(
      "skill_library_cover_version_check",
      sql`${table.coverVersion} IS NULL OR ${table.coverVersion} > 0`,
    ),
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
    libraryId: uuid("library_id"),
    copiedFrom: uuid("copied_from"),
    published: boolean("published").default(false).notNull(),
    publishedUpdatedBy: uuid("published_updated_by"),
    publishedUpdatedAt: timestamp("published_updated_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "skill_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [skillLibrary.id],
      name: "skill_revision_library_id_fkey",
    }),
    foreignKey({
      columns: [table.copiedFrom],
      foreignColumns: [skillRevision.id],
      name: "skill_revision_copied_from_fkey",
    }),
    foreignKey({
      columns: [table.publishedUpdatedBy],
      foreignColumns: [authUser.id],
      name: "skill_revision_published_updated_by_fkey",
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
