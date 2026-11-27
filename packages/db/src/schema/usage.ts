import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ExecutionPolicy } from "#conversation-domain/execution-policy";
import type { UsageCounters, UsagePurpose, UsageRate } from "#conversation-domain/usage";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const usageOperation = factorySchema.table(
  "usage_operation",
  {
    id: text("id").primaryKey().notNull(),
    projectId: uuid("project_id"),
    userId: uuid("user_id"),
    purpose: text("purpose").$type<UsagePurpose>().notNull(),
    engine: text("engine").$type<"opencode" | "mastra">().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    rate: jsonb("rate").$type<UsageRate>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    outcome: text("outcome").$type<"completed" | "failed" | "interrupted" | "unknown">(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("usage_operation_scope_time_idx").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "usage_operation_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "usage_operation_user_id_fkey",
    }),
    check("usage_operation_check", sql`(${table.settledAt} IS NULL) = (${table.outcome} IS NULL)`),
    check(
      "usage_operation_engine_check",
      sql`${table.engine} = ANY (ARRAY['opencode'::text, 'mastra'::text])`,
    ),
    check(
      "usage_operation_id_check",
      sql`(length(${table.id}) >= 1) AND (length(${table.id}) <= 400)`,
    ),
    check(
      "usage_operation_outcome_check",
      sql`${table.outcome} = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])`,
    ),
    check(
      "usage_operation_purpose_check",
      sql`${table.purpose} = ANY (ARRAY['coding'::text, 'research'::text, 'requirements'::text, 'wiki'::text, 'setup'::text, 'probe'::text, 'learning'::text])`,
    ),
  ],
);

export const executionPolicy = factorySchema.table(
  "execution_policy",
  {
    scope: text("scope").primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    policy: jsonb("policy").$type<ExecutionPolicy>().notNull(),
    timezone: text("timezone"),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "execution_policy_updated_by_fkey",
    }),
    check(
      "execution_policy_check",
      sql`(${table.scope} = 'factory'::text) OR (${table.timezone} IS NULL)`,
    ),
    check("execution_policy_policy_check", sql`jsonb_typeof(${table.policy}) = 'object'::text`),
    check(
      "execution_policy_scope_check",
      sql`(${table.scope} = 'factory'::text) OR (${table.scope} ~ '^[0-9a-f-]{36}$'::text)`,
    ),
    check("execution_policy_version_check", sql`${table.version} >= 1`),
  ],
);

export const usageEntry = factorySchema.table(
  "usage_entry",
  {
    operationId: text("operation_id").notNull(),
    eventId: text("event_id").notNull(),
    source: text("source").$type<"step" | "title" | "compaction" | "unobserved">().notNull(),
    outcome: text("outcome").$type<"completed" | "failed" | "interrupted" | "unknown">().notNull(),
    counters: jsonb("counters").$type<UsageCounters>().notNull(),
    nanoUsd: bigint("nano_usd", { mode: "bigint" }),
    knownNanoUsd: bigint("known_nano_usd", { mode: "bigint" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("usage_entry_time_idx").using("btree", table.occurredAt.asc().nullsLast()),
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [usageOperation.id],
      name: "usage_entry_operation_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.operationId, table.eventId], name: "usage_entry_pkey" }),
    check(
      "usage_entry_event_id_check",
      sql`(length(${table.eventId}) >= 1) AND (length(${table.eventId}) <= 400)`,
    ),
    check("usage_entry_known_nano_usd_check", sql`${table.knownNanoUsd} >= 0`),
    check("usage_entry_nano_usd_check", sql`${table.nanoUsd} >= 0`),
    check(
      "usage_entry_outcome_check",
      sql`${table.outcome} = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])`,
    ),
    check(
      "usage_entry_source_check",
      sql`${table.source} = ANY (ARRAY['step'::text, 'title'::text, 'compaction'::text, 'unobserved'::text])`,
    ),
  ],
);
