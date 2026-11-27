import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { ticket } from "./tickets";

export type LearningApplicationRecord = {
  id: string;
  proposalId: string;
  target: unknown;
  editDigest: string;
  activation: unknown[];
  appliedRevisionId: string;
  appliedVersion: number;
  appliedBy: string;
  comparisonId: string | null;
  createdAt: string;
  state: "applied" | "reverted";
  revertedRevisionId: string | null;
  revertedVersion: number | null;
  revertedBy: string | null;
  revertedComparisonId: string | null;
  revertedAt: string | null;
};

export type LearningTrialStepRecord = {
  stage: number;
  input: unknown;
  inputDigest: string;
  state: "running" | "completed" | "uncertain";
  result: unknown;
  createdAt: string;
  completedAt: string | null;
};

export const learningCase = factorySchema.table(
  "learning_case",
  {
    id: text("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ownerId: uuid("owner_id"),
    reviewerId: uuid("reviewer_id").notNull(),
    developerOnly: boolean("developer_only").notNull(),
    activity: text("activity").notNull(),
    outcome: text("outcome").$type<"completed" | "failed" | "interrupted" | "unknown">().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    snapshot: jsonb("snapshot").notNull(),
    selected: boolean("selected").notNull(),
    batchId: uuid("batch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("learning_case_observed")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        table.ownerId.asc().nullsLast(),
        table.developerOnly.asc().nullsLast(),
        table.settledAt.asc().nullsLast(),
      )
      .where(sql`${table.selected}`),
    index("learning_case_pending")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        table.ownerId.asc().nullsLast(),
        table.developerOnly.asc().nullsLast(),
        table.settledAt.asc().nullsLast(),
      )
      .where(sql`(${table.selected} AND (${table.batchId} IS NULL))`),
    foreignKey({
      columns: [table.batchId],
      foreignColumns: [learningReview.id],
      name: "learning_case_batch_fk",
    }),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "learning_case_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "learning_case_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reviewerId],
      foreignColumns: [authUser.id],
      name: "learning_case_reviewer_id_fkey",
    }),
    check(
      "learning_case_outcome_check",
      sql`${table.outcome} = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])`,
    ),
    check("learning_case_snapshot_check", sql`octet_length((${table.snapshot})::text) <= 65536`),
  ],
);

export const learningProposal = factorySchema.table(
  "learning_proposal",
  {
    id: uuid("id").primaryKey().notNull(),
    reviewId: uuid("review_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: jsonb("content").notNull(),
    state: text("state")
      .$type<"proposed" | "dismissed" | "ticket-created" | "applied">()
      .default("proposed")
      .notNull(),
    decisionId: uuid("decision_id"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ticketId: uuid("ticket_id"),
    application: jsonb("application").$type<LearningApplicationRecord | null>(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.decidedBy],
      foreignColumns: [authUser.id],
      name: "learning_proposal_decided_by_fkey",
    }),
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [learningReview.id],
      name: "learning_proposal_review_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "learning_proposal_ticket_id_fkey",
    }),
    unique("learning_proposal_review_id_ordinal_key").on(table.reviewId, table.ordinal),
    unique("learning_proposal_decision_id_key").on(table.decisionId),
    check("learning_proposal_content_check", sql`octet_length((${table.content})::text) <= 32000`),
    check("learning_proposal_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "learning_proposal_state_check",
      sql`${table.state} = ANY (ARRAY['proposed'::text, 'dismissed'::text, 'ticket-created'::text, 'applied'::text])`,
    ),
    check(
      "learning_proposal_application_check",
      sql`${table.application} IS NULL OR jsonb_typeof(${table.application}) = 'object'::text`,
    ),
  ],
);

export const learningReview = factorySchema.table(
  "learning_review",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ownerId: uuid("owner_id"),
    developerOnly: boolean("developer_only").notNull(),
    reviewerId: uuid("reviewer_id").notNull(),
    kind: text("kind").$type<"calibration" | "work">().notNull(),
    rubric: text("rubric").notNull(),
    modelId: text("model_id").notNull(),
    modelConnection: jsonb("model_connection"),
    judgeKey: text("judge_key").notNull(),
    state: text("state").$type<"running" | "completed" | "failed" | "uncertain">().notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    result: jsonb("result"),
    calibrated: boolean("calibrated"),
    reason: text("reason"),
    ownerToken: uuid("owner_token").notNull(),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("learning_review_judge").using(
      "btree",
      table.judgeKey.asc().nullsLast(),
      table.kind.asc().nullsLast(),
      table.state.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "learning_review_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "learning_review_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reviewerId],
      foreignColumns: [authUser.id],
      name: "learning_review_reviewer_id_fkey",
    }),
    check("learning_review_input_check", sql`octet_length((${table.input})::text) <= 262144`),
    check("learning_review_input_digest_check", sql`${table.inputDigest} ~ '^[a-f0-9]{64}$'::text`),
    check(
      "learning_review_kind_check",
      sql`${table.kind} = ANY (ARRAY['calibration'::text, 'work'::text])`,
    ),
    check("learning_review_result_check", sql`octet_length((${table.result})::text) <= 65536`),
    check(
      "learning_review_state_check",
      sql`${table.state} = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])`,
    ),
  ],
);
