import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
import { change } from "./delivery";
import { factorySchema } from "./namespaces";
import { runtimeAttempt } from "./runtime";

export const projectDeliveryPolicy = factorySchema.table(
  "project_delivery_policy",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    delegatedBy: uuid("delegated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedCommandId: uuid("revoked_command_id"),
    revokedBy: uuid("revoked_by"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("project_delivery_one_active_policy")
      .using("btree", table.projectId.asc().nullsLast())
      .where(sql`(revoked_at IS NULL)`),
    foreignKey({
      columns: [table.delegatedBy],
      foreignColumns: [authUser.id],
      name: "project_delivery_policy_delegated_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_delivery_policy_project_id_fkey",
    }),
    foreignKey({
      columns: [table.revokedBy],
      foreignColumns: [authUser.id],
      name: "project_delivery_policy_revoked_by_fkey",
    }),
  ],
);

export const project = factorySchema.table(
  "project",
  {
    id: uuid("id").primaryKey().notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    devcontainerPath: text("devcontainer_path").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    desktopBackgroundKey: text("desktop_background_key").default("river-landscape").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "project_created_by_fkey",
    }),
    unique("project_slug_key").on(table.slug),
    check(
      "project_default_branch_check",
      sql`(length(default_branch) >= 1) AND (length(default_branch) <= 200)`,
    ),
    check(
      "project_desktop_background_key_check",
      sql`desktop_background_key = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text, 'gulf-of-marseille'::text, 'scene-on-the-ice'::text, 'moonlit-landscape'::text])`,
    ),
    check(
      "project_devcontainer_path_check",
      sql`(devcontainer_path <> ''::text) AND (devcontainer_path !~ '(^/|(^|/)\\.\\.(/|$))'::text)`,
    ),
    check("project_name_check", sql`(length(name) >= 1) AND (length(name) <= 200)`),
    check("project_slug_check", sql`slug ~ '^[a-z][a-z0-9-]{1,62}$'::text`),
  ],
);

export const projectSetupInspection = factorySchema.table(
  "project_setup_inspection",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    sourceCommit: text("source_commit").notNull(),
    state: text("state").notNull(),
    output: jsonb("output"),
    failure: text("failure"),
    modelId: text("model_id"),
    connectionId: uuid("connection_id"),
    connectionVersion: bigint("connection_version", { mode: "number" }),
    parentId: uuid("parent_id"),
    answers: jsonb("answers").default({}).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("project_setup_one_inspection")
      .using("btree", table.projectId.asc().nullsLast())
      .where(sql`(state = ANY (ARRAY['inspecting'::text, 'proposal'::text, 'confirming'::text]))`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "project_setup_inspection_created_by_fkey",
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [projectSetupInspection.id],
      name: "project_setup_inspection_parent_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_setup_inspection_project_id_fkey",
    }).onDelete("cascade"),
    check(
      "project_setup_inspection_source_commit_check",
      sql`source_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'::text`,
    ),
    check(
      "project_setup_inspection_check",
      sql`(connection_id IS NULL) = (connection_version IS NULL)`,
    ),
    check(
      "project_setup_inspection_state_check",
      sql`state = ANY (ARRAY['inspecting'::text, 'complete'::text, 'proposal'::text, 'failed'::text, 'confirming'::text, 'confirmed'::text, 'superseded'::text])`,
    ),
  ],
);

export const projectImagePreparation = factorySchema.table(
  "project_image_preparation",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    environment: text("environment").notNull(),
    revision: text("revision").notNull(),
    environmentVersion: bigint("environment_version", { mode: "number" }).notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    state: text("state").default("pending").notNull(),
    identity: text("identity"),
    image: text("image"),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_image_preparation_project_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "project_image_preparation_runtime_attempt_id_fkey",
    }),
    unique("project_image_preparation_project_id_environment_revision_e_key").on(
      table.projectId,
      table.environment,
      table.revision,
      table.environmentVersion,
    ),
    unique("project_image_preparation_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "project_image_preparation_check",
      sql`(state = 'succeeded'::text) = ((identity IS NOT NULL) AND (image IS NOT NULL))`,
    ),
    check(
      "project_image_preparation_environment_check",
      sql`environment = ANY (ARRAY['development'::text, 'main-preview'::text])`,
    ),
    check("project_image_preparation_environment_version_check", sql`environment_version >= 0`),
    check("project_image_preparation_identity_check", sql`identity ~ '^[a-f0-9]{64}$'::text`),
    check(
      "project_image_preparation_image_check",
      sql`image ~ '^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$'::text`,
    ),
    check(
      "project_image_preparation_revision_check",
      sql`revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'::text`,
    ),
    check(
      "project_image_preparation_state_check",
      sql`state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'unsupported'::text, 'failed'::text])`,
    ),
  ],
);

export const projectRepositoryIntent = factorySchema.table(
  "project_repository_intent",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    setupId: uuid("setup_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").$type<"starter" | "import">().notNull(),
    sourceUrl: text("source_url").notNull(),
    credentialKey: text("credential_key"),
    fingerprint: text("fingerprint").notNull(),
    state: text("state")
      .$type<
        | "credential-intended"
        | "create-intended"
        | "repository-ready"
        | "committed"
        | "uncertain"
        | "failed"
      >()
      .notNull(),
    defaultBranch: text("default_branch"),
    failure: text("failure"),
    credentialRemovedAt: timestamp("credential_removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "project_repository_intent_user_id_fkey",
    }),
    unique("project_repository_intent_setup_id_key").on(table.setupId),
    unique("project_repository_intent_project_id_key").on(table.projectId),
    unique("project_repository_intent_slug_key").on(table.slug),
    unique("project_repository_intent_credential_key_key").on(table.credentialKey),
    check("project_repository_intent_fingerprint_check", sql`fingerprint ~ '^[a-f0-9]{64}$'::text`),
    check(
      "project_repository_intent_kind_check",
      sql`kind = ANY (ARRAY['starter'::text, 'import'::text])`,
    ),
    check(
      "project_repository_intent_state_check",
      sql`state = ANY (ARRAY['credential-intended'::text, 'create-intended'::text, 'repository-ready'::text, 'committed'::text, 'uncertain'::text, 'failed'::text])`,
    ),
  ],
);

export const projectDeliveryQueue = factorySchema.table(
  "project_delivery_queue",
  {
    projectId: uuid("project_id").primaryKey().notNull(),
    changeId: uuid("change_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "project_delivery_queue_change_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_delivery_queue_project_id_fkey",
    }),
    unique("project_delivery_queue_change_id_key").on(table.changeId),
  ],
);

export const projectSetupConfirmation = factorySchema.table(
  "project_setup_confirmation",
  {
    inspectionId: uuid("inspection_id").primaryKey().notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "project_setup_confirmation_created_by_fkey",
    }),
    foreignKey({
      columns: [table.inspectionId],
      foreignColumns: [projectSetupInspection.id],
      name: "project_setup_confirmation_inspection_id_fkey",
    }),
  ],
);

export const projectSetupDraft = factorySchema.table(
  "project_setup_draft",
  {
    id: uuid("id").primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    name: text("name").default("").notNull(),
    slug: text("slug").default("").notNull(),
    kind: text("kind").default("starter").notNull(),
    sourceUrl: text("source_url").default("").notNull(),
    state: text("state").default("draft").notNull(),
    projectId: uuid("project_id"),
    commandId: uuid("command_id"),
    failure: text("failure"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_setup_draft_project_id_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "project_setup_draft_user_id_fkey",
    }).onDelete("cascade"),
    unique("project_setup_draft_user_id_key").on(table.userId),
    unique("project_setup_draft_command_id_key").on(table.commandId),
    check(
      "project_setup_draft_kind_check",
      sql`kind = ANY (ARRAY['starter'::text, 'import'::text])`,
    ),
    check("project_setup_draft_name_check", sql`length(name) <= 200`),
    check(
      "project_setup_draft_slug_check",
      sql`(slug = ''::text) OR (slug ~ '^[a-z][a-z0-9-]{1,62}$'::text)`,
    ),
    check("project_setup_draft_source_url_check", sql`length(source_url) <= 2000`),
    check(
      "project_setup_draft_state_check",
      sql`state = ANY (ARRAY['draft'::text, 'creating'::text, 'checking'::text, 'created'::text, 'failed'::text])`,
    ),
    check("project_setup_draft_version_check", sql`version > 0`),
  ],
);

export const userUIPreference = factorySchema.table(
  "user_ui_preference",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    desktopBackgroundKey: text("desktop_background_key").default("river-landscape").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "user_ui_preference_user_id_fkey",
    }).onDelete("cascade"),
    check(
      "user_ui_preference_desktop_background_key_check",
      sql`desktop_background_key = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text])`,
    ),
  ],
);

export const projectMembership = factorySchema.table(
  "project_membership",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<"developer" | "product-contributor">().notNull(),
    updatedBy: uuid("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    manageProject: boolean("manage_project").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("project_membership_user_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_membership_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "project_membership_updated_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "project_membership_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.userId], name: "project_membership_pkey" }),
    check(
      "project_membership_role_check",
      sql`role = ANY (ARRAY['product-contributor'::text, 'developer'::text])`,
    ),
  ],
);

export const projectSetupReadiness = factorySchema.table(
  "project_setup_readiness",
  {
    projectId: uuid("project_id").notNull(),
    task: text("task").notNull(),
    state: text("state")
      .$type<"pending" | "running" | "ready" | "failed">()
      .default("pending")
      .notNull(),
    commandId: uuid("command_id").notNull(),
    operationId: uuid("operation_id"),
    failure: text("failure"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_setup_readiness_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.task], name: "project_setup_readiness_pkey" }),
    unique("project_setup_readiness_command_id_key").on(table.commandId),
    check(
      "project_setup_readiness_state_check",
      sql`state = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text])`,
    ),
    check(
      "project_setup_readiness_task_check",
      sql`task = ANY (ARRAY['configuration'::text, 'development-secrets'::text, 'preview-secrets'::text, 'protection'::text, 'hook'::text, 'wiki'::text, 'development'::text, 'preview-image'::text, 'main-preview'::text])`,
    ),
  ],
);
