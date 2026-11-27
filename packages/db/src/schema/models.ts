import { sql } from "drizzle-orm";
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
  uuid,
} from "drizzle-orm/pg-core";
import type { ModelProvider } from "#conversation-domain/model-connection";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const modelSettings = factorySchema.table(
  "model_settings",
  {
    scopeType: text("scope_type")
      .$type<"default" | "project" | "personal" | "role_connection">()
      .notNull(),
    scopeKey: text("scope_key").notNull(),
    projectId: uuid("project_id"),
    userId: uuid("user_id"),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
    connectionId: uuid("connection_id"),
    connectionVersion: bigint("connection_version", { mode: "number" }),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.scopeType, table.scopeKey], name: "model_settings_pkey" }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "model_settings_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "model_settings_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.connectionId, table.connectionVersion],
      foreignColumns: [modelConnectionVersion.connectionId, modelConnectionVersion.version],
      name: "model_settings_connection_id_connection_version_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "model_settings_updated_by_fkey",
    }),
    check(
      "model_settings_scope_type_check",
      sql`${table.scopeType} = ANY (ARRAY['default'::text, 'project'::text, 'personal'::text, 'role_connection'::text])`,
    ),
    check("model_settings_version_check", sql`${table.version} > 0`),
    check("model_settings_settings_check", sql`jsonb_typeof(${table.settings}) = 'object'::text`),
    check(
      "model_settings_connection_pair_check",
      sql`(${table.connectionId} IS NULL) = (${table.connectionVersion} IS NULL)`,
    ),
    check(
      "model_settings_role_connection_check",
      sql`(${table.scopeType} <> 'role_connection'::text) OR ((${table.scopeKey} = ANY (ARRAY['planning'::text, 'build'::text])) AND (${table.connectionId} IS NOT NULL))`,
    ),
    check(
      "model_settings_project_scope_check",
      sql`(${table.scopeType} <> 'project'::text) OR ((${table.projectId} IS NOT NULL) AND (${table.userId} IS NULL))`,
    ),
    check(
      "model_settings_personal_scope_check",
      sql`(${table.scopeType} <> 'personal'::text) OR ((${table.projectId} IS NOT NULL) AND (${table.userId} IS NOT NULL))`,
    ),
    check(
      "model_settings_default_scope_check",
      sql`(${table.scopeType} <> 'default'::text) OR ((${table.scopeKey} = 'default'::text) AND (${table.projectId} IS NULL) AND (${table.userId} IS NULL))`,
    ),
  ],
);

export const modelConnectionVersion = factorySchema.table(
  "model_connection_version",
  {
    connectionId: uuid("connection_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    provider: text("provider").$type<ModelProvider>().notNull(),
    endpoint: text("endpoint").notNull(),
    secretKey: text("secret_key").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "model_connection_version_created_by_fkey",
    }),
    primaryKey({
      columns: [table.connectionId, table.version],
      name: "model_connection_version_pkey",
    }),
    unique("model_connection_version_secret_key_key").on(table.secretKey),
    check(
      "model_connection_version_provider_check",
      sql`${table.provider} = ANY (ARRAY['openai'::text, 'anthropic'::text, 'deepseek'::text])`,
    ),
    check("model_connection_version_version_check", sql`${table.version} > 0`),
  ],
);
