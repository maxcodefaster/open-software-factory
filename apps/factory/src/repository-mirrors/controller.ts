import { createHmac } from "node:crypto";
import { and, asc, eq, sql as expression, inArray } from "drizzle-orm";
import type { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { administrator, operation as operationTable, project as projectTable } from "#db/schema";
import type { ForgeRepository } from "#forge/contracts";
import type { createForgejoClient } from "#forge/forge";
import { ForgeMirrorWriteError } from "#forge/mirrors";
import { boundForgeRepositoryFromURL } from "#forge/repository";
import {
  type RepositoryMirror,
  type RepositoryMirrorProject,
  type RepositoryMirrorView,
  repositoryMirrorCreate,
  repositoryMirrorRemove,
} from "#project-domain/repository-mirror";
import { projectImportURL } from "#project-domain/setup";
import { createAccessController } from "../access/api";
import { requireActiveAccountIn } from "../access/authority";
import { CommandError } from "../command-error";

const REPOSITORY_MIRROR_COMMAND_KIND = "releases.mirror_command";
const REPOSITORY_MIRROR_SCOPE_TYPE = "project";
const repositoryMirrorCommandIdempotencyKey = (commandID: string) =>
  `${REPOSITORY_MIRROR_COMMAND_KIND}:${commandID}`;

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
type MirrorCommandPayload = {
  action: "create" | "remove" | "sync";
  targetURL: string | null;
  remoteName: string | null;
  fingerprint: string;
  beforeState: RepositoryMirror[];
};
type Command = {
  id: string;
  action: "create" | "remove" | "sync";
  targetURL: string | null;
  remoteName: string | null;
  fingerprint: string;
  createdBy: string;
  state: "executing" | "completed" | "failed" | "uncertain" | "acknowledged";
  before: RepositoryMirror[];
};

export function createRepositoryMirrorController(options: {
  database: Database;
  forge: Pick<ReturnType<typeof createForgejoClient>, "pushMirrors">;
  apiURL: string;
  publicURL: string;
  owner: string;
  signingKey: string;
  allowedOrigins: readonly string[];
}) {
  const { database, forge } = options;
  const access = createAccessController(database);
  async function manager(sql: Parameters<typeof requireActiveAccountIn>[0], actor: string) {
    await requireActiveAccountIn(sql, actor);
    const [row] = await drizzleTransaction(sql)
      .select({ userID: administrator.userId })
      .from(administrator)
      .where(eq(administrator.userId, actor))
      .for("share");
    if (!row) throw new CommandError("forbidden", "System Manager access required");
  }
  async function project(projectID: string): Promise<ForgeRepository> {
    const [row] = await drizzleTransaction(database.client)
      .select({ url: projectTable.repositoryUrl })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
    if (!row) throw new CommandError("not-found", "Project not found");
    return boundForgeRepositoryFromURL(
      row.url,
      options,
      () => new CommandError("conflict", "Project does not identify this Factory's repository"),
    );
  }
  async function commands(projectID: string, sql: SQL = database.client) {
    const rows = await drizzleTransaction(sql)
      .select({
        id: operationTable.id,
        createdBy: operationTable.createdBy,
        state: operationTable.state,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
          eq(operationTable.scopeType, REPOSITORY_MIRROR_SCOPE_TYPE),
          eq(operationTable.scopeId, projectID),
          inArray(operationTable.state, ["executing", "uncertain"]),
        ),
      )
      .orderBy(asc(operationTable.createdAt));
    return rows.map((row) => {
      const payload = row.payload as MirrorCommandPayload;
      return {
        id: row.id,
        action: payload.action,
        targetURL: payload.targetURL ?? null,
        remoteName: payload.remoteName ?? null,
        fingerprint: payload.fingerprint,
        createdBy: row.createdBy ?? "",
        state: row.state as Command["state"],
        before: payload.beforeState,
      };
    });
  }
  async function observe(projectID: string, mirrors: RepositoryMirror[]) {
    for (const command of await commands(projectID)) {
      const completed =
        command.action === "create"
          ? mirrors.some(
              (item) =>
                item.targetURL === command.targetURL &&
                item.syncOnCommit &&
                item.branchFilter === "" &&
                ["1h", "1h0m0s"].includes(item.interval) &&
                !command.before.some((before) => before.remoteName === item.remoteName),
            )
          : command.action === "remove"
            ? !mirrors.some((item) => item.remoteName === command.remoteName)
            : command.before.length > 0 &&
              command.before.every((before) =>
                mirrors.some(
                  (item) =>
                    item.remoteName === before.remoteName &&
                    item.lastAttempt !== null &&
                    item.lastAttempt !== before.lastAttempt,
                ),
              );
      if (completed)
        await drizzleTransaction(database.client)
          .update(operationTable)
          .set({
            state:
              command.action === "sync" && mirrors.some((item) => item.failed)
                ? "failed"
                : "completed",
            updatedAt: expression`now()`,
            completedAt: expression`now()`,
          })
          .where(
            and(
              eq(operationTable.id, command.id),
              eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
              inArray(operationTable.state, ["executing", "uncertain"]),
            ),
          );
    }
  }
  async function get(actor: string, projectID: string): Promise<RepositoryMirrorView> {
    await access.requireSystemManager(actor);
    const repo = await project(projectID);
    let mirrors: RepositoryMirror[];
    try {
      mirrors = await forge.pushMirrors.list(repo);
    } catch {
      throw new CommandError("unavailable", "Mirror status is unavailable. Reload to check again.");
    }
    await access.requireSystemManager(actor);
    await observe(projectID, mirrors);
    const pending = (await commands(projectID))[0];
    return {
      projectID,
      mirrors,
      pending: pending ? { commandID: pending.id, action: pending.action } : null,
    };
  }
  async function execute(
    actor: string,
    projectID: string,
    commandID: string,
    action: Command["action"],
    value: { targetURL?: string; remoteName?: string; username?: string; token?: string },
    effect: (repo: ForgeRepository) => Promise<unknown>,
  ) {
    await access.requireSystemManager(actor);
    const repo = await project(projectID);
    const fingerprint = createHmac("sha256", options.signingKey)
      .update(JSON.stringify({ projectID, action, ...value }))
      .digest("hex");
    // One existing owner serializes native configuration commands, not a sync loop.
    const sql = database.coordination();
    try {
      // Configure this pool's JSON/date codecs before binding its transactions.
      const db = drizzleTransaction(sql);
      await sql`SELECT pg_advisory_lock(hashtextextended(${`repository-mirror:${projectID}`},0))`;
      const before = await get(actor, projectID);
      const admitted = await sql.begin(async (tx) => {
        await manager(tx, actor);
        const db = drizzleTransaction(tx);
        const [previous] = await db
          .select({
            id: operationTable.id,
            createdBy: operationTable.createdBy,
            payload: operationTable.payload,
            state: operationTable.state,
          })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.id, commandID),
              eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
            ),
          );
        if (previous) {
          if (previous.createdBy !== actor || previous.payload["fingerprint"] !== fingerprint)
            throw new CommandError("conflict", "This mirror command belongs to different input.");
          if (previous.state === "failed" || previous.state === "acknowledged")
            throw new CommandError(
              "conflict",
              "This operation failed. Submit a new explicit command.",
            );
          return false;
        }
        if (before.pending)
          throw new CommandError(
            "conflict",
            "A mirror operation is unconfirmed. Check Forgejo and reload before another change.",
          );
        if (
          action === "create" &&
          before.mirrors.some((item) => item.targetURL === value.targetURL)
        )
          throw new CommandError(
            "conflict",
            "This repository already has a mirror for that target.",
          );
        if (
          action === "remove" &&
          !before.mirrors.some(
            (item) => item.remoteName === value.remoteName && item.targetURL === value.targetURL,
          )
        )
          throw new CommandError("conflict", "Mirror identity changed. Reload before removing it.");
        if (action === "sync" && before.mirrors.length === 0)
          throw new CommandError("conflict", "Configure a mirror before synchronizing.");
        await db.insert(operationTable).values({
          id: commandID,
          kind: REPOSITORY_MIRROR_COMMAND_KIND,
          scopeType: REPOSITORY_MIRROR_SCOPE_TYPE,
          scopeId: projectID,
          idempotencyKey: repositoryMirrorCommandIdempotencyKey(commandID),
          activeKey: null,
          state: "executing",
          payload: {
            action,
            targetURL: value.targetURL ?? null,
            remoteName: value.remoteName ?? null,
            fingerprint,
            beforeState: before.mirrors,
          },
          result: null,
          error: null,
          createdBy: actor,
          completedAt: null,
        });
        return true;
      });
      if (!admitted) return get(actor, projectID);
      try {
        await access.requireSystemManager(actor);
        await effect(repo);
      } catch (cause) {
        const uncertain = !(cause instanceof ForgeMirrorWriteError) || cause.unconfirmed;
        await db
          .update(operationTable)
          .set({
            state: uncertain ? "uncertain" : "failed",
            updatedAt: expression`now()`,
            completedAt: uncertain ? null : new Date(),
          })
          .where(
            and(
              eq(operationTable.id, commandID),
              eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
              eq(operationTable.state, "executing"),
            ),
          );
        throw new CommandError(
          "unavailable",
          uncertain
            ? "Mirror operation is unconfirmed. Reload to observe it; it was not automatically repeated."
            : "Forgejo refused the mirror operation. Check the target URL, allowed host and access token.",
        );
      }
      await db
        .update(operationTable)
        .set({
          state: "completed",
          updatedAt: expression`now()`,
          completedAt: expression`now()`,
        })
        .where(
          and(
            eq(operationTable.id, commandID),
            eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
            eq(operationTable.state, "executing"),
          ),
        );
      return get(actor, projectID);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  return {
    get,
    async projects(actor: string): Promise<RepositoryMirrorProject[]> {
      await access.requireSystemManager(actor);
      return drizzleTransaction(database.client)
        .select({ id: projectTable.id, name: projectTable.name })
        .from(projectTable)
        .orderBy(asc(projectTable.name), asc(projectTable.id));
    },
    async create(actor: string, projectID: string, value: z.output<typeof repositoryMirrorCreate>) {
      const input = repositoryMirrorCreate.parse(value);
      let targetURL: string;
      try {
        targetURL = projectImportURL(input.targetURL, options.allowedOrigins);
        if (
          [new URL(options.apiURL).origin, new URL(options.publicURL).origin].includes(
            new URL(targetURL).origin,
          )
        )
          throw new Error("Mirror target must be external");
      } catch {
        throw new CommandError("conflict", "Use an approved HTTPS Git URL without credentials.");
      }
      return execute(
        actor,
        projectID,
        input.commandID,
        "create",
        { targetURL, username: input.username, token: input.token },
        (repo) => forge.pushMirrors.create(repo, { ...input, targetURL }),
      );
    },
    remove(actor: string, projectID: string, value: z.output<typeof repositoryMirrorRemove>) {
      const input = repositoryMirrorRemove.parse(value);
      return execute(actor, projectID, input.commandID, "remove", input, (repo) =>
        forge.pushMirrors.remove(repo, input.remoteName),
      );
    },
    sync(actor: string, projectID: string, commandID: string) {
      return execute(actor, projectID, commandID, "sync", {}, (repo) =>
        forge.pushMirrors.sync(repo),
      );
    },
    async acknowledge(actor: string, projectID: string, commandID: string) {
      await access.requireSystemManager(actor);
      const sql = database.coordination();
      try {
        drizzleTransaction(sql);
        await sql`SELECT pg_advisory_lock(hashtextextended(${`repository-mirror:${projectID}`},0))`;
        await sql.begin(async (tx) => {
          await manager(tx, actor);
          await drizzleTransaction(tx)
            .update(operationTable)
            .set({
              state: "acknowledged",
              updatedAt: expression`now()`,
              completedAt: expression`now()`,
            })
            .where(
              and(
                eq(operationTable.id, commandID),
                eq(operationTable.kind, REPOSITORY_MIRROR_COMMAND_KIND),
                eq(operationTable.scopeType, REPOSITORY_MIRROR_SCOPE_TYPE),
                eq(operationTable.scopeId, projectID),
                inArray(operationTable.state, ["executing", "uncertain"]),
              ),
            );
        });
        return await get(actor, projectID);
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  };
}
