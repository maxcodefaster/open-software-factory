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
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";
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
    WHEN ${table.changeId} IS NULL AND (${table.input} ->> 'contextId'::text) IS NOT NULL THEN 'context:'::text || (${table.input} ->> 'contextId'::text)
    ELSE COALESCE(${table.ticketId}::text, 'draft:'::text || ${table.createdBy}::text)
END) text_ops`,
      )
      .where(
        sql`(${table.state} = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state]))`,
      ),
    index("agent_turn_recovery_idx")
      .using("btree", table.state.asc().nullsLast(), table.ownerExpiresAt.asc().nullsLast())
      .where(
        sql`(${table.state} = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state]))`,
      ),
    uniqueIndex("agent_turn_unresolved_change_boundary_uidx")
      .using("btree", table.projectId.asc().nullsLast(), table.ticketId.asc().nullsLast())
      .where(
        sql`((${table.changeId} IS NOT NULL) AND (${table.state} = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state])))`,
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
      sql`(jsonb_typeof(${table.authority}) = 'object'::text) AND (${table.authority} ? 'mode'::text) AND (octet_length((${table.authority})::text) <= 2000)`,
    ),
    check(
      "agent_turn_check",
      sql`(${table.ownerToken} IS NULL) = (${table.ownerExpiresAt} IS NULL)`,
    ),
    check(
      "agent_turn_check1",
      sql`(((${table.input} ->> 'kind'::text) = ANY (ARRAY['project-message'::text, 'project-answer'::text])) AND (${table.conversationId} IS NOT NULL) AND (${table.changeId} IS NULL) AND ((${table.authority} ->> 'mode'::text) = ANY (ARRAY['investigate'::text, 'plan'::text]))) OR (((${table.input} ->> 'kind'::text) = ANY (ARRAY['change-start'::text, 'change-prompt'::text, 'change-repair'::text, 'change-review'::text])) AND (${table.changeId} IS NOT NULL) AND (${table.ticketId} IS NOT NULL) AND ((${table.authority} ->> 'mode'::text) = 'build'::text))`,
    ),
    check(
      "agent_turn_check2",
      sql`((${table.input} ->> 'kind'::text) <> 'project-answer'::text) OR ((${table.authority} ->> 'mode'::text) = 'plan'::text)`,
    ),
    check(
      "agent_turn_check3",
      sql`(${table.state} <> ALL (ARRAY['dispatching'::agent_turn_state, 'running'::agent_turn_state])) OR (${table.ownerToken} IS NOT NULL)`,
    ),
    check(
      "agent_turn_check4",
      sql`(${table.state} <> ALL (ARRAY['completed'::agent_turn_state, 'failed'::agent_turn_state, 'stopped'::agent_turn_state, 'uncertain'::agent_turn_state])) OR (${table.ownerToken} IS NULL)`,
    ),
    check(
      "agent_turn_input_check",
      sql`(jsonb_typeof(${table.input}) = 'object'::text) AND (${table.input} ? 'kind'::text) AND (octet_length((${table.input})::text) <= 100000)`,
    ),
    check("agent_turn_input_digest_check", sql`${table.inputDigest} ~ '^[a-f0-9]{64}$'::text`),
    check("agent_turn_outcome_summary_check", sql`length(${table.outcomeSummary}) <= 2000`),
    check(
      "agent_turn_review_authority",
      sql`((${table.input} ->> 'kind'::text) = 'change-review'::text) = (${table.authority} ? 'review'::text)`,
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
    state: text("state")
      .$type<"intended" | "active" | "closing" | "closed">()
      .default("intended")
      .notNull(),
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
      .where(sql`(${table.state} <> 'closed'::text)`),
    index("build_browser_session_cleanup_idx")
      .using("btree", table.runtimeAttemptId.asc().nullsLast())
      .where(sql`(${table.state} <> 'closed'::text)`),
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
      sql`(${table.agentSessionId} ~~ 'ses%'::text) AND (length(${table.agentSessionId}) <= 200)`,
    ),
    check(
      "build_browser_session_check",
      sql`(${table.inspectionContext} IS NULL) OR (((jsonb_typeof(${table.inspectionContext}) = 'object'::text) AND (octet_length((${table.inspectionContext})::text) <= 2048) AND ((${table.inspectionContext} ->> 'sessionId'::text) = (${table.id})::text) AND ((${table.inspectionContext} ->> 'turnId'::text) = (${table.turnId})::text) AND ((${table.inspectionContext} ->> 'changeId'::text) = (${table.changeId})::text) AND ((${table.inspectionContext} ->> 'runtimeAttemptId'::text) = (${table.runtimeAttemptId})::text) AND (((${table.inspectionContext} ->> 'generation'::text))::bigint = ${table.generation}) AND ((${table.inspectionContext} ->> 'headCommit'::text) ~ '^[a-f0-9]{40}$'::text) AND ((${table.inspectionContext} ->> 'app'::text) ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (jsonb_typeof((${table.inspectionContext} -> 'workingTreeModified'::text)) = 'boolean'::text)) IS TRUE)`,
    ),
    check(
      "build_browser_session_check1",
      sql`(${table.state} <> 'active'::text) OR (${table.createConfirmedAt} IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check2",
      sql`(${table.state} <> 'active'::text) OR (${table.inspectionContext} IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check3",
      sql`(${table.state} = ANY (ARRAY['closing'::text, 'closed'::text])) = (${table.cleanupIntendedAt} IS NOT NULL)`,
    ),
    check(
      "build_browser_session_check4",
      sql`(${table.state} = 'closed'::text) = (${table.cleanupConfirmedAt} IS NOT NULL)`,
    ),
    check("build_browser_session_generation_check", sql`${table.generation} > 0`),
    check("build_browser_session_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "build_browser_session_outcome_summary_check",
      sql`octet_length(${table.outcomeSummary}) <= 512`,
    ),
    check("build_browser_session_owner_id_check", sql`${table.ownerId} ~ '^[a-f0-9]{64}$'::text`),
    check(
      "build_browser_session_state_check",
      sql`${table.state} = ANY (ARRAY['intended'::text, 'active'::text, 'closing'::text, 'closed'::text])`,
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
    check("change_agent_turn_intent_model_epoch_check", sql`${table.modelRequestEpoch} >= 0`),
    check(
      "change_agent_turn_intent_terminal_check",
      sql`(${table.terminalOutcome} IS NULL) OR ((jsonb_typeof(${table.terminalOutcome}) = 'object'::text) AND (octet_length((${table.terminalOutcome})::text) <= 8192) AND (${table.terminalOutcome} ?& ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) AND ((${table.terminalOutcome} - ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) = '{}'::jsonb) AND ((${table.terminalOutcome} ->> 'version'::text) = '1'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'version'::text)) = 'number'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'turnID'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'attemptID'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'sessionID'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'promptID'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'promptDigest'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'assistantID'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'assistantDigest'::text)) = 'string'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'modelRequestEpoch'::text)) = 'string'::text) AND ((${table.terminalOutcome} ->> 'turnID'::text) = (${table.turnId})::text) AND (${table.runtimeAttemptId} IS NOT NULL) AND ((${table.terminalOutcome} ->> 'attemptID'::text) = (${table.runtimeAttemptId})::text) AND ((${table.terminalOutcome} ->> 'sessionID'::text) = ${table.sessionId}) AND ((${table.terminalOutcome} ->> 'promptID'::text) = ${table.promptId}) AND ((${table.terminalOutcome} ->> 'modelRequestEpoch'::text) = (${table.modelRequestEpoch})::text) AND ((${table.terminalOutcome} ->> 'promptDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND ((${table.terminalOutcome} ->> 'assistantDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND ((${table.terminalOutcome} ->> 'assistantID'::text) ~~ 'msg_%'::text) AND (length((${table.terminalOutcome} ->> 'assistantID'::text)) <= 200) AND (jsonb_typeof((${table.terminalOutcome} -> 'completed'::text)) = 'number'::text) AND ((((${table.terminalOutcome} ->> 'completed'::text))::numeric >= (1)::numeric) AND (((${table.terminalOutcome} ->> 'completed'::text))::numeric <= ('9007199254740991'::bigint)::numeric)) AND (jsonb_typeof((${table.terminalOutcome} -> 'shells'::text)) = 'array'::text) AND (jsonb_typeof((${table.terminalOutcome} -> 'outcome'::text)) = 'object'::text) AND (jsonb_typeof(((${table.terminalOutcome} -> 'outcome'::text) -> 'state'::text)) = 'string'::text) AND ((${table.terminalOutcome} -> 'outcome'::text) ? 'state'::text) AND (((${table.terminalOutcome} -> 'outcome'::text) - ARRAY['state'::text, 'summary'::text, 'error'::text]) = '{}'::jsonb) AND (((((${table.terminalOutcome} -> 'outcome'::text) ->> 'state'::text) = 'succeeded'::text) AND (NOT ((${table.terminalOutcome} -> 'outcome'::text) ? 'error'::text)) AND ((NOT ((${table.terminalOutcome} -> 'outcome'::text) ? 'summary'::text)) OR ((jsonb_typeof(((${table.terminalOutcome} -> 'outcome'::text) -> 'summary'::text)) = 'string'::text) AND (length(((${table.terminalOutcome} -> 'outcome'::text) ->> 'summary'::text)) <= 2000)))) OR ((((${table.terminalOutcome} -> 'outcome'::text) ->> 'state'::text) = 'failed'::text) AND ((${table.terminalOutcome} -> 'outcome'::text) ? 'error'::text) AND (NOT ((${table.terminalOutcome} -> 'outcome'::text) ? 'summary'::text)) AND (jsonb_typeof(((${table.terminalOutcome} -> 'outcome'::text) -> 'error'::text)) = 'string'::text) AND (length(((${table.terminalOutcome} -> 'outcome'::text) ->> 'error'::text)) <= 2000))))`,
    ),
    check(
      "change_agent_turn_intent_prompt_id_check",
      sql`(${table.promptId} ~~ 'msg_%'::text) AND (length(${table.promptId}) <= 200)`,
    ),
    check(
      "change_agent_turn_intent_prompt_text_check",
      sql`(length(btrim(${table.promptText})) > 0) AND (octet_length(${table.promptText}) <= 4000000)`,
    ),
    check(
      "change_agent_turn_intent_session_id_check",
      sql`(${table.sessionId} ~~ 'ses%'::text) AND (length(${table.sessionId}) <= 200)`,
    ),
    check(
      "change_agent_turn_intent_session_title_check",
      sql`(length(${table.sessionTitle}) >= 1) AND (length(${table.sessionTitle}) <= 200)`,
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
      .where(sql`(${table.opencodeSessionId} IS NOT NULL)`),
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
      columns: [table.runtimeAttemptId, table.changeId],
      foreignColumns: [runtimeAttempt.id, runtimeAttempt.changeId],
      name: "change_agent_session_runtime_change_fk",
    }),
    check(
      "change_agent_implementation_confirmation",
      sql`(${table.implementationSessionConfirmedAt} IS NULL) OR (${table.implementationSessionId} IS NOT NULL)`,
    ),
    check(
      "change_agent_native_session_confirmation",
      sql`(${table.nativeSessionConfirmedAt} IS NULL) OR (${table.opencodeSessionId} IS NOT NULL)`,
    ),
    check(
      "change_agent_session_active_inbox_id_check",
      sql`length(COALESCE(${table.activeInboxId}, ''::text)) <= 200`,
    ),
    check(
      "change_agent_session_check",
      sql`(${table.state} <> 'starting'::change_agent_state) OR (${table.opencodeSessionId} IS NULL) OR (length(${table.opencodeSessionId}) > 0)`,
    ),
    check(
      "change_agent_session_opencode_session_id_check",
      sql`length(COALESCE(${table.opencodeSessionId}, ''::text)) <= 200`,
    ),
    check(
      "change_agent_stop_dispatch_state",
      sql`(NOT ${table.stopDispatched}) OR ${table.stopPending}`,
    ),
    check(
      "change_agent_stop_pending_state",
      sql`(NOT ${table.stopPending}) OR (${table.state} = 'stopped'::change_agent_state)`,
    ),
  ],
);
