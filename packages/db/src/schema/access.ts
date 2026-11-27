import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { change } from "./delivery";
import { factorySchema } from "./namespaces";
import { runtimeAttempt } from "./runtime";

export const accountAccess = factorySchema.table(
  "account_access",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    directoryDisabledAt: timestamp("directory_disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.disabledBy],
      foreignColumns: [authUser.id],
      name: "account_access_disabled_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "account_access_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const administrator = factorySchema.table(
  "administrator",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "administrator_user_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const changeWriter = factorySchema.table(
  "change_writer",
  {
    changeId: uuid("change_id").primaryKey().notNull(),
    state: text("state")
      .$type<"unassigned" | "agent-preparing" | "agent" | "handoff" | "human">()
      .default("unassigned")
      .notNull(),
    epoch: bigint("epoch", { mode: "number" }).default(1).notNull(),
    userId: uuid("user_id"),
    turnId: uuid("turn_id"),
    fenceAttemptId: uuid("fence_attempt_id"),
    fenceRequired: boolean("fence_required").default(false).notNull(),
    requestedBy: uuid("requested_by"),
    requestId: uuid("request_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    handoffKind: text("handoff_kind").$type<"takeover" | "release">().default("takeover").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_writer_change_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.fenceAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "change_writer_fence_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.requestedBy],
      foreignColumns: [authUser.id],
      name: "change_writer_requested_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "change_writer_user_id_fkey",
    }),
    check(
      "change_writer_check",
      sql`(${table.state} = 'human'::text) = (${table.userId} IS NOT NULL)`,
    ),
    check(
      "change_writer_check1",
      sql`(${table.state} = ANY (ARRAY['agent-preparing'::text, 'agent'::text])) = (${table.turnId} IS NOT NULL)`,
    ),
    check(
      "change_writer_check2",
      sql`(${table.state} = 'handoff'::text) = ((${table.requestedBy} IS NOT NULL) AND (${table.requestId} IS NOT NULL))`,
    ),
    check("change_writer_epoch_check", sql`${table.epoch} > 0`),
    check(
      "change_writer_handoff_kind_check",
      sql`${table.handoffKind} = ANY (ARRAY['takeover'::text, 'release'::text])`,
    ),
    check(
      "change_writer_state_check",
      sql`${table.state} = ANY (ARRAY['unassigned'::text, 'agent-preparing'::text, 'agent'::text, 'handoff'::text, 'human'::text])`,
    ),
  ],
);
