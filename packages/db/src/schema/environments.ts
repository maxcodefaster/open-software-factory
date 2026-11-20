import { sql } from "drizzle-orm";
import type { EnvironmentManifest } from "../../../project-domain/src/environment";
import {
  bigint,
  check,
  foreignKey,
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
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";

export const runtimeEnvironmentIntent = factorySchema.table(
  "runtime_environment_intent",
  {
    runtimeAttemptId: uuid("runtime_attempt_id").primaryKey().notNull(),
    environment: text("environment").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    secretKey: text("secret_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "runtime_environment_intent_runtime_attempt_id_fkey",
    }),
    check("runtime_environment_intent_version_check", sql`version >= 0`),
    check(
      "runtime_environment_intent_environment_check",
      sql`environment = ANY (ARRAY['development'::text, 'main-preview'::text])`,
    ),
  ],
);

export const environmentWrite = factorySchema.table(
  "environment_write",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    environment: text("environment").$type<"development" | "main-preview">().notNull(),
    baseVersion: bigint("base_version", { mode: "number" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    manifest: jsonb("manifest").$type<EnvironmentManifest>().notNull(),
    secretKey: text("secret_key").notNull(),
    state: text("state")
      .$type<"write-intended" | "committed" | "discarded">()
      .default("write-intended")
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("environment_one_pending")
      .using("btree", table.projectId.asc().nullsLast(), table.environment.asc().nullsLast())
      .where(sql`(state = 'write-intended'::text)`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "environment_write_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "environment_write_project_id_fkey",
    }),
    unique("environment_write_secret_key_key").on(table.secretKey),
    check("environment_write_base_version_check", sql`base_version >= 0`),
    check(
      "environment_write_environment_check",
      sql`environment = ANY (ARRAY['development'::text, 'main-preview'::text])`,
    ),
    check("environment_write_fingerprint_check", sql`fingerprint ~ '^[0-9a-f]{64}$'::text`),
    check(
      "environment_write_state_check",
      sql`state = ANY (ARRAY['write-intended'::text, 'committed'::text, 'discarded'::text])`,
    ),
  ],
);

export const projectEnvironment = factorySchema.table(
  "project_environment",
  {
    projectId: uuid("project_id").notNull(),
    environment: text("environment").$type<"development" | "main-preview">().notNull(),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    manifest: jsonb("manifest")
      .$type<EnvironmentManifest>()
      .default({ variables: [], registries: [] })
      .notNull(),
    secretKey: text("secret_key"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_environment_project_id_fkey",
    }),
    primaryKey({ columns: [table.projectId, table.environment], name: "project_environment_pkey" }),
    check(
      "project_environment_environment_check",
      sql`environment = ANY (ARRAY['development'::text, 'main-preview'::text])`,
    ),
    check("project_environment_version_check", sql`version >= 0`),
  ],
);
