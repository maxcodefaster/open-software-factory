import { and, asc, desc, eq, exists, sql as expression, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  administrator,
  change,
  developmentWorkspace,
  projectMembership,
  runtimeAttempt,
  ticket,
  workspaceShare,
} from "#db/schema";
import { workspaceShareInput } from "#workspace-domain/sharing";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { appRuntimeOrigin } from "../runtime-origins";
import type { createWorkspaceLifecycle } from "../workspace/api";
import {
  type ExternalToolContext,
  lifecycleInput,
  openWorkspaceInput,
  resolveOpenWorkspaceTarget,
  resolveStartWorkspaceTarget,
  startWorkspaceInput,
  workspaceInput,
} from "./external-schemas";

async function currentAttemptID(
  database: ReturnType<typeof createDatabase>,
  workspaceID: string,
): Promise<string | null> {
  const [attempt] = await drizzleTransaction(database.client)
    .select({ id: runtimeAttempt.id })
    .from(runtimeAttempt)
    .where(eq(runtimeAttempt.workspaceId, workspaceID))
    .orderBy(desc(runtimeAttempt.generation))
    .limit(1);
  return attempt?.id ?? null;
}

export function registerWorkspaceTools(
  { services, actor, tool }: ExternalToolContext,
  lifecycle: ReturnType<typeof createWorkspaceLifecycle>,
) {
  const {
    database,
    factoryOrigin,
    workspaceSources,
    workspaceSharing,
    runtimeController,
    runtimeAccess,
    runtimeHub,
  } = services;
  const userID = actor.userID;

  tool(
    "listTicketWorkspaces",
    "List retained Ticket Changes and whether canonical Workspace source has been prepared. This reads saved decisions; it starts neither compute nor inference.",
    z.strictObject({
      projectID: z.uuid(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(100).default(50),
    }),
    false,
    async (input) => {
      await database.client.begin((sql) =>
        projectDevelopmentAuthorityIn(sql, userID, input.projectID),
      );
      const rows = await drizzleTransaction(database.client)
        .select({
          changeID: change.id,
          ticketID: ticket.id,
          title: ticket.title,
          state: change.state,
          workspaceID: developmentWorkspace.id,
        })
        .from(change)
        .innerJoin(ticket, eq(ticket.id, change.ticketId))
        .leftJoin(developmentWorkspace, eq(developmentWorkspace.changeId, change.id))
        .where(
          and(
            eq(change.projectId, input.projectID),
            isNull(change.cancelRequestedAt),
            isNull(ticket.trashedAt),
            inArray(change.state, ["starting", "active", "failed"]),
          ),
        )
        .orderBy(desc(change.createdAt), desc(change.id))
        .offset(input.offset)
        .limit(input.limit + 1);
      return {
        workspaces: rows.slice(0, input.limit),
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
      };
    },
  );

  tool(
    "getWorkspaceEditing",
    "Observe current editing permission and the exact Ticket writer epoch without acquiring editing or waking compute.",
    workspaceInput,
    false,
    async (input) => {
      const access = await database.client.begin((sql) =>
        workspaceAuthorityIn(sql, input.workspaceID, userID),
      );
      return access.changeID
        ? services.writers.view(access.changeID, userID)
        : {
            kind: "personal",
            canWrite: access.permission === "collaborate",
            collaborative: access.collaborative,
          };
    },
  );

  tool(
    "takeOverTicketEditing",
    "Deliberately take over the exact observed Ticket writer epoch through Factory's existing handoff. This stops and fences previous Agent work, but grants no requirements or Delivery approval and starts no inference. Active human editing still follows Factory's request/release rules.",
    workspaceInput.extend({
      requestID: z.uuid(),
      epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    true,
    async (input) => {
      const access = await database.client.begin((sql) =>
        workspaceAuthorityIn(sql, input.workspaceID, userID, true),
      );
      if (!access.changeID)
        throw new CommandError(
          "invalid",
          "Personal Workspaces do not have a Ticket writer handoff",
        );
      return services.writers.takeOver(
        access.changeID,
        userID,
        input.requestID,
        undefined,
        undefined,
        input.epoch,
      );
    },
  );

  tool(
    "listProjects",
    "List Projects currently accessible to your Factory account. Starts no compute or inference.",
    z.strictObject({}),
    false,
    () => services.projects.list(userID),
  );

  tool(
    "listWorkspaces",
    "List authorized retained Workspaces, including explicitly shared personal Workspaces. Does not start compute.",
    z.strictObject({ projectID: z.uuid().optional() }),
    false,
    async ({ projectID }) => {
      if (projectID)
        await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
      const db = drizzleTransaction(database.client);
      const rows = await db
        .select({
          workspaceID: developmentWorkspace.id,
          projectID: developmentWorkspace.projectId,
          kind: developmentWorkspace.kind,
          ownerID: developmentWorkspace.ownerUserId,
          changeID: developmentWorkspace.changeId,
          collaborative: developmentWorkspace.collaborationEnabled,
        })
        .from(developmentWorkspace)
        .where(
          and(
            projectID ? eq(developmentWorkspace.projectId, projectID) : undefined,
            or(
              exists(
                db
                  .select({ userID: administrator.userId })
                  .from(administrator)
                  .where(eq(administrator.userId, userID)),
              ),
              exists(
                db
                  .select({ userID: projectMembership.userId })
                  .from(projectMembership)
                  .where(
                    and(
                      eq(projectMembership.projectId, developmentWorkspace.projectId),
                      eq(projectMembership.userId, userID),
                      eq(projectMembership.role, "developer"),
                    ),
                  ),
              ),
            ),
            or(
              eq(developmentWorkspace.kind, "ticket"),
              eq(developmentWorkspace.ownerUserId, userID),
              exists(
                db
                  .select({ userID: workspaceShare.userId })
                  .from(workspaceShare)
                  .where(
                    and(
                      eq(workspaceShare.workspaceId, developmentWorkspace.id),
                      eq(workspaceShare.userId, userID),
                      isNull(workspaceShare.revokedAt),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(asc(developmentWorkspace.createdAt), asc(developmentWorkspace.id));
      return { workspaces: rows };
    },
  );

  tool(
    "openWorkspace",
    "Open retained source for an existing Workspace, Ticket Change or your personal Project Workspace. Current files may wake paused compute; this never starts an Agent.",
    openWorkspaceInput,
    true,
    async (input) => {
      const resolved = resolveOpenWorkspaceTarget(input);
      switch (resolved.target) {
        case "workspace":
          return workspaceSources.ensure(resolved.workspaceID, userID);
        case "change":
          return workspaceSources.ensureChange(resolved.changeID, userID);
        case "project":
          return workspaceSources.ensurePersonal(resolved.projectID, userID);
      }
    },
  );

  tool(
    "getWorkspace",
    "Observe exact Workspace access, source and Runtime Attempt. No automatic Start or Resume.",
    workspaceInput,
    false,
    async ({ workspaceID }) => {
      const access = await database.client.begin((sql) =>
        workspaceAuthorityIn(sql, workspaceID, userID),
      );
      const attemptID = await currentAttemptID(database, workspaceID);
      return {
        workspaceID,
        ...access,
        runtime: attemptID ? await runtimeController.get(attemptID) : null,
      };
    },
  );

  tool(
    "startWorkspace",
    "Explicitly start or resume your Workspace's retained native environment, including first initialization of your personal Project Workspace. Choose exactly one projectID or workspaceID. Use one requestID per deliberate operation; reuse it only to observe that operation.",
    startWorkspaceInput,
    true,
    (input) => {
      const resolved = resolveStartWorkspaceTarget(input);
      return resolved.target === "workspace"
        ? lifecycle.start(userID, {
            workspaceID: resolved.workspaceID,
            requestID: resolved.requestID,
          })
        : lifecycle.start(userID, {
            projectID: resolved.projectID,
            requestID: resolved.requestID,
          });
    },
  );

  tool(
    "pauseWorkspace",
    "Durably pause shared Workspace compute for all participants, retaining its native Actor and files. startWorkspace resumes it. This is not deletion or Coding Stop. Use one requestID per deliberate operation; reuse it only to observe that operation. Unknown outcomes are not success.",
    lifecycleInput,
    true,
    (input) => lifecycle.pause(userID, input),
  );

  tool(
    "shareWorkspace",
    "Record an explicit owner decision granting observation/collaboration or removing access. Removal never stops shared compute or admitted jobs.",
    workspaceShareInput,
    true,
    (input) => workspaceSharing.decide(userID, input),
  );

  tool(
    "getPreview",
    "Get a private one-use Preview link for a declared App. The local browser uses it; browser credentials are not copied into Factory.",
    workspaceInput.extend({
      app: z
        .string()
        .regex(/^app(?:-[a-z][a-z0-9-]{0,26})?$/)
        .default("app"),
    }),
    false,
    async ({ workspaceID, app }) => {
      await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID));
      const attemptID = await currentAttemptID(database, workspaceID);
      if (!attemptID) throw new CommandError("not-found", "No Workspace execution exists");
      const [declared] = await drizzleTransaction(database.client)
        .select({ id: runtimeAttempt.id })
        .from(runtimeAttempt)
        .where(
          and(
            eq(runtimeAttempt.id, attemptID),
            expression`${runtimeAttempt.declaredApps} @> ${JSON.stringify([app])}::jsonb`,
          ),
        );
      if (!declared) throw new CommandError("not-found", "Declared App not found");
      const token = await runtimeAccess.issue({
        attemptID,
        channel: "app",
        appChannel: app,
        userID,
        sessionID: actor.sessionID,
        expires: Date.now() + 8 * 60 * 60_000,
        mode: "top-level",
      });
      const url = new URL(
        `/runtime/${attemptID}/preview/${app}/`,
        appRuntimeOrigin(factoryOrigin, attemptID, app),
      );
      url.searchParams.set("factory-grant", token);
      return {
        workspaceID,
        attemptID,
        app,
        url: url.href,
        connected: runtimeHub.connected(attemptID),
      };
    },
  );
}
