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
import { drizzleTransaction } from "#db/client";
import { operation as operationTable, projectRelease, runtimeAttempt } from "#db/schema";
import type { ForgeRepository } from "#forge/contracts";
import {
  publishRelease,
  releaseContract,
  releasePackageOwner,
  releaseSettingsView,
  versionSuggestions,
} from "#project-domain/release";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import {
  createReleaseAccessGrants,
  type PublicationRuntime,
  type ReleaseControllerOptions,
} from "./access-grants";
import { createReleaseCredentialsEndpoint } from "./credentials-endpoint";
import { createReleaseReconciler } from "./reconciler";
import { publicationWorkflow, validatePublicationWorkflow } from "./workflow";

export type { PublicationRuntime };

function isUniqueViolation(cause: unknown): boolean {
  if (cause instanceof DrizzleQueryError) return isUniqueViolation(cause.cause);
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "23505");
}

export function createReleaseController(options: ReleaseControllerOptions) {
  const { database, forge, publication, secrets } = options;
  const grants = createReleaseAccessGrants(options);
  const { access, authorize, cleanup, lock, project, record, revoke } = grants;
  const { reconcileOne } = createReleaseReconciler(options, grants);
  const { credentials } = createReleaseCredentialsEndpoint(options, grants);

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
      .select({ sha: query<string>`${operationTable.payload}->>'revision'` })
      .from(operationTable)
      .innerJoin(
        runtimeAttempt,
        and(
          eq(
            query<string>`${runtimeAttempt.id}::text`,
            query<string>`${operationTable.payload}->>'runtimeAttemptId'`,
          ),
          eq(runtimeAttempt.state, "ready"),
        ),
      )
      .where(
        and(
          eq(operationTable.kind, "delivery.staging_preview"),
          eq(operationTable.scopeType, "project"),
          eq(operationTable.scopeId, projectID),
          eq(operationTable.idempotencyKey, `delivery.staging_preview:${projectID}`),
          // The native invoker-security view owns latest-promotion selection.
          query<boolean>`EXISTS(
            SELECT 1 FROM factory.current_promotion promotion WHERE promotion.project_id=${projectID}
            AND promotion.commit_sha=${operationTable.payload}->>'revision' AND promotion.state='succeeded')`,
        ),
      );
    return row?.sha ?? null;
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
      const accessGrantRows = await database.db
        .select({
          id: operationTable.id,
          state: operationTable.state,
          createdAt: query<string>`${operationTable.createdAt}::text`,
          payload: operationTable.payload,
        })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, "releases.access"),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, projectID),
            query<boolean>`${operationTable.payload}->>'scope' <> 'publish'`,
          ),
        )
        .orderBy(desc(operationTable.createdAt));
      const accessGrants = accessGrantRows.map((grant) => ({
        id: grant.id,
        name: String(grant.payload["name"] ?? ""),
        scope: grant.payload["scope"] as "git" | "packages" | "publish",
        state: grant.state as "pending" | "active" | "revoking" | "revoked" | "uncertain",
        createdAt: grant.createdAt,
        username: String(grant.payload["username"] ?? ""),
      }));
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
        access: canManageAccess ? accessGrants : [],
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
            await db.insert(operationTable).values({
              id,
              kind: "releases.attempt",
              scopeType: "project_release",
              scopeId: id,
              idempotencyKey: `releases.attempt:${command.commandID}`,
              activeKey: `releases.attempt.ordinal:${id}:1`,
              state: "pending",
              createdBy: userID,
              payload: {
                id,
                releaseId: id,
                commandId: command.commandID,
                ordinal: 1,
                dispatchIntendedAt: null,
                runId: null,
                runnerId: null,
                runnerUuid: null,
                runnerToken: null,
                jobHandle: null,
                runtimeAttemptId: null,
                cleanedAt: null,
              },
            });
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
    createAccess: grants.createAccess,
    rotateAccess: grants.rotateAccess,
    revokeAccess: grants.revokeAccess,
    credentials,
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
                .select({ id: operationTable.id })
                .from(operationTable)
                .where(
                  and(
                    eq(operationTable.kind, "releases.attempt"),
                    eq(operationTable.scopeType, "project_release"),
                    eq(operationTable.scopeId, query<string>`${projectRelease.id}::text`),
                    isNull(operationTable.completedAt),
                  ),
                ),
            ),
          ),
        );
      for (const row of rows)
        await reconcileOne(row.id).catch(reportFailure("Release reconciliation"));
      const pendingGrants = await db
        .select({ id: operationTable.id, projectID: operationTable.scopeId })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, "releases.access"),
            eq(operationTable.scopeType, "project"),
            inArray(operationTable.state, ["pending", "revoking", "uncertain"]),
            query<boolean>`${operationTable.payload}->>'scope' <> 'publish'`,
          ),
        );
      for (const grant of pendingGrants)
        await lock(grant.projectID, async (sql) => {
          const [current] = await drizzleTransaction(sql)
            .select({ id: operationTable.id })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.id, grant.id),
                eq(operationTable.kind, "releases.access"),
                inArray(operationTable.state, ["pending", "revoking", "uncertain"]),
              ),
            );
          if (current) await revoke(grant.id);
        }).catch(reportFailure("Release access revocation"));
    },
  };
}
