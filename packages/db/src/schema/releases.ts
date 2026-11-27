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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUser } from "./auth";
import { factorySchema } from "./namespaces";
import { project } from "./projects";

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
