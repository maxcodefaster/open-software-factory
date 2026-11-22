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
import { change, verification } from "./delivery";
import { isolatedRuntimeKind, runtimeAttemptState } from "./enums";
import { factorySchema } from "./namespaces";
import { project, projectImagePreparation } from "./projects";
import { developmentWorkspace } from "./workspace";

export const runtimeAttempt = factorySchema.table(
  "runtime_attempt",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    changeId: uuid("change_id"),
    workspaceId: uuid("workspace_id"),
    generation: bigint("generation", { mode: "number" }).notNull(),
    revision: text("revision").notNull(),
    state: runtimeAttemptState("state").notNull(),
    parentConnectorTokenHash: text("parent_connector_token_hash").notNull(),
    childConnectorTokenHash: text("child_connector_token_hash").notNull(),
    createIntendedAt: timestamp("create_intended_at", { withTimezone: true }).notNull(),
    createObservedAt: timestamp("create_observed_at", { withTimezone: true }),
    stopIntendedAt: timestamp("stop_intended_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    failure: text("failure"),
    declaredApps: jsonb("declared_apps").default([]).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    isolatedKind: isolatedRuntimeKind("isolated_kind"),
    verificationId: uuid("verification_id"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    appReadyAt: jsonb("app_ready_at").default({}).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("runtime_attempt_active_isolated_idx")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        table.isolatedKind.asc().nullsLast(),
        table.state.asc().nullsLast(),
      )
      .where(
        sql`((${table.isolatedKind} IS NOT NULL) AND (${table.state} = ANY (ARRAY['create-intended'::runtime_attempt_state, 'starting'::runtime_attempt_state, 'ready'::runtime_attempt_state, 'stop-intended'::runtime_attempt_state, 'stopping'::runtime_attempt_state, 'cleanup-failed'::runtime_attempt_state])))`,
      ),
    uniqueIndex("runtime_attempt_change_generation_uidx")
      .using("btree", table.changeId.asc().nullsLast(), table.generation.asc().nullsLast())
      .where(sql`(${table.changeId} IS NOT NULL)`),
    uniqueIndex("runtime_attempt_one_active_per_change")
      .using("btree", table.changeId.asc().nullsLast())
      .where(
        sql`((${table.changeId} IS NOT NULL) AND (${table.state} <> ALL (ARRAY['stopped'::runtime_attempt_state, 'failed'::runtime_attempt_state])))`,
      ),
    uniqueIndex("runtime_attempt_one_active_per_workspace")
      .using("btree", table.workspaceId.asc().nullsLast())
      .where(
        sql`((${table.workspaceId} IS NOT NULL) AND (${table.state} <> ALL (ARRAY['stopped'::runtime_attempt_state, 'failed'::runtime_attempt_state])))`,
      ),
    uniqueIndex("runtime_attempt_workspace_generation_uidx")
      .using("btree", table.workspaceId.asc().nullsLast(), table.generation.asc().nullsLast())
      .where(sql`(${table.workspaceId} IS NOT NULL)`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "runtime_attempt_change_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId, table.projectId],
      foreignColumns: [change.id, change.projectId],
      name: "runtime_attempt_change_project_fk",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "runtime_attempt_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "runtime_attempt_project_id_fkey",
    }),
    foreignKey({
      columns: [table.verificationId],
      foreignColumns: [verification.id],
      name: "runtime_attempt_verification_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId, table.changeId],
      foreignColumns: [developmentWorkspace.id, developmentWorkspace.changeId],
      name: "runtime_attempt_workspace_change_fk",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "runtime_attempt_workspace_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [developmentWorkspace.id, developmentWorkspace.projectId],
      name: "runtime_attempt_workspace_project_fk",
    }),
    unique("runtime_attempt_id_change_id_key").on(table.id, table.changeId),
    unique("runtime_attempt_id_project_id_key").on(table.id, table.projectId),
    unique("runtime_attempt_id_workspace_id_key").on(table.id, table.workspaceId),
    unique("runtime_attempt_verification_identity_unique").on(table.id, table.verificationId),
    check(
      "runtime_attempt_app_ready_shape",
      sql`(jsonb_typeof(${table.appReadyAt}) = 'object'::text) AND (octet_length((${table.appReadyAt})::text) <= 4096)`,
    ),
    check(
      "runtime_attempt_declared_apps_check",
      sql`jsonb_typeof(${table.declaredApps}) = 'array'::text`,
    ),
    check("runtime_attempt_generation_check", sql`${table.generation} > 0`),
    check(
      "runtime_attempt_native_owner",
      sql`(
        (${table.workspaceId} IS NOT NULL AND ${table.isolatedKind} IS NULL AND ${table.verificationId} IS NULL)
        OR (${table.workspaceId} IS NULL AND ${table.changeId} IS NULL AND (
          (${table.isolatedKind} = 'verification'::isolated_runtime_kind AND ${table.verificationId} IS NOT NULL)
          OR (${table.isolatedKind} = ANY (ARRAY['prebuild'::isolated_runtime_kind, 'staging'::isolated_runtime_kind, 'publication'::isolated_runtime_kind]) AND ${table.verificationId} IS NULL)
        ))
      ) IS TRUE`,
    ),
  ],
);

export const runtimeComputeWait = factorySchema.table(
  "runtime_compute_wait",
  {
    attemptId: uuid("attempt_id").primaryKey().notNull(),
    reason: text("reason")
      .$type<
        "compute-capacity" | "accounting-incomplete" | "coding-budget-used" | "finish-reserve-used"
      >()
      .default("compute-capacity")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.attemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "runtime_compute_wait_attempt_id_fkey",
    }).onDelete("cascade"),
    check(
      "runtime_compute_wait_reason_check",
      sql`${table.reason} = ANY (ARRAY['compute-capacity'::text, 'accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])`,
    ),
  ],
);

export const substrateBinding = factorySchema.table(
  "substrate_binding",
  {
    runtimeAttemptId: uuid("runtime_attempt_id").primaryKey().notNull(),
    atespace: text("atespace").notNull(),
    actorName: text("actor_name").notNull(),
    intent: jsonb("intent").notNull(),
    actorUid: uuid("actor_uid"),
    createAttemptedAt: timestamp("create_attempted_at", { withTimezone: true }),
    createRejected: boolean("create_rejected").default(false).notNull(),
    deleteIntendedAt: timestamp("delete_intended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    observation: jsonb("observation"),
    checkpoint: jsonb("checkpoint"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "substrate_binding_runtime_attempt_id_fkey",
    }),
    unique("substrate_binding_atespace_actor_name_key").on(table.atespace, table.actorName),
    unique("substrate_binding_atespace_key").on(table.atespace),
    unique("substrate_binding_actor_uid_key").on(table.actorUid),
    check(
      "substrate_binding_check",
      sql`(${table.actorUid} IS NULL) OR (${table.createAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_binding_check1",
      sql`(${table.deletedAt} IS NULL) OR (${table.deleteIntendedAt} IS NOT NULL)`,
    ),
    check("substrate_binding_intent_check", sql`jsonb_typeof(${table.intent}) = 'object'::text`),
  ],
);

export const substratePrebuild = factorySchema.table(
  "substrate_prebuild",
  {
    preparationId: uuid("preparation_id").primaryKey().notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    intent: jsonb("intent").notNull(),
    atespaceAttemptedAt: timestamp("atespace_attempted_at", { withTimezone: true }),
    atespaceRejected: boolean("atespace_rejected").default(false).notNull(),
    atespace: jsonb("atespace"),
    policyAttemptedAt: timestamp("policy_attempted_at", { withTimezone: true }),
    policyRejected: boolean("policy_rejected").default(false).notNull(),
    policy: jsonb("policy"),
    templateAttemptedAt: timestamp("template_attempted_at", { withTimezone: true }),
    templateRejected: boolean("template_rejected").default(false).notNull(),
    template: jsonb("template"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.preparationId],
      foreignColumns: [projectImagePreparation.id],
      name: "substrate_prebuild_preparation_id_fkey",
    }),
    unique("substrate_prebuild_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "substrate_prebuild_check",
      sql`(${table.atespace} IS NULL) OR ((${table.atespaceAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.atespace}) = 'object'::text))`,
    ),
    check(
      "substrate_prebuild_check1",
      sql`(${table.policy} IS NULL) OR ((${table.policyAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.policy}) = 'object'::text))`,
    ),
    check(
      "substrate_prebuild_check2",
      sql`(${table.template} IS NULL) OR ((${table.templateAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.template}) = 'object'::text))`,
    ),
    check("substrate_prebuild_generation_check", sql`${table.generation} = 1`),
    check("substrate_prebuild_intent_check", sql`jsonb_typeof(${table.intent}) = 'object'::text`),
  ],
);

export const substrateSource = factorySchema.table(
  "substrate_source",
  {
    workspaceId: uuid("workspace_id").primaryKey().notNull(),
    actorUid: uuid("actor_uid").notNull(),
    owner: text("owner").$type<"actor" | "service">().default("actor").notNull(),
    writerEpoch: bigint("writer_epoch", { mode: "number" }).default(1).notNull(),
    writable: boolean("writable").default(true).notNull(),
    generation: bigint("generation", { mode: "number" }).default(0).notNull(),
    checkpointId: uuid("checkpoint_id"),
    checkpoint: jsonb("checkpoint"),
    serviceBase: uuid("service_base"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "substrate_source_workspace_id_fkey",
    }),
    check("substrate_source_check", sql`(${table.generation} = 0) = (${table.checkpoint} IS NULL)`),
    check("substrate_source_check1", sql`${table.writable} = (${table.checkpointId} IS NULL)`),
    check(
      "substrate_source_check2",
      sql`(${table.owner} <> 'service'::text) OR (${table.serviceBase} IS NOT NULL)`,
    ),
    check("substrate_source_generation_check", sql`${table.generation} >= 0`),
    check(
      "substrate_source_owner_check",
      sql`${table.owner} = ANY (ARRAY['actor'::text, 'service'::text])`,
    ),
    check("substrate_source_writer_epoch_check", sql`${table.writerEpoch} > 0`),
  ],
);

export const substrateVerification = factorySchema.table(
  "substrate_verification",
  {
    verificationId: uuid("verification_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    intent: jsonb("intent").notNull(),
    atespaceAttemptedAt: timestamp("atespace_attempted_at", { withTimezone: true }),
    atespaceRejected: boolean("atespace_rejected").default(false).notNull(),
    atespace: jsonb("atespace"),
    policyAttemptedAt: timestamp("policy_attempted_at", { withTimezone: true }),
    policyRejected: boolean("policy_rejected").default(false).notNull(),
    policy: jsonb("policy"),
    templateAttemptedAt: timestamp("template_attempted_at", { withTimezone: true }),
    templateRejected: boolean("template_rejected").default(false).notNull(),
    template: jsonb("template"),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.runtimeAttemptId], name: "substrate_verification_pkey" }),
    foreignKey({
      columns: [table.verificationId],
      foreignColumns: [verification.id],
      name: "substrate_verification_verification_id_fkey",
    }),
    unique("substrate_verification_verification_id_generation_key").on(
      table.verificationId,
      table.generation,
    ),

    check(
      "substrate_verification_atespace_check",
      sql`(${table.atespace} IS NULL) OR (jsonb_typeof(${table.atespace}) = 'object'::text)`,
    ),
    check(
      "substrate_verification_check",
      sql`(${table.atespace} IS NULL) OR (${table.atespaceAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_verification_check1",
      sql`(${table.policy} IS NULL) OR (${table.policyAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_verification_check2",
      sql`(${table.template} IS NULL) OR (${table.templateAttemptedAt} IS NOT NULL)`,
    ),
    check("substrate_verification_generation_check", sql`${table.generation} > 0`),
    check(
      "substrate_verification_intent_check",
      sql`jsonb_typeof(${table.intent}) = 'object'::text`,
    ),
    check(
      "substrate_verification_policy_check",
      sql`(${table.policy} IS NULL) OR (jsonb_typeof(${table.policy}) = 'object'::text)`,
    ),
    check(
      "substrate_verification_template_check",
      sql`(${table.template} IS NULL) OR (jsonb_typeof(${table.template}) = 'object'::text)`,
    ),
  ],
);

export const substrateInputStop = factorySchema.table(
  "substrate_input_stop",
  {
    stopId: uuid("stop_id").primaryKey().notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    changeId: uuid("change_id").notNull(),
    actorUid: uuid("actor_uid").notNull(),
    assignment: jsonb("assignment").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    sourceCheckpointId: uuid("source_checkpoint_id"),
    sourceWriterEpoch: bigint("source_writer_epoch", { mode: "number" }),
    resumeAttemptedAt: timestamp("resume_attempted_at", { withTimezone: true }),
    snapshotAttemptedAt: timestamp("snapshot_attempted_at", { withTimezone: true }),
    result: jsonb("result"),
    completedCheckpoint: jsonb("completed_checkpoint"),
    completedSourceCheckpointId: uuid("completed_source_checkpoint_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "substrate_input_stop_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "substrate_input_stop_workspace_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "substrate_input_stop_change_id_fkey",
    }),
    check(
      "substrate_input_stop_assignment_check",
      sql`(jsonb_typeof(${table.assignment}) = 'object'::text) AND (octet_length((${table.assignment})::text) <= 8192)`,
    ),
    check(
      "substrate_input_stop_checkpoint_check",
      sql`jsonb_typeof(${table.checkpoint}) = 'object'::text`,
    ),
    check("substrate_input_stop_source_writer_epoch_check", sql`${table.sourceWriterEpoch} > 0`),
    check(
      "substrate_input_stop_result_check",
      sql`(jsonb_typeof(${table.result}) = 'object'::text) AND (octet_length((${table.result})::text) <= 8192)`,
    ),
    check(
      "substrate_input_stop_check",
      sql`(${table.sourceCheckpointId} IS NULL) = (${table.sourceWriterEpoch} IS NULL)`,
    ),
    check(
      "substrate_input_stop_check1",
      sql`(${table.resumeAttemptedAt} IS NULL) OR (${table.sourceCheckpointId} IS NOT NULL)`,
    ),
    check(
      "substrate_input_stop_check2",
      sql`(${table.result} IS NULL) OR (${table.resumeAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_input_stop_check3",
      sql`(${table.snapshotAttemptedAt} IS NULL) OR (${table.resumeAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_input_stop_check4",
      sql`(${table.completedAt} IS NULL) OR ((${table.result} IS NOT NULL) AND ((${table.result} -> 'confirmed'::text) = 'true'::jsonb) AND (${table.completedCheckpoint} IS NOT NULL) AND (${table.completedSourceCheckpointId} IS NOT NULL))`,
    ),
  ],
);

export const substrateCapacityInstallation = factorySchema.table(
  "substrate_capacity_installation",
  {
    owner: text("owner").primaryKey().notNull(),
    intent: jsonb("intent").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      "substrate_capacity_installation_owner_check",
      sql`${table.owner} ~ '^[a-f0-9]{32}$'::text`,
    ),
    check(
      "substrate_capacity_installation_intent_check",
      sql`jsonb_typeof(${table.intent}) = 'object'::text`,
    ),
  ],
);

export const substrateWorkerCapacity = factorySchema.table(
  "substrate_worker_capacity",
  {
    owner: text("owner").notNull(),
    nodeUid: uuid("node_uid").notNull(),
    intent: jsonb("intent").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    rejected: boolean("rejected").default(false).notNull(),
    pool: jsonb("pool"),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.owner, table.nodeUid], name: "substrate_worker_capacity_pkey" }),
    check(
      "substrate_worker_capacity_check",
      sql`(${table.pool} IS NULL) OR (${table.attemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_worker_capacity_intent_check",
      sql`jsonb_typeof(${table.intent}) = 'object'::text`,
    ),
    check("substrate_worker_capacity_owner_check", sql`${table.owner} ~ '^[a-f0-9]{32}$'::text`),
    check(
      "substrate_worker_capacity_pool_check",
      sql`(${table.pool} IS NULL) OR (jsonb_typeof(${table.pool}) = 'object'::text)`,
    ),
  ],
);

export const substrateActorRpc = factorySchema.table(
  "substrate_actor_rpc",
  {
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    action: text("action").$type<"resume" | "suspend">().notNull(),
    originKey: text("origin_key").notNull(),
    actorUid: uuid("actor_uid").notNull(),
    nativeVersion: text("native_version").notNull(),
    originCheckpoint: jsonb("origin_checkpoint"),
    stopId: uuid("stop_id"),
    intendedAt: timestamp("intended_at", { withTimezone: true }).defaultNow().notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    outcome: jsonb("outcome"),
    outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "substrate_actor_rpc_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.stopId],
      foreignColumns: [substrateInputStop.stopId],
      name: "substrate_actor_rpc_stop_id_fkey",
    }),
    primaryKey({
      columns: [table.runtimeAttemptId, table.action, table.originKey],
      name: "substrate_actor_rpc_pkey",
    }),
    check(
      "substrate_actor_rpc_action_check",
      sql`${table.action} = ANY (ARRAY['resume'::text, 'suspend'::text])`,
    ),
    check(
      "substrate_actor_rpc_native_version_check",
      sql`${table.nativeVersion} ~ '^[1-9][0-9]*$'::text`,
    ),
    check(
      "substrate_actor_rpc_origin_checkpoint_check",
      sql`jsonb_typeof(${table.originCheckpoint}) = 'object'::text`,
    ),
    check(
      "substrate_actor_rpc_outcome_check",
      sql`(jsonb_typeof(${table.outcome}) = 'object'::text) AND (octet_length((${table.outcome})::text) <= 65536)`,
    ),
    check(
      "substrate_actor_rpc_check",
      sql`${table.originKey} = COALESCE((${table.originCheckpoint} ->> 'uuid'::text), 'initial'::text)`,
    ),
    check(
      "substrate_actor_rpc_check1",
      sql`(${table.outcome} IS NULL) = (${table.outcomeRecordedAt} IS NULL)`,
    ),
    check(
      "substrate_actor_rpc_check2",
      sql`(${table.outcome} IS NULL) OR (${table.attemptedAt} IS NOT NULL)`,
    ),
  ],
);

export const substrateWorkspace = factorySchema.table(
  "substrate_workspace",
  {
    workspaceId: uuid("workspace_id").notNull(),
    generation: bigint("generation", { mode: "number" }).default(1).notNull(),
    intent: jsonb("intent").notNull(),
    atespaceAttemptedAt: timestamp("atespace_attempted_at", { withTimezone: true }),
    atespaceRejected: boolean("atespace_rejected").default(false).notNull(),
    atespace: jsonb("atespace"),
    policyAttemptedAt: timestamp("policy_attempted_at", { withTimezone: true }),
    policyRejected: boolean("policy_rejected").default(false).notNull(),
    policy: jsonb("policy"),
    templateAttemptedAt: timestamp("template_attempted_at", { withTimezone: true }),
    templateRejected: boolean("template_rejected").default(false).notNull(),
    template: jsonb("template"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "substrate_workspace_workspace_id_fkey",
    }),
    primaryKey({
      columns: [table.workspaceId, table.generation],
      name: "substrate_workspace_pkey",
    }),
    check(
      "substrate_workspace_check",
      sql`(${table.atespace} IS NULL) OR (${table.atespaceAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_workspace_check1",
      sql`(${table.policy} IS NULL) OR (${table.policyAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_workspace_check2",
      sql`(${table.template} IS NULL) OR (${table.templateAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "substrate_workspace_generation_check",
      sql`(${table.generation} > 0) AND (${table.generation} <= '9007199254740991'::bigint)`,
    ),
    check("substrate_workspace_intent_check", sql`jsonb_typeof(${table.intent}) = 'object'::text`),
  ],
);

export const substrateIsolated = factorySchema.table(
  "substrate_isolated",
  {
    ownerId: uuid("owner_id").notNull(),
    kind: text("kind").$type<"staging" | "publication">().notNull(),
    projectId: uuid("project_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    intent: jsonb("intent").notNull(),
    atespaceAttemptedAt: timestamp("atespace_attempted_at", { withTimezone: true }),
    atespaceRejected: boolean("atespace_rejected").default(false).notNull(),
    atespace: jsonb("atespace"),
    policyAttemptedAt: timestamp("policy_attempted_at", { withTimezone: true }),
    policyRejected: boolean("policy_rejected").default(false).notNull(),
    policy: jsonb("policy"),
    templateAttemptedAt: timestamp("template_attempted_at", { withTimezone: true }),
    templateRejected: boolean("template_rejected").default(false).notNull(),
    template: jsonb("template"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "substrate_isolated_project_id_fkey",
    }),
    primaryKey({
      columns: [table.ownerId, table.kind, table.generation],
      name: "substrate_isolated_pkey",
    }),
    unique("substrate_isolated_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "substrate_isolated_check",
      sql`(${table.atespace} IS NULL) OR ((${table.atespaceAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.atespace}) = 'object'::text))`,
    ),
    check(
      "substrate_isolated_check1",
      sql`(${table.policy} IS NULL) OR ((${table.policyAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.policy}) = 'object'::text))`,
    ),
    check(
      "substrate_isolated_check2",
      sql`(${table.template} IS NULL) OR ((${table.templateAttemptedAt} IS NOT NULL) AND (jsonb_typeof(${table.template}) = 'object'::text))`,
    ),
    check(
      "substrate_isolated_check3",
      sql`(${table.kind} = 'staging'::text) OR (${table.generation} = 1)`,
    ),
    check(
      "substrate_isolated_check4",
      sql`((${table.intent} ->> 'promotionID'::text) IS NULL) OR ((${table.kind} = 'staging'::text) AND (${table.generation} = 1))`,
    ),
    check(
      "substrate_isolated_check5",
      sql`(${table.kind} = 'staging'::text) = (jsonb_typeof((${table.intent} -> 'declaration'::text)) = 'object'::text)`,
    ),
    check("substrate_isolated_generation_check", sql`${table.generation} > 0`),
    check("substrate_isolated_intent_check", sql`jsonb_typeof(${table.intent}) = 'object'::text`),
    check(
      "substrate_isolated_kind_check",
      sql`${table.kind} = ANY (ARRAY['staging'::text, 'publication'::text])`,
    ),
  ],
);
