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
import { project } from "./projects";
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
    createIntendedAt: timestamp("create_intended_at", { withTimezone: true }).notNull(),
    stopIntendedAt: timestamp("stop_intended_at", { withTimezone: true }),
    failure: text("failure"),
    declaredApps: jsonb("declared_apps").default([]).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    isolatedKind: isolatedRuntimeKind("isolated_kind"),
    verificationId: uuid("verification_id"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    appReadyAt: jsonb("app_ready_at").default({}).notNull(),
    atespace: text("atespace"),
    actorName: text("actor_name"),
    bindingIntent: jsonb("binding_intent"),
    actorUid: uuid("actor_uid"),
    createAttemptedAt: timestamp("create_attempted_at", { withTimezone: true }),
    createRejected: boolean("create_rejected").default(false).notNull(),
    deleteIntendedAt: timestamp("delete_intended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    observation: jsonb("observation"),
    checkpoint: jsonb("checkpoint"),
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
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [developmentWorkspace.id, developmentWorkspace.projectId],
      name: "runtime_attempt_workspace_project_fk",
    }),
    unique("runtime_attempt_id_change_id_key").on(table.id, table.changeId),
    unique("runtime_attempt_id_project_id_key").on(table.id, table.projectId),
    unique("runtime_attempt_id_workspace_id_key").on(table.id, table.workspaceId),
    unique("runtime_attempt_verification_identity_unique").on(table.id, table.verificationId),
    unique("runtime_attempt_atespace_key").on(table.atespace),
    unique("runtime_attempt_actor_uid_key").on(table.actorUid),
    check(
      "runtime_attempt_app_ready_shape",
      sql`(jsonb_typeof(${table.appReadyAt}) = 'object'::text) AND (octet_length((${table.appReadyAt})::text) <= 4096)`,
    ),
    check(
      "runtime_attempt_binding_actor_check",
      sql`(${table.actorUid} IS NULL) OR (${table.createAttemptedAt} IS NOT NULL)`,
    ),
    check(
      "runtime_attempt_binding_delete_check",
      sql`(${table.deletedAt} IS NULL) OR (${table.deleteIntendedAt} IS NOT NULL)`,
    ),
    check(
      "runtime_attempt_binding_intent_check",
      sql`(${table.bindingIntent} IS NULL) OR (jsonb_typeof(${table.bindingIntent}) = 'object'::text)`,
    ),
    check(
      "runtime_attempt_binding_tuple_check",
      sql`((${table.atespace} IS NULL) = (${table.actorName} IS NULL)) AND ((${table.atespace} IS NULL) = (${table.bindingIntent} IS NULL))`,
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
          OR (${table.isolatedKind} = ANY (ARRAY['staging'::isolated_runtime_kind, 'publication'::isolated_runtime_kind]) AND ${table.verificationId} IS NULL)
        ))
      ) IS TRUE`,
    ),
  ],
);

export const substrateSource = factorySchema.table(
  "substrate_source",
  {
    workspaceId: uuid("workspace_id").primaryKey().notNull(),
    actorUid: uuid("actor_uid"),
    owner: text("owner").$type<"actor" | "service">().default("actor").notNull(),
    writerEpoch: bigint("writer_epoch", { mode: "number" }).default(1).notNull(),
    writable: boolean("writable").default(true).notNull(),
    generation: bigint("generation", { mode: "number" }).default(0).notNull(),
    checkpointId: uuid("checkpoint_id"),
    checkpoint: jsonb("checkpoint"),
    serviceBase: uuid("service_base"),
    seed: jsonb("seed"),
    seedConfirmedAt: timestamp("seed_confirmed_at", { withTimezone: true }),
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
    check(
      "substrate_source_actor_check",
      sql`(${table.actorUid} IS NOT NULL) OR (${table.owner} = 'service'::text AND ${table.seed} IS NOT NULL)`,
    ),
    check(
      "substrate_source_seed_check",
      sql`${table.seed} IS NULL OR (
        jsonb_typeof(${table.seed}) = 'object'
        AND ${table.seed} - ARRAY['version','id','workspaceID','projectID','repositoryURL','revision','branch'] = '{}'::jsonb
        AND ${table.seed}->'version' = '1'::jsonb
        AND jsonb_typeof(${table.seed}->'id') = 'string'
        AND ${table.seed}->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        AND jsonb_typeof(${table.seed}->'workspaceID') = 'string'
        AND ${table.seed}->>'workspaceID' = ${table.workspaceId}::text
        AND jsonb_typeof(${table.seed}->'projectID') = 'string'
        AND ${table.seed}->>'projectID' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        AND jsonb_typeof(${table.seed}->'repositoryURL') = 'string'
        AND jsonb_typeof(${table.seed}->'revision') = 'string'
        AND ${table.seed}->>'revision' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
        AND jsonb_typeof(${table.seed}->'branch') = 'string'
      ) IS TRUE`,
    ),
    check(
      "substrate_source_seed_confirmation_check",
      sql`${table.seedConfirmedAt} IS NULL OR ${table.seed} IS NOT NULL`,
    ),
    check("substrate_source_generation_check", sql`${table.generation} >= 0`),
    check(
      "substrate_source_owner_check",
      sql`${table.owner} = ANY (ARRAY['actor'::text, 'service'::text])`,
    ),
    check("substrate_source_writer_epoch_check", sql`${table.writerEpoch} > 0`),
  ],
);

export type SubstrateProvisionResourceState = {
  attemptedAt?: string | null;
  rejected?: boolean;
  value?: Record<string, unknown> | null;
};

export type SubstrateProvisionResources = {
  atespace?: SubstrateProvisionResourceState;
  policy?: SubstrateProvisionResourceState;
  template?: SubstrateProvisionResourceState;
};

export const substrateProvision = factorySchema.table(
  "substrate_provision",
  {
    ownerId: uuid("owner_id").notNull(),
    kind: text("kind").$type<"workspace" | "verification" | "staging" | "publication">().notNull(),
    generation: bigint("generation", { mode: "number" }).default(1).notNull(),
    projectId: uuid("project_id"),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    intent: jsonb("intent").notNull(),
    resources: jsonb("resources").$type<SubstrateProvisionResources>().default({}).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "substrate_provision_project_id_fkey",
    }),
    primaryKey({
      columns: [table.ownerId, table.kind, table.generation],
      name: "substrate_provision_pkey",
    }),
    unique("substrate_provision_runtime_attempt_id_key").on(table.runtimeAttemptId),
    check(
      "substrate_provision_kind_check",
      sql`${table.kind} = ANY (ARRAY['workspace'::text, 'verification'::text, 'staging'::text, 'publication'::text])`,
    ),
    check(
      "substrate_provision_generation_check",
      sql`(${table.generation} > 0) AND (${table.generation} <= '9007199254740991'::bigint)`,
    ),
    check("substrate_provision_intent_check", sql`jsonb_typeof(${table.intent}) = 'object'::text`),
    check(
      "substrate_provision_resources_check",
      sql`jsonb_typeof(${table.resources}) = 'object'::text
        AND ((${table.resources} - ARRAY['atespace','policy','template']) = '{}'::jsonb)
        AND ((${table.resources} -> 'atespace') IS NULL OR (jsonb_typeof(${table.resources} -> 'atespace') = 'object'::text
          AND ((${table.resources} -> 'atespace' -> 'value') IS NULL OR (${table.resources} -> 'atespace' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof(${table.resources} -> 'atespace' -> 'value') = 'object'::text AND jsonb_typeof(${table.resources} -> 'atespace' -> 'attemptedAt') = 'string'::text))))
        AND ((${table.resources} -> 'policy') IS NULL OR (jsonb_typeof(${table.resources} -> 'policy') = 'object'::text
          AND ((${table.resources} -> 'policy' -> 'value') IS NULL OR (${table.resources} -> 'policy' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof(${table.resources} -> 'policy' -> 'value') = 'object'::text AND jsonb_typeof(${table.resources} -> 'policy' -> 'attemptedAt') = 'string'::text))))
        AND ((${table.resources} -> 'template') IS NULL OR (jsonb_typeof(${table.resources} -> 'template') = 'object'::text
          AND ((${table.resources} -> 'template' -> 'value') IS NULL OR (${table.resources} -> 'template' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof(${table.resources} -> 'template' -> 'value') = 'object'::text AND jsonb_typeof(${table.resources} -> 'template' -> 'attemptedAt') = 'string'::text))))`,
    ),
    check(
      "substrate_provision_attempt_check",
      sql`(${table.kind} = 'workspace'::text) = (${table.runtimeAttemptId} IS NULL)`,
    ),
    check(
      "substrate_provision_project_check",
      sql`(${table.kind} = ANY (ARRAY['staging'::text, 'publication'::text])) = (${table.projectId} IS NOT NULL)`,
    ),
    check(
      "substrate_provision_publication_generation_check",
      sql`(${table.kind} <> 'publication'::text) OR (${table.generation} = 1)`,
    ),
    check(
      "substrate_provision_promotion_check",
      sql`((${table.intent} ->> 'promotionID'::text) IS NULL) OR ((${table.kind} = 'staging'::text) AND (${table.generation} = 1))`,
    ),
    check(
      "substrate_provision_declaration_check",
      sql`((${table.kind} <> 'staging'::text) OR (jsonb_typeof((${table.intent} -> 'declaration'::text)) = 'object'::text))
        AND ((${table.kind} <> 'publication'::text) OR (${table.intent} -> 'declaration'::text) IS NULL OR (${table.intent} -> 'declaration'::text) = 'null'::jsonb)`,
    ),
  ],
);
