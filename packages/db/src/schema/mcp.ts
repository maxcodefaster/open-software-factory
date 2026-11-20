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
import { agentTurn } from "./coding";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const mcpAccessDecision = factorySchema.table(
  "mcp_access_decision",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    credentialEpoch: uuid("credential_epoch").notNull(),
    projectId: uuid("project_id"),
    action: text("action").notNull(),
    decidedBy: uuid("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_access_decision_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.decidedBy],
      foreignColumns: [authUser.id],
      name: "mcp_access_decision_decided_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "mcp_access_decision_project_id_fkey",
    }),
    check(
      "mcp_access_decision_action_check",
      sql`action = ANY (ARRAY['grant'::text, 'revoke'::text, 'disconnect'::text])`,
    ),
  ],
);

export const mcpLibrary = factorySchema.table(
  "mcp_library",
  {
    id: uuid("id").primaryKey().notNull(),
    scope: text("scope").notNull(),
    ownerId: uuid("owner_id"),
    projectId: uuid("project_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [authUser.id],
      name: "mcp_library_owner_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "mcp_library_project_id_fkey",
    }),
    check(
      "mcp_library_check",
      sql`((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL))`,
    ),
    check(
      "mcp_library_scope_check",
      sql`scope = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])`,
    ),
  ],
);

export const mcpObservation = factorySchema.table(
  "mcp_observation",
  {
    id: uuid("id").primaryKey().notNull(),
    turnId: uuid("turn_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolDigest: text("tool_digest").notNull(),
    resultDigest: text("result_digest").notNull(),
    isError: boolean("is_error").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_observation_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "mcp_observation_turn_id_fkey",
    }),
  ],
);

export const mcpPolicyApproval = factorySchema.table(
  "mcp_policy_approval",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    credentialEpoch: uuid("credential_epoch").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    tools: jsonb("tools").notNull(),
    reviewedBy: uuid("reviewed_by").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_policy_approval_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.reviewedBy],
      foreignColumns: [authUser.id],
      name: "mcp_policy_approval_reviewed_by_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "mcp_policy_approval_revision_id_fkey",
    }),
    unique("mcp_policy_approval_connection_id_version_key").on(table.connectionId, table.version),
  ],
);

export const mcpRevision = factorySchema.table(
  "mcp_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    libraryId: uuid("library_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    content: jsonb("content").notNull(),
    digest: text("digest").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "mcp_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [mcpLibrary.id],
      name: "mcp_revision_library_id_fkey",
    }),
    unique("mcp_revision_library_id_revision_key").on(table.libraryId, table.revision),
    check(
      "mcp_revision_content_check",
      sql`(jsonb_typeof(content) = 'object'::text) AND (octet_length((content)::text) < 16000)`,
    ),
    check("mcp_revision_digest_check", sql`digest ~ '^[a-f0-9]{64}$'::text`),
    check("mcp_revision_revision_check", sql`revision > 0`),
  ],
);

export const mcpConnection = factorySchema.table(
  "mcp_connection",
  {
    id: uuid("id").primaryKey().notNull(),
    revisionId: uuid("revision_id").notNull(),
    state: text("state").notNull(),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    secretKey: text("secret_key"),
    credentialEpoch: uuid("credential_epoch").notNull(),
    tools: jsonb("tools").default([]).notNull(),
    allowedTools: jsonb("allowed_tools").default([]).notNull(),
    authorizedBy: uuid("authorized_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.authorizedBy],
      foreignColumns: [authUser.id],
      name: "mcp_connection_authorized_by_fkey",
    }),
    foreignKey({
      columns: [table.id],
      foreignColumns: [mcpLibrary.id],
      name: "mcp_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "mcp_connection_revision_id_fkey",
    }),
    check(
      "mcp_connection_state_check",
      sql`state = ANY (ARRAY['disconnected'::text, 'authorizing'::text, 'review'::text, 'ready'::text, 'reconnect'::text, 'revoked'::text])`,
    ),
    check(
      "mcp_connection_tools_check",
      sql`(jsonb_typeof(tools) = 'array'::text) AND (octet_length((tools)::text) <= 1000000)`,
    ),
  ],
);

export const mcpLibraryCover = factorySchema.table(
  "mcp_library_cover",
  {
    libraryId: uuid("library_id").primaryKey().notNull(),
    coverKey: text("cover_key").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [mcpLibrary.id],
      name: "mcp_library_cover_library_id_fkey",
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [authUser.id],
      name: "mcp_library_cover_updated_by_fkey",
    }),
    check("mcp_library_cover_cover_key_check", sql`cover_key ~ '^[a-z][a-z-]{1,63}$'::text`),
    check("mcp_library_cover_version_check", sql`version > 0`),
  ],
);

export const mcpConnectIntent = factorySchema.table(
  "mcp_connect_intent",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").notNull(),
    authorizationUrl: text("authorization_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("mcp_connect_running")
      .using("btree", table.connectionId.asc().nullsLast())
      .where(sql`(state = 'running'::text)`),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_connect_intent_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "mcp_connect_intent_created_by_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "mcp_connect_intent_revision_id_fkey",
    }),
    check(
      "mcp_connect_intent_state_check",
      sql`state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])`,
    ),
  ],
);

export const mcpOauthFlow = factorySchema.table(
  "mcp_oauth_flow",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    stateDigest: text("state_digest").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_oauth_flow_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "mcp_oauth_flow_created_by_fkey",
    }),
    unique("mcp_oauth_flow_state_digest_key").on(table.stateDigest),
    check(
      "mcp_oauth_flow_state_check",
      sql`state = ANY (ARRAY['pending'::text, 'exchanging'::text, 'completed'::text, 'failed'::text])`,
    ),
  ],
);

export const mcpSecretWrite = factorySchema.table(
  "mcp_secret_write",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    baseKey: text("base_key"),
    credentialEpoch: uuid("credential_epoch").notNull(),
    secretKey: text("secret_key").notNull(),
    digest: text("digest").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("mcp_secret_pending")
      .using("btree", table.connectionId.asc().nullsLast())
      .where(sql`(state = 'intended'::text)`),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_secret_write_connection_id_fkey",
    }),
    unique("mcp_secret_write_secret_key_key").on(table.secretKey),
    check(
      "mcp_secret_write_state_check",
      sql`state = ANY (ARRAY['intended'::text, 'committed'::text, 'superseded'::text])`,
    ),
  ],
);

export const mcpShareProposal = factorySchema.table(
  "mcp_share_proposal",
  {
    id: uuid("id").primaryKey().notNull(),
    revisionId: uuid("revision_id").notNull(),
    proposedBy: uuid("proposed_by").notNull(),
    target: text("target").notNull(),
    projectId: uuid("project_id"),
    acceptedLibraryId: uuid("accepted_library_id"),
    acceptedBy: uuid("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.acceptedBy],
      foreignColumns: [authUser.id],
      name: "mcp_share_proposal_accepted_by_fkey",
    }),
    foreignKey({
      columns: [table.acceptedLibraryId],
      foreignColumns: [mcpLibrary.id],
      name: "mcp_share_proposal_accepted_library_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "mcp_share_proposal_project_id_fkey",
    }),
    foreignKey({
      columns: [table.proposedBy],
      foreignColumns: [authUser.id],
      name: "mcp_share_proposal_proposed_by_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "mcp_share_proposal_revision_id_fkey",
    }),
    check("mcp_share_proposal_check", sql`(target = 'project'::text) = (project_id IS NOT NULL)`),
    check(
      "mcp_share_proposal_target_check",
      sql`target = ANY (ARRAY['project'::text, 'system'::text])`,
    ),
  ],
);

export const mcpTokenRefresh = factorySchema.table(
  "mcp_token_refresh",
  {
    id: uuid("id").primaryKey().notNull(),
    connectionId: uuid("connection_id").notNull(),
    credentialEpoch: uuid("credential_epoch").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("mcp_refresh_pending")
      .using("btree", table.connectionId.asc().nullsLast())
      .where(sql`(state = 'intended'::text)`),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_token_refresh_connection_id_fkey",
    }),
    check(
      "mcp_token_refresh_state_check",
      sql`state = ANY (ARRAY['intended'::text, 'committed'::text, 'uncertain'::text])`,
    ),
  ],
);

export const mcpProjectGrant = factorySchema.table(
  "mcp_project_grant",
  {
    connectionId: uuid("connection_id").notNull(),
    credentialEpoch: uuid("credential_epoch").notNull(),
    projectId: uuid("project_id").notNull(),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "mcp_project_grant_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.grantedBy],
      foreignColumns: [authUser.id],
      name: "mcp_project_grant_granted_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "mcp_project_grant_project_id_fkey",
    }),
    primaryKey({ columns: [table.connectionId, table.projectId], name: "mcp_project_grant_pkey" }),
  ],
);

export const mcpChoice = factorySchema.table(
  "mcp_choice",
  {
    libraryId: uuid("library_id").notNull(),
    scope: text("scope").notNull(),
    contextId: uuid("context_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull(),
    state: text("state").notNull(),
    revisionId: uuid("revision_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.libraryId],
      foreignColumns: [mcpLibrary.id],
      name: "mcp_choice_library_id_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "mcp_choice_revision_id_fkey",
    }),
    primaryKey({
      columns: [table.libraryId, table.scope, table.contextId, table.userId, table.role],
      name: "mcp_choice_pkey",
    }),
    check("mcp_choice_check", sql`(scope <> 'personal'::text) OR (state <> 'required'::text)`),
    check("mcp_choice_role_check", sql`role = ANY (ARRAY['planning'::text, 'build'::text])`),
    check(
      "mcp_choice_scope_check",
      sql`scope = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])`,
    ),
    check(
      "mcp_choice_state_check",
      sql`state = ANY (ARRAY['inherit'::text, 'enable'::text, 'disable'::text, 'required'::text])`,
    ),
    check("mcp_choice_version_check", sql`version > 0`),
  ],
);
