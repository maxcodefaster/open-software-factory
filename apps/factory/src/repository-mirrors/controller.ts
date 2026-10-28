import { createHmac } from "node:crypto";
import type { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient, ForgeRepository } from "../../../../packages/forge/src/forge";
import { ForgeMirrorWriteError } from "../../../../packages/forge/src/mirrors";
import {
  type RepositoryMirror,
  type RepositoryMirrorProject,
  type RepositoryMirrorView,
  repositoryMirrorCreate,
  repositoryMirrorRemove,
} from "../../../../packages/project-domain/src/repository-mirror";
import { projectImportURL } from "../../../../packages/project-domain/src/setup";
import { createAccessController, requireActiveAccountIn } from "../access/controller";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
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
    const [row] =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id=${actor} FOR SHARE`;
    if (!row) throw new CommandError("forbidden", "System Manager access required");
  }
  async function project(projectID: string): Promise<ForgeRepository> {
    const [row] = await database.client<{ url: string }[]>`
      SELECT repository_url AS url FROM factory.project WHERE id=${projectID}`;
    if (!row) throw new CommandError("not-found", "Project not found");
    const url = new URL(row.url);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (
      ![new URL(options.apiURL).origin, new URL(options.publicURL).origin].includes(url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2 ||
      parts[0] !== options.owner ||
      !parts[1]
    )
      throw new CommandError("conflict", "Project does not identify this Factory's repository");
    return { owner: options.owner, name: parts[1] };
  }
  async function commands(projectID: string, sql: SQL = database.client) {
    return sql<Command[]>`
      SELECT id,action,target_url AS "targetURL",remote_name AS "remoteName",fingerprint,
        created_by AS "createdBy",state,before_state AS before
      FROM factory.repository_mirror_command WHERE project_id=${projectID}
        AND state IN ('executing','uncertain') ORDER BY created_at`;
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
        await database.client`UPDATE factory.repository_mirror_command
          SET state=${command.action === "sync" && mirrors.some((item) => item.failed) ? "failed" : "completed"},
          completed_at=now() WHERE id=${command.id}
          AND state IN ('executing','uncertain')`;
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
      await sql`SELECT pg_advisory_lock(hashtextextended(${`repository-mirror:${projectID}`},0))`;
      const before = await get(actor, projectID);
      const admitted = await sql.begin(async (tx) => {
        await manager(tx, actor);
        const [previous] = await tx<Command[]>`
          SELECT id,created_by AS "createdBy",fingerprint,state FROM factory.repository_mirror_command
          WHERE id=${commandID}`;
        if (previous) {
          if (previous.createdBy !== actor || previous.fingerprint !== fingerprint)
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
        await tx`INSERT INTO factory.repository_mirror_command
          (id,project_id,created_by,action,target_url,remote_name,fingerprint,before_state,state)
          VALUES(${commandID},${projectID},${actor},${action},${value.targetURL ?? null},
            ${value.remoteName ?? null},${fingerprint},${tx.json(before.mirrors)},'executing')`;
        return true;
      });
      if (!admitted) return get(actor, projectID);
      try {
        await access.requireSystemManager(actor);
        await effect(repo);
      } catch (cause) {
        const uncertain = !(cause instanceof ForgeMirrorWriteError) || cause.unconfirmed;
        await sql`UPDATE factory.repository_mirror_command SET state=${uncertain ? "uncertain" : "failed"},
          completed_at=${uncertain ? null : new Date()} WHERE id=${commandID} AND state='executing'`;
        throw new CommandError(
          "unavailable",
          uncertain
            ? "Mirror operation is unconfirmed. Reload to observe it; it was not automatically repeated."
            : "Forgejo refused the mirror operation. Check the target URL, allowed host and access token.",
        );
      }
      await sql`UPDATE factory.repository_mirror_command SET state='completed',completed_at=now()
        WHERE id=${commandID} AND state='executing'`;
      return get(actor, projectID);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  return {
    get,
    async projects(actor: string): Promise<RepositoryMirrorProject[]> {
      await access.requireSystemManager(actor);
      return database.client<
        RepositoryMirrorProject[]
      >`SELECT id,name FROM factory.project ORDER BY name,id`;
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
        await sql`SELECT pg_advisory_lock(hashtextextended(${`repository-mirror:${projectID}`},0))`;
        await sql.begin(async (tx) => {
          await manager(tx, actor);
          await tx`UPDATE factory.repository_mirror_command
            SET state='acknowledged',completed_at=now()
            WHERE id=${commandID} AND project_id=${projectID} AND state IN ('executing','uncertain')`;
        });
        return await get(actor, projectID);
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  };
}
