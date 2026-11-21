import { timingSafeEqual } from "node:crypto";
import {
  and,
  DrizzleQueryError,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql as query,
} from "drizzle-orm";
import type { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  projectRelease,
  project as projectTable,
  releaseAccess,
  releaseAttempt,
  runtimeAttempt,
  stagingPreview,
} from "../../../../packages/db/src/schema";
import { type ForgeRepository } from "../../../../packages/forge/src/contracts";
import { type createForgejoClient } from "../../../../packages/forge/src/forge";
import type { createForgejoReleases } from "../../../../packages/forge/src/releases";
import { boundForgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
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
import { createAccessController } from "../access/api";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import type { ReleaseSecrets } from "./secrets";
import { publicationWorkflow, validatePublicationWorkflow } from "./workflow";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
function isUniqueViolation(cause: unknown): boolean {
  if (cause instanceof DrizzleQueryError) return isUniqueViolation(cause.cause);
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "23505");
}
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
    return boundForgeRepositoryFromURL(
      url,
      options,
      () =>
        new CommandError("conflict", "Project does not identify the configured Forgejo repository"),
    );
  }
  async function project(projectID: string) {
    const [row] = await database.db
      .select({ repositoryURL: projectTable.repositoryUrl, branch: projectTable.defaultBranch })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
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
    const [row] = await database.db
      .select({ sha: stagingPreview.revision })
      .from(stagingPreview)
      .innerJoin(
        runtimeAttempt,
        and(
          eq(runtimeAttempt.id, stagingPreview.runtimeAttemptId),
          eq(runtimeAttempt.state, "ready"),
        ),
      )
      .where(
        and(
          eq(stagingPreview.projectId, projectID),
          // The native invoker-security view owns latest-promotion selection.
          query<boolean>`EXISTS(
            SELECT 1 FROM factory.current_promotion promotion WHERE promotion.project_id=${projectID}
            AND promotion.commit_sha=${stagingPreview.revision} AND promotion.state='succeeded')`,
        ),
      );
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
  async function record(id: string): Promise<ReleaseRow | undefined> {
    const attempt = database.db
      .select()
      .from(releaseAttempt)
      .where(eq(releaseAttempt.releaseId, projectRelease.id))
      .orderBy(desc(releaseAttempt.ordinal))
      .limit(1)
      .as("attempt");
    const [row] = await database.db
      .select({
        id: projectRelease.id,
        projectID: projectRelease.projectId,
        version: projectRelease.version,
        commitSHA: projectRelease.commitSha,
        notes: projectRelease.notes,
        state: projectRelease.state,
        contract: query<ReleaseRow["contract"]>`${projectRelease.contract}`,
        artifacts: query<ReleaseArtifact[]>`${projectRelease.artifacts}`,
        createdBy: projectRelease.createdBy,
        ended: query<boolean>`${projectRelease.endedAt} IS NOT NULL`,
        attemptID: attempt.id,
        attemptState: attempt.state,
        runID: attempt.runId,
        dispatchIntended: query<boolean>`${attempt.dispatchIntendedAt} IS NOT NULL`,
        runnerID: attempt.runnerId,
        runnerUUID: attempt.runnerUuid,
        runnerToken: attempt.runnerToken,
        jobHandle: attempt.jobHandle,
        runtimeAttemptID: attempt.runtimeAttemptId,
      })
      .from(projectRelease)
      .innerJoinLateral(attempt, query`true`)
      .where(eq(projectRelease.id, id));
    return row;
  }
  async function state(
    row: ReleaseRow,
    next: (typeof projectRelease.$inferSelect)["state"],
    failure: string | null = null,
  ) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      await db
        .update(releaseAttempt)
        .set({ state: next })
        .where(eq(releaseAttempt.id, row.attemptID));
      await db
        .update(projectRelease)
        .set({ state: next, failure })
        .where(and(eq(projectRelease.id, row.id), ne(projectRelease.state, "published")));
    });
    row.state = next;
    row.attemptState = next;
  }
  async function provisionGrant(id: string) {
    const [grant] = await database.db
      .select({
        projectID: releaseAccess.projectId,
        username: releaseAccess.username,
        secretKey: releaseAccess.secretKey,
        scope: releaseAccess.scope,
      })
      .from(releaseAccess)
      .where(eq(releaseAccess.id, id));
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
    scope: "git" | "packages" | "publish",
    releaseID?: string,
    replacesID?: string,
  ) {
    const username = `fr-${id.replaceAll("-", "")}`;
    await drizzleTransaction(sql)
      .insert(releaseAccess)
      .values({
        id,
        projectId: projectID,
        commandId: id,
        name,
        scope,
        state: "pending",
        username,
        secretKey: `release-access/${projectID}/${id}`,
        createdBy: userID,
        releaseId: releaseID ?? null,
        replacesId: replacesID ?? null,
      });
  }
  async function revoke(id: string) {
    const [grant] = await database.db
      .select({
        projectID: releaseAccess.projectId,
        username: releaseAccess.username,
        state: releaseAccess.state,
      })
      .from(releaseAccess)
      .where(eq(releaseAccess.id, id));
    if (!grant || grant.state === "revoked") return;
    await database.db
      .update(releaseAccess)
      .set({ state: "revoking" })
      .where(eq(releaseAccess.id, id));
    const context = await project(grant.projectID);
    await publication.revokeMachine(
      context.repository,
      releasePackageOwner(grant.projectID),
      grant.username,
    );
    await database.db
      .update(releaseAccess)
      .set({ state: "revoked", revokedAt: query`now()` })
      .where(eq(releaseAccess.id, id));
  }
  async function cleanup(row: ReleaseRow) {
    const grants = await database.db
      .select({ id: releaseAccess.id })
      .from(releaseAccess)
      .where(and(eq(releaseAccess.releaseId, row.id), ne(releaseAccess.state, "revoked")));
    for (const grant of grants) await revoke(grant.id);
    if (row.runtimeAttemptID) await runtime.stop(row.runtimeAttemptID);
    if (row.runnerID) {
      const context = await project(row.projectID);
      await forge.deleteRunner(context.repository, row.runnerID);
    }
    await database.db
      .update(releaseAttempt)
      .set({ cleanedAt: query`now()`, runnerToken: null })
      .where(eq(releaseAttempt.id, row.attemptID));
  }
  async function reconcileOne(id: string) {
    return lock(id, async (sql) => {
      const db = drizzleTransaction(sql);
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
            await db
              .update(releaseAttempt)
              .set({ dispatchIntendedAt: query`now()` })
              .where(
                and(
                  eq(releaseAttempt.id, row.attemptID),
                  isNull(releaseAttempt.dispatchIntendedAt),
                ),
              );
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
          await db
            .update(releaseAttempt)
            .set({ runId: row.runID })
            .where(eq(releaseAttempt.id, row.attemptID));
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
          await db
            .update(projectRelease)
            .set({ runId: observed.id, runUrl: observed.html_url })
            .where(eq(projectRelease.id, row.id));
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
              const [attempt] = await db
                .select({ state: runtimeAttempt.state })
                .from(runtimeAttempt)
                .where(eq(runtimeAttempt.id, row.runtimeAttemptID));
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
              await db
                .update(releaseAttempt)
                .set({ jobHandle: row.jobHandle })
                .where(eq(releaseAttempt.id, row.attemptID));
            }
            if (!row.runnerUUID) {
              const runner = await forge.registerEphemeralRunner(
                context.repository,
                `factory-release-${row.attemptID}`,
              );
              row.runnerID = runner.id;
              row.runnerUUID = runner.uuid;
              row.runnerToken = runner.token;
              await db
                .update(releaseAttempt)
                .set({ runnerId: runner.id, runnerUuid: runner.uuid, runnerToken: runner.token })
                .where(eq(releaseAttempt.id, row.attemptID));
            }
            await state(row, "running");
            await runtime.startPublication(row.attemptID, row.createdBy);
            return;
          }
          await state(row, "checking");
          const [grant] = await db
            .select({ id: releaseAccess.id, username: releaseAccess.username })
            .from(releaseAccess)
            .where(
              and(
                eq(releaseAccess.releaseId, row.id),
                eq(releaseAccess.scope, "publish"),
                eq(releaseAccess.state, "active"),
              ),
            );
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
            await db.update(projectRelease).set({ artifacts }).where(eq(projectRelease.id, row.id));
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
          const db = drizzleTransaction(tx);
          await db
            .update(releaseAttempt)
            .set({ state: "published" })
            .where(eq(releaseAttempt.id, row.attemptID));
          await db
            .update(projectRelease)
            .set({ state: "published", releaseUrl: url, publishedAt: query`now()`, failure: null })
            .where(and(eq(projectRelease.id, row.id), eq(projectRelease.state, "publishing")));
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
      const releases = await database.db
        .select({
          id: projectRelease.id,
          version: projectRelease.version,
          commitSHA: projectRelease.commitSha,
          state: projectRelease.state,
          notes: projectRelease.notes,
          createdAt: query<string>`${projectRelease.createdAt}::text`,
          publishedAt: query<string | null>`${projectRelease.publishedAt}::text`,
          endedAt: query<string | null>`${projectRelease.endedAt}::text`,
          runURL: projectRelease.runUrl,
          releaseURL: projectRelease.releaseUrl,
          failure: projectRelease.failure,
          artifacts: projectRelease.artifacts,
        })
        .from(projectRelease)
        .where(eq(projectRelease.projectId, projectID))
        .orderBy(desc(projectRelease.createdAt))
        .limit(100);
      const grants = await database.db
        .select({
          id: releaseAccess.id,
          name: releaseAccess.name,
          scope: releaseAccess.scope,
          state: releaseAccess.state,
          createdAt: query<string>`${releaseAccess.createdAt}::text`,
          username: releaseAccess.username,
        })
        .from(releaseAccess)
        .where(and(eq(releaseAccess.projectId, projectID), ne(releaseAccess.scope, "publish")))
        .orderBy(desc(releaseAccess.createdAt));
      const [lastPublished] = await database.db
        .select({ version: projectRelease.version })
        .from(projectRelease)
        .where(and(eq(projectRelease.projectId, projectID), eq(projectRelease.state, "published")))
        .orderBy(desc(projectRelease.publishedAt), desc(projectRelease.id))
        .limit(1);
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
        const [previous] = await drizzleTransaction(sql)
          .select({
            id: projectRelease.id,
            commitSHA: projectRelease.commitSha,
            version: projectRelease.version,
            notes: projectRelease.notes,
            createdBy: projectRelease.createdBy,
            projectID: projectRelease.projectId,
          })
          .from(projectRelease)
          .where(eq(projectRelease.commandId, command.commandID));
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
            const db = drizzleTransaction(tx);
            await db.insert(projectRelease).values({
              id,
              projectId: projectID,
              commandId: command.commandID,
              version: command.version,
              commitSha: command.commitSHA,
              workflow: contract ? publicationWorkflow : null,
              contract,
              notes: command.notes,
              createdBy: userID,
            });
            await db
              .insert(releaseAttempt)
              .values({ id, releaseId: id, commandId: command.commandID, ordinal: 1 });
          });
        } catch (cause) {
          if (isUniqueViolation(cause))
            throw new CommandError(
              "conflict",
              "This version exists or another publication still needs attention",
            );
          throw cause;
        }
        void reconcileOne(id).catch(reportFailure("Release reconciliation is unavailable"));
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
        await drizzleTransaction(sql)
          .update(projectRelease)
          .set({
            endedAt: query`COALESCE(${projectRelease.endedAt},now())`,
            failure:
              "Publication ended by a human. Previously published content has not been rolled back; an unconfirmed outcome remains unconfirmed.",
          })
          .where(and(eq(projectRelease.id, id), ne(projectRelease.state, "published")));
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
        const [existing] = await drizzleTransaction(sql)
          .select({
            projectID: releaseAccess.projectId,
            createdBy: releaseAccess.createdBy,
            name: releaseAccess.name,
            scope: releaseAccess.scope,
            username: releaseAccess.username,
            replacesID: releaseAccess.replacesId,
          })
          .from(releaseAccess)
          .where(eq(releaseAccess.commandId, command.commandID));
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
            await drizzleTransaction(tx)
              .update(releaseAccess)
              .set({ state: "active", tokenId: token.id })
              .where(eq(releaseAccess.id, command.commandID));
            if (replacesID) await revoke(replacesID);
            return { id: command.commandID, username: credential.username, token: token.sha1 };
          });
        } catch (cause) {
          await drizzleTransaction(sql)
            .update(releaseAccess)
            .set({ state: "revoking" })
            .where(eq(releaseAccess.id, command.commandID));
          await revoke(command.commandID).catch(() => {});
          throw cause;
        }
      });
    },
    async rotateAccess(userID: string, projectID: string, id: string, commandID: string) {
      await access.requireProject(userID, projectID, true);
      await access.requireDevelopment(userID, projectID);
      const [previous] = await database.db
        .select({
          name: releaseAccess.name,
          scope: query<"git" | "packages">`${releaseAccess.scope}`,
        })
        .from(releaseAccess)
        .where(
          and(
            eq(releaseAccess.id, id),
            eq(releaseAccess.projectId, projectID),
            ne(releaseAccess.scope, "publish"),
          ),
        );
      if (!previous) throw new CommandError("not-found", "Machine access not found");
      return this.createAccess(userID, projectID, { commandID, ...previous }, id);
    },
    async revokeAccess(userID: string, projectID: string, id: string) {
      return lock(projectID, async (sql) => {
        await authorize(sql, userID, projectID, true);
        const [grant] = await drizzleTransaction(sql)
          .select({ id: releaseAccess.id })
          .from(releaseAccess)
          .where(
            and(
              eq(releaseAccess.id, id),
              eq(releaseAccess.projectId, projectID),
              ne(releaseAccess.scope, "publish"),
            ),
          );
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
      const [link] = await database.db
        .select({ releaseID: releaseAttempt.releaseId })
        .from(releaseAttempt)
        .where(eq(releaseAttempt.id, attemptID));
      if (!link) return new Response(null, { status: 403 });
      // The same cross-process lock fences both credential issuance and End attempt.
      return lock(link.releaseID, async (sql) => {
        const db = drizzleTransaction(sql);
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
        const [runtime] = await db
          .select({ id: runtimeAttempt.id })
          .from(runtimeAttempt)
          .where(
            and(
              eq(runtimeAttempt.id, row.runtimeAttemptID),
              inArray(runtimeAttempt.state, ["starting", "ready"]),
              isNull(runtimeAttempt.stopIntendedAt),
              eq(runtimeAttempt.isolatedKind, "publication"),
            ),
          );
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
        let [grant] = await db
          .select({ id: releaseAccess.id })
          .from(releaseAccess)
          .where(
            and(
              eq(releaseAccess.releaseId, row.id),
              eq(releaseAccess.scope, "publish"),
              inArray(releaseAccess.state, ["pending", "active"]),
            ),
          );
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
          await db
            .update(releaseAccess)
            .set({ tokenId: token.id })
            .where(eq(releaseAccess.id, grant.id));
        }
        // Recover a lost DB acknowledgement after the immutable secret was sealed.
        await db
          .update(releaseAccess)
          .set({ state: "active" })
          .where(eq(releaseAccess.id, grant.id));
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
      const db = database.db;
      const rows = await db
        .select({ id: projectRelease.id })
        .from(projectRelease)
        .where(
          or(
            and(
              notInArray(projectRelease.state, ["published", "failed"]),
              isNull(projectRelease.endedAt),
            ),
            exists(
              db
                .select({ id: releaseAttempt.id })
                .from(releaseAttempt)
                .where(
                  and(
                    eq(releaseAttempt.releaseId, projectRelease.id),
                    isNull(releaseAttempt.cleanedAt),
                  ),
                ),
            ),
          ),
        );
      for (const row of rows)
        await reconcileOne(row.id).catch(reportFailure("Release reconciliation"));
      const grants = await db
        .select({ id: releaseAccess.id, projectID: releaseAccess.projectId })
        .from(releaseAccess)
        .where(
          and(
            inArray(releaseAccess.state, ["pending", "revoking", "uncertain"]),
            ne(releaseAccess.scope, "publish"),
          ),
        );
      for (const grant of grants)
        await lock(grant.projectID, async (sql) => {
          const [current] = await drizzleTransaction(sql)
            .select({ id: releaseAccess.id })
            .from(releaseAccess)
            .where(
              and(
                eq(releaseAccess.id, grant.id),
                inArray(releaseAccess.state, ["pending", "revoking", "uncertain"]),
              ),
            );
          if (current) await revoke(grant.id);
        }).catch(reportFailure("Release access revocation"));
    },
  };
}
