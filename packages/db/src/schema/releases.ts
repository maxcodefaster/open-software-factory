import { sql } from "drizzle-orm";
import {
  bigint,
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
import { factorySchema } from "./namespaces";
import { project } from "./projects";
import { runtimeAttempt } from "./runtime";

export const projectRelease = factorySchema.table(
  "project_release",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    commandId: uuid("command_id").notNull(),
    version: text("version").notNull(),
    commitSha: text("commit_sha").notNull(),
    workflow: text("workflow"),
    contract: jsonb("contract"),
    notes: text("notes").notNull(),
    state: text("state")
      .$type<
        | "pending"
        | "dispatching"
        | "running"
        | "checking"
        | "publishing"
        | "published"
        | "failed"
        | "uncertain"
      >()
      .default("pending")
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    runId: bigint("run_id", { mode: "number" }),
    runUrl: text("run_url"),
    releaseUrl: text("release_url"),
    artifacts: jsonb("artifacts").default([]).notNull(),
    failure: text("failure"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("project_release_one_active")
      .using("btree", table.projectId.asc().nullsLast())
      .where(
        sql`((${table.state} = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'uncertain'::text])) AND (${table.endedAt} IS NULL))`,
      ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "project_release_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "project_release_project_id_fkey",
    }),
    unique("project_release_project_id_version_key").on(table.projectId, table.version),
    unique("project_release_command_id_key").on(table.commandId),
    check("project_release_artifacts_check", sql`jsonb_typeof(${table.artifacts}) = 'array'::text`),
    check("project_release_commit_sha_check", sql`${table.commitSha} ~ '^[a-f0-9]{40}$'::text`),
    check(
      "project_release_contract_check",
      sql`(${table.contract} IS NULL) OR (jsonb_typeof(${table.contract}) = 'object'::text)`,
    ),
    check(
      "project_release_state_check",
      sql`${table.state} = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'uncertain'::text])`,
    ),
    check(
      "project_release_version_check",
      sql`${table.version} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'::text`,
    ),
  ],
);

export const releaseAttempt = factorySchema.table(
  "release_attempt",
  {
    id: uuid("id").primaryKey().notNull(),
    releaseId: uuid("release_id").notNull(),
    commandId: uuid("command_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    state: text("state").default("pending").notNull(),
    dispatchIntendedAt: timestamp("dispatch_intended_at", { withTimezone: true }),
    runId: bigint("run_id", { mode: "number" }),
    runnerId: bigint("runner_id", { mode: "number" }),
    runnerUuid: text("runner_uuid"),
    runnerToken: text("runner_token"),
    jobHandle: text("job_handle"),
    runtimeAttemptId: uuid("runtime_attempt_id"),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.releaseId],
      foreignColumns: [projectRelease.id],
      name: "release_attempt_release_id_fkey",
    }),
    foreignKey({
      columns: [table.runtimeAttemptId],
      foreignColumns: [runtimeAttempt.id],
      name: "release_attempt_runtime_attempt_id_fkey",
    }),
    unique("release_attempt_release_id_ordinal_key").on(table.releaseId, table.ordinal),
    unique("release_attempt_command_id_key").on(table.commandId),
    check(
      "release_attempt_check",
      sql`(${table.runId} IS NULL) OR (${table.dispatchIntendedAt} IS NOT NULL)`,
    ),
    check("release_attempt_ordinal_check", sql`${table.ordinal} > 0`),
  ],
);

export const repositoryMirrorCommand = factorySchema.table(
  "repository_mirror_command",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    action: text("action").$type<"create" | "remove" | "sync">().notNull(),
    targetUrl: text("target_url"),
    remoteName: text("remote_name"),
    fingerprint: text("fingerprint").notNull(),
    beforeState: jsonb("before_state").notNull(),
    state: text("state")
      .$type<"executing" | "completed" | "failed" | "uncertain" | "acknowledged">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("repository_mirror_unconfirmed")
      .using("btree", table.projectId.asc().nullsLast())
      .where(sql`(${table.state} = ANY (ARRAY['executing'::text, 'uncertain'::text]))`),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "repository_mirror_command_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "repository_mirror_command_project_id_fkey",
    }),
    check(
      "repository_mirror_command_action_check",
      sql`${table.action} = ANY (ARRAY['create'::text, 'remove'::text, 'sync'::text])`,
    ),
    check(
      "repository_mirror_command_state_check",
      sql`${table.state} = ANY (ARRAY['executing'::text, 'completed'::text, 'failed'::text, 'uncertain'::text, 'acknowledged'::text])`,
    ),
  ],
);

export const releaseAccess = factorySchema.table(
  "release_access",
  {
    id: uuid("id").primaryKey().notNull(),
    projectId: uuid("project_id").notNull(),
    commandId: uuid("command_id").notNull(),
    name: text("name").notNull(),
    scope: text("scope").$type<"git" | "packages" | "publish">().notNull(),
    state: text("state")
      .$type<"pending" | "active" | "revoking" | "revoked" | "uncertain">()
      .notNull(),
    username: text("username").notNull(),
    secretKey: text("secret_key").notNull(),
    createdBy: uuid("created_by").notNull(),
    releaseId: uuid("release_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tokenId: bigint("token_id", { mode: "number" }),
    replacesId: uuid("replaces_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("release_access_publish_attempt")
      .using("btree", table.releaseId.asc().nullsLast())
      .where(
        sql`((${table.scope} = 'publish'::text) AND (${table.state} = ANY (ARRAY['pending'::text, 'active'::text, 'uncertain'::text])))`,
      ),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [authUser.id],
      name: "release_access_created_by_fkey",
    }),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "release_access_project_id_fkey",
    }),
    foreignKey({
      columns: [table.releaseId],
      foreignColumns: [projectRelease.id],
      name: "release_access_release_id_fkey",
    }),
    foreignKey({
      columns: [table.replacesId],
      foreignColumns: [releaseAccess.id],
      name: "release_access_replaces_id_fkey",
    }),
    unique("release_access_command_id_key").on(table.commandId),
    unique("release_access_username_key").on(table.username),
    check(
      "release_access_scope_check",
      sql`${table.scope} = ANY (ARRAY['git'::text, 'packages'::text, 'publish'::text])`,
    ),
    check(
      "release_access_state_check",
      sql`${table.state} = ANY (ARRAY['pending'::text, 'active'::text, 'revoking'::text, 'revoked'::text, 'uncertain'::text])`,
    ),
  ],
);
