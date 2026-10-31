import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient, ForgeRepository } from "../../../../packages/forge/src/forge";
import type { createForgejoReleases } from "../../../../packages/forge/src/releases";
import {
  externalAccessInput,
  publishRelease,
  type ReleaseArtifact,
  releaseArtifact,
  releaseContract,
  releasePackageOwner,
  releaseSettingsView,
  versionSuggestions,
} from "../../../../packages/project-domain/src/release";
import { runtimePublicationToken } from "../../../../packages/runtime-domain/src/identity";
import {
  createAccessController,
  projectAuthorityIn,
  projectDevelopmentAuthorityIn,
} from "../access/controller";
import { CommandError } from "../command-error";
import type { ReleaseSecrets } from "./secrets";
import { publicationWorkflow, validatePublicationWorkflow } from "./workflow";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
type ReleaseRow = {
  id: string;
  projectID: string;
  version: string;
  commitSHA: string;
  notes: string;
  state: string;
  createdBy: string;
  contract: z.output<typeof releaseContract> | null;
  attemptID: string;
  runID: number | null;
  runnerID: number | null;
  runnerUUID: string | null;
  runnerToken: string | null;
  jobHandle: string | null;
  runtimeAttemptID: string | null;
  attemptState: string;
  ended: boolean;
  artifacts: ReleaseArtifact[];
  dispatchIntended: boolean;
};
export type PublicationRuntime = {
  startPublication(id: string, userID: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
};
export function createReleaseController(options: {
  database: Database;
  secrets: ReleaseSecrets;
  signingKey: string;
  runtime: PublicationRuntime;
  forge: ReturnType<typeof createForgejoClient>;
  publication: ReturnType<typeof createForgejoReleases>;
  apiURL: string;
  publicURL: string;
  owner: string;
}) {
  const { database, forge, publication, secrets, runtime } = options;
  const access = createAccessController(database);
  function repository(url: string): ForgeRepository {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    const [owner, name] = parts;
    const allowed = [new URL(options.apiURL).origin, new URL(options.publicURL).origin];
    if (
      !allowed.includes(parsed.origin) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parts.length !== 2 ||
      owner !== options.owner ||
      !name
    )
      throw new CommandError(
        "conflict",
        "Project does not identify the configured Forgejo repository",
      );
    return { owner, name };
  }
  async function project(projectID: string) {
    const [row] = await database.client<{ repositoryURL: string; branch: string }[]>`
      SELECT repository_url AS "repositoryURL", default_branch AS branch FROM factory.project WHERE id=${projectID}`;
    if (!row) throw new CommandError("not-found", "Project not found");
    return { ...row, repository: repository(row.repositoryURL) };
  }
  async function configuration(repo: ForgeRepository, sha: string) {
    const source = await forge.getOptionalFile(repo, ".factory/release.json", sha);
    if (source === null) return null;
    if (source.length > 65_536) throw new Error("Release contract is too large");
    const contract = releaseContract.parse(JSON.parse(source));
    if (
      (contract.images.length || contract.chart) &&
      new URL(options.publicURL).protocol !== "https:"
    )
      throw new CommandError(
        "unavailable",
        "Configure an HTTPS Forgejo public origin before publishing images or charts",
      );
    const workflow = await forge.getOptionalFile(repo, publicationWorkflow, sha);
    if (workflow === null)
      throw new Error("Add .forgejo/workflows/factory-release.yml through a reviewed Change");
    validatePublicationWorkflow(workflow);
    return contract;
  }
  async function candidate(projectID: string) {
    const [row] = await database.client<{ sha: string }[]>`
      SELECT staging.revision AS sha FROM factory.staging_preview staging
      JOIN factory.runtime_attempt runtime ON runtime.id=staging.runtime_attempt_id AND runtime.state='ready'
      WHERE staging.project_id=${projectID} AND EXISTS(
        SELECT 1 FROM factory.current_promotion promotion WHERE promotion.project_id=${projectID}
        AND promotion.commit_sha=staging.revision AND promotion.state='succeeded')`;
    return row?.sha ?? null;
  }
  async function lock<T>(key: string, execute: (sql: SQL) => Promise<T>): Promise<T> {
    const sql = database.coordination();
    try {
      await sql`SELECT pg_advisory_lock(hashtextextended(${`release:${key}`},0))`;
      return await execute(sql);
    } finally {
      try {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${`release:${key}`},0))`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  }
  async function authorize(sql: SQL, userID: string, projectID: string, manage = false) {
    await sql.begin(async (tx) => {
      await projectAuthorityIn(tx, userID, projectID, manage);
      await projectDevelopmentAuthorityIn(tx, userID, projectID);
    });
  }
  async function record(id: string) {
    const [row] = await database.client<ReleaseRow[]>`
      SELECT release.id,release.project_id AS "projectID",release.version,release.commit_sha AS "commitSHA",
        release.notes,release.state,release.contract,release.artifacts,release.created_by AS "createdBy",release.ended_at IS NOT NULL AS ended,
        attempt.id AS "attemptID",attempt.state AS "attemptState",attempt.run_id::float8 AS "runID",
        attempt.dispatch_intended_at IS NOT NULL AS "dispatchIntended",
        attempt.runner_id::float8 AS "runnerID",attempt.runner_uuid AS "runnerUUID",
        attempt.runner_token AS "runnerToken",attempt.job_handle AS "jobHandle",attempt.runtime_attempt_id AS "runtimeAttemptID"
      FROM factory.project_release release JOIN LATERAL(
        SELECT * FROM factory.release_attempt WHERE release_id=release.id ORDER BY ordinal DESC LIMIT 1
      ) attempt ON true WHERE release.id=${id}`;
    return row;
  }
  async function state(row: ReleaseRow, next: string, failure: string | null = null) {
    await database.client.begin(async (sql) => {
      await sql`UPDATE factory.release_attempt SET state=${next} WHERE id=${row.attemptID}`;
      await sql`UPDATE factory.project_release SET state=${next},failure=${failure}
        WHERE id=${row.id} AND state <> 'published'`;
    });
    row.state = next;
    row.attemptState = next;
  }
  async function provisionGrant(id: string) {
    const [grant] = await database.client<
      {
        projectID: string;
        username: string;
        secretKey: string;
        scope: "git" | "packages" | "publish";
      }[]
    >`SELECT project_id AS "projectID",username,secret_key AS "secretKey",scope FROM factory.release_access WHERE id=${id}`;
    if (!grant || !secrets.configured)
      throw new CommandError("unavailable", "Release credential store is unavailable");
    let credential = await secrets.read(grant.secretKey);
    if (!credential) {
      const intended = {
        username: grant.username,
        password: crypto.randomUUID() + crypto.randomUUID(),
      };
      try {
        await secrets.create(grant.secretKey, intended);
      } catch {
        /* A lost acknowledgement is recovered by reading the same secret identity. */
      }
      credential = await secrets.read(grant.secretKey);
      if (!credential)
        throw new CommandError("unavailable", "Machine credential outcome is unconfirmed");
    }
    await publication.ensureMachine(credential.username, credential.password);
    const context = await project(grant.projectID);
    if (grant.scope === "git") await publication.gitGrant(context.repository, grant.username);
    else
      await publication.packageGrant(
        releasePackageOwner(grant.projectID),
        grant.username,
        grant.scope === "publish",
      );
    return { ...grant, ...credential, repository: context.repository };
  }
  async function grantIntent(
    sql: SQL,
    projectID: string,
    userID: string,
    id: string,
    name: string,
    scope: string,
    releaseID?: string,
    replacesID?: string,
  ) {
    const username = `fr-${id.replaceAll("-", "")}`;
    await sql`INSERT INTO factory.release_access(id,project_id,command_id,name,scope,state,username,secret_key,created_by,release_id,replaces_id)
      VALUES(${id},${projectID},${id},${name},${scope},'pending',${username},${`release-access/${projectID}/${id}`},${userID},${releaseID ?? null},${replacesID ?? null})`;
  }
  async function revoke(id: string) {
    const [grant] = await database.client<{ projectID: string; username: string; state: string }[]>`
      SELECT project_id AS "projectID",username,state FROM factory.release_access WHERE id=${id}`;
    if (!grant || grant.state === "revoked") return;
    await database.client`UPDATE factory.release_access SET state='revoking' WHERE id=${id}`;
    const context = await project(grant.projectID);
    await publication.revokeMachine(
      context.repository,
      releasePackageOwner(grant.projectID),
      grant.username,
    );
    await database.client`UPDATE factory.release_access SET state='revoked',revoked_at=now() WHERE id=${id}`;
  }
  async function cleanup(row: ReleaseRow) {
    const grants = await database.client<{ id: string }[]>`
      SELECT id FROM factory.release_access WHERE release_id=${row.id} AND state <> 'revoked'`;
    for (const grant of grants) await revoke(grant.id);
    if (row.runtimeAttemptID) await runtime.stop(row.runtimeAttemptID);
    if (row.runnerID) {
      const context = await project(row.projectID);
      await forge.deleteRunner(context.repository, row.runnerID);
    }
    await database.client`UPDATE factory.release_attempt SET cleaned_at=now(),runner_token=NULL WHERE id=${row.attemptID}`;
  }
  async function reconcileOne(id: string) {
    return lock(id, async (sql) => {
      const row = await record(id);
      if (!row) return;
      if (row.ended || ["published", "failed"].includes(row.state)) {
        await cleanup(row);
        return;
      }
      try {
        await authorize(sql, row.createdBy, row.projectID);
        const context = await project(row.projectID);
        if (row.contract) {
          if (!row.runID && row.dispatchIntended) {
            const matching = (await publication.runs(context.repository, row.commitSHA)).filter(
              (value) => {
                try {
                  return (
                    value.event === "workflow_dispatch" &&
                    value.workflow_id === "factory-release.yml" &&
                    JSON.parse(value.event_payload).inputs?.factory_release_id === row.attemptID &&
                    value.trigger_user.login === context.repository.owner
                  );
                } catch {
                  return false;
                }
              },
            );
            const [run] = matching;
            if (matching.length !== 1 || !run) {
              await state(
                row,
                "uncertain",
                "Publication dispatch outcome is unconfirmed. Check outcome before retrying.",
              );
              return;
            }
            row.runID = run.id;
          }
          if (!row.runID) {
            await publication.protectReleaseTags(context.repository);
            await state(row, "dispatching");
            await sql`UPDATE factory.release_attempt SET dispatch_intended_at=now() WHERE id=${row.attemptID} AND dispatch_intended_at IS NULL`;
            const admitted = await sql.begin(async (tx) => {
              await projectDevelopmentAuthorityIn(tx, row.createdBy, row.projectID);
              return publication.dispatch(
                context.repository,
                row.commitSHA,
                row.attemptID,
                row.version,
                releasePackageOwner(row.projectID),
              );
            });
            if (admitted.jobs.length !== 1)
              throw new Error("Publication run must contain exactly one job");
            row.runID = admitted.id;
          }
          await sql`UPDATE factory.release_attempt SET run_id=${row.runID} WHERE id=${row.attemptID}`;
          const observed = await publication.run(context.repository, row.runID);
          if (
            !observed ||
            observed.id !== row.runID ||
            observed.commit_sha !== row.commitSHA ||
            observed.event !== "workflow_dispatch" ||
            observed.workflow_id !== "factory-release.yml" ||
            observed.trigger_user.login !== context.repository.owner ||
            JSON.parse(observed.event_payload).inputs?.factory_release_id !== row.attemptID ||
            JSON.parse(observed.event_payload).inputs?.version !== row.version ||
            JSON.parse(observed.event_payload).inputs?.package_owner !==
              releasePackageOwner(row.projectID)
          )
            throw new Error("Publication run identity differs from its admitted commit and inputs");
          await sql`UPDATE factory.project_release SET run_id=${observed.id},run_url=${observed.html_url} WHERE id=${row.id}`;
          if (["failure", "cancelled", "skipped"].includes(observed.status)) {
            await state(
              row,
              "failed",
              "Publication workflow did not succeed. Inspect the native Forgejo run.",
            );
            await cleanup(row);
            return;
          }
          if (observed.status !== "success") {
            if (row.runtimeAttemptID) {
              const [attempt] = await sql<
                { state: string }[]
              >`SELECT state FROM factory.runtime_attempt WHERE id=${row.runtimeAttemptID}`;
              if (attempt && ["failed", "stopped", "cleanup-failed"].includes(attempt.state)) {
                await state(
                  row,
                  "failed",
                  "Publication Sandbox ended. Existing artifacts are retained; use a new version for another build.",
                );
                await cleanup(row);
                return;
              }
            }
            if (!row.jobHandle) {
              const jobs = await publication.jobs(
                context.repository,
                `factory-release-${row.attemptID}`,
              );
              if (!jobs.length) {
                await state(row, "running");
                return;
              }
              const [job] = jobs;
              if (jobs.length !== 1 || !job)
                throw new Error("Publication job identity is missing or ambiguous");
              row.jobHandle = job.handle;
              await sql`UPDATE factory.release_attempt SET job_handle=${row.jobHandle} WHERE id=${row.attemptID}`;
            }
            if (!row.runnerUUID) {
              const runner = await forge.registerEphemeralRunner(
                context.repository,
                `factory-release-${row.attemptID}`,
              );
              row.runnerID = runner.id;
              row.runnerUUID = runner.uuid;
              row.runnerToken = runner.token;
              await sql`UPDATE factory.release_attempt SET runner_id=${runner.id},runner_uuid=${runner.uuid},runner_token=${runner.token} WHERE id=${row.attemptID}`;
            }
            await state(row, "running");
            await runtime.startPublication(row.attemptID, row.createdBy);
            return;
          }
          await state(row, "checking");
          const [grant] = await sql<{ id: string; username: string }[]>`
            SELECT id,username FROM factory.release_access WHERE release_id=${row.id} AND scope='publish' AND state='active'`;
          if (!grant) throw new Error("Publication credential receipt is missing");
          const credential = await secrets.read(`release-publish/${row.projectID}/${grant.id}`);
          if (!credential?.token) throw new Error("Publication credential receipt is unavailable");
          const artifacts: ReleaseArtifact[] = [];
          for (const [kind, name] of [
            ...row.contract.images.map((name) => ["image", name] as const),
            ...(row.contract.chart ? [["chart", row.contract.chart] as const] : []),
          ]) {
            const observed = await publication.manifest(
              releasePackageOwner(row.projectID),
              name,
              row.version,
              credential.username,
              credential.token,
            );
            if ((kind === "chart") !== observed.helm)
              throw new Error("Artifact type differs from the release contract");
            artifacts.push(releaseArtifact.parse({ kind, name, digest: observed.digest }));
          }
          for (const file of row.contract.files) {
            const digest = await publication.genericFile(
              releasePackageOwner(row.projectID),
              file.name,
              row.version,
              file.filename,
              credential.username,
              credential.token,
            );
            artifacts.push(releaseArtifact.parse({ kind: "file", ...file, digest }));
          }
          if (
            row.artifacts.length &&
            JSON.stringify(releaseArtifact.array().parse(row.artifacts)) !==
              JSON.stringify(artifacts)
          )
            throw new Error(
              "Published artifact references changed after their identities were recorded",
            );
          if (!row.artifacts.length)
            await sql`UPDATE factory.project_release SET artifacts=${JSON.stringify(artifacts)}::text::jsonb WHERE id=${row.id}`;
          row.artifacts = artifacts;
        }
        await state(row, "publishing");
        // The immutable intent exists before the native tag/Release write.
        await authorize(sql, row.createdBy, row.projectID);
        const url = await sql.begin(async (tx) => {
          await projectDevelopmentAuthorityIn(tx, row.createdBy, row.projectID);
          const receipt = row.artifacts.map((artifact) =>
            artifact.kind === "file"
              ? `- ${artifact.name}/${artifact.filename}: \`${artifact.digest}\``
              : `- ${releasePackageOwner(row.projectID)}/${artifact.name}@${artifact.digest}`,
          );
          return publication.ensureRelease(
            context.repository,
            row.version,
            row.commitSHA,
            `${row.notes}\n\nSource: \`${row.commitSHA}\`${receipt.length ? `\n\nArtifacts:\n${receipt.join("\n")}` : ""}\n\n<!-- factory-release:${row.id} -->`,
          );
        });
        await sql.begin(async (tx) => {
          await tx`UPDATE factory.release_attempt SET state='published' WHERE id=${row.attemptID}`;
          await tx`UPDATE factory.project_release SET state='published',release_url=${url},published_at=now(),failure=NULL WHERE id=${row.id} AND state='publishing'`;
        });
        row.state = "published";
        await cleanup(row);
      } catch (cause) {
        if (row.state === "published") return;
        if (cause instanceof CommandError && ["forbidden", "not-found"].includes(cause.code)) {
          await state(row, "failed", "Publication authority ended");
          await cleanup(row);
        } else {
          const message = cause instanceof Error ? cause.message : "";
          const safe = new Set([
            "Publication run identity differs from its admitted commit and inputs",
            "Publication job identity is missing or ambiguous",
            "Publication credential receipt is missing",
            "Publication credential receipt is unavailable",
            "Expected release artifact is unavailable",
            "Expected generic package is unavailable",
            "Expected release file is unavailable",
            "Registry manifest digest mismatch",
            "Published artifact references changed after their identities were recorded",
          ]);
          await state(
            row,
            "uncertain",
            safe.has(message) || /^Forgejo publication operation failed \(\d{3}\)$/.test(message)
              ? message
              : "Publication outcome needs reconciliation. Existing artifacts have not been rolled back.",
          );
        }
      }
    });
  }
  return {
    async view(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      const canPublish = await access.canDevelop(userID, projectID);
      let canManageAccess = false;
      if (canPublish) {
        try {
          await access.requireProject(userID, projectID, true);
          canManageAccess = true;
        } catch {
          /* read-only */
        }
      }
      const context = await project(projectID);
      const sha = await candidate(projectID);
      let contract: z.output<typeof releaseContract> | null = null;
      let configurationError: string | null = null;
      if (sha) {
        try {
          contract = await configuration(context.repository, sha);
        } catch (cause) {
          configurationError =
            cause instanceof CommandError && cause.code === "unavailable"
              ? cause.message
              : "Release configuration is invalid. Check .factory/release.json and the single-job release workflow.";
        }
      }
      const releases = await database.client`
        SELECT id,version,commit_sha AS "commitSHA",state,notes,created_at::text AS "createdAt",
          published_at::text AS "publishedAt",ended_at::text AS "endedAt",run_url AS "runURL",release_url AS "releaseURL",failure,artifacts
        FROM factory.project_release WHERE project_id=${projectID} ORDER BY created_at DESC LIMIT 100`;
      const grants = await database.client`
        SELECT id,name,scope,state,created_at::text AS "createdAt",username
        FROM factory.release_access WHERE project_id=${projectID} AND scope <> 'publish' ORDER BY created_at DESC`;
      const [lastPublished] = await database.client<{ version: string }[]>`
        SELECT version FROM factory.project_release WHERE project_id=${projectID} AND state='published'
        ORDER BY published_at DESC,id DESC LIMIT 1`;
      const lastVersion = lastPublished?.version;
      return releaseSettingsView.parse({
        canPublish,
        canManageAccess,
        configured: publication.configuredAccess && secrets.configured,
        candidateSHA: sha,
        lastVersion: lastVersion ?? null,
        suggestions: versionSuggestions(lastVersion ?? null),
        repositoryURL: `${new URL(options.publicURL).origin}/${context.repository.owner}/${context.repository.name}.git`,
        registryURL: new URL("/", options.publicURL).origin,
        packageOwner: releasePackageOwner(projectID),
        contract,
        configurationError,
        releases,
        access: canManageAccess ? grants : [],
      });
    },
    async publish(userID: string, projectID: string, input: z.input<typeof publishRelease>) {
      const command = publishRelease.parse(input);
      return lock(projectID, async (sql) => {
        await authorize(sql, userID, projectID);
        const [previous] = await sql<
          {
            id: string;
            commitSHA: string;
            version: string;
            notes: string;
            createdBy: string;
            projectID: string;
          }[]
        >`
          SELECT id,commit_sha AS "commitSHA",version,notes,created_by AS "createdBy",project_id AS "projectID"
          FROM factory.project_release WHERE command_id=${command.commandID}`;
        if (previous) {
          if (
            previous.projectID !== projectID ||
            previous.createdBy !== userID ||
            previous.commitSHA !== command.commitSHA ||
            previous.version !== command.version ||
            previous.notes !== command.notes
          )
            throw new CommandError("conflict", "Release command identity was already used");
          return { id: previous.id };
        }
        const context = await project(projectID);
        const head = await forge.getDefaultBranch(context.repository);
        if (
          (await candidate(projectID)) !== command.commitSHA ||
          head.headSha !== command.commitSHA
        )
          throw new CommandError(
            "conflict",
            "The selected commit is no longer the current delivered, healthy Staging revision",
          );
        const contract = await configuration(context.repository, command.commitSHA);
        if (contract && (!secrets.configured || !publication.configuredAccess))
          throw new CommandError("unavailable", "Publication credentials are not configured");
        const id = crypto.randomUUID();
        try {
          await sql.begin(async (tx) => {
            await projectDevelopmentAuthorityIn(tx, userID, projectID);
            await tx`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,workflow,contract,notes,created_by)
              VALUES(${id},${projectID},${command.commandID},${command.version},${command.commitSHA},
              ${contract ? publicationWorkflow : null},${contract ? JSON.stringify(contract) : null}::text::jsonb,${command.notes},${userID})`;
            await tx`INSERT INTO factory.release_attempt(id,release_id,command_id,ordinal) VALUES(${id},${id},${command.commandID},1)`;
          });
        } catch (cause) {
          if ((cause as { code?: string }).code === "23505")
            throw new CommandError(
              "conflict",
              "This version exists or another publication still needs attention",
            );
          throw cause;
        }
        void reconcileOne(id).catch(() => console.error("Release reconciliation is unavailable"));
        return { id };
      });
    },
    async reconcile(userID: string, projectID: string, id: string) {
      await access.requireDevelopment(userID, projectID);
      const row = await record(id);
      if (!row || row.projectID !== projectID)
        throw new CommandError("not-found", "Release not found");
      await reconcileOne(id);
    },
    async end(userID: string, projectID: string, id: string) {
      return lock(id, async (sql) => {
        await authorize(sql, userID, projectID);
        const row = await record(id);
        if (!row || row.projectID !== projectID)
          throw new CommandError("not-found", "Release not found");
        if (row.state === "published")
          throw new CommandError("conflict", "A published release cannot be withdrawn");
        await sql`UPDATE factory.project_release SET ended_at=COALESCE(ended_at,now()),
          failure='Publication ended by a human. Previously published content has not been rolled back; an unconfirmed outcome remains unconfirmed.'
          WHERE id=${id} AND state <> 'published'`;
        await cleanup(row);
      });
    },
    async createAccess(
      userID: string,
      projectID: string,
      input: z.input<typeof externalAccessInput>,
      replacesID?: string,
    ) {
      const command = externalAccessInput.parse(input);
      return lock(projectID, async (sql) => {
        await authorize(sql, userID, projectID, true);
        if (!secrets.configured || !publication.configuredAccess)
          throw new CommandError("unavailable", "Machine access is unavailable");
        const [existing] = await sql<
          {
            projectID: string;
            createdBy: string;
            name: string;
            scope: string;
            username: string;
            replacesID: string | null;
          }[]
        >`
          SELECT project_id AS "projectID",created_by AS "createdBy",name,scope,username,replaces_id AS "replacesID"
          FROM factory.release_access WHERE command_id=${command.commandID}`;
        if (existing) {
          if (
            existing.projectID !== projectID ||
            existing.createdBy !== userID ||
            existing.name !== command.name ||
            existing.scope !== command.scope ||
            existing.replacesID !== (replacesID ?? null)
          )
            throw new CommandError("conflict", "Machine access command identity was already used");
          return { id: command.commandID, username: existing.username, token: null };
        }
        await grantIntent(
          sql,
          projectID,
          userID,
          command.commandID,
          command.name,
          command.scope,
          undefined,
          replacesID,
        );
        try {
          return await sql.begin(async (tx) => {
            await projectAuthorityIn(tx, userID, projectID, true);
            await projectDevelopmentAuthorityIn(tx, userID, projectID);
            const credential = await provisionGrant(command.commandID);
            const token = await publication.issueToken(
              credential.repository,
              credential.username,
              credential.password,
              command.scope,
              command.commandID,
            );
            await tx`UPDATE factory.release_access SET state='active',token_id=${token.id} WHERE id=${command.commandID}`;
            if (replacesID) await revoke(replacesID);
            return { id: command.commandID, username: credential.username, token: token.sha1 };
          });
        } catch (cause) {
          await sql`UPDATE factory.release_access SET state='revoking' WHERE id=${command.commandID}`;
          await revoke(command.commandID).catch(() => {});
          throw cause;
        }
      });
    },
    async rotateAccess(userID: string, projectID: string, id: string, commandID: string) {
      await access.requireProject(userID, projectID, true);
      await access.requireDevelopment(userID, projectID);
      const [previous] = await database.client<{ name: string; scope: "git" | "packages" }[]>`
        SELECT name,scope FROM factory.release_access WHERE id=${id} AND project_id=${projectID} AND scope <> 'publish'`;
      if (!previous) throw new CommandError("not-found", "Machine access not found");
      return this.createAccess(userID, projectID, { commandID, ...previous }, id);
    },
    async revokeAccess(userID: string, projectID: string, id: string) {
      return lock(projectID, async (sql) => {
        await authorize(sql, userID, projectID, true);
        const [grant] =
          await sql`SELECT id FROM factory.release_access WHERE id=${id} AND project_id=${projectID} AND scope <> 'publish'`;
        if (!grant) throw new CommandError("not-found", "Machine access not found");
        await revoke(id);
      });
    },
    async credentials(request: Request, attemptID: string) {
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const expected = runtimePublicationToken(options.signingKey, attemptID);
      const suppliedBytes = Buffer.from(supplied),
        expectedBytes = Buffer.from(expected);
      if (
        request.method !== "POST" ||
        suppliedBytes.length !== expectedBytes.length ||
        !timingSafeEqual(suppliedBytes, expectedBytes)
      )
        return new Response(null, { status: 403 });
      const [link] = await database.client<{ releaseID: string }[]>`
        SELECT release_id AS "releaseID" FROM factory.release_attempt WHERE id=${attemptID}`;
      if (!link) return new Response(null, { status: 403 });
      // The same cross-process lock fences both credential issuance and End attempt.
      return lock(link.releaseID, async (sql) => {
        const row = await record(link.releaseID);
        if (
          !row ||
          row.attemptID !== attemptID ||
          !row.runID ||
          !row.dispatchIntended ||
          !row.jobHandle ||
          row.state !== "running" ||
          row.ended ||
          !row.runtimeAttemptID ||
          !row.contract
        )
          return new Response(null, { status: 409 });
        const contract = row.contract;
        await authorize(sql, row.createdBy, row.projectID);
        const [runtime] =
          await sql`SELECT id FROM factory.runtime_attempt WHERE id=${row.runtimeAttemptID} AND state IN ('starting','ready') AND stop_intended_at IS NULL AND isolated_kind='publication'`;
        const context = await project(row.projectID);
        const actual = await publication.run(context.repository, row.runID);
        if (
          !runtime ||
          !actual ||
          actual.id !== row.runID ||
          actual.event !== "workflow_dispatch" ||
          actual.workflow_id !== "factory-release.yml" ||
          actual.trigger_user.login !== context.repository.owner ||
          actual.commit_sha !== row.commitSHA ||
          JSON.parse(actual.event_payload).inputs?.factory_release_id !== row.attemptID ||
          JSON.parse(actual.event_payload).inputs?.version !== row.version ||
          JSON.parse(actual.event_payload).inputs?.package_owner !==
            releasePackageOwner(row.projectID) ||
          !(await publication.attestTask(context.repository, row.jobHandle, actual))
        )
          return new Response(null, { status: 403 });
        let [grant] = await sql<
          { id: string }[]
        >`SELECT id FROM factory.release_access WHERE release_id=${row.id} AND scope='publish' AND state IN ('pending','active')`;
        if (!grant) {
          grant = { id: crypto.randomUUID() };
          await grantIntent(
            sql,
            row.projectID,
            row.createdBy,
            grant.id,
            `Release ${row.version}`,
            "publish",
            row.id,
          );
        }
        let credential = await secrets.read(`release-publish/${row.projectID}/${grant.id}`);
        if (!credential?.token) {
          // A retry must not silently replace content already published under this version.
          for (const name of [...contract.images, ...(contract.chart ? [contract.chart] : [])])
            if (
              await publication.versionExists(releasePackageOwner(row.projectID), name, row.version)
            )
              throw new CommandError(
                "conflict",
                "This version already contains artifacts. Publish a new version instead of overwriting them.",
              );
          for (const file of contract.files)
            if (
              await publication.versionExists(
                releasePackageOwner(row.projectID),
                file.name,
                row.version,
                "generic",
              )
            )
              throw new CommandError(
                "conflict",
                "This version already contains files. Publish a new version instead of overwriting them.",
              );
          const account = await provisionGrant(grant.id);
          const token = await sql.begin(async (tx) => {
            await projectDevelopmentAuthorityIn(tx, row.createdBy, row.projectID);
            return publication.issueToken(
              context.repository,
              account.username,
              account.password,
              "publish",
              grant.id,
            );
          });
          credential = {
            username: account.username,
            password: account.password,
            token: token.sha1,
          };
          await secrets.create(`release-publish/${row.projectID}/${grant.id}`, credential);
          await sql`UPDATE factory.release_access SET token_id=${token.id} WHERE id=${grant.id}`;
        }
        // Recover a lost DB acknowledgement after the immutable secret was sealed.
        await sql`UPDATE factory.release_access SET state='active' WHERE id=${grant.id}`;
        return Response.json(
          {
            username: credential.username,
            token: credential.token,
            packageOwner: releasePackageOwner(row.projectID),
          },
          { headers: { "cache-control": "no-store" } },
        );
      });
    },
    async recover() {
      const rows = await database.client<{ id: string }[]>`
        SELECT id FROM factory.project_release WHERE state NOT IN ('published','failed') AND ended_at IS NULL
        OR EXISTS(SELECT 1 FROM factory.release_attempt attempt WHERE attempt.release_id=project_release.id AND attempt.cleaned_at IS NULL)`;
      for (const row of rows) await reconcileOne(row.id).catch(() => {});
      const grants = await database.client<
        { id: string; projectID: string }[]
      >`SELECT id,project_id AS "projectID" FROM factory.release_access WHERE state IN ('pending','revoking','uncertain') AND scope <> 'publish'`;
      for (const grant of grants)
        await lock(grant.projectID, async (sql) => {
          const [current] =
            await sql`SELECT id FROM factory.release_access WHERE id=${grant.id} AND state IN ('pending','revoking','uncertain')`;
          if (current) await revoke(grant.id);
        }).catch(() => {});
    },
  };
}
