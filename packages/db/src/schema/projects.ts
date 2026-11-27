import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { DesktopBackgroundKey } from "#interface-domain/background";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";

export const project = factorySchema.table(
  "project",
  {
    id: uuid("id").primaryKey().notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    actorTemplatePath: text("actor_template_path").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    desktopBackgroundKey: text("desktop_background_key")
      .$type<DesktopBackgroundKey>()
      .default("river-landscape")
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "project_created_by_fkey",
    }),
    unique("project_slug_key").on(table.slug),
    check(
      "project_default_branch_check",
      sql`(length(${table.defaultBranch}) >= 1) AND (length(${table.defaultBranch}) <= 200)`,
    ),
    check(
      "project_desktop_background_key_check",
      sql`${table.desktopBackgroundKey} = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text, 'gulf-of-marseille'::text, 'scene-on-the-ice'::text, 'moonlit-landscape'::text])`,
    ),
    check(
      "project_actor_template_path_check",
      sql`(${table.actorTemplatePath} <> ''::text) AND (${table.actorTemplatePath} !~ '(^/|(^|/)\\.\\.(/|$))'::text)`,
    ),
    check(
      "project_name_check",
      sql`(length(${table.name}) >= 1) AND (length(${table.name}) <= 200)`,
    ),
    check("project_slug_check", sql`${table.slug} ~ '^[a-z][a-z0-9-]{1,62}$'::text`),
  ],
);

export const projectMembership = factorySchema.table(
  "project_membership",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<"developer" | "product-contributor">().notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    manageProject: boolean("manage_project").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("project_membership_user_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_membership_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "project_membership_updated_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "project_membership_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.userId], name: "project_membership_pkey" }),
    check(
      "project_membership_role_check",
      sql`${table.role} = ANY (ARRAY['product-contributor'::text, 'developer'::text])`,
    ),
  ],
);
