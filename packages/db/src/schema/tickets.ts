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
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { agentTurn } from "./coding";
import { conversationEntry } from "./conversations";
import { ticketState } from "./enums";
import { monitoringIncident, monitoringPolicy } from "./monitoring";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

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
    check("epic_check", sql`${table.parentId} IS DISTINCT FROM ${table.id}`),
    check("epic_description_check", sql`length(${table.description}) <= 10000`),
    check(
      "epic_title_check",
      sql`(length(btrim(${table.title})) >= 1) AND (length(btrim(${table.title})) <= 200)`,
    ),
    check("epic_version_check", sql`${table.version} > 0`),
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
      sql`(${table.monitoringIncidentId} IS NULL) = (${table.monitoringPolicyId} IS NULL)`,
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
    check(
      "requirement_revision_canonical_content_check",
      sql`length(${table.canonicalContent}) > 0`,
    ),
    check(
      "requirement_revision_check",
      sql`${table.contentDigest} = encode(digest(convert_to(${table.canonicalContent}, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "requirement_revision_content_digest_check",
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'::text`,
    ),
    check("requirement_revision_ordinal_check", sql`${table.ordinal} > 0`),
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
    authorKind: text("author_kind").$type<"human" | "ai">().notNull(),
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
      sql`${table.authorKind} = ANY (ARRAY['human'::text, 'ai'::text])`,
    ),
    check(
      "technical_design_revision_canonical_content_check",
      sql`(length(${table.canonicalContent}) >= 1) AND (length(${table.canonicalContent}) <= 100000)`,
    ),
    check(
      "technical_design_revision_check",
      sql`${table.contentDigest} = encode(digest(convert_to(${table.canonicalContent}, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "technical_design_revision_citations_check",
      sql`jsonb_typeof(${table.citations}) = 'array'::text`,
    ),
    check(
      "technical_design_revision_diagram_renders_check",
      sql`jsonb_typeof(${table.diagramRenders}) = 'array'::text`,
    ),
    check("technical_design_revision_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "technical_design_revision_source_commit_check",
      sql`${table.sourceCommit} ~ '^[a-f0-9]{40}$'::text`,
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
    check("ticket_description_check", sql`length(${table.description}) <= 10000`),
    check(
      "ticket_title_check",
      sql`(length(btrim(${table.title})) >= 1) AND (length(btrim(${table.title})) <= 200)`,
    ),
    check("ticket_version_check", sql`${table.version} > 0`),
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
    authorKind: text("author_kind").$type<"human" | "ai">().default("human").notNull(),
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
      sql`${table.authorKind} = ANY (ARRAY['human'::text, 'ai'::text])`,
    ),
    check(
      "ticket_document_revision_check",
      sql`${table.contentDigest} = encode(digest(convert_to(${table.canonicalContent}, 'UTF8'::name), 'sha256'::text), 'hex'::text)`,
    ),
    check(
      "ticket_document_revision_content_digest_check",
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'::text`,
    ),
    check(
      "ticket_document_revision_input_digest_check",
      sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'::text`,
    ),
    check("ticket_document_revision_ordinal_check", sql`${table.ordinal} > 0`),
    check("ticket_document_revision_title_check", sql`length(${table.title}) > 0`),
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
    check("ticket_dependency_check", sql`${table.ticketId} <> ${table.prerequisiteId}`),
  ],
);
