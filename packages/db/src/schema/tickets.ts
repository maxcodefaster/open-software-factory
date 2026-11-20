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
import { agentTurn } from "./coding";
import { conversationEntry } from "./conversations";
import { change } from "./delivery";
import { ticketState } from "./enums";
import { monitoringIncident, monitoringPolicy } from "./monitoring";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const epicConfirmation = factorySchema.table(
  "epic_confirmation",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    proposalEntryId: uuid("proposal_entry_id").notNull(),
    epicId: uuid("epic_id").notNull(),
    originTicketId: uuid("origin_ticket_id"),
    inputDigest: text("input_digest").notNull(),
    decision: jsonb("decision").notNull(),
    members: jsonb("members").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "epic_confirmation_created_by_fkey",
    }),
    foreignKey({
      columns: [table.epicId],
      foreignColumns: [epic.id],
      name: "epic_confirmation_epic_id_fkey",
    }),
    foreignKey({
      columns: [table.originTicketId],
      foreignColumns: [ticket.id],
      name: "epic_confirmation_origin_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "epic_confirmation_project_id_fkey",
    }),
    foreignKey({
      columns: [table.proposalEntryId],
      foreignColumns: [conversationEntry.id],
      name: "epic_confirmation_proposal_entry_id_fkey",
    }),
    unique("epic_confirmation_proposal_entry_id_key").on(table.proposalEntryId),
    check("epic_confirmation_input_digest_check", sql`input_digest ~ '^[0-9a-f]{64}$'::text`),
  ],
);

export const epic = factorySchema.table(
  "epic",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("epic_project_parent_idx").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.parentId.asc().nullsLast(),
    ),
    index("epic_research_idx").using("gin", sql`research_vector(title, description) tsvector_ops`),
    index("epic_title_trgm_idx").using("gin", sql`lower(title) gin_trgm_ops`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "epic_created_by_fkey",
    }),
    foreignKey({
      columns: [table.parentId, table.projectId],
      foreignColumns: [epic.id, epic.projectId],
      name: "epic_parent_id_project_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "epic_project_id_fkey",
    }).onDelete("cascade"),
    unique("epic_id_project_id_key").on(table.id, table.projectId),
    check("epic_check", sql`parent_id IS DISTINCT FROM id`),
    check("epic_description_check", sql`length(description) <= 10000`),
    check("epic_title_check", sql`(length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)`),
    check("epic_version_check", sql`version > 0`),
  ],
);

export const implementationOrder = factorySchema.table(
  "implementation_order",
  {
    commandId: uuid("command_id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    requirementRevisionId: uuid("requirement_revision_id").notNull(),
    technicalDesignRevisionId: uuid("technical_design_revision_id"),
    codingReasoning: text("coding_reasoning"),
    sourceSha: text("source_sha").notNull(),
    state: text("state").default("waiting").notNull(),
    changeId: uuid("change_id"),
    cancelledBy: uuid("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("implementation_order_one_waiting")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(sql`(state = 'waiting'::text)`),
    foreignKey({
      columns: [table.cancelledBy],
      foreignColumns: [authUser.id],
      name: "implementation_order_cancelled_by_fkey",
    }),
    foreignKey({
      columns: [table.changeId],
      foreignColumns: [change.id],
      name: "implementation_order_change_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "implementation_order_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "implementation_order_project_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementRevisionId],
      foreignColumns: [requirementRevision.id],
      name: "implementation_order_requirement_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.technicalDesignRevisionId],
      foreignColumns: [technicalDesignRevision.id],
      name: "implementation_order_technical_design_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "implementation_order_ticket_id_fkey",
    }),
    check(
      "implementation_order_source_sha_check",
      sql`source_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
    check(
      "implementation_order_state_check",
      sql`state = ANY (ARRAY['waiting'::text, 'started'::text, 'blocked'::text, 'cancelled'::text])`,
    ),
  ],
);

export const requirementApproval = factorySchema.table(
  "requirement_approval",
  {
    id: uuid("id").primaryKey().notNull(),
    ticketId: uuid("ticket_id").notNull(),
    requirementRevisionId: uuid("requirement_revision_id").notNull(),
    technicalDesignRevisionId: uuid("technical_design_revision_id"),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    monitoringIncidentId: uuid("monitoring_incident_id"),
    monitoringPolicyId: uuid("monitoring_policy_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [authUser.id],
      name: "requirement_approval_approved_by_fkey",
    }),
    foreignKey({
      columns: [table.monitoringIncidentId],
      foreignColumns: [monitoringIncident.id],
      name: "requirement_approval_monitoring_incident_id_fkey",
    }),
    foreignKey({
      columns: [table.monitoringPolicyId],
      foreignColumns: [monitoringPolicy.id],
      name: "requirement_approval_monitoring_policy_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementRevisionId, table.ticketId],
      foreignColumns: [requirementRevision.id, requirementRevision.ticketId],
      name: "requirement_approval_requirement_revision_id_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.technicalDesignRevisionId, table.ticketId, table.requirementRevisionId],
      foreignColumns: [
        technicalDesignRevision.id,
        technicalDesignRevision.ticketId,
        technicalDesignRevision.requirementRevisionId,
      ],
      name: "requirement_approval_technical_design_fk",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "requirement_approval_ticket_id_fkey",
    }),
    unique("requirement_approval_id_ticket_id_key").on(table.id, table.ticketId),
    unique("requirement_approval_ticket_id_key").on(table.ticketId),
    unique("requirement_approval_requirement_revision_id_key").on(table.requirementRevisionId),
    check(
      "requirement_monitoring_basis",
      sql`(monitoring_incident_id IS NULL) = (monitoring_policy_id IS NULL)`,
    ),
  ],
);

export const requirementRevision = factorySchema.table(
  "requirement_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    ticketId: uuid("ticket_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    canonicalContent: text("canonical_content").notNull(),
    contentDigest: text("content_digest").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("requirement_research_idx").using(
      "gin",
      sql`research_vector(''::text, canonical_content) tsvector_ops`,
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "requirement_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "requirement_revision_ticket_id_fkey",
    }),
    unique("requirement_revision_id_ticket_id_key").on(table.id, table.ticketId),
    unique("requirement_revision_ticket_id_ordinal_key").on(table.ticketId, table.ordinal),
    check("requirement_revision_canonical_content_check", sql`length(canonical_content) > 0`),
    check(
      "requirement_revision_check",
      sql`content_digest = encode(digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "requirement_revision_content_digest_check",
      sql`content_digest ~ '^[0-9a-f]{64}$'::text`,
    ),
    check("requirement_revision_ordinal_check", sql`ordinal > 0`),
  ],
);

export const technicalDesignRevision = factorySchema.table(
  "technical_design_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    ticketId: uuid("ticket_id").notNull(),
    requirementRevisionId: uuid("requirement_revision_id").notNull(),
    previousRevisionId: uuid("previous_revision_id"),
    ordinal: integer("ordinal").notNull(),
    sourceCommit: text("source_commit").notNull(),
    canonicalContent: text("canonical_content").notNull(),
    contentDigest: text("content_digest").notNull(),
    citations: jsonb("citations").default([]).notNull(),
    diagramRenders: jsonb("diagram_renders").default([]).notNull(),
    rendererVersion: text("renderer_version").notNull(),
    createdBy: uuid("created_by").notNull(),
    authorKind: text("author_kind").notNull(),
    turnId: uuid("turn_id"),
    planningTurnId: uuid("planning_turn_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "technical_design_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.planningTurnId],
      foreignColumns: [agentTurn.id],
      name: "technical_design_revision_planning_turn_id_fkey",
    }),
    foreignKey({
      columns: [table.previousRevisionId],
      foreignColumns: [technicalDesignRevision.id],
      name: "technical_design_revision_previous_revision_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementRevisionId, table.ticketId],
      foreignColumns: [requirementRevision.id, requirementRevision.ticketId],
      name: "technical_design_revision_requirement_revision_id_ticket_i_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "technical_design_revision_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.turnId],
      foreignColumns: [agentTurn.id],
      name: "technical_design_revision_turn_id_fkey",
    }),
    unique("technical_design_revision_id_ticket_id_requirement_revision_key").on(
      table.id,
      table.ticketId,
      table.requirementRevisionId,
    ),
    unique("technical_design_revision_ticket_id_ordinal_key").on(table.ticketId, table.ordinal),
    unique("technical_design_revision_turn_id_key").on(table.turnId),
    check(
      "technical_design_revision_author_kind_check",
      sql`author_kind = ANY (ARRAY['human'::text, 'ai'::text])`,
    ),
    check(
      "technical_design_revision_canonical_content_check",
      sql`(length(canonical_content) >= 1) AND (length(canonical_content) <= 100000)`,
    ),
    check(
      "technical_design_revision_check",
      sql`content_digest = encode(digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "technical_design_revision_citations_check",
      sql`jsonb_typeof(citations) = 'array'::text`,
    ),
    check(
      "technical_design_revision_diagram_renders_check",
      sql`jsonb_typeof(diagram_renders) = 'array'::text`,
    ),
    check("technical_design_revision_ordinal_check", sql`ordinal > 0`),
    check(
      "technical_design_revision_source_commit_check",
      sql`source_commit ~ '^[a-f0-9]{40}$'::text`,
    ),
  ],
);

export const ticket = factorySchema.table(
  "ticket",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description").default("").notNull(),
    state: ticketState("state").default("inbox").notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    epicId: uuid("epic_id"),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    trashedBy: uuid("trashed_by"),
    trashStopPending: boolean("trash_stop_pending").default(false).notNull(),
    trashError: text("trash_error"),
    convertedToEpicId: uuid("converted_to_epic_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("ticket_epic_idx").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.epicId.asc().nullsLast(),
    ),
    index("ticket_project_updated_idx").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("ticket_research_idx").using(
      "gin",
      sql`research_vector(title, description) tsvector_ops`,
    ),
    index("ticket_title_trgm_idx").using("gin", sql`lower(title) gin_trgm_ops`),
    foreignKey({
      columns: [table.convertedToEpicId],
      foreignColumns: [epic.id],
      name: "ticket_converted_to_epic_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "ticket_created_by_fkey",
    }),
    foreignKey({
      columns: [table.epicId, table.projectId],
      foreignColumns: [epic.id, epic.projectId],
      name: "ticket_epic_id_project_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "ticket_project_id_fkey",
    }),
    foreignKey({
      columns: [table.trashedBy],
      foreignColumns: [authUser.id],
      name: "ticket_trashed_by_fkey",
    }),
    unique("ticket_id_project_id_key").on(table.id, table.projectId),
    check("ticket_description_check", sql`length(description) <= 10000`),
    check("ticket_title_check", sql`(length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)`),
    check("ticket_version_check", sql`version > 0`),
  ],
);

export const ticketDocumentRevision = factorySchema.table(
  "ticket_document_revision",
  {
    id: uuid("id").primaryKey().notNull(),
    ticketId: uuid("ticket_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    canonicalContent: text("canonical_content").notNull(),
    contentDigest: text("content_digest").notNull(),
    requirementRevisionId: uuid("requirement_revision_id"),
    inputDigest: text("input_digest").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    authorKind: text("author_kind").default("human").notNull(),
    proposalEntryId: uuid("proposal_entry_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("ticket_document_research_idx").using(
      "gin",
      sql`research_vector(title, canonical_content) tsvector_ops`,
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "ticket_document_revision_created_by_fkey",
    }),
    foreignKey({
      columns: [table.proposalEntryId],
      foreignColumns: [conversationEntry.id],
      name: "ticket_document_revision_proposal_entry_id_fkey",
    }),
    foreignKey({
      columns: [table.requirementRevisionId, table.ticketId],
      foreignColumns: [requirementRevision.id, requirementRevision.ticketId],
      name: "ticket_document_revision_requirement_revision_id_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_document_revision_ticket_id_fkey",
    }),
    unique("ticket_document_revision_ticket_id_ordinal_key").on(table.ticketId, table.ordinal),
    unique("ticket_document_revision_proposal_entry_id_key").on(table.proposalEntryId),
    check(
      "ticket_document_revision_author_kind_check",
      sql`author_kind = ANY (ARRAY['human'::text, 'ai'::text])`,
    ),
    check(
      "ticket_document_revision_check",
      sql`content_digest = encode(digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "ticket_document_revision_content_digest_check",
      sql`content_digest ~ '^[0-9a-f]{64}$'::text`,
    ),
    check(
      "ticket_document_revision_input_digest_check",
      sql`input_digest ~ '^[0-9a-f]{64}$'::text`,
    ),
    check("ticket_document_revision_ordinal_check", sql`ordinal > 0`),
    check("ticket_document_revision_title_check", sql`length(title) > 0`),
  ],
);

export const ticketResponsibility = factorySchema.table(
  "ticket_responsibility",
  {
    ticketId: uuid("ticket_id").primaryKey().notNull(),
    userId: uuid("user_id"),
    version: integer("version").default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_responsibility_ticket_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "ticket_responsibility_user_id_fkey",
    }),
    check("ticket_responsibility_version_check", sql`version > 0`),
  ],
);

export const ticketResponsibilityEvent = factorySchema.table(
  "ticket_responsibility_event",
  {
    id: uuid("id").primaryKey().notNull(),
    ticketId: uuid("ticket_id").notNull(),
    userId: uuid("user_id"),
    actorId: uuid("actor_id").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("ticket_responsibility_event_recipient").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [authUser.id],
      name: "ticket_responsibility_event_actor_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_responsibility_event_ticket_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "ticket_responsibility_event_user_id_fkey",
    }),
  ],
);

export const ticketFollowUp = factorySchema.table(
  "ticket_follow_up",
  {
    ticketId: uuid("ticket_id").primaryKey().notNull(),
    sourceTicketId: uuid("source_ticket_id").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    sourceRevisionId: uuid("source_revision_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.sourceDocumentId],
      foreignColumns: [ticketDocumentRevision.id],
      name: "ticket_follow_up_source_document_id_fkey",
    }),
    foreignKey({
      columns: [table.sourceRevisionId, table.sourceTicketId],
      foreignColumns: [requirementRevision.id, requirementRevision.ticketId],
      name: "ticket_follow_up_source_revision_id_source_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.sourceTicketId],
      foreignColumns: [ticket.id],
      name: "ticket_follow_up_source_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_follow_up_ticket_id_fkey",
    }),
    check("ticket_follow_up_check", sql`ticket_id <> source_ticket_id`),
  ],
);

export const requirementsEntryIntent = factorySchema.table(
  "requirements_entry_intent",
  {
    ticketId: uuid("ticket_id").primaryKey().notNull(),
    commandId: uuid("command_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "requirements_entry_intent_created_by_fkey",
    }),
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "requirements_entry_intent_ticket_id_fkey",
    }).onDelete("cascade"),
    unique("requirements_entry_intent_command_id_key").on(table.commandId),
  ],
);

export const ticketFollow = factorySchema.table(
  "ticket_follow",
  {
    ticketId: uuid("ticket_id").notNull(),
    userId: uuid("user_id").notNull(),
    following: boolean("following").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ticketId],
      foreignColumns: [ticket.id],
      name: "ticket_follow_ticket_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "ticket_follow_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.ticketId, table.userId], name: "ticket_follow_pkey" }),
  ],
);

export const inboxReceipt = factorySchema.table(
  "inbox_receipt",
  {
    userId: uuid("user_id").notNull(),
    itemId: text("item_id").notNull(),
    seenEventId: text("seen_event_id"),
    archived: boolean("archived").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "inbox_receipt_user_id_fkey",
    }).onDelete("cascade"),
    primaryKey({ columns: [table.userId, table.itemId], name: "inbox_receipt_pkey" }),
  ],
);

export const ticketDependency = factorySchema.table(
  "ticket_dependency",
  {
    projectId: uuid("project_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    prerequisiteId: uuid("prerequisite_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("ticket_dependency_prerequisite_idx").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.prerequisiteId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "ticket_dependency_created_by_fkey",
    }),
    foreignKey({
      columns: [table.prerequisiteId, table.projectId],
      foreignColumns: [ticket.id, ticket.projectId],
      name: "ticket_dependency_prerequisite_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "ticket_dependency_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ticketId, table.projectId],
      foreignColumns: [ticket.id, ticket.projectId],
      name: "ticket_dependency_ticket_id_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.ticketId, table.prerequisiteId],
      name: "ticket_dependency_pkey",
    }),
    check("ticket_dependency_check", sql`ticket_id <> prerequisite_id`),
  ],
);
