import { and, desc, eq, exists, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  administrator,
  authUser,
  change,
  developmentWorkspace,
  operation,
  project,
  projectMembership,
  runtimeAttempt,
  ticket,
  workspaceShare,
} from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { parseSystemContract } from "#system-contract/system-contract";
import { factoryForgeSource } from "../knowledge/forge-source";
import { createAccessController } from "./controller";

export type PreviewProcess = { state: string; exitCode?: number };

const declaredApps = z.array(z.string().regex(/^app(?:-[a-z][a-z0-9-]{0,26})?$/)).max(64);

export function createProjectAppPreviews(
  database: ReturnType<typeof createDatabase>,
  channels: (attemptID: string) => readonly string[],
  processes: (attemptID: string, channel: string) => PreviewProcess | undefined = () => undefined,
) {
  const access = createAccessController(database);
  const contracts = new Map<string, Promise<{ channel: string; label: string; port: number }[]>>();
  function source(repositoryURL: string) {
    const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
    const owner = process.env["FACTORY_FORGEJO_OWNER"];
    const token = process.env["FACTORY_FORGEJO_TOKEN"];
    if (!apiURL || !owner || !token) throw new Error("Factory Forgejo is unavailable");
    return {
      repository: factoryForgeSource(
        repositoryURL,
        apiURL,
        owner,
        process.env["FACTORY_FORGEJO_PUBLIC_URL"],
      ),
      forge: createForgejoClient({ apiURL, token }),
    };
  }
  function contractApps(repositoryURL: string, revision: string) {
    const key = `${repositoryURL}:${revision}`;
    const retained = contracts.get(key);
    if (retained) return retained;
    const read = (async () => {
      const { repository, forge } = source(repositoryURL);
      const contract = parseSystemContract(
        await forge.getFile(repository, ".factory/system.json", revision),
      );
      return contract.apps.map((app) => ({
        channel: app.id === contract.primaryApp ? "app" : `app-${app.id}`,
        label: app.label,
        port: app.port,
      }));
    })();
    contracts.set(key, read);
    if (contracts.size > 64) {
      const oldest = contracts.keys().next().value;
      if (oldest) contracts.delete(oldest);
    }
    void read.catch(() => {
      if (contracts.get(key) === read) contracts.delete(key);
    });
    return read;
  }
  return async (projectID: string, userID: string) => {
    await access.requireProject(userID, projectID);
    const db = drizzleTransaction(database.client);
    const stagingPreview = alias(operation, "staging_preview");
    const [staging] = await db
      .select({
        repositoryURL: project.repositoryUrl,
        defaultBranch: project.defaultBranch,
        revision: sql<string | null>`${stagingPreview.payload}->>'revision'`,
        attemptID: runtimeAttempt.id,
        state: runtimeAttempt.state,
      })
      .from(project)
      .leftJoin(
        stagingPreview,
        and(
          eq(stagingPreview.kind, "delivery.staging_preview"),
          eq(stagingPreview.scopeType, "project"),
          eq(stagingPreview.scopeId, sql`${project.id}::text`),
        ),
      )
      .leftJoin(
        runtimeAttempt,
        eq(sql`${runtimeAttempt.id}::text`, sql`${stagingPreview.payload}->>'runtimeAttemptId'`),
      )
      .where(
        and(
          eq(project.id, projectID),
          or(
            sql`(${stagingPreview.payload}->>'runtimeAttemptId') IS NOT NULL`,
            exists(
              db
                .select({ id: operation.id })
                .from(operation)
                .where(
                  and(
                    eq(operation.kind, "projects.setup_readiness"),
                    eq(operation.scopeType, "project"),
                    eq(operation.scopeId, projectID),
                    eq(
                      operation.idempotencyKey,
                      `projects.setup_readiness:${projectID}:configuration`,
                    ),
                    eq(operation.state, "ready"),
                  ),
                ),
            ),
          ),
        ),
      );
    const attempts = await db
      .select({
        id: runtimeAttempt.id,
        owner: authUser.name,
        title: ticket.title,
        apps: runtimeAttempt.declaredApps,
        state: runtimeAttempt.state,
        revision: runtimeAttempt.revision,
        repositoryURL: project.repositoryUrl,
      })
      .from(runtimeAttempt)
      .innerJoin(project, eq(project.id, runtimeAttempt.projectId))
      .innerJoin(developmentWorkspace, eq(developmentWorkspace.id, runtimeAttempt.workspaceId))
      .leftJoin(authUser, eq(authUser.id, developmentWorkspace.ownerUserId))
      .leftJoin(change, eq(change.id, developmentWorkspace.changeId))
      .leftJoin(ticket, eq(ticket.id, change.ticketId))
      .where(
        and(
          eq(runtimeAttempt.projectId, projectID),
          inArray(runtimeAttempt.state, [
            "create-intended",
            "ready",
            "pausing",
            "paused",
            "resuming",
            "starting",
          ]),
          or(
            eq(developmentWorkspace.kind, "personal"),
            and(eq(change.runtimeAttemptId, runtimeAttempt.id), isNull(ticket.trashedAt)),
          ),
          or(
            ne(developmentWorkspace.kind, "personal"),
            and(
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
                        eq(projectMembership.projectId, projectID),
                        eq(projectMembership.userId, userID),
                        eq(projectMembership.role, "developer"),
                      ),
                    ),
                ),
              ),
              or(
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
          ),
        ),
      )
      .orderBy(desc(runtimeAttempt.createdAt))
      .limit(100);
    const development: {
      attemptID: string;
      projectID: string;
      channel: string;
      label: string;
      state: string;
      port?: number;
      process?: PreviewProcess;
    }[] = [];
    // The Staging branch and contract reads share nothing with the development
    // reads below. Start them first so one Forge round trip is not added after.
    const stagingRead = staging
      ? (async () => {
          let revision = staging.revision;
          if (!revision) {
            const { repository, forge } = source(staging.repositoryURL);
            const branch = await forge.getBranch(repository, staging.defaultBranch);
            if (!branch) throw new Error("Project Preview source branch is unavailable");
            revision = branch.headSha;
          }
          return contractApps(staging.repositoryURL, revision);
        })()
      : null;
    stagingRead?.catch(() => {});
    const nameReads = new Map<string, ReturnType<typeof contractApps>>();
    for (let offset = 0; offset < attempts.length; offset += 4) {
      const batch = await Promise.all(
        attempts.slice(offset, offset + 4).map(async (attempt) => {
          const retained = declaredApps.parse(attempt.apps);
          const visible = retained.length ? retained : channels(attempt.id);
          if (!visible.length) return [];
          // The exact execution revision owns names, not the current branch or
          // mutable checkout. Coalesce failures within this read as well, while
          // allowing a later observation to recover from a temporary Forge outage.
          const key = `${attempt.repositoryURL}:${attempt.revision}`;
          let names = nameReads.get(key);
          if (!names) {
            names = contractApps(attempt.repositoryURL, attempt.revision).catch(() => []);
            nameReads.set(key, names);
          }
          const labels = await names;
          return visible.map((channel) => {
            const declared = labels.find((app) => app.channel === channel);
            const process = processes(attempt.id, channel);
            return {
              attemptID: attempt.id,
              projectID,
              channel,
              label: `${declared?.label ?? (channel === "app" ? "App" : channel.slice(4))} · ${
                attempt.title ?? attempt.owner ?? "Development"
              }`,
              state: attempt.state,
              ...(declared ? { port: declared.port } : {}),
              ...(process ? { process } : {}),
            };
          });
        }),
      );
      development.push(...batch.flat());
    }
    if (!staging || !stagingRead) return development;
    const apps = await stagingRead;
    const usable = [
      "create-intended",
      "starting",
      "ready",
      "pausing",
      "paused",
      "resuming",
    ].includes(staging.state ?? "");
    // Discovering declared Apps is a read. Only an explicit selection may
    // commission their compute; terminal attempts are not live access targets.
    return [
      ...apps.map(({ channel, label, port }) => {
        const process =
          usable && staging.attemptID ? processes(staging.attemptID, channel) : undefined;
        return {
          ...(usable && staging.attemptID ? { attemptID: staging.attemptID } : {}),
          projectID,
          channel,
          label: `Staging · ${label}`,
          state: staging.state ?? "not-started",
          port,
          ...(process ? { process } : {}),
        };
      }),
      ...development,
    ];
  };
}
