import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

export const mcpLibrary = factorySchema.table(
  "mcp_library",
  {
    id: uuid("id").primaryKey().notNull(),
    scope: text("scope").$type<"personal" | "project" | "system">().notNull(),
    ownerId: uuid("owner_id"),
    projectId: uuid("project_id"),
    coverKey: text("cover_key"),
    coverVersion: bigint("cover_version", { mode: "number" }),
    coverUpdatedBy: uuid("cover_updated_by"),
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
    foreignKey({
      columns: [table.coverUpdatedBy],
      foreignColumns: [authUser.id],
      name: "mcp_library_cover_updated_by_fkey",
    }),
    check(
      "mcp_library_check",
      sql`((${table.scope} = 'personal'::text) AND (${table.ownerId} IS NOT NULL) AND (${table.projectId} IS NULL)) OR ((${table.scope} = 'project'::text) AND (${table.ownerId} IS NULL) AND (${table.projectId} IS NOT NULL)) OR ((${table.scope} = 'system'::text) AND (${table.ownerId} IS NULL) AND (${table.projectId} IS NULL))`,
    ),
    check(
      "mcp_library_scope_check",
      sql`${table.scope} = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])`,
    ),
    check(
      "mcp_library_cover_nulls_check",
      sql`(${table.coverKey} IS NULL) = (${table.coverVersion} IS NULL AND ${table.coverUpdatedBy} IS NULL)`,
    ),
    check(
      "mcp_library_cover_key_check",
      sql`${table.coverKey} IS NULL OR ${table.coverKey} ~ '^[a-z][a-z-]{1,63}$'::text`,
    ),
    check(
      "mcp_library_cover_version_check",
      sql`${table.coverVersion} IS NULL OR ${table.coverVersion} > 0`,
    ),
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
      sql`(jsonb_typeof(${table.content}) = 'object'::text) AND (octet_length((${table.content})::text) < 16000)`,
    ),
    check("mcp_revision_digest_check", sql`${table.digest} ~ '^[a-f0-9]{64}$'::text`),
    check("mcp_revision_revision_check", sql`${table.revision} > 0`),
  ],
);

export type MCPProjectGrantRecord = {
  credentialEpoch: string;
  grantedBy: string;
  grantedAt: string;
};

export const mcpConnection = factorySchema.table(
  "mcp_connection",
  {
    id: uuid("id").primaryKey().notNull(),
    revisionId: uuid("revision_id").notNull(),
    state: text("state")
      .$type<"disconnected" | "authorizing" | "review" | "ready" | "reconnect" | "revoked">()
      .notNull(),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    secretKey: text("secret_key"),
    credentialEpoch: uuid("credential_epoch").notNull(),
    tools: jsonb("tools").default([]).notNull(),
    allowedTools: jsonb("allowed_tools").default([]).notNull(),
    projectGrants: jsonb("project_grants")
      .$type<Record<string, MCPProjectGrantRecord>>()
      .default({})
      .notNull(),
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
      sql`${table.state} = ANY (ARRAY['disconnected'::text, 'authorizing'::text, 'review'::text, 'ready'::text, 'reconnect'::text, 'revoked'::text])`,
    ),
    check(
      "mcp_connection_tools_check",
      sql`(jsonb_typeof(${table.tools}) = 'array'::text) AND (octet_length((${table.tools})::text) <= 1000000)`,
    ),
    check(
      "mcp_connection_project_grants_check",
      sql`jsonb_typeof(${table.projectGrants}) = 'object'::text`,
    ),
  ],
);
