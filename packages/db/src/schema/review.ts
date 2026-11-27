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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { agentTurn, buildBrowserSession } from "./coding";
import { change, verification } from "./delivery";
import { factorySchema } from "./namespaces";
import { runtimeAttempt } from "./runtime";

export const candidateReview = factorySchema.table(
  "candidate_review",
  {
    id: uuid("id").primaryKey().notNull(),
    verificationId: uuid("verification_id").notNull(),
    ordinal: integer("ordinal").default(1).notNull(),
    supersedesId: uuid("supersedes_id"),
    findingSourceId: uuid("finding_source_id"),
    focusReviewId: uuid("focus_review_id"),
    findingChecks: jsonb("finding_checks"),
    changeId: uuid("change_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    createdBy: uuid("created_by").notNull(),
    turnId: uuid("turn_id"),
    state: text("state")
      .$type<"pending" | "running" | "passed" | "changes-requested" | "incomplete">()
      .default("pending")
      .notNull(),
    uiRequired: boolean("ui_required").default(false).notNull(),
    result: jsonb("result"),
    evidence: jsonb("evidence").default([]).notNull(),
    repairCommandId: uuid("repair_command_id").defaultRandom().notNull(),
    repairPromptedAt: timestamp("repair_prompted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("candidate_review_change_idx").using("btree", table.changeId.asc().nullsLast()),
    uniqueIndex("candidate_review_finding_source_idx")
      .using("btree", table.findingSourceId.asc().nullsLast())
      .where(sql`((${table.findingSourceId} IS NOT NULL) AND (${table.supersedesId} IS NULL))`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "candidate_review_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "candidate_review_created_by_fkey",
    }),
    foreignKey({
      columns: [table.findingSourceId, table.changeId, table.verificationId, table.commitSha],
      foreignColumns: [
        candidateReview.id,
        candidateReview.changeId,
        candidateReview.verificationId,
        candidateReview.commitSha,
      ],
      name: "candidate_review_finding_source_fkey",
    }),
    foreignKey({
      columns: [table.focusReviewId],
      foreignColumns: [candidateReview.id],
      name: "candidate_review_focus_fkey",
    }),
    foreignKey({
      columns: [table.supersedesId],
      foreignColumns: [candidateReview.id],
      name: "candidate_review_supersedes_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "candidate_review_turn_id_fkey",
    }),
    foreignKey({
      columns: [table.verificationId, table.changeId, table.commitSha],
      foreignColumns: [verification.id, verification.changeId, verification.commitSha],
      name: "candidate_review_verification_id_change_id_commit_sha_fkey",
    }),
    unique("candidate_review_id_change_id_verification_id_commit_sha_key").on(
      table.id,
      table.changeId,
      table.verificationId,
      table.commitSha,
    ),
    unique("candidate_review_verification_id_ordinal_key").on(table.verificationId, table.ordinal),
    unique("candidate_review_supersedes_id_key").on(table.supersedesId),
    unique("candidate_review_turn_id_key").on(table.turnId),
    unique("candidate_review_repair_command_id_key").on(table.repairCommandId),
    check("candidate_review_commit_sha_check", sql`${table.commitSha} ~ '^[a-f0-9]{40}$'::text`),
    check("candidate_review_base_sha_check", sql`${table.baseSha} ~ '^[a-f0-9]{40}$'::text`),
    check(
      "candidate_review_check",
      sql`(${table.state} <> ALL (ARRAY['passed'::text, 'changes-requested'::text])) OR (${table.result} IS NOT NULL)`,
    ),
    check(
      "candidate_review_evidence_check",
      sql`(jsonb_typeof(${table.evidence}) = 'array'::text) AND (jsonb_array_length(${table.evidence}) <= 256)`,
    ),
    check(
      "candidate_review_finding_checks_check",
      sql`(${table.findingChecks} IS NULL) OR ((${table.findingSourceId} IS NOT NULL) AND (jsonb_typeof(${table.findingChecks}) = 'object'::text) AND (octet_length((${table.findingChecks})::text) <= 32768))`,
    ),
    check("candidate_review_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "candidate_review_result_check",
      sql`(${table.result} IS NULL) OR ((jsonb_typeof(${table.result}) = 'object'::text) AND (octet_length((${table.result})::text) <= 32768))`,
    ),
    check(
      "candidate_review_state_check",
      sql`${table.state} = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'changes-requested'::text, 'incomplete'::text])`,
    ),
  ],
);

export const reviewFeedback = factorySchema.table(
  "review_feedback",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    authorId: uuid("author_id").notNull(),
    kind: text("kind").$type<"comment" | "thread">().notNull(),
    state: text("state").$type<"open" | "implemented" | "resolved">().default("open").notNull(),
    version: integer("version").default(1).notNull(),
    commitSha: text("commit_sha").notNull(),
    annotation: jsonb("annotation"),
    mediaId: uuid("media_id"),
    resolvedBy: uuid("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("review_feedback_delivery")
      .using("btree", table.changeId.asc().nullsLast())
      .where(sql`((${table.kind} = 'thread'::text) AND (${table.state} <> 'resolved'::text))`),
    foreignKey({
      columns: [table.authorId],
      foreignColumns: [authUser.id],
      name: "review_feedback_author_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "review_feedback_change_id_fkey",
    }),
    foreignKey({
      columns: [table.mediaId],
      foreignColumns: [reviewMedia.id],
      name: "review_feedback_media_id_fkey",
    }),
    foreignKey({
      columns: [table.resolvedBy],
      foreignColumns: [authUser.id],
      name: "review_feedback_resolved_by_fkey",
    }),
    check(
      "review_feedback_annotation_media",
      sql`(${table.mediaId} IS NULL) OR (${table.annotation} IS NOT NULL)`,
    ),
    check(
      "review_feedback_check",
      sql`(${table.kind} <> 'comment'::text) OR (${table.state} = 'open'::text)`,
    ),
    check("review_feedback_commit_sha_check", sql`${table.commitSha} ~ '^[a-f0-9]{40}$'::text`),
    check(
      "review_feedback_kind_check",
      sql`${table.kind} = ANY (ARRAY['comment'::text, 'thread'::text])`,
    ),
    check(
      "review_feedback_state_check",
      sql`${table.state} = ANY (ARRAY['open'::text, 'implemented'::text, 'resolved'::text])`,
    ),
  ],
);

export const reviewMedia = factorySchema.table(
  "review_media",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    reviewId: uuid("review_id"),
    browserSessionId: uuid("browser_session_id"),
    createdBy: uuid("created_by"),
    kind: text("kind").$type<"recording" | "still">().notNull(),
    commitSha: text("commit_sha").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    sourceContext: jsonb("source_context"),
    state: text("state")
      .$type<"intended" | "recording" | "complete" | "unavailable" | "deleted">()
      .notNull(),
    byteLength: integer("byte_length"),
    sha256: text("sha256"),
    durationMs: integer("duration_ms"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("review_media_retention").using(
      "btree",
      table.changeId.asc().nullsLast(),
      table.kind.asc().nullsLast(),
      table.state.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.browserSessionId],
      foreignColumns: [buildBrowserSession.id],
      name: "review_media_browser_session_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "review_media_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "review_media_created_by_fkey",
    }),
    foreignKey({
      columns: [table.reviewId],
      foreignColumns: [candidateReview.id],
      name: "review_media_review_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "review_media_runtime_attempt_id_fkey",
    }),
    unique("review_media_browser_session_id_kind_key").on(table.browserSessionId, table.kind),
    check(
      "review_media_byte_length_check",
      sql`(${table.byteLength} >= 1) AND (${table.byteLength} <= 100663296)`,
    ),
    check(
      "review_media_check",
      sql`(${table.state} <> 'complete'::text) OR ((${table.byteLength} IS NOT NULL) AND (${table.sha256} IS NOT NULL))`,
    ),
    check(
      "review_media_check1",
      sql`(${table.kind} <> 'recording'::text) OR (${table.reviewId} IS NOT NULL)`,
    ),
    check("review_media_commit_sha_check", sql`${table.commitSha} ~ '^[a-f0-9]{40}$'::text`),
    check("review_media_duration_ms_check", sql`${table.durationMs} >= 0`),
    check(
      "review_media_kind_check",
      sql`${table.kind} = ANY (ARRAY['recording'::text, 'still'::text])`,
    ),
    check("review_media_sha256_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'::text`),
    check(
      "review_media_state_check",
      sql`${table.state} = ANY (ARRAY['intended'::text, 'recording'::text, 'complete'::text, 'unavailable'::text, 'deleted'::text])`,
    ),
  ],
);
