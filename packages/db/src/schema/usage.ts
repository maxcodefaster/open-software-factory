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
import type { ExecutionPolicy } from "../../../conversation-domain/src/execution-policy";
import type {
  UsageCounters,
  UsagePurpose,
  UsageRate,
} from "../../../conversation-domain/src/usage";
import { authUser } from "./auth";
import { agentTurn } from "./coding";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const executionPolicyCommand = factorySchema.table(
  "execution_policy_command",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    scope: text("scope").notNull(),
    actorId: uuid("actor_id").notNull(),
    input: jsonb("input").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "execution_policy_command_actor_id_fkey",
    }),
  ],
);

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

export const codingPause = factorySchema.table(
  "coding_pause",
  {
    turnId: uuid("turn_id").primaryKey().notNull(),
    reason: text("reason")
      .$type<"accounting-incomplete" | "coding-budget-used" | "finish-reserve-used">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resumedByTurnId: uuid("resumed_by_turn_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.resumedByTurnId],
      foreignColumns: [agentTurn.id],
      name: "coding_pause_resumed_by_turn_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "coding_pause_turn_id_fkey",
    }).onDelete("cascade"),
    check(
      "coding_pause_reason_check",
      sql`${table.reason} = ANY (ARRAY['accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])`,
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

export const usageReplayCursor = factorySchema.table(
  "usage_replay_cursor",
  {
    operationId: text("operation_id").notNull(),
    sessionId: text("session_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    startSequence: bigint("start_sequence", { mode: "number" }).default(0).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [usageOperation.id],
      name: "usage_replay_cursor_operation_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.operationId, table.sessionId], name: "usage_replay_cursor_pkey" }),
    check("usage_replay_cursor_sequence_check", sql`${table.sequence} >= 0`),
    check("usage_replay_cursor_start_sequence_check", sql`${table.startSequence} >= 0`),
  ],
);

export const usageRateOverride = factorySchema.table(
  "usage_rate_override",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    rate: jsonb("rate").$type<UsageRate>(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "usage_rate_override_updated_by_fkey",
    }),
    primaryKey({ columns: [table.provider, table.model], name: "usage_rate_override_pkey" }),
    check("usage_rate_override_version_check", sql`${table.version} > 0`),
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
