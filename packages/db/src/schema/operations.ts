import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";

export const operation = factorySchema.table(
  "operation",
  {
    id: uuid("id").primaryKey().notNull(),
    kind: text("kind").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    activeKey: text("active_key"),
    state: text("state").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdBy: uuid("created_by"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("operation_scope_idx").using(
      "btree",
      table.kind.asc().nullsLast(),
      table.scopeType.asc().nullsLast(),
      table.scopeId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    index("operation_active_lease_idx")
      .using(
        "btree",
        table.kind.asc().nullsLast(),
        table.state.asc().nullsLast(),
        table.leaseExpiresAt.asc().nullsLast(),
      )
      .where(sql`${table.completedAt} IS NULL`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "operation_created_by_fkey",
    }),
    unique("operation_idempotency_key_key").on(table.idempotencyKey),
    unique("operation_active_key_key").on(table.activeKey),
    check("operation_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'::text`),
  ],
);

export const auditEvent = factorySchema.table(
  "audit_event",
  {
    id: uuid("id").primaryKey().notNull(),
    kind: text("kind").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    dedupeKey: text("dedupe_key"),
    actorId: uuid("actor_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("audit_event_scope_idx").using(
      "btree",
      table.kind.asc().nullsLast(),
      table.scopeType.asc().nullsLast(),
      table.scopeId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    index("audit_event_actor_idx").using(
      "btree",
      table.actorId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "audit_event_actor_id_fkey",
    }),
    unique("audit_event_dedupe_key_key").on(table.dedupeKey),
    check("audit_event_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'::text`),
  ],
);
