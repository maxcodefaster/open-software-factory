import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { change, changeCommitOperation } from "./delivery";
import { workspaceKind } from "./enums";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";
import { ticket } from "./tickets";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const workspaceSubmission = factorySchema.table(
  "workspace_submission",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    writerEpoch: bigint("writer_epoch", { mode: "number" }).notNull(),
    remoteHead: text("remote_head").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    prepareAttemptedAt: timestamp("prepare_attempted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_submission_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.id],
      foreignColumns: [changeCommitOperation.id],
      name: "workspace_submission_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_submission_workspace_id_fkey",
    }),
    check(
      "workspace_submission_repository_url_check",
      sql`repository_url ~ '^https://[^/@?#]+/[^/?#]+/[^/?#]+$'::text`,
    ),
    check(
      "workspace_submission_remote_head_check",
      sql`remote_head ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'::text`,
    ),
    check("workspace_submission_writer_epoch_check", sql`writer_epoch > 0`),
  ],
);

export const developerIde = factorySchema.table(
  "developer_ide",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    serviceEpoch: bigint("service_epoch", { mode: "number" }).default(1).notNull(),
    state: text("state").notNull(),
    image: text("image").notNull(),
    namespaceUid: text("namespace_uid"),
    podUid: text("pod_uid"),
    failure: text("failure"),
    createIntendedAt: timestamp("create_intended_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createObservedAt: timestamp("create_observed_at", { withTimezone: true }),
    stopIntendedAt: timestamp("stop_intended_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceId: uuid("resource_id").defaultRandom().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "developer_ide_user_id_fkey",
    }),
    unique("developer_ide_resource_id_unique").on(table.resourceId),
    check("developer_ide_image_check", sql`image ~ '@sha256:[0-9a-f]{64}$'::text`),
    check("developer_ide_service_epoch_check", sql`service_epoch > 0`),
    check(
      "developer_ide_state_check",
      sql`state = ANY (ARRAY['create-intended'::text, 'preparing'::text, 'ready'::text, 'failed'::text, 'stop-intended'::text, 'stopped'::text])`,
    ),
  ],
);

export const developmentWorkspace = factorySchema.table(
  "development_workspace",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    kind: workspaceKind("kind").notNull(),
    ownerUserId: uuid("owner_user_id"),
    ticketId: uuid("ticket_id"),
    changeId: uuid("change_id"),
    sourceBranch: text("source_branch").notNull(),
    sourceRevision: text("source_revision").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    substrate: boolean("substrate").default(true).notNull(),
    collaborationEnabled: boolean("collaboration_enabled").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("development_workspace_one_per_ticket")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(sql`(kind = 'ticket'::development_workspace_kind)`),
    uniqueIndex("development_workspace_one_personal_per_user_project")
      .using("btree", table.projectId.asc().nullsLast(), table.ownerUserId.asc().nullsLast())
      .where(sql`(kind = 'personal'::development_workspace_kind)`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "development_workspace_change_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId, table.projectId],
      foreignColumns: [change.id, change.projectId],
      name: "development_workspace_change_id_project_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId, table.ticketId],
      foreignColumns: [change.id, change.ticketId],
      name: "development_workspace_change_id_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "development_workspace_created_by_fkey",
    }),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [authUser.id],
      name: "development_workspace_owner_user_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "development_workspace_project_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "development_workspace_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId, table.projectId],
      foreignColumns: [ticket.id, ticket.projectId],
      name: "development_workspace_ticket_id_project_id_fkey",
    }),
    unique("development_workspace_id_change_id_key").on(table.id, table.changeId),
    unique("development_workspace_id_project_id_key").on(table.id, table.projectId),
    check(
      "development_workspace_check",
      sql`((kind = 'personal'::development_workspace_kind) AND (owner_user_id IS NOT NULL) AND (ticket_id IS NULL) AND (change_id IS NULL)) OR ((kind = 'ticket'::development_workspace_kind) AND (owner_user_id IS NULL) AND (ticket_id IS NOT NULL) AND (change_id IS NOT NULL))`,
    ),
    check("development_workspace_native_only", sql`(substrate)`),
    check(
      "development_workspace_source_branch_check",
      sql`(length(source_branch) >= 1) AND (length(source_branch) <= 200)`,
    ),
    check(
      "development_workspace_source_revision_check",
      sql`source_revision ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const personalGitOperation = factorySchema.table(
  "personal_git_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    userId: uuid("user_id").notNull(),
    action: text("action").notNull(),
    expectedHead: text("expected_head").notNull(),
    branch: text("branch").notNull(),
    message: text("message").notNull(),
    state: text("state").default("intended").notNull(),
    result: jsonb("result"),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("personal_git_operation_workspace").using(
      "btree",
      table.workspaceId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "personal_git_operation_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.workspaceId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.workspaceId],
      name: "personal_git_operation_runtime_attempt_id_workspace_id_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "personal_git_operation_user_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "personal_git_operation_workspace_id_fkey",
    }),
    check(
      "personal_git_operation_action_check",
      sql`action = ANY (ARRAY['commit'::text, 'fetch'::text, 'pull'::text])`,
    ),
    check(
      "personal_git_operation_branch_check",
      sql`(length(branch) >= 1) AND (length(branch) <= 200)`,
    ),
    check(
      "personal_git_operation_check",
      sql`(state = ANY (ARRAY['succeeded'::text, 'failed'::text])) = (completed_at IS NOT NULL)`,
    ),
    check(
      "personal_git_operation_check1",
      sql`(state <> 'succeeded'::text) OR ((result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text))`,
    ),
    check(
      "personal_git_operation_expected_head_check",
      sql`expected_head ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'::text`,
    ),
    check("personal_git_operation_message_check", sql`length(message) <= 240`),
    check(
      "personal_git_operation_state_check",
      sql`state = ANY (ARRAY['intended'::text, 'attempted'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text])`,
    ),
  ],
);

export const sharedDocumentResolution = factorySchema.table(
  "shared_document_resolution",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    path: text("path").notNull(),
    actorId: uuid("actor_id").notNull(),
    choice: text("choice").notNull(),
    documentRevision: text("document_revision").notNull(),
    diskVersion: text("disk_version").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "shared_document_resolution_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "shared_document_resolution_workspace_id_fkey",
    }),
    check(
      "shared_document_resolution_choice_check",
      sql`choice = ANY (ARRAY['keep-shared'::text, 'use-saved'::text])`,
    ),
  ],
);

export const workspaceCollaborationDecision = factorySchema.table(
  "workspace_collaboration_decision",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_collaboration_decision_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_collaboration_decision_workspace_id_fkey",
    }),
  ],
);

export const workspaceCommand = factorySchema.table(
  "workspace_command",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    kind: text("kind").default("shell").notNull(),
    inputDigest: text("input_digest").notNull(),
    state: text("state").default("start-intended").notNull(),
    dispatchAttemptedAt: timestamp("dispatch_attempted_at", { withTimezone: true }),
    result: jsonb("result").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("workspace_command_runtime_idx").using(
      "btree",
      table.runtimeAttemptId.asc().nullsLast(),
      table.state.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_command_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "workspace_command_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_command_workspace_id_fkey",
    }),
    check("workspace_command_input_digest_check", sql`input_digest ~ '^[0-9a-f]{64}$'::text`),
    check("workspace_command_kind_check", sql`kind = ANY (ARRAY['shell'::text, 'terminal'::text])`),
    check(
      "workspace_command_state_check",
      sql`state = ANY (ARRAY['start-intended'::text, 'dispatching'::text, 'starting'::text, 'running'::text, 'exited'::text, 'cancelled'::text, 'failed'::text, 'uncertain'::text, 'interrupted'::text])`,
    ),
  ],
);

export const workspaceFileOperation = factorySchema.table(
  "workspace_file_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    inputDigest: text("input_digest").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_file_operation_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "workspace_file_operation_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_file_operation_workspace_id_fkey",
    }),
    check(
      "workspace_file_operation_action_check",
      sql`action = ANY (ARRAY['mkdir'::text, 'delete'::text, 'rename'::text])`,
    ),
    check(
      "workspace_file_operation_input_digest_check",
      sql`input_digest ~ '^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const workspaceFileTransfer = factorySchema.table(
  "workspace_file_transfer",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    direction: text("direction").notNull(),
    inputDigest: text("input_digest").notNull(),
    path: text("path").notNull(),
    state: text("state").notNull(),
    result: jsonb("result"),
    commitAttemptedAt: timestamp("commit_attempted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .default(sql`(now() + '00:30:00'::interval)`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("workspace_file_transfer_runtime_idx").using(
      "btree",
      table.runtimeAttemptId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_file_transfer_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "workspace_file_transfer_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_file_transfer_workspace_id_fkey",
    }),
    check(
      "workspace_file_transfer_direction_check",
      sql`direction = ANY (ARRAY['upload'::text, 'download'::text])`,
    ),
    check("workspace_file_transfer_input_digest_check", sql`input_digest ~ '^[0-9a-f]{64}$'::text`),
    check(
      "workspace_file_transfer_state_check",
      sql`state = ANY (ARRAY['preparing'::text, 'active'::text, 'committing'::text, 'committed'::text, 'releasing'::text, 'released'::text, 'uncertain'::text])`,
    ),
  ],
);

export const workspaceLifecycleCommand = factorySchema.table(
  "workspace_lifecycle_command",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    dispatchAttemptedAt: timestamp("dispatch_attempted_at", { withTimezone: true }),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_lifecycle_command_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "workspace_lifecycle_command_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_lifecycle_command_workspace_id_fkey",
    }),
    check(
      "workspace_lifecycle_command_action_check",
      sql`action = ANY (ARRAY['start'::text, 'pause'::text, 'stop'::text])`,
    ),
  ],
);

export const workspaceShareDecision = factorySchema.table(
  "workspace_share_decision",
  {
    id: uuid("id").primaryKey().notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    permission: text("permission"),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    accessReconciledAt: timestamp("access_reconciled_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_share_decision_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "workspace_share_decision_user_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_share_decision_workspace_id_fkey",
    }),
    check("workspace_share_decision_expected_version_check", sql`expected_version >= 0`),
    check(
      "workspace_share_decision_permission_check",
      sql`permission = ANY (ARRAY['observe'::text, 'collaborate'::text])`,
    ),
  ],
);

export const workspaceTerminalOperation = factorySchema.table(
  "workspace_terminal_operation",
  {
    id: uuid("id").primaryKey().notNull(),
    commandId: uuid("command_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    inputDigest: text("input_digest").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "workspace_terminal_operation_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.commandId],
      foreignColumns: [workspaceCommand.id],
      name: "workspace_terminal_operation_command_id_fkey",
    }),
    check(
      "workspace_terminal_operation_action_check",
      sql`action = ANY (ARRAY['input'::text, 'resize'::text])`,
    ),
    check(
      "workspace_terminal_operation_input_digest_check",
      sql`input_digest ~ '^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const workspaceShare = factorySchema.table(
  "workspace_share",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    permission: text("permission").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.grantedBy],
      foreignColumns: [authUser.id],
      name: "workspace_share_granted_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "workspace_share_user_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_share_workspace_id_fkey",
    }),
    primaryKey({ columns: [table.workspaceId, table.userId], name: "workspace_share_pkey" }),
    check(
      "workspace_share_permission_check",
      sql`permission = ANY (ARRAY['observe'::text, 'collaborate'::text])`,
    ),
    check("workspace_share_version_check", sql`version > 0`),
  ],
);

export const workspaceSharedDocument = factorySchema.table(
  "workspace_shared_document",
  {
    workspaceId: uuid("workspace_id").notNull(),
    path: text("path").notNull(),
    yState: bytea("y_state").notNull(),
    diskVersion: text("disk_version").notNull(),
    dirty: boolean("dirty").default(false).notNull(),
    conflict: boolean("conflict").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_shared_document_workspace_id_fkey",
    }),
    primaryKey({
      columns: [table.workspaceId, table.path],
      name: "workspace_shared_document_pkey",
    }),
    check("workspace_shared_document_y_state_check", sql`octet_length(y_state) <= 8388608`),
  ],
);
