import { sql } from "drizzle-orm";
import {
  bigint,
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
import {
  branchOperationState,
  changeCommitSource,
  changeCommitState,
  changeState,
  mergeOperationState,
  promotionOperationState,
  pullRequestOperationState,
  verificationState,
} from "./enums";
import { monitoringIncident, monitoringPolicy } from "./monitoring";
import { factorySchema } from "./namespaces";
import { project, projectDeliveryPolicy } from "./projects";
import { candidateReview } from "./review";
import { runtimeAttempt } from "./runtime";
import { requirementApproval, ticket } from "./tickets";
import { executionPolicyCommand } from "./usage";

export const branchCreateOperation = factorySchema.table(
  "branch_create_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    branchName: text("branch_name").notNull(),
    startSha: text("start_sha").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: branchOperationState("state").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseGeneration: bigint("lease_generation", { mode: "number" }).default(0).notNull(),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true }).defaultNow().notNull(),
    observedHeadSha: text("observed_head_sha"),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("branch_create_operation_due_idx").using(
      "btree",
      table.state.asc().nullsLast(),
      table.reconcileAfter.asc().nullsLast(),
      table.leaseExpiresAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.changeId, table.branchName, table.startSha],
      foreignColumns: [change.id, change.branchName, change.baseSha],
      name: "branch_create_operation_change_id_branch_name_start_sha_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "branch_create_operation_change_id_fkey",
    }),
    unique("branch_create_operation_change_id_key").on(table.changeId),
    unique("branch_create_operation_repository_owner_repository_name_br_key").on(
      table.repositoryOwner,
      table.repositoryName,
      table.branchName,
    ),
    unique("branch_create_operation_idempotency_key_key").on(table.idempotencyKey),
    check("branch_create_operation_lease_generation_check", sql`${table.leaseGeneration} >= 0`),
    check("branch_create_operation_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "branch_create_operation_check",
      sql`(${table.leaseOwner} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "branch_create_operation_check1",
      sql`(${table.state} = ANY (ARRAY['succeeded'::branch_operation_state, 'failed'::branch_operation_state, 'cancelled'::branch_operation_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "branch_create_operation_check2",
      sql`(${table.state} <> 'succeeded'::branch_operation_state) OR (${table.observedHeadSha} = ${table.startSha})`,
    ),
    check(
      "branch_create_operation_observed_head_sha_check",
      sql`(${table.observedHeadSha} IS NULL) OR (${table.observedHeadSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)`,
    ),
    check(
      "branch_create_operation_repository_name_check",
      sql`length(btrim(${table.repositoryName})) > 0`,
    ),
    check(
      "branch_create_operation_repository_owner_check",
      sql`length(btrim(${table.repositoryOwner})) > 0`,
    ),
    check(
      "branch_create_operation_start_sha_check",
      sql`${table.startSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const change = factorySchema.table(
  "change",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    requirementApprovalId: uuid("requirement_approval_id").notNull(),
    branchName: text("branch_name").notNull(),
    baseSha: text("base_sha").notNull(),
    state: changeState("state").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failure: text("failure"),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    deliveryWaitingSha: text("delivery_waiting_sha"),
    deliveryWaitingPolicyId: uuid("delivery_waiting_policy_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("change_one_active_per_ticket")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(
        sql`(${table.state} = ANY (ARRAY['branch-pending'::change_state, 'starting'::change_state, 'active'::change_state, 'cancelling'::change_state]))`,
      ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "change_created_by_fkey",
    }),
    foreignKey({
      columns: [table.deliveryWaitingPolicyId],
      foreignColumns: [projectDeliveryPolicy.id],
      name: "change_delivery_waiting_policy_fk",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "change_project_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementApprovalId],
      foreignColumns: [requirementApproval.id],
      name: "change_requirement_approval_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementApprovalId, table.ticketId],
      foreignColumns: [requirementApproval.id, requirementApproval.ticketId],
      name: "change_requirement_approval_id_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.id],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "change_runtime_attempt_fk",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "change_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId, table.projectId],
      foreignColumns: [ticket.id, ticket.projectId],
      name: "change_ticket_id_project_id_fkey",
    }),
    unique("change_id_branch_name_base_sha_key").on(table.id, table.branchName, table.baseSha),
    unique("change_id_project_id_base_sha_key").on(table.id, table.projectId, table.baseSha),
    unique("change_id_project_id_key").on(table.id, table.projectId),
    unique("change_id_ticket_id_key").on(table.id, table.ticketId),
    unique("change_project_id_branch_name_key").on(table.projectId, table.branchName),
    unique("change_requirement_approval_id_key").on(table.requirementApprovalId),
    unique("change_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check("change_base_sha_check", sql`${table.baseSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`),
    check(
      "change_branch_name_check",
      sql`${table.branchName} ~ '^factory/change-[0-9a-f]{12}$'::text`,
    ),
    check(
      "change_check",
      sql`(${table.state} = 'cancelled'::change_state) = (${table.cancelledAt} IS NOT NULL)`,
    ),
    check("change_version_check", sql`${table.version} > 0`),
  ],
);

export const deliveryApproval = factorySchema.table(
  "delivery_approval",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    verificationId: uuid("verification_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    candidateReviewId: uuid("candidate_review_id"),
    monitoringIncidentId: uuid("monitoring_incident_id"),
    monitoringPolicyId: uuid("monitoring_policy_id"),
    deliveryPolicyId: uuid("delivery_policy_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [authUser.id],
      name: "delivery_approval_approved_by_fkey",
    }),
    foreignKey({
      columns: [table.candidateReviewId, table.changeId, table.verificationId, table.commitSha],
      foreignColumns: [
        candidateReview.id,
        candidateReview.changeId,
        candidateReview.verificationId,
        candidateReview.commitSha,
      ],
      name: "delivery_approval_candidate_review_identity",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "delivery_approval_change_id_fkey",
    }),
    foreignKey({
      columns: [table.monitoringIncidentId],
      foreignColumns: [monitoringIncident.id],
      name: "delivery_approval_monitoring_incident_id_fkey",
    }),
    foreignKey({
      columns: [table.monitoringPolicyId],
      foreignColumns: [monitoringPolicy.id],
      name: "delivery_approval_monitoring_policy_id_fkey",
    }),
    foreignKey({
      columns: [table.verificationId, table.changeId, table.commitSha],
      foreignColumns: [verification.id, verification.changeId, verification.commitSha],
      name: "delivery_approval_verification_id_change_id_commit_sha_fkey",
    }),
    foreignKey({
      columns: [table.deliveryPolicyId],
      foreignColumns: [projectDeliveryPolicy.id],
      name: "delivery_policy_basis_fk",
    }),
    unique("delivery_approval_exact_basis_key")
      .on(
        table.verificationId,
        table.candidateReviewId,
        table.approvedBy,
        table.monitoringPolicyId,
        table.deliveryPolicyId,
      )
      .nullsNotDistinct(),
    check(
      "delivery_approval_commit_sha_check",
      sql`${table.commitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "delivery_monitoring_basis",
      sql`(${table.monitoringIncidentId} IS NULL) = (${table.monitoringPolicyId} IS NULL)`,
    ),
    check(
      "delivery_one_delegation",
      sql`(${table.deliveryPolicyId} IS NULL) OR (${table.monitoringPolicyId} IS NULL)`,
    ),
  ],
);

export const changeCommitOperation = factorySchema.table(
  "change_commit_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    sequence: integer("sequence").notNull(),
    branchName: text("branch_name").notNull(),
    expectedParentSha: text("expected_parent_sha").notNull(),
    integrationBaseSha: text("integration_base_sha"),
    mergeParentSha: text("merge_parent_sha"),
    commitSha: text("commit_sha"),
    observedRemoteSha: text("observed_remote_sha"),
    commitMessage: text("commit_message").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: changeCommitState("state").notNull(),
    lastError: text("last_error"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    source: changeCommitSource("source").default("agent").notNull(),
    repositoryPath: text("repository_path"),
    repositoryBlobSha: text("repository_blob_sha"),
    repositoryContent: text("repository_content"),
    contentDigest: text("content_digest"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("change_commit_one_active_uidx")
      .using("btree", table.changeId.asc().nullsLast())
      .where(
        sql`(${table.state} <> ALL (ARRAY['succeeded'::change_commit_state, 'failed'::change_commit_state]))`,
      ),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_commit_operation_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "change_commit_operation_created_by_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "change_commit_operation_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.changeId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "change_commit_operation_runtime_change_fk",
    }),
    unique("change_commit_operation_change_id_sequence_key").on(table.changeId, table.sequence),
    unique("change_commit_operation_idempotency_key_key").on(table.idempotencyKey),
    check(
      "change_commit_operation_expected_parent_sha_check",
      sql`${table.expectedParentSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "change_commit_integration_base",
      sql`(${table.integrationBaseSha} IS NULL) OR (${table.integrationBaseSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)`,
    ),
    check(
      "change_commit_merge_parent",
      sql`(${table.mergeParentSha} IS NULL) OR ((${table.mergeParentSha} = ${table.integrationBaseSha}) AND (${table.mergeParentSha} <> ${table.expectedParentSha}))`,
    ),
    check(
      "change_commit_operation_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::change_commit_state, 'failed'::change_commit_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "change_commit_operation_check2",
      sql`(${table.state} <> 'succeeded'::change_commit_state) OR (${table.observedRemoteSha} = ${table.commitSha})`,
    ),
    check(
      "change_commit_operation_commit_message_check",
      sql`(length(btrim(${table.commitMessage})) >= 1) AND (length(btrim(${table.commitMessage})) <= 240)`,
    ),
    check(
      "change_commit_operation_commit_presence_check",
      sql`(${table.state} <> ALL (ARRAY['committed'::change_commit_state, 'push-intended'::change_commit_state, 'succeeded'::change_commit_state])) OR (${table.commitSha} IS NOT NULL) OR ((${table.source} = 'repository-document'::change_commit_source) AND (${table.state} = 'push-intended'::change_commit_state))`,
    ),
    check(
      "change_commit_operation_commit_sha_check",
      sql`(${table.commitSha} IS NULL) OR (${table.commitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)`,
    ),
    check(
      "change_commit_operation_observed_remote_sha_check",
      sql`(${table.observedRemoteSha} IS NULL) OR (${table.observedRemoteSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)`,
    ),
    check("change_commit_operation_sequence_check", sql`${table.sequence} > 0`),
    check(
      "change_commit_operation_source_check",
      sql`(((${table.source})::text = ANY (ARRAY['agent'::text, 'integration'::text, 'workspace'::text])) AND (${table.runtimeAttemptId} IS NOT NULL) AND (${table.repositoryPath} IS NULL) AND (${table.repositoryBlobSha} IS NULL) AND (${table.repositoryContent} IS NULL) AND (${table.contentDigest} IS NULL)) OR (((${table.source})::text = 'repository-document'::text) AND (${table.runtimeAttemptId} IS NULL) AND (${table.repositoryPath} IS NOT NULL) AND (${table.repositoryBlobSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text) AND (${table.repositoryContent} IS NOT NULL) AND (${table.contentDigest} ~ '^[0-9a-f]{64}$'::text))`,
    ),
  ],
);

export const promotionOperation = factorySchema.table(
  "promotion_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    projectId: uuid("project_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    previousRuntimeAttemptId: uuid("previous_runtime_attempt_id"),
    replacementRuntimeAttemptId: uuid("replacement_runtime_attempt_id"),
    state: promotionOperationState("state").default("pending").notNull(),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ordinal: integer("ordinal").default(1).notNull(),
    supersedesId: uuid("supersedes_id"),
    retryCommandId: uuid("retry_command_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "promotion_operation_change_id_fkey",
    }),
    foreignKey({
      columns: [table.previousRuntimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "promotion_operation_previous_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "promotion_operation_project_id_fkey",
    }),
    foreignKey({
      columns: [table.replacementRuntimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "promotion_operation_replacement_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.retryCommandId],
      foreignColumns: [executionPolicyCommand.commandId],
      name: "promotion_operation_retry_command_id_fkey",
    }),
    foreignKey({
      columns: [table.supersedesId],
      foreignColumns: [promotionOperation.id],
      name: "promotion_operation_supersedes_id_fkey",
    }),
    unique("promotion_operation_sequence").on(table.changeId, table.ordinal),
    unique("promotion_operation_replacement_runtime_attempt_id_key").on(
      table.replacementRuntimeAttemptId,
    ),
    unique("promotion_operation_supersedes_id_key").on(table.supersedesId),
    unique("promotion_operation_retry_command_id_key").on(table.retryCommandId),
    check(
      "promotion_operation_retry_identity",
      sql`((${table.ordinal} = 1) AND (${table.supersedesId} IS NULL) AND (${table.retryCommandId} IS NULL)) OR ((${table.ordinal} > 1) AND (${table.supersedesId} IS NOT NULL) AND (${table.retryCommandId} = ${table.id}))`,
    ),
    check(
      "promotion_operation_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::promotion_operation_state, 'failed'::promotion_operation_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "promotion_operation_commit_sha_check",
      sql`${table.commitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check("promotion_operation_ordinal_check", sql`${table.ordinal} > 0`),
  ],
);

export const pullRequestOperation = factorySchema.table(
  "pull_request_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    firstHeadSha: text("first_head_sha").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: pullRequestOperationState("state").default("pending").notNull(),
    pullRequestNumber: bigint("pull_request_number", { mode: "number" }),
    pullRequestUrl: text("pull_request_url"),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "pull_request_operation_change_id_fkey",
    }),
    unique("pull_request_operation_change_id_key").on(table.changeId),
    unique("pull_request_operation_idempotency_key_key").on(table.idempotencyKey),
    check("pull_request_operation_body_check", sql`length(${table.body}) <= 10000`),
    check(
      "pull_request_operation_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::pull_request_operation_state, 'failed'::pull_request_operation_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "pull_request_operation_check1",
      sql`(${table.state} <> 'succeeded'::pull_request_operation_state) OR ((${table.pullRequestNumber} IS NOT NULL) AND (${table.pullRequestUrl} IS NOT NULL))`,
    ),
    check(
      "pull_request_operation_first_head_sha_check",
      sql`${table.firstHeadSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "pull_request_operation_title_check",
      sql`(length(btrim(${table.title})) >= 1) AND (length(btrim(${table.title})) <= 240)`,
    ),
  ],
);

export const mergeOperation = factorySchema.table(
  "merge_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    deliveryApprovalId: uuid("delivery_approval_id").notNull(),
    pullRequestNumber: bigint("pull_request_number", { mode: "number" }).notNull(),
    baseSha: text("base_sha").notNull(),
    commitSha: text("commit_sha").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: mergeOperationState("state").default("pending").notNull(),
    observedDefaultSha: text("observed_default_sha"),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("merge_operation_one_success")
      .using("btree", table.changeId.asc().nullsLast())
      .where(sql`(${table.state} = 'succeeded'::merge_operation_state)`),
    uniqueIndex("merge_operation_one_unfinished")
      .using("btree", table.changeId.asc().nullsLast())
      .where(
        sql`(${table.state} <> ALL (ARRAY['succeeded'::merge_operation_state, 'failed'::merge_operation_state]))`,
      ),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "merge_operation_change_id_fkey",
    }),
    foreignKey({
      columns: [table.deliveryApprovalId],
      foreignColumns: [deliveryApproval.id],
      name: "merge_operation_delivery_approval_id_fkey",
    }),
    unique("merge_operation_delivery_approval_id_key").on(table.deliveryApprovalId),
    unique("merge_operation_idempotency_key_key").on(table.idempotencyKey),
    check(
      "merge_operation_base_sha_check",
      sql`${table.baseSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "merge_operation_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::merge_operation_state, 'failed'::merge_operation_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "merge_operation_check1",
      sql`(${table.state} <> 'succeeded'::merge_operation_state) OR (${table.observedDefaultSha} = ${table.commitSha})`,
    ),
    check(
      "merge_operation_commit_sha_check",
      sql`${table.commitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "merge_operation_observed_default_sha_check",
      sql`(${table.observedDefaultSha} IS NULL) OR (${table.observedDefaultSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)`,
    ),
  ],
);

export const stagingPreview = factorySchema.table(
  "staging_preview",
  {
    projectId: uuid("project_id").primaryKey().notNull(),
    revision: text("revision").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "staging_preview_project_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.projectId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.projectId],
      name: "staging_preview_runtime_attempt_id_project_id_fkey",
    }),
    unique("staging_preview_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "staging_preview_revision_check",
      sql`${table.revision} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const verification = factorySchema.table(
  "verification",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    commitSha: text("commit_sha").notNull(),
    pullRequestNumber: bigint("pull_request_number", { mode: "number" }).notNull(),
    workflowId: text("workflow_id").default("factory-verification.yml").notNull(),
    actionRunId: bigint("action_run_id", { mode: "number" }),
    actionRunUrl: text("action_run_url"),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    runnerName: text("runner_name").notNull(),
    runnerId: bigint("runner_id", { mode: "number" }),
    runnerUuid: uuid("runner_uuid"),
    runnerToken: text("runner_token"),
    state: verificationState("state").default("pending").notNull(),
    summary: text("summary"),
    diagnosis: jsonb("diagnosis"),
    repairPromptedAt: timestamp("repair_prompted_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    runnerJobHandle: text("runner_job_handle"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("verification_one_active_per_change")
      .using("btree", table.changeId.asc().nullsLast())
      .where(
        sql`(${table.state} = ANY (ARRAY['pending'::verification_state, 'runner-starting'::verification_state, 'running'::verification_state]))`,
      ),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "verification_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "verification_created_by_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.id],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.verificationId],
      name: "verification_runtime_fk",
    }),
    unique("verification_id_change_id_commit_sha_key").on(
      table.id,
      table.changeId,
      table.commitSha,
    ),
    unique("verification_change_id_commit_sha_key").on(table.changeId, table.commitSha),
    unique("verification_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "verification_check",
      sql`(${table.state} = ANY (ARRAY['succeeded'::verification_state, 'failed'::verification_state, 'cancelled'::verification_state])) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "verification_check1",
      sql`(${table.state} <> ALL (ARRAY['runner-starting'::verification_state, 'running'::verification_state, 'succeeded'::verification_state, 'failed'::verification_state])) OR (${table.actionRunId} IS NOT NULL)`,
    ),
    check(
      "verification_check2",
      sql`(${table.runtimeAttemptId} IS NULL) OR (${table.runnerToken} IS NOT NULL)`,
    ),
    check(
      "verification_check3",
      sql`(${table.runnerJobHandle} IS NULL) OR ((${table.actionRunId} IS NOT NULL) AND (${table.runnerJobHandle} ~ '^[A-Za-z0-9_-]{1,200}$'::text))`,
    ),
    check(
      "verification_commit_sha_check",
      sql`${table.commitSha} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "verification_diagnosis_check",
      sql`(${table.diagnosis} IS NULL) OR ((jsonb_typeof(${table.diagnosis}) = 'object'::text) AND (octet_length((${table.diagnosis})::text) <= 24000))`,
    ),
    check(
      "verification_summary_check",
      sql`(${table.summary} IS NULL) OR (length(${table.summary}) <= 2000)`,
    ),
  ],
);

export const stagingConfiguration = factorySchema.table(
  "staging_configuration",
  {
    runtimeAttemptId: uuid("runtime_attempt_id").primaryKey().notNull(),
    declaration: jsonb("declaration").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "staging_configuration_attempt_fkey",
    }),
    check(
      "staging_configuration_declaration_check",
      sql`jsonb_typeof(${table.declaration}) = 'object'::text`,
    ),
  ],
);
