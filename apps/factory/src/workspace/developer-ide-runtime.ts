import type { createDatabase } from "../../../../packages/db/src/client";
import type { createRuntimeController } from "../runtime/controller";
import type { RuntimeHub, RuntimeSocketData } from "../runtime/hub";
import type { createRuntimeAccess } from "../access/runtime";
import type { DeveloperIDEGrant } from "./developer-ide-access";
import { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import { json } from "../http";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { z } from "zod";
import { executeEditingCommand } from "../access/writer-command";
import type { createChangeWriterController } from "../access/writer-controller";
import { createPersonalGit } from "./personal-git";

type EditorAuthorization = { token: string; grant: DeveloperIDEGrant };
type Workspace = { projectID: string; changeID: string | null; kind: string; available: boolean };

export function createDeveloperIDERuntime(
  database: ReturnType<typeof createDatabase>,
  runtimes: Pick<
    ReturnType<typeof createRuntimeController>,
    "start" | "startPersisted" | "processOutput" | "processAction" | "closeTerminal"
  >,
  hub: RuntimeHub,
  access: ReturnType<typeof createRuntimeAccess>,
  writers?: Pick<
    ReturnType<typeof createChangeWriterController>,
    "view" | "takeOver" | "activity" | "request" | "approve" | "release" | "takeIdle"
  >,
) {
  const authority = createAccessController(database);
  const git = createPersonalGit(database, hub);
  const terminalGrants = new Map<
    string,
    { editorToken: string; attemptID: string; token: string }
  >();
  async function workspace(workspaceID: string, userID: string): Promise<Workspace> {
    const [row] = await database.client<Array<Workspace & { ownerID: string | null }>>`
      SELECT workspace.project_id AS "projectID", workspace.change_id AS "changeID",
        workspace.kind, workspace.owner_user_id AS "ownerID",
        workspace.kind = 'personal' OR (change.state IN ('starting','active','failed')
          AND ticket.trashed_at IS NULL) AS available
      FROM factory.development_workspace workspace
      LEFT JOIN factory.change change ON change.id=workspace.change_id
      LEFT JOIN factory.ticket ticket ON ticket.id=change.ticket_id
      WHERE workspace.id=${workspaceID}`;
    if (!row || (row.kind === "personal" && row.ownerID !== userID))
      throw new CommandError("not-found", "Workspace not found");
    await authority.requireDevelopment(userID, row.projectID);
    return row;
  }
  async function context(workspaceID: string, userID: string) {
    const source = await workspace(workspaceID, userID);
    if (!source.available)
      return {
        workspaceID,
        kind: source.kind,
        attemptID: null,
        state: "unavailable",
        failure: "This implementation is no longer active. Source files remain available.",
      };
    const [attempt] = await database.client<
      Array<{ attemptID: string; state: string; failure: string | null }>
    >`
      SELECT id AS "attemptID",state,failure FROM factory.runtime_attempt
      WHERE workspace_id=${workspaceID} AND project_id=${source.projectID}
        AND ((${source.changeID}::uuid IS NULL AND change_id IS NULL)
          OR (change_id=${source.changeID} AND id=(SELECT runtime_attempt_id FROM factory.change WHERE id=${source.changeID})))
      ORDER BY generation DESC LIMIT 1`;
    return {
      workspaceID,
      kind: source.kind,
      attemptID: attempt?.attemptID ?? null,
      state:
        attempt?.state === "ready" && !hub.connected(attempt.attemptID)
          ? "reconnecting"
          : (attempt?.state ?? "stopped"),
      failure: attempt?.failure ?? null,
    };
  }
  async function exactAttempt(workspaceID: string, attemptID: string, userID: string) {
    const current = await context(workspaceID, userID);
    if (current.attemptID !== attemptID || current.state !== "ready" || !hub.connected(attemptID))
      throw new CommandError(
        "conflict",
        "This Runtime Attempt is not connected. Reopen the selected Workspace to resume compute.",
      );
  }
  async function executionToken(authorized: EditorAuthorization, attemptID: string) {
    for (const [key, scoped] of terminalGrants)
      if (!access.has(scoped.token)) terminalGrants.delete(key);
    const key = `${authorized.token}:${attemptID}`;
    let scoped = terminalGrants.get(key);
    if (!scoped) {
      const token = await access.issue({
        attemptID,
        channel: "ide",
        userID: authorized.grant.userID,
        sessionID: authorized.grant.sessionID,
        expires: authorized.grant.expires,
        mode: "embedded",
      });
      scoped = { editorToken: authorized.token, attemptID, token };
      terminalGrants.set(key, scoped);
    }
    return scoped.token;
  }
  return {
    async route(
      suffix: string,
      request: Request,
      authorized: EditorAuthorization,
    ): Promise<Response | undefined> {
      const gitRoute = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/git\/(status|diff|commit|fetch|pull)$/,
      );
      if (gitRoute?.[1] && gitRoute[2]) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const source = await workspace(gitRoute[1], authorized.grant.userID);
        if (source.kind !== "personal")
          throw new CommandError("forbidden", "Git controls are for your personal Workspace");
        if (gitRoute[2] === "status")
          return json(await git.read(gitRoute[1], authorized.grant.userID));
        if (gitRoute[2] === "diff") {
          const input = z
            .strictObject({ path: z.string().min(1).max(4096) })
            .parse(await request.json());
          return json(await git.read(gitRoute[1], authorized.grant.userID, input.path));
        }
        return json(
          await git.mutate(gitRoute[1], authorized.grant.userID, gitRoute[2], await request.json()),
        );
      }
      const writer = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/writer(?:\/(activity|request|approve|release|idle-takeover))?$/,
      );
      if (writer?.[1]) {
        const source = await workspace(writer[1], authorized.grant.userID);
        if (!source.changeID)
          return json({ state: "human", canWrite: true, yours: true, epoch: 1 });
        if (!writers) throw new CommandError("unavailable", "Editing authority is unavailable");
        if (writer[2] && writer[2] !== "activity") {
          if (request.method !== "POST") return new Response(null, { status: 405 });
          return json(
            await executeEditingCommand(
              writers,
              writer[2],
              source.changeID,
              authorized.grant.userID,
              await request.json(),
            ),
          );
        }
        if (writer[2]) {
          if (request.method !== "POST") return new Response(null, { status: 405 });
          const input = z
            .strictObject({
              epoch: z.number().int().positive(),
              kind: z.enum(["edit", "heartbeat"]),
            })
            .parse(await request.json());
          await writers.activity(source.changeID, authorized.grant.userID, input.epoch, input.kind);
          return new Response(null, { status: 204 });
        }
        if (request.method === "GET")
          return json(await writers.view(source.changeID, authorized.grant.userID));
        if (request.method === "POST") {
          const input: unknown = await request.json();
          if (
            !input ||
            typeof input !== "object" ||
            !("commandID" in input) ||
            !("epoch" in input) ||
            typeof input.epoch !== "number" ||
            !Number.isSafeInteger(input.epoch) ||
            input.epoch <= 0 ||
            typeof input.commandID !== "string" ||
            !/^[0-9a-f-]{36}$/.test(input.commandID)
          )
            throw new CommandError("conflict", "Editing takeover identity is invalid");
          return json(
            await writers.takeOver(
              source.changeID,
              authorized.grant.userID,
              input.commandID,
              undefined,
              undefined,
              input.epoch,
            ),
          );
        }
        return new Response(null, { status: 405 });
      }
      const selection = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/runtime(?:\/(ensure|activity))?$/,
      );
      if (selection?.[1]) {
        const workspaceID = selection[1];
        if (!selection[2]) {
          if (request.method !== "GET") return new Response(null, { status: 405 });
          return json(await context(workspaceID, authorized.grant.userID));
        }
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const source = await workspace(workspaceID, authorized.grant.userID);
        if (!source.available)
          throw new CommandError("conflict", "This implementation is no longer active");
        await database.client.begin((sql) =>
          workspaceWriteAuthorityIn(sql, workspaceID, authorized.grant.userID),
        );
        if (selection[2] === "activity") {
          const current = await context(workspaceID, authorized.grant.userID);
          if (!current.attemptID || current.state !== "ready" || !hub.use(current.attemptID))
            throw new CommandError("conflict", "Workspace compute is not running");
          return new Response(null, { status: 204 });
        }
        if (source.changeID)
          await runtimes.startPersisted(source.changeID, authorized.grant.userID);
        else await runtimes.start(source.projectID, authorized.grant.userID);
        return json(await context(workspaceID, authorized.grant.userID), 202);
      }
      const operation = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/runtime\/([0-9a-f-]{36})\/(processes(?:\/events|\/(app(?:-[a-z][a-z0-9-]{0,26})?)\/(start|stop|restart))?|terminals\/([a-zA-Z0-9_-]{1,64}))$/,
      );
      if (!operation?.[1] || !operation[2]) return undefined;
      const [, workspaceID, attemptID, resource, process, action, terminalID] = operation;
      await exactAttempt(workspaceID, attemptID, authorized.grant.userID);
      if (resource === "processes/events" && request.method === "GET")
        return hub.processEvents.subscribe(
          attemptID,
          await executionToken(authorized, attemptID),
          request.signal,
        );
      if (resource === "processes" && request.method === "GET")
        return json(await runtimes.processOutput(attemptID));
      if (process && action && request.method === "POST")
        return database.client.begin(async (sql) => {
          await workspaceWriteAuthorityIn(sql, workspaceID, authorized.grant.userID);
          return json(
            await runtimes.processAction(
              attemptID,
              process,
              action as "start" | "stop" | "restart",
            ),
          );
        });
      if (terminalID && request.method === "DELETE")
        return database.client.begin(async (sql) => {
          await workspaceWriteAuthorityIn(sql, workspaceID, authorized.grant.userID);
          return json(await runtimes.closeTerminal(attemptID, terminalID));
        });
      return new Response(null, { status: 405 });
    },
    async socketData(
      suffix: string,
      authorized: EditorAuthorization,
    ): Promise<RuntimeSocketData | undefined> {
      const match = suffix.match(
        /^\/__factory\/workspaces\/([0-9a-f-]{36})\/runtime\/([0-9a-f-]{36})\/(?:terminal\/([a-zA-Z0-9_-]{1,64})|language\/(typescript|python))$/,
      );
      if (!match?.[1] || !match[2] || (!match[3] && !match[4])) return undefined;
      const [, workspaceID, attemptID, terminalID, language] = match;
      await exactAttempt(workspaceID, attemptID, authorized.grant.userID);
      await database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspaceID, authorized.grant.userID),
      );
      const token = await executionToken(authorized, attemptID);
      return {
        kind: "browser",
        attemptID,
        channel: language ? "language" : "terminal",
        path: language ? `/${language}/${workspaceID}` : `/${terminalID}`,
        accessToken: token,
      };
    },
    revokeEditor(editorToken: string) {
      for (const [key, scoped] of terminalGrants)
        if (scoped.editorToken === editorToken) {
          access.revoke(scoped.token);
          terminalGrants.delete(key);
        }
    },
    sweep() {
      for (const [key, scoped] of terminalGrants)
        if (!access.has(scoped.token)) terminalGrants.delete(key);
    },
  };
}
