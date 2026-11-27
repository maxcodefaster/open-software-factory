import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
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
import { workspaceKind } from "./enums";
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { ticket } from "./tickets";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const developmentWorkspace = factorySchema.table(
  "development_workspace",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    kind: workspaceKind("kind").notNull(),
    ownerUserId: uuid("owner_user_id"),
    ticketId: uuid("ticket_id"),
    changeId: uuid("change_id"),
    sourceBranch: text("source_branch").notNull(),
    sourceRevision: text("source_revision").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    collaborationEnabled: boolean("collaboration_enabled").default(false).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("development_workspace_one_per_ticket")
      .using("btree", table.ticketId.asc().nullsLast())
      .where(sql`(${table.kind} = 'ticket'::development_workspace_kind)`),
    uniqueIndex("development_workspace_one_personal_per_user_project")
      .using("btree", table.projectId.asc().nullsLast(), table.ownerUserId.asc().nullsLast())
      .where(sql`(${table.kind} = 'personal'::development_workspace_kind)`),
    foreignKey({
      columns: [table.changeId, table.projectId],
      foreignColumns: [change.id, change.projectId],
      name: "development_workspace_change_id_project_id_fkey",
    }),
    foreignKey({
      columns: [table.changeId, table.ticketId],
      foreignColumns: [change.id, change.ticketId],
      name: "development_workspace_change_id_ticket_id_fkey",
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "development_workspace_created_by_fkey",
    }),
    foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [authUser.id],
      name: "development_workspace_owner_user_id_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "development_workspace_project_id_fkey",
    }),
    foreignKey({
      columns: [table.ticketId, table.projectId],
      foreignColumns: [ticket.id, ticket.projectId],
      name: "development_workspace_ticket_id_project_id_fkey",
    }),
    unique("development_workspace_id_change_id_key").on(table.id, table.changeId),
    unique("development_workspace_id_project_id_key").on(table.id, table.projectId),
    check(
      "development_workspace_check",
      sql`((${table.kind} = 'personal'::development_workspace_kind) AND (${table.ownerUserId} IS NOT NULL) AND (${table.ticketId} IS NULL) AND (${table.changeId} IS NULL)) OR ((${table.kind} = 'ticket'::development_workspace_kind) AND (${table.ownerUserId} IS NULL) AND (${table.ticketId} IS NOT NULL) AND (${table.changeId} IS NOT NULL))`,
    ),
    check(
      "development_workspace_source_branch_check",
      sql`(length(${table.sourceBranch}) >= 1) AND (length(${table.sourceBranch}) <= 200)`,
    ),
    check(
      "development_workspace_source_revision_check",
      sql`${table.sourceRevision} ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text`,
    ),
  ],
);

export const workspaceShare = factorySchema.table(
  "workspace_share",
  {
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    permission: text("permission").$type<"observe" | "collaborate">().notNull(),
    version: bigint("version", { mode: "number" }).default(1).notNull(),
    grantedBy: uuid("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.grantedBy],
      foreignColumns: [authUser.id],
      name: "workspace_share_granted_by_fkey",
    }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUser.id],
      name: "workspace_share_user_id_fkey",
    }),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_share_workspace_id_fkey",
    }),
    primaryKey({ columns: [table.workspaceId, table.userId], name: "workspace_share_pkey" }),
    check(
      "workspace_share_permission_check",
      sql`${table.permission} = ANY (ARRAY['observe'::text, 'collaborate'::text])`,
    ),
    check("workspace_share_version_check", sql`${table.version} > 0`),
  ],
);

export const workspaceSharedDocument = factorySchema.table(
  "workspace_shared_document",
  {
    workspaceId: uuid("workspace_id").notNull(),
    path: text("path").notNull(),
    yState: bytea("y_state").notNull(),
    diskVersion: text("disk_version").notNull(),
    syncState: text("sync_state")
      .$type<"clean" | "dirty" | "conflict">()
      .default("clean")
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [developmentWorkspace.id],
      name: "workspace_shared_document_workspace_id_fkey",
    }),
    primaryKey({
      columns: [table.workspaceId, table.path],
      name: "workspace_shared_document_pkey",
    }),
    check(
      "workspace_shared_document_sync_state_check",
      sql`${table.syncState} = ANY (ARRAY['clean'::text, 'dirty'::text, 'conflict'::text])`,
    ),
    check("workspace_shared_document_y_state_check", sql`octet_length(${table.yState}) <= 8388608`),
  ],
);
