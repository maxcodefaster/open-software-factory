import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  type PgTableExtraConfigValue,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { factorySchema } from "./namespaces";

export const installationMaintenance = factorySchema.table(
  "installation_maintenance",
  {
    singleton: boolean("singleton").default(true).primaryKey().notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    check("installation_maintenance_singleton_check", sql`(${table.singleton})`),
  ],
);

export const schemaMigration = factorySchema.table(
  "schema_migration",
  {
    version: integer("version").primaryKey().notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
    sourceDigest: text("source_digest").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check("schema_migration_version_check", sql`${table.version} = 1`),
    check(
      "schema_migration_source_digest_check",
      sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'::text`,
    ),
  ],
);
