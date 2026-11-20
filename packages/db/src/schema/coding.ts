import { sql } from "drizzle-orm";
import {
  bigint,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { ticketConversation } from "./conversations";
import { change } from "./delivery";
import { agentTurnState, changeAgentState } from "./enums";
import { mcpConnection, mcpRevision } from "./mcp";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";
import { skillRevision } from "./skills";
import { ticket } from "./tickets";

export const agentTurn = factorySchema.table(
  "agent_turn",
  {
    id: uuid("id").primaryKey().notNull(),
    commandId: uuid("command_id").notNull(),
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id"),
    conversationId: uuid("conversation_id"),
    changeId: uuid("change_id"),
    createdBy: uuid("created_by").notNull(),
    input: jsonb("input").notNull(),
    inputDigest: text("input_digest").notNull(),
    authority: jsonb("authority").notNull(),
    state: agentTurnState("state").default("pending").notNull(),
    ownerToken: uuid("owner_token"),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }),
    outcomeSummary: text("outcome_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("agent_turn_active_boundary_uidx")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        sql`(
CASE
    WHEN change_id IS NULL AND (input ->> 'contextId'::text) IS NOT NULL THEN 'context:'::text || (input ->> 'contextId'::text)
    ELSE COALESCE(ticket_id::text, 'draft:'::text || created_by::text)
END) text_ops`,
      )
      .where(
        sql`(state = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state]))`,
      ),
    index("agent_turn_recovery_idx")
      .using("btree", table.state.asc().nullsLast(), table.ownerExpiresAt.asc().nullsLast())
      .where(
        sql`(state = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state]))`,
      ),
    uniqueIndex("agent_turn_unresolved_change_boundary_uidx")
      .using("btree", table.projectId.asc().nullsLast(), table.ticketId.asc().nullsLast())
      .where(
        sql`((change_id IS NOT NULL) AND (state = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state])))`,
      ),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "agent_turn_change_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.conversationId],
      foreignColumns: [ticketConversation.id],
      name: "agent_turn_conversation_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "agent_turn_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "agent_turn_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "agent_turn_ticket_id_fkey",
    }).onDelete("cascade"),
    unique("agent_turn_command_id_key").on(table.commandId),
    check(
      "agent_turn_authority_check",
      sql`(jsonb_typeof(authority) = 'object'::text) AND (authority ? 'mode'::text) AND (octet_length((authority)::text) <= 2000)`,
    ),
    check("agent_turn_check", sql`(owner_token IS NULL) = (owner_expires_at IS NULL)`),
    check(
      "agent_turn_check1",
      sql`(((input ->> 'kind'::text) = ANY (ARRAY['project-message'::text, 'project-answer'::text])) AND (conversation_id IS NOT NULL) AND (change_id IS NULL) AND ((authority ->> 'mode'::text) = ANY (ARRAY['investigate'::text, 'plan'::text]))) OR (((input ->> 'kind'::text) = ANY (ARRAY['change-start'::text, 'change-prompt'::text, 'change-repair'::text, 'change-review'::text])) AND (change_id IS NOT NULL) AND (ticket_id IS NOT NULL) AND ((authority ->> 'mode'::text) = 'build'::text))`,
    ),
    check(
      "agent_turn_check2",
      sql`((input ->> 'kind'::text) <> 'project-answer'::text) OR ((authority ->> 'mode'::text) = 'plan'::text)`,
    ),
    check(
      "agent_turn_check3",
      sql`(state <> ALL (ARRAY['dispatching'::agent_turn_state, 'running'::agent_turn_state])) OR (owner_token IS NOT NULL)`,
    ),
    check(
      "agent_turn_check4",
      sql`(state <> ALL (ARRAY['completed'::agent_turn_state, 'failed'::agent_turn_state, 'stopped'::agent_turn_state, 'uncertain'::agent_turn_state])) OR (owner_token IS NULL)`,
    ),
    check(
      "agent_turn_input_check",
      sql`(jsonb_typeof(input) = 'object'::text) AND (input ? 'kind'::text) AND (octet_length((input)::text) <= 100000)`,
    ),
    check("agent_turn_input_digest_check", sql`input_digest ~ '^[a-f0-9]{64}$'::text`),
    check("agent_turn_outcome_summary_check", sql`length(outcome_summary) <= 2000`),
    check(
      "agent_turn_review_authority",
      sql`((input ->> 'kind'::text) = 'change-review'::text) = (authority ? 'review'::text)`,
    ),
  ],
);

export const buildBrowserSession = factorySchema.table(
  "build_browser_session",
  {
    id: uuid("id").primaryKey().notNull(),
    turnId: uuid("turn_id").notNull(),
    changeId: uuid("change_id").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    ownerId: text("owner_id").notNull(),
    state: text("state").default("intended").notNull(),
    createIntendedAt: timestamp("create_intended_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createConfirmedAt: timestamp("create_confirmed_at", { withTimezone: true }),
    cleanupIntendedAt: timestamp("cleanup_intended_at", { withTimezone: true }),
    cleanupConfirmedAt: timestamp("cleanup_confirmed_at", { withTimezone: true }),
    outcomeSummary: text("outcome_summary"),
    inspectionContext: jsonb("inspection_context"),
    ordinal: integer("ordinal").default(1).notNull(),
    reopenAllowed: boolean("reopen_allowed").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("build_browser_one_unclosed_session")
      .using("btree", table.turnId.asc().nullsLast(), table.ownerId.asc().nullsLast())
      .where(sql`(state <> 'closed'::text)`),
    index("build_browser_session_cleanup_idx")
      .using("btree", table.runtimeAttemptId.asc().nullsLast())
      .where(sql`(state <> 'closed'::text)`),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "build_browser_session_change_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.changeId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "build_browser_session_runtime_attempt_id_change_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "build_browser_session_turn_id_fkey",
    }).onDelete("cascade"),
    unique("build_browser_session_owner_ordinal_key").on(
      table.turnId,
      table.ownerId,
      table.ordinal,
    ),
    check(
      "build_browser_session_agent_session_id_check",
      sql`(agent_session_id ~~ 'ses%'::text) AND (length(agent_session_id) <= 200)`,
    ),
    check(
      "build_browser_session_check",
      sql`(inspection_context IS NULL) OR (((jsonb_typeof(inspection_context) = 'object'::text) AND (octet_length((inspection_context)::text) <= 2048) AND ((inspection_context ->> 'sessionId'::text) = (id)::text) AND ((inspection_context ->> 'turnId'::text) = (turn_id)::text) AND ((inspection_context ->> 'changeId'::text) = (change_id)::text) AND ((inspection_context ->> 'runtimeAttemptId'::text) = (runtime_attempt_id)::text) AND (((inspection_context ->> 'generation'::text))::bigint = generation) AND ((inspection_context ->> 'headCommit'::text) ~ '^[a-f0-9]{40}$'::text) AND ((inspection_context ->> 'app'::text) ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (jsonb_typeof((inspection_context -> 'workingTreeModified'::text)) = 'boolean'::text)) IS TRUE)`,
    ),
    check(
      "build_browser_session_check1",
      sql`(state <> 'active'::text) OR (create_confirmed_at IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check2",
      sql`(state <> 'active'::text) OR (inspection_context IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check3",
      sql`(state = ANY (ARRAY['closing'::text, 'closed'::text])) = (cleanup_intended_at IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check4",
      sql`(state = 'closed'::text) = (cleanup_confirmed_at IS NOT NULL)`,
    ),
    check("build_browser_session_generation_check", sql`generation > 0`),
    check("build_browser_session_ordinal_check", sql`ordinal > 0`),
    check("build_browser_session_outcome_summary_check", sql`octet_length(outcome_summary) <= 512`),
    check("build_browser_session_owner_id_check", sql`owner_id ~ '^[a-f0-9]{64}$'::text`),
    check(
      "build_browser_session_state_check",
      sql`state = ANY (ARRAY['intended'::text, 'active'::text, 'closing'::text, 'closed'::text])`,
    ),
  ],
);

export const changeAgentTurnIntent = factorySchema.table(
  "change_agent_turn_intent",
  {
    turnId: uuid("turn_id").primaryKey().notNull(),
    changeId: uuid("change_id").notNull(),
    sessionId: text("session_id").notNull(),
    promptId: text("prompt_id").notNull(),
    promptText: text("prompt_text").notNull(),
    bootstrap: boolean("bootstrap").notNull(),
    sessionTitle: text("session_title").notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    skillLoading: text("skill_loading").default("eager").notNull(),
    skillManifest: jsonb("skill_manifest"),
    skillAttachments: jsonb("skill_attachments").default([]).notNull(),
    modelRequestEpoch: bigint("model_request_epoch", { mode: "number" }).default(0).notNull(),
    terminalOutcome: jsonb("terminal_outcome"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_agent_turn_intent_change_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.changeId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "change_agent_turn_intent_runtime_attempt_id_change_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "change_agent_turn_intent_turn_id_fkey",
    }).onDelete("cascade"),
    unique("change_agent_turn_intent_prompt_id_key").on(table.promptId),
    check("change_agent_turn_intent_model_epoch_check", sql`model_request_epoch >= 0`),
    check(
      "change_agent_turn_intent_terminal_check",
      sql`(terminal_outcome IS NULL) OR ((jsonb_typeof(terminal_outcome) = 'object'::text) AND (octet_length((terminal_outcome)::text) <= 8192) AND (terminal_outcome ?& ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) AND ((terminal_outcome - ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) = '{}'::jsonb) AND ((terminal_outcome ->> 'version'::text) = '1'::text) AND (jsonb_typeof((terminal_outcome -> 'version'::text)) = 'number'::text) AND (jsonb_typeof((terminal_outcome -> 'turnID'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'attemptID'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'sessionID'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'promptID'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'promptDigest'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'assistantID'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'assistantDigest'::text)) = 'string'::text) AND (jsonb_typeof((terminal_outcome -> 'modelRequestEpoch'::text)) = 'string'::text) AND ((terminal_outcome ->> 'turnID'::text) = (turn_id)::text) AND (runtime_attempt_id IS NOT NULL) AND ((terminal_outcome ->> 'attemptID'::text) = (runtime_attempt_id)::text) AND ((terminal_outcome ->> 'sessionID'::text) = session_id) AND ((terminal_outcome ->> 'promptID'::text) = prompt_id) AND ((terminal_outcome ->> 'modelRequestEpoch'::text) = (model_request_epoch)::text) AND ((terminal_outcome ->> 'promptDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND ((terminal_outcome ->> 'assistantDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND ((terminal_outcome ->> 'assistantID'::text) ~~ 'msg_%'::text) AND (length((terminal_outcome ->> 'assistantID'::text)) <= 200) AND (jsonb_typeof((terminal_outcome -> 'completed'::text)) = 'number'::text) AND ((((terminal_outcome ->> 'completed'::text))::numeric >= (1)::numeric) AND (((terminal_outcome ->> 'completed'::text))::numeric <= ('9007199254740991'::bigint)::numeric)) AND (jsonb_typeof((terminal_outcome -> 'shells'::text)) = 'array'::text) AND (jsonb_typeof((terminal_outcome -> 'outcome'::text)) = 'object'::text) AND (jsonb_typeof(((terminal_outcome -> 'outcome'::text) -> 'state'::text)) = 'string'::text) AND ((terminal_outcome -> 'outcome'::text) ? 'state'::text) AND (((terminal_outcome -> 'outcome'::text) - ARRAY['state'::text, 'summary'::text, 'error'::text]) = '{}'::jsonb) AND (((((terminal_outcome -> 'outcome'::text) ->> 'state'::text) = 'succeeded'::text) AND (NOT ((terminal_outcome -> 'outcome'::text) ? 'error'::text)) AND ((NOT ((terminal_outcome -> 'outcome'::text) ? 'summary'::text)) OR ((jsonb_typeof(((terminal_outcome -> 'outcome'::text) -> 'summary'::text)) = 'string'::text) AND (length(((terminal_outcome -> 'outcome'::text) ->> 'summary'::text)) <= 2000)))) OR ((((terminal_outcome -> 'outcome'::text) ->> 'state'::text) = 'failed'::text) AND ((terminal_outcome -> 'outcome'::text) ? 'error'::text) AND (NOT ((terminal_outcome -> 'outcome'::text) ? 'summary'::text)) AND (jsonb_typeof(((terminal_outcome -> 'outcome'::text) -> 'error'::text)) = 'string'::text) AND (length(((terminal_outcome -> 'outcome'::text) ->> 'error'::text)) <= 2000))))`,
    ),
    check(
      "change_agent_turn_intent_prompt_id_check",
      sql`(prompt_id ~~ 'msg_%'::text) AND (length(prompt_id) <= 200)`,
    ),
    check(
      "change_agent_turn_intent_prompt_text_check",
      sql`(length(btrim(prompt_text)) > 0) AND (octet_length(prompt_text) <= 4000000)`,
    ),
    check(
      "change_agent_turn_intent_session_id_check",
      sql`(session_id ~~ 'ses%'::text) AND (length(session_id) <= 200)`,
    ),
    check(
      "change_agent_turn_intent_session_title_check",
      sql`(length(session_title) >= 1) AND (length(session_title) <= 200)`,
    ),
    check(
      "change_agent_turn_intent_skill_loading_check",
      sql`skill_loading = ANY (ARRAY['eager'::text, 'native'::text])`,
    ),
  ],
);

export const changeAgentSession = factorySchema.table(
  "change_agent_session",
  {
    changeId: uuid("change_id").primaryKey().notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    opencodeSessionId: text("opencode_session_id"),
    state: changeAgentState("state").notNull(),
    activeInboxId: text("active_inbox_id"),
    lastError: text("last_error"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    activeTurnId: uuid("active_turn_id"),
    stopPending: boolean("stop_pending").default(false).notNull(),
    stopDispatched: boolean("stop_dispatched").default(false).notNull(),
    stopId: uuid("stop_id"),
    stopTurnId: uuid("stop_turn_id"),
    nativeSessionConfirmedAt: timestamp("native_session_confirmed_at", { withTimezone: true }),
    implementationSessionId: text("implementation_session_id"),
    implementationSessionConfirmedAt: timestamp("implementation_session_confirmed_at", {
      withTimezone: true,
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("change_agent_opencode_session_uidx")
      .using("btree", table.opencodeSessionId.asc().nullsLast())
      .where(sql`(opencode_session_id IS NOT NULL)`),
    foreignKey({
      columns: [table.activeTurnId],
      foreignColumns: [agentTurn.id],
      name: "change_agent_session_active_turn_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "change_agent_session_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "change_agent_session_created_by_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "change_agent_session_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId, table.changeId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "change_agent_session_runtime_change_fk",
    }),
    check(
      "change_agent_implementation_confirmation",
      sql`(implementation_session_confirmed_at IS NULL) OR (implementation_session_id IS NOT NULL)`,
    ),
    check(
      "change_agent_native_session_confirmation",
      sql`(native_session_confirmed_at IS NULL) OR (opencode_session_id IS NOT NULL)`,
    ),
    check(
      "change_agent_session_active_inbox_id_check",
      sql`length(COALESCE(active_inbox_id, ''::text)) <= 200`,
    ),
    check(
      "change_agent_session_check",
      sql`(state <> 'starting'::change_agent_state) OR (opencode_session_id IS NULL) OR (length(opencode_session_id) > 0)`,
    ),
    check(
      "change_agent_session_opencode_session_id_check",
      sql`length(COALESCE(opencode_session_id, ''::text)) <= 200`,
    ),
    check("change_agent_stop_dispatch_state", sql`(NOT stop_dispatched) OR stop_pending`),
    check(
      "change_agent_stop_pending_state",
      sql`(NOT stop_pending) OR (state = 'stopped'::change_agent_state)`,
    ),
  ],
);

export const sessionArchive = factorySchema.table(
  "session_archive",
  {
    turnId: uuid("turn_id").primaryKey().notNull(),
    runtimeAttemptId: uuid("runtime_attempt_id").notNull(),
    sessionId: text("session_id").notNull(),
    promptId: text("prompt_id").notNull(),
    sourceRefs: jsonb("source_refs").notNull(),
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    manifestKey: text("manifest_key"),
    manifestSha256: text("manifest_sha256"),
    throughMessageId: text("through_message_id"),
    producerVersion: text("producer_version"),
    summary: jsonb("summary"),
    lastError: text("last_error"),
    retryAfter: timestamp("retry_after", { withTimezone: true }).defaultNow().notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("session_archive_pending")
      .using("btree", table.retryAfter.asc().nullsLast())
      .where(sql`(state <> 'saved'::text)`),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "session_archive_runtime_attempt_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "session_archive_turn_id_fkey",
    }),
    check("session_archive_attempts_check", sql`attempts >= 0`),
    check("session_archive_check", sql`(state = 'saved'::text) = (saved_at IS NOT NULL)`),
    check(
      "session_archive_check1",
      sql`(state <> 'saved'::text) OR ((manifest_key IS NOT NULL) AND (manifest_sha256 IS NOT NULL) AND (through_message_id IS NOT NULL) AND (producer_version IS NOT NULL) AND (summary IS NOT NULL))`,
    ),
    check("session_archive_last_error_check", sql`length(last_error) <= 2000`),
    check("session_archive_manifest_sha256_check", sql`manifest_sha256 ~ '^[a-f0-9]{64}$'::text`),
    check(
      "session_archive_prompt_id_check",
      sql`(length(prompt_id) >= 1) AND (length(prompt_id) <= 200)`,
    ),
    check(
      "session_archive_session_id_check",
      sql`(length(session_id) >= 1) AND (length(session_id) <= 200)`,
    ),
    check(
      "session_archive_source_refs_check",
      sql`(jsonb_typeof(source_refs) = 'object'::text) AND (octet_length((source_refs)::text) <= 16384)`,
    ),
    check(
      "session_archive_state_check",
      sql`state = ANY (ARRAY['pending'::text, 'failed'::text, 'saved'::text])`,
    ),
    check(
      "session_archive_summary_check",
      sql`(jsonb_typeof(summary) = 'object'::text) AND (octet_length((summary)::text) <= 16384)`,
    ),
  ],
);

export const agentTurnSkill = factorySchema.table(
  "agent_turn_skill",
  {
    turnId: uuid("turn_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [skillRevision.id],
      name: "agent_turn_skill_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "agent_turn_skill_turn_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.turnId, table.revisionId], name: "agent_turn_skill_pkey" }),
  ],
);

export const agentTurnMcp = factorySchema.table(
  "agent_turn_mcp",
  {
    turnId: uuid("turn_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    credentialEpoch: uuid("credential_epoch").notNull(),
    revisionId: uuid("revision_id").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    tools: jsonb("tools").notNull(),
    required: boolean("required").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "agent_turn_mcp_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.revisionId],
      foreignColumns: [mcpRevision.id],
      name: "agent_turn_mcp_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "agent_turn_mcp_turn_id_fkey",
    }),
    primaryKey({ columns: [table.turnId, table.connectionId], name: "agent_turn_mcp_pkey" }),
  ],
);
