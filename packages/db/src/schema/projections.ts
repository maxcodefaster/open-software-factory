import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const readVersion = factorySchema.table(
  "read_version",
  {
    projectId: uuid("project_id").notNull(),
    audience: text("audience").notNull(),
    scope: text("scope").notNull(),
    resourceId: uuid("resource_id").notNull(),
    revision: uuid("revision").defaultRandom().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("read_version_scope").using(
      "btree",
      table.scope.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "read_version_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.audience, table.scope, table.resourceId],
      name: "read_version_pkey",
    }),
    check(
      "read_version_audience_check",
      sql`(audience = ANY (ARRAY['shared'::text, 'developer'::text])) OR (audience ~ '^[0-9a-f-]{36}$'::text)`,
    ),
    check(
      "read_version_scope_check",
      sql`scope = ANY (ARRAY['lifecycle'::text, 'ticket'::text, 'conversation'::text, 'review'::text, 'inbox'::text, 'knowledge'::text, 'inputs'::text, 'sources'::text, 'releases'::text])`,
    ),
  ],
);
