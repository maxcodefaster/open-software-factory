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
import { mcpConnection } from "./mcp";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { ticket } from "./tickets";

export const monitoringCommand = factorySchema.table(
  "monitoring_command",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    hookId: uuid("hook_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    inputDigest: text("input_digest").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "monitoring_command_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.hookId],
      foreignColumns: [monitoringHook.id],
      name: "monitoring_command_hook_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "monitoring_command_project_id_fkey",
    }),
    check(
      "monitoring_command_action_check",
      sql`action = ANY (ARRAY['save'::text, 'disable'::text, 'rotate'::text])`,
    ),
  ],
);

export const monitoringEvidence = factorySchema.table(
  "monitoring_evidence",
  {
    id: uuid("id").primaryKey().notNull(),
    incidentId: uuid("incident_id").notNull(),
    kind: text("kind").notNull(),
    digest: text("digest").notNull(),
    path: text("path"),
    commitSha: text("commit_sha"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [monitoringIncident.id],
      name: "monitoring_evidence_incident_id_fkey",
    }),
    check("monitoring_evidence_digest_check", sql`digest ~ '^[a-f0-9]{64}$'::text`),
  ],
);

export const monitoringPolicy = factorySchema.table(
  "monitoring_policy",
  {
    id: uuid("id").primaryKey().notNull(),
    hookId: uuid("hook_id").notNull(),
    connectionId: uuid("connection_id"),
    assignment: jsonb("assignment"),
    delegatedBy: uuid("delegated_by").notNull(),
    delegatedAt: timestamp("delegated_at", { withTimezone: true }).defaultNow().notNull(),
    delegation: text("delegation").notNull(),
    instructions: text("instructions"),
    sourceIds: uuid("source_ids").array().default([]).notNull(),
    sourceAssignments: jsonb("source_assignments"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [mcpConnection.id],
      name: "monitoring_policy_connection_id_fkey",
    }),
    foreignKey({
      columns: [table.delegatedBy],
      foreignColumns: [authUser.id],
      name: "monitoring_policy_delegated_by_fkey",
    }),
    foreignKey({
      columns: [table.hookId],
      foreignColumns: [monitoringHook.id],
      name: "monitoring_policy_hook_id_fkey",
    }),
    check(
      "monitoring_policy_delegation_check",
      sql`delegation = ANY (ARRAY['prepare-ticket'::text, 'application-fix-and-delivery'::text])`,
    ),
    check(
      "monitoring_policy_instructions_check",
      sql`(length(instructions) >= 1) AND (length(instructions) <= 6000)`,
    ),
  ],
);

export const monitoringHook = factorySchema.table(
  "monitoring_hook",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    enabled: boolean("enabled").notNull(),
    secretDigest: text("secret_digest").notNull(),
    policyId: uuid("policy_id").notNull(),
    receivedWindow: timestamp("received_window", { withTimezone: true }).defaultNow().notNull(),
    receivedCount: integer("received_count").default(0).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.policyId],
      foreignColumns: [monitoringPolicy.id],
      name: "monitoring_current_policy",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "monitoring_hook_project_id_fkey",
    }),
    check("monitoring_hook_name_check", sql`(length(name) >= 1) AND (length(name) <= 100)`),
    check("monitoring_hook_secret_digest_check", sql`secret_digest ~ '^[a-f0-9]{64}$'::text`),
    check("monitoring_hook_version_check", sql`version > 0`),
  ],
);

export const monitoringIncident = factorySchema.table(
  "monitoring_incident",
  {
    id: uuid("id").primaryKey().notNull(),
    hookId: uuid("hook_id").notNull(),
    projectId: uuid("project_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    hookVersion: bigint("hook_version", { mode: "number" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    title: text("title").notNull(),
    reference: text("reference"),
    context: text("context").notNull(),
    occurrences: bigint("occurrences", { mode: "number" }).default(1).notNull(),
    state: text("state").default("queued").notNull(),
    reason: text("reason"),
    diagnosis: jsonb("diagnosis"),
    modelId: text("model_id"),
    modelConnection: jsonb("model_connection"),
    ownerToken: uuid("owner_token"),
    ownerExpiresAt: timestamp("owner_expires_at", { withTimezone: true }),
    ticketId: uuid("ticket_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    skillAssignment: jsonb("skill_assignment"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("monitoring_pending")
      .using(
        "btree",
        table.projectId.asc().nullsLast(),
        table.receivedAt.asc().nullsLast(),
        table.id.asc().nullsLast(),
      )
      .where(sql`(state = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'implementing'::text]))`),
    uniqueIndex("monitoring_ticket")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(sql`(ticket_id IS NOT NULL)`),
    foreignKey({
      columns: [table.hookId],
      foreignColumns: [monitoringHook.id],
      name: "monitoring_incident_hook_id_fkey",
    }),
    foreignKey({
      columns: [table.policyId],
      foreignColumns: [monitoringPolicy.id],
      name: "monitoring_incident_policy_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "monitoring_incident_project_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "monitoring_incident_ticket_id_fkey",
    }),
    unique("monitoring_incident_hook_id_fingerprint_key").on(table.hookId, table.fingerprint),
    check("monitoring_incident_context_check", sql`octet_length(context) <= 64000`),
    check("monitoring_incident_fingerprint_check", sql`fingerprint ~ '^[a-f0-9]{64}$'::text`),
    check("monitoring_incident_occurrences_check", sql`occurrences > 0`),
    check("monitoring_incident_payload_digest_check", sql`payload_digest ~ '^[a-f0-9]{64}$'::text`),
    check(
      "monitoring_incident_state_check",
      sql`state = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'insufficient-context'::text, 'not-application-defect'::text, 'prepared'::text, 'implementing'::text, 'delivered'::text, 'blocked'::text, 'uncertain'::text])`,
    ),
  ],
);
