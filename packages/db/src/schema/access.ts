import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
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
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";

export const changeEditingDecision = factorySchema.table(
  "change_editing_decision",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    targetId: uuid("target_id"),
    requestId: uuid("request_id"),
    writerEpoch: bigint("writer_epoch", { mode: "number" }).notNull(),
    kind: text("kind").$type<"takeover" | "idle-takeover" | "approve" | "release">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "change_editing_decision_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_editing_decision_change_id_fkey",
    }),
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [changeEditingRequest.id],
      name: "change_editing_decision_request_id_fkey",
    }),
    foreignKey({
      columns: [table.targetId],
      foreignColumns: [authUser.id],
      name: "change_editing_decision_target_id_fkey",
    }),
    check(
      "change_editing_decision_kind_check",
      sql`${table.kind} = ANY (ARRAY['takeover'::text, 'idle-takeover'::text, 'approve'::text, 'release'::text])`,
    ),
  ],
);

export const accountAccess = factorySchema.table(
  "account_access",
  {
    id: uuid("id").defaultRandom().notNull(),
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
    unique("account_access_id_key").on(table.id),
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

export const changeEditingRequest = factorySchema.table(
  "change_editing_request",
  {
    id: uuid("id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    requesterId: uuid("requester_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    writerEpoch: bigint("writer_epoch", { mode: "number" }).notNull(),
    state: text("state")
      .$type<"requested" | "accepted" | "superseded">()
      .default("requested")
      .notNull(),
    decidedBy: uuid("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("change_editing_request_pending")
      .using(
        "btree",
        table.changeId.asc().nullsLast(),
        table.requesterId.asc().nullsLast(),
        table.writerEpoch.asc().nullsLast(),
      )
      .where(sql`(${table.state} = 'requested'::text)`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_editing_request_change_id_fkey",
    }),
    foreignKey({
      columns: [table.decidedBy],
      foreignColumns: [authUser.id],
      name: "change_editing_request_decided_by_fkey",
    }),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "change_editing_request_owner_id_fkey",
    }),
    foreignKey({
      columns: [table.requesterId],
      foreignColumns: [authUser.id],
      name: "change_editing_request_requester_id_fkey",
    }),
    check(
      "change_editing_request_state_check",
      sql`${table.state} = ANY (ARRAY['requested'::text, 'accepted'::text, 'superseded'::text])`,
    ),
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

export const accessRevocation = factorySchema.table(
  "access_revocation",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    processedVersion: bigint("processed_version", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "access_revocation_user_id_fkey",
    }).onDelete("cascade"),
    check(
      "access_revocation_check",
      sql`(${table.processedVersion} >= 0) AND (${table.processedVersion} <= ${table.version})`,
    ),
  ],
);

export const externalIdentity = factorySchema.table(
  "external_identity",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id").notNull(),
    directorySubject: text("directory_subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "external_identity_user_id_fkey",
    }).onDelete("cascade"),
    unique("external_identity_issuer_subject_key").on(table.issuer, table.subject),
  ],
);

export const forgeAccountIntent = factorySchema.table(
  "forge_account_intent",
  {
    userId: uuid("user_id").primaryKey().notNull(),
    username: text("username").notNull(),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    forgeUserId: bigint("forge_user_id", { mode: "number" }),
    state: text("state").$type<"create-intended" | "ready" | "disabled">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "forge_account_intent_user_id_fkey",
    }),
    unique("forge_account_intent_username_key").on(table.username),
    check(
      "forge_account_intent_state_check",
      sql`${table.state} = ANY (ARRAY['create-intended'::text, 'ready'::text, 'disabled'::text])`,
    ),
  ],
);

export const forgeConnection = factorySchema.table(
  "forge_connection",
  {
    id: boolean("id").default(true).primaryKey().notNull(),
    sourceName: text("source_name").notNull(),
    discoveryUrl: text("discovery_url").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    sourceId: bigint("source_id", { mode: "number" }),
    state: text("state").$type<"create-intended" | "ready">().notNull(),
    intendedBy: uuid("intended_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.intendedBy],
      foreignColumns: [authUser.id],
      name: "forge_connection_intended_by_fkey",
    }),
    check("forge_connection_id_check", sql`(${table.id})`),
    check("forge_connection_source_name_check", sql`${table.sourceName} = 'Factory'::text`),
    check(
      "forge_connection_state_check",
      sql`${table.state} = ANY (ARRAY['create-intended'::text, 'ready'::text])`,
    ),
  ],
);

export const forgeIdentityIntent = factorySchema.table(
  "forge_identity_intent",
  {
    clientId: text("client_id").primaryKey().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    intendedBy: uuid("intended_by").notNull(),
    state: text("state").$type<"create-intended" | "ready">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.intendedBy],
      foreignColumns: [authUser.id],
      name: "forge_identity_intent_intended_by_fkey",
    }),
    check(
      "forge_identity_intent_state_check",
      sql`${table.state} = ANY (ARRAY['create-intended'::text, 'ready'::text])`,
    ),
  ],
);

export const identityConfiguration = factorySchema.table(
  "identity_configuration",
  {
    singleton: boolean("singleton").default(true).primaryKey().notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    setupId: uuid("setup_id").notNull(),
    activatedBy: uuid("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.activatedBy],
      foreignColumns: [authUser.id],
      name: "identity_configuration_activated_by_fkey",
    }),
    foreignKey({
      columns: [table.setupId],
      foreignColumns: [identitySetup.id],
      name: "identity_configuration_setup_id_fkey",
    }),
    check("identity_configuration_singleton_check", sql`(${table.singleton})`),
  ],
);

export const identitySetup = factorySchema.table(
  "identity_setup",
  {
    id: uuid("id").primaryKey().notNull(),
    baseVersion: bigint("base_version", { mode: "number" }).notNull(),
    metadata: jsonb("metadata").notNull(),
    fingerprint: text("fingerprint").notNull(),
    secretKey: text("secret_key").notNull(),
    createdBy: uuid("created_by").notNull(),
    state: text("state").$type<"write-intended" | "saved" | "active" | "superseded">().notNull(),
    testedAt: timestamp("tested_at", { withTimezone: true }),
    testedUserId: uuid("tested_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "identity_setup_created_by_fkey",
    }),
    foreignKey({
      columns: [table.testedUserId],
      foreignColumns: [authUser.id],
      name: "identity_setup_tested_user_id_fkey",
    }),
    unique("identity_setup_secret_key_key").on(table.secretKey),
    check("identity_setup_base_version_check", sql`${table.baseVersion} >= 0`),
    check(
      "identity_setup_state_check",
      sql`${table.state} = ANY (ARRAY['write-intended'::text, 'saved'::text, 'active'::text, 'superseded'::text])`,
    ),
  ],
);

export const forgeGrantIntent = factorySchema.table(
  "forge_grant_intent",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    desired: boolean("desired").notNull(),
    confirmed: boolean("confirmed"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "forge_grant_intent_project_id_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "forge_grant_intent_user_id_fkey",
    }),
    primaryKey({ columns: [table.projectId, table.userId], name: "forge_grant_intent_pkey" }),
  ],
);

export const forgeBranchIntent = factorySchema.table(
  "forge_branch_intent",
  {
    projectId: uuid("project_id").notNull(),
    branch: text("branch").notNull(),
    writers: text("writers").array().notNull(),
    merger: text("merger").notNull(),
    confirmed: boolean("confirmed").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "forge_branch_intent_project_id_fkey",
    }),
    primaryKey({ columns: [table.projectId, table.branch], name: "forge_branch_intent_pkey" }),
  ],
);
