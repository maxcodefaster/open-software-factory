import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { agentTurn } from "./coding";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { ticket } from "./tickets";

export const learningApplication = factorySchema.table(
  "learning_application",
  {
    id: uuid("id").primaryKey().notNull(),
    proposalId: uuid("proposal_id").notNull(),
    target: jsonb("target").notNull(),
    editDigest: text("edit_digest").notNull(),
    activation: jsonb("activation").default([]).notNull(),
    appliedRevisionId: uuid("applied_revision_id").notNull(),
    appliedVersion: integer("applied_version").notNull(),
    appliedBy: uuid("applied_by").notNull(),
    comparisonId: uuid("comparison_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    state: text("state").default("applied").notNull(),
    revertedRevisionId: uuid("reverted_revision_id"),
    revertedVersion: integer("reverted_version"),
    revertedBy: uuid("reverted_by"),
    revertedComparisonId: uuid("reverted_comparison_id"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.appliedBy],
      foreignColumns: [authUser.id],
      name: "learning_application_applied_by_fkey",
    }),
    foreignKey({
      columns: [table.comparisonId],
      foreignColumns: [learningTrial.id],
      name: "learning_application_comparison_id_fkey",
    }),
    foreignKey({
      columns: [table.proposalId],
      foreignColumns: [learningProposal.id],
      name: "learning_application_proposal_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.revertedBy],
      foreignColumns: [authUser.id],
      name: "learning_application_reverted_by_fkey",
    }),
    foreignKey({
      columns: [table.revertedComparisonId],
      foreignColumns: [learningTrial.id],
      name: "learning_application_reverted_comparison_id_fkey",
    }),
    unique("learning_application_proposal_id_key").on(table.proposalId),
    check("learning_application_applied_version_check", sql`applied_version > 0`),
    check(
      "learning_application_activation_check",
      sql`(jsonb_typeof(activation) = 'array'::text) AND (jsonb_array_length(activation) <= 2)`,
    ),
    check(
      "learning_application_check",
      sql`((state = 'applied'::text) AND (reverted_revision_id IS NULL) AND (reverted_version IS NULL) AND (reverted_by IS NULL) AND (reverted_at IS NULL) AND (reverted_comparison_id IS NULL)) OR ((state = 'reverted'::text) AND (reverted_revision_id IS NOT NULL) AND (reverted_version = (applied_version + 1)) AND (reverted_by IS NOT NULL) AND (reverted_at IS NOT NULL))`,
    ),
    check("learning_application_edit_digest_check", sql`edit_digest ~ '^[a-f0-9]{64}$'::text`),
    check(
      "learning_application_state_check",
      sql`state = ANY (ARRAY['applied'::text, 'reverted'::text])`,
    ),
  ],
);

export const learningCase = factorySchema.table(
  "learning_case",
  {
    id: text("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ownerId: uuid("owner_id"),
    reviewerId: uuid("reviewer_id").notNull(),
    developerOnly: boolean("developer_only").notNull(),
    activity: text("activity").notNull(),
    outcome: text("outcome").notNull(),
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
      .where(sql`selected`),
    index("learning_case_pending")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        table.ownerId.asc().nullsLast(),
        table.developerOnly.asc().nullsLast(),
        table.settledAt.asc().nullsLast(),
      )
      .where(sql`(selected AND (batch_id IS NULL))`),
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
      sql`outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])`,
    ),
    check("learning_case_snapshot_check", sql`octet_length((snapshot)::text) <= 65536`),
  ],
);

export const learningCommand = factorySchema.table(
  "learning_command",
  {
    id: uuid("id").primaryKey().notNull(),
    actorId: uuid("actor_id").notNull(),
    input: jsonb("input").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "learning_command_actor_id_fkey",
    }),
  ],
);

export const learningProposal = factorySchema.table(
  "learning_proposal",
  {
    id: uuid("id").primaryKey().notNull(),
    reviewId: uuid("review_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: jsonb("content").notNull(),
    state: text("state").default("proposed").notNull(),
    decisionId: uuid("decision_id"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ticketId: uuid("ticket_id"),
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
    check("learning_proposal_content_check", sql`octet_length((content)::text) <= 32000`),
    check("learning_proposal_ordinal_check", sql`ordinal >= 0`),
    check(
      "learning_proposal_state_check",
      sql`state = ANY (ARRAY['proposed'::text, 'dismissed'::text, 'ticket-created'::text, 'applied'::text])`,
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
    kind: text("kind").notNull(),
    rubric: text("rubric").notNull(),
    modelId: text("model_id").notNull(),
    modelConnection: jsonb("model_connection"),
    judgeKey: text("judge_key").notNull(),
    state: text("state").notNull(),
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
    check("learning_review_input_check", sql`octet_length((input)::text) <= 262144`),
    check("learning_review_input_digest_check", sql`input_digest ~ '^[a-f0-9]{64}$'::text`),
    check("learning_review_kind_check", sql`kind = ANY (ARRAY['calibration'::text, 'work'::text])`),
    check("learning_review_result_check", sql`octet_length((result)::text) <= 65536`),
    check(
      "learning_review_state_check",
      sql`state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])`,
    ),
  ],
);

export const learningTrial = factorySchema.table(
  "learning_trial",
  {
    id: uuid("id").primaryKey().notNull(),
    proposalId: uuid("proposal_id").notNull(),
    phase: text("phase").notNull(),
    actorId: uuid("actor_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    modelId: text("model_id").notNull(),
    modelConnection: jsonb("model_connection"),
    judgeKey: text("judge_key").notNull(),
    rubric: text("rubric").notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    state: text("state").default("running").notNull(),
    result: jsonb("result"),
    reason: text("reason"),
    ownerToken: uuid("owner_token").notNull(),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("learning_trial_running")
      .using("btree", table.ownerExpiresAt.asc().nullsLast())
      .where(sql`(state = 'running'::text)`),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "learning_trial_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.proposalId],
      foreignColumns: [learningProposal.id],
      name: "learning_trial_proposal_id_fkey",
    }).onDelete("cascade"),
    unique("learning_trial_proposal_id_phase_key").on(table.proposalId, table.phase),
    check("learning_trial_input_check", sql`octet_length((input)::text) <= 196608`),
    check("learning_trial_input_digest_check", sql`input_digest ~ '^[a-f0-9]{64}$'::text`),
    check("learning_trial_phase_check", sql`phase = ANY (ARRAY['adopt'::text, 'recover'::text])`),
    check("learning_trial_policy_version_check", sql`policy_version > 0`),
    check("learning_trial_result_check", sql`octet_length((result)::text) <= 65536`),
    check(
      "learning_trial_state_check",
      sql`state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])`,
    ),
  ],
);

export const learningPolicy = factorySchema.table(
  "learning_policy",
  {
    scopeKey: text("scope_key").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ownerId: uuid("owner_id"),
    enabled: boolean("enabled").notNull(),
    automaticSkills: boolean("automatic_skills").default(false).notNull(),
    version: integer("version").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "learning_policy_owner_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "learning_policy_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "learning_policy_updated_by_fkey",
    }),
    check(
      "learning_policy_check",
      sql`scope_key = (((project_id)::text || ':'::text) || COALESCE((owner_id)::text, 'project'::text))`,
    ),
    check("learning_policy_version_check", sql`version > 0`),
  ],
);

export const learningSourceArtifact = factorySchema.table(
  "learning_source_artifact",
  {
    turnId: uuid("turn_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    reference: text("reference").notNull(),
    body: text("body").notNull(),
    truncated: boolean("truncated").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "learning_source_artifact_turn_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.turnId, table.ordinal], name: "learning_source_artifact_pkey" }),
    check(
      "learning_source_artifact_body_check",
      sql`(length(body) >= 1) AND (length(body) <= 2000)`,
    ),
    check("learning_source_artifact_ordinal_check", sql`(ordinal >= 0) AND (ordinal <= 2)`),
    check(
      "learning_source_artifact_reference_check",
      sql`(length(reference) >= 1) AND (length(reference) <= 400)`,
    ),
  ],
);

export const learningTrialStep = factorySchema.table(
  "learning_trial_step",
  {
    trialId: uuid("trial_id").notNull(),
    stage: integer("stage").notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    state: text("state").default("running").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.trialId],
      foreignColumns: [learningTrial.id],
      name: "learning_trial_step_trial_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.trialId, table.stage], name: "learning_trial_step_pkey" }),
    check("learning_trial_step_input_check", sql`octet_length((input)::text) <= 196608`),
    check("learning_trial_step_input_digest_check", sql`input_digest ~ '^[a-f0-9]{64}$'::text`),
    check("learning_trial_step_result_check", sql`octet_length((result)::text) <= 65536`),
    check("learning_trial_step_stage_check", sql`(stage >= 0) AND (stage <= 2)`),
    check(
      "learning_trial_step_state_check",
      sql`state = ANY (ARRAY['running'::text, 'completed'::text, 'uncertain'::text])`,
    ),
  ],
);
