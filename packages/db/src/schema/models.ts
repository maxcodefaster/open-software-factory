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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ModelProvider } from "../../../conversation-domain/src/model-connection";
import type { CodingReasoning } from "../../../conversation-domain/src/model-settings";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const modelRoleProbe = factorySchema.table(
  "model_role_probe",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    role: text("role").$type<"planning" | "build">().notNull(),
    connectionId: uuid("connection_id").notNull(),
    connectionVersion: bigint("connection_version", { mode: "number" }).notNull(),
    modelId: text("model_id").notNull(),
    settingsVersion: bigint("settings_version", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    state: text("state").$type<"probing" | "finished" | "uncertain">().notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    reasoningEffort: text("reasoning_effort").$type<CodingReasoning>(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId, table.connectionVersion],
      foreignColumns: [modelConnectionVersion.connectionId, modelConnectionVersion.version],
      name: "model_role_probe_connection_id_connection_version_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "model_role_probe_created_by_fkey",
    }),
    check(
      "model_role_probe_check",
      sql`(${table.state} = 'probing'::text) = (${table.result} IS NULL)`,
    ),
    check(
      "model_role_probe_reasoning_check",
      sql`(${table.reasoningEffort} IS NULL) OR ((${table.role} = 'build'::text) AND (${table.reasoningEffort} = ANY (ARRAY['medium'::text, 'high'::text, 'xhigh'::text, 'max'::text])))`,
    ),
    check(
      "model_role_probe_result_check",
      sql`(${table.result} IS NULL) OR (jsonb_typeof(${table.result}) = 'object'::text)`,
    ),
    check(
      "model_role_probe_role_check",
      sql`${table.role} = ANY (ARRAY['planning'::text, 'build'::text])`,
    ),
    check("model_role_probe_settings_version_check", sql`${table.settingsVersion} >= 0`),
    check(
      "model_role_probe_state_check",
      sql`${table.state} = ANY (ARRAY['probing'::text, 'finished'::text, 'uncertain'::text])`,
    ),
  ],
);

export const modelConnectionWrite = factorySchema.table(
  "model_connection_write",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    baseVersion: bigint("base_version", { mode: "number" }).notNull(),
    provider: text("provider").$type<ModelProvider>().notNull(),
    endpoint: text("endpoint").notNull(),
    fingerprint: text("fingerprint").notNull(),
    secretKey: text("secret_key").notNull(),
    state: text("state")
      .$type<"write-intended" | "committed">()
      .default("write-intended")
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("model_connection_pending")
      .using("btree", table.connectionId.asc().nullsLast())
      .where(sql`(${table.state} = 'write-intended'::text)`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "model_connection_write_created_by_fkey",
    }),
    unique("model_connection_write_secret_key_key").on(table.secretKey),
    check(
      "model_connection_write_fingerprint_check",
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'::text`,
    ),
    check("model_connection_write_base_version_check", sql`${table.baseVersion} >= 0`),
    check(
      "model_connection_write_provider_check",
      sql`${table.provider} = ANY (ARRAY['openai'::text, 'anthropic'::text, 'deepseek'::text])`,
    ),
    check(
      "model_connection_write_state_check",
      sql`${table.state} = ANY (ARRAY['write-intended'::text, 'committed'::text])`,
    ),
  ],
);

export const modelDefaults = factorySchema.table(
  "model_defaults",
  {
    singleton: boolean("singleton").default(true).primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    planningModelId: text("planning_model_id").notNull(),
    buildModelId: text("build_model_id").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    roleRules: jsonb("role_rules"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "model_defaults_updated_by_fkey",
    }),
    check(
      "model_defaults_build_model_id_check",
      sql`(length(${table.buildModelId}) >= 1) AND (length(${table.buildModelId}) <= 200)`,
    ),
    check(
      "model_defaults_planning_model_id_check",
      sql`(length(${table.planningModelId}) >= 1) AND (length(${table.planningModelId}) <= 200)`,
    ),
    check("model_defaults_singleton_check", sql`(${table.singleton})`),
    check("model_defaults_version_check", sql`${table.version} > 0`),
    check(
      "model_role_rules_object",
      sql`(${table.roleRules} IS NULL) OR (jsonb_typeof(${table.roleRules}) = 'object'::text)`,
    ),
  ],
);

export const modelRoleConnection = factorySchema.table(
  "model_role_connection",
  {
    role: text("role").$type<"planning" | "build">().primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    connectionVersion: bigint("connection_version", { mode: "number" }).notNull(),
    modelId: text("model_id").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId, table.connectionVersion],
      foreignColumns: [modelConnectionVersion.connectionId, modelConnectionVersion.version],
      name: "model_role_connection_connection_id_connection_version_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "model_role_connection_updated_by_fkey",
    }),
    check(
      "model_role_connection_role_check",
      sql`${table.role} = ANY (ARRAY['planning'::text, 'build'::text])`,
    ),
  ],
);

export const projectModelSettings = factorySchema.table(
  "project_model_settings",
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
      name: "project_model_settings_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "project_model_settings_updated_by_fkey",
    }),
    check(
      "project_model_settings_planning_check",
      sql`jsonb_typeof(${table.planning}) = 'object'::text`,
    ),
    check("project_model_settings_build_check", sql`jsonb_typeof(${table.build}) = 'object'::text`),
    check("project_model_settings_version_check", sql`${table.version} > 0`),
  ],
);

export const personalModelSettings = factorySchema.table(
  "personal_model_settings",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    planningModelId: text("planning_model_id"),
    buildModelId: text("build_model_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "personal_model_settings_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "personal_model_settings_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.userId], name: "personal_model_settings_pkey" }),
    check(
      "personal_model_settings_build_model_id_check",
      sql`(length(${table.buildModelId}) >= 1) AND (length(${table.buildModelId}) <= 200)`,
    ),
    check(
      "personal_model_settings_planning_model_id_check",
      sql`(length(${table.planningModelId}) >= 1) AND (length(${table.planningModelId}) <= 200)`,
    ),
    check("personal_model_settings_version_check", sql`${table.version} > 0`),
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
