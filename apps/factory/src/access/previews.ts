import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import { parseSystemContract } from "../../../../packages/system-contract/src/system-contract";
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
      repository: factoryForgeSource(repositoryURL, apiURL, owner),
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
    const [staging] = await database.client<
      {
        repositoryURL: string;
        defaultBranch: string;
        revision: string | null;
        attemptID: string | null;
        state: string | null;
      }[]
    >`
      SELECT project.repository_url AS "repositoryURL",project.default_branch AS "defaultBranch",
        preview.revision,attempt.id AS "attemptID",attempt.state
      FROM factory.project project
      LEFT JOIN factory.staging_preview preview ON preview.project_id=project.id
      LEFT JOIN factory.runtime_attempt attempt ON attempt.id=preview.runtime_attempt_id
      WHERE project.id=${projectID} AND (preview.runtime_attempt_id IS NOT NULL OR EXISTS(
        SELECT 1 FROM factory.project_setup_readiness readiness
        WHERE readiness.project_id=project.id AND readiness.task='configuration' AND readiness.state='ready'
      ))`;
    const attempts = await database.client<
      {
        id: string;
        owner: string | null;
        title: string | null;
        apps: unknown;
        state: string;
        revision: string;
        repositoryURL: string;
      }[]
    >`
      SELECT attempt.id,person.name AS owner,ticket.title,attempt.declared_apps AS apps,
        attempt.state,attempt.revision,project.repository_url AS "repositoryURL"
      FROM factory.runtime_attempt attempt
      JOIN factory.project project ON project.id=attempt.project_id
      JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      LEFT JOIN auth."user" person ON person.id=workspace.owner_user_id
      LEFT JOIN factory.change change ON change.id=workspace.change_id
      LEFT JOIN factory.ticket ticket ON ticket.id=change.ticket_id
      WHERE attempt.project_id=${projectID} AND attempt.state IN ('create-intended','ready','pausing','paused','resuming','starting')
        AND (workspace.kind='personal' OR change.runtime_attempt_id=attempt.id AND ticket.trashed_at IS NULL)
        AND (workspace.kind<>'personal' OR (
          (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=${userID}) OR EXISTS(
            SELECT 1 FROM factory.project_membership WHERE project_id=${projectID} AND user_id=${userID} AND role='developer'))
          AND (workspace.owner_user_id=${userID} OR EXISTS(SELECT 1 FROM factory.workspace_share
            WHERE workspace_id=workspace.id AND user_id=${userID} AND revoked_at IS NULL))))
      ORDER BY attempt.created_at DESC LIMIT 100`;
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
