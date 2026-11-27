import { and, desc, eq, ne, sql as query } from "drizzle-orm";
import type { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { operation as operationTable, projectRelease, project as projectTable } from "#db/schema";
import type { ForgeRepository } from "#forge/contracts";
import type { createForgejoClient } from "#forge/forge";
import type { createForgejoReleases } from "#forge/releases";
import { boundForgeRepositoryFromURL } from "#forge/repository";
import {
  externalAccessInput,
  type ReleaseArtifact,
  type releaseContract,
  releasePackageOwner,
} from "#project-domain/release";
import { createAccessController } from "../access/api";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { ReleaseSecrets } from "./secrets";

export type ReleaseDatabase = ReturnType<typeof createDatabase>;
export type ReleaseSQL = ReleaseDatabase["client"];

export type PublicationRuntime = {
  startPublication(id: string, userID: string): Promise<unknown>;
  stop(id: string): Promise<unknown>;
};

export type ReleaseControllerOptions = {
  database: ReleaseDatabase;
  secrets: ReleaseSecrets;
  signingKey: string;
  runtime: PublicationRuntime;
  forge: ReturnType<typeof createForgejoClient>;
  publication: ReturnType<typeof createForgejoReleases>;
  apiURL: string;
  publicURL: string;
  owner: string;
};

export type ReleaseRow = {
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

const RELEASE_ACCESS_KIND = "releases.access";
const RELEASE_ATTEMPT_KIND = "releases.attempt";

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function createReleaseAccessGrants(options: ReleaseControllerOptions) {
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

  async function lock<T>(key: string, execute: (sql: ReleaseSQL) => Promise<T>): Promise<T> {
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

  async function authorize(sql: ReleaseSQL, userID: string, projectID: string, manage = false) {
    await sql.begin(async (tx) => {
      await projectAuthorityIn(tx, userID, projectID, manage);
      await projectDevelopmentAuthorityIn(tx, userID, projectID);
    });
  }

  async function record(id: string): Promise<ReleaseRow | undefined> {
    const attempt = database.db
      .select({
        id: operationTable.id,
        state: operationTable.state,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, RELEASE_ATTEMPT_KIND),
          eq(operationTable.scopeType, "project_release"),
          eq(operationTable.scopeId, query<string>`${projectRelease.id}::text`),
        ),
      )
      .orderBy(desc(query<number>`(${operationTable.payload}->>'ordinal')::int`))
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
        attemptPayload: attempt.payload,
      })
      .from(projectRelease)
      .innerJoinLateral(attempt, query`true`)
      .where(eq(projectRelease.id, id));
    if (!row) return undefined;
    const payload = row.attemptPayload;
    return {
      id: row.id,
      projectID: row.projectID,
      version: row.version,
      commitSHA: row.commitSHA,
      notes: row.notes,
      state: row.state,
      contract: row.contract,
      artifacts: row.artifacts,
      createdBy: row.createdBy,
      ended: row.ended,
      attemptID: row.attemptID,
      attemptState: row.attemptState,
      runID: nullableNumber(payload["runId"]),
      dispatchIntended: payload["dispatchIntendedAt"] != null,
      runnerID: nullableNumber(payload["runnerId"]),
      runnerUUID: nullableString(payload["runnerUuid"]),
      runnerToken: nullableString(payload["runnerToken"]),
      jobHandle: nullableString(payload["jobHandle"]),
      runtimeAttemptID: nullableString(payload["runtimeAttemptId"]),
    };
  }

  async function state(
    row: ReleaseRow,
    next: (typeof projectRelease.$inferSelect)["state"],
    failure: string | null = null,
  ) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      await db
        .update(operationTable)
        .set({ state: next, updatedAt: query`now()` })
        .where(
          and(eq(operationTable.id, row.attemptID), eq(operationTable.kind, RELEASE_ATTEMPT_KIND)),
        );
      await db
        .update(projectRelease)
        .set({ state: next, failure })
        .where(and(eq(projectRelease.id, row.id), ne(projectRelease.state, "published")));
    });
    row.state = next;
    row.attemptState = next;
  }

  async function provisionGrant(id: string) {
    const [grantRow] = await database.db
      .select({
        projectID: operationTable.scopeId,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(and(eq(operationTable.id, id), eq(operationTable.kind, RELEASE_ACCESS_KIND)));
    const grant = grantRow
      ? {
          projectID: grantRow.projectID,
          username: String(grantRow.payload["username"] ?? ""),
          secretKey: String(grantRow.payload["secretKey"] ?? ""),
          scope: grantRow.payload["scope"] as "git" | "packages" | "publish",
        }
      : undefined;
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
    sql: ReleaseSQL,
    projectID: string,
    userID: string,
    id: string,
    name: string,
    scope: "git" | "packages" | "publish",
    releaseID?: string,
    replacesID?: string,
  ) {
    const username = `fr-${id.replaceAll("-", "")}`;
    const secretKey = `release-access/${projectID}/${id}`;
    await drizzleTransaction(sql)
      .insert(operationTable)
      .values({
        id,
        kind: RELEASE_ACCESS_KIND,
        scopeType: "project",
        scopeId: projectID,
        idempotencyKey: `${RELEASE_ACCESS_KIND}:${id}`,
        activeKey: scope === "publish" && releaseID ? `releases.access.publish:${releaseID}` : null,
        state: "pending",
        createdBy: userID,
        completedAt: null,
        payload: {
          id,
          projectId: projectID,
          commandId: id,
          name,
          scope,
          username,
          secretKey,
          createdBy: userID,
          releaseId: releaseID ?? null,
          revokedAt: null,
          tokenId: null,
          replacesId: replacesID ?? null,
        },
      });
  }

  async function revoke(id: string) {
    const [grantRow] = await database.db
      .select({
        projectID: operationTable.scopeId,
        state: operationTable.state,
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(and(eq(operationTable.id, id), eq(operationTable.kind, RELEASE_ACCESS_KIND)));
    if (!grantRow || grantRow.state === "revoked") return;
    const username = String(grantRow.payload["username"] ?? "");
    await database.db
      .update(operationTable)
      .set({ state: "revoking", activeKey: null, updatedAt: query`now()` })
      .where(and(eq(operationTable.id, id), eq(operationTable.kind, RELEASE_ACCESS_KIND)));
    const context = await project(grantRow.projectID);
    await publication.revokeMachine(
      context.repository,
      releasePackageOwner(grantRow.projectID),
      username,
    );
    await database.db
      .update(operationTable)
      .set({
        state: "revoked",
        activeKey: null,
        completedAt: query`now()`,
        updatedAt: query`now()`,
        payload: query`jsonb_set(${operationTable.payload}, '{revokedAt}', to_jsonb(now()))`,
      })
      .where(and(eq(operationTable.id, id), eq(operationTable.kind, RELEASE_ACCESS_KIND)));
  }

  async function cleanup(row: ReleaseRow) {
    const grants = await database.db
      .select({ id: operationTable.id })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, RELEASE_ACCESS_KIND),
          query<boolean>`${operationTable.payload}->>'releaseId' = ${row.id}`,
          ne(operationTable.state, "revoked"),
        ),
      );
    for (const grant of grants) await revoke(grant.id);
    if (row.runtimeAttemptID) await runtime.stop(row.runtimeAttemptID);
    if (row.runnerID) {
      const context = await project(row.projectID);
      await forge.deleteRunner(context.repository, row.runnerID);
    }
    await database.db
      .update(operationTable)
      .set({
        completedAt: query`now()`,
        updatedAt: query`now()`,
        payload: query`${operationTable.payload} || jsonb_build_object('cleanedAt', now(), 'runnerToken', NULL::text)`,
      })
      .where(
        and(eq(operationTable.id, row.attemptID), eq(operationTable.kind, RELEASE_ATTEMPT_KIND)),
      );
  }

  async function createAccess(
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
      const [existingRow] = await drizzleTransaction(sql)
        .select({
          projectID: operationTable.scopeId,
          createdBy: operationTable.createdBy,
          payload: operationTable.payload,
        })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, RELEASE_ACCESS_KIND),
            eq(operationTable.idempotencyKey, `${RELEASE_ACCESS_KIND}:${command.commandID}`),
          ),
        );
      if (existingRow) {
        if (
          existingRow.projectID !== projectID ||
          existingRow.createdBy !== userID ||
          existingRow.payload["name"] !== command.name ||
          existingRow.payload["scope"] !== command.scope ||
          nullableString(existingRow.payload["replacesId"]) !== (replacesID ?? null)
        )
          throw new CommandError("conflict", "Machine access command identity was already used");
        return {
          id: command.commandID,
          username: String(existingRow.payload["username"] ?? ""),
          token: null,
        };
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
            .update(operationTable)
            .set({
              state: "active",
              updatedAt: query`now()`,
              payload: query`jsonb_set(${operationTable.payload}, '{tokenId}', to_jsonb(${token.id}::bigint))`,
            })
            .where(
              and(
                eq(operationTable.id, command.commandID),
                eq(operationTable.kind, RELEASE_ACCESS_KIND),
              ),
            );
          if (replacesID) await revoke(replacesID);
          return { id: command.commandID, username: credential.username, token: token.sha1 };
        });
      } catch (cause) {
        await drizzleTransaction(sql)
          .update(operationTable)
          .set({ state: "revoking", activeKey: null, updatedAt: query`now()` })
          .where(
            and(
              eq(operationTable.id, command.commandID),
              eq(operationTable.kind, RELEASE_ACCESS_KIND),
            ),
          );
        await revoke(command.commandID).catch(() => {});
        throw cause;
      }
    });
  }

  async function rotateAccess(userID: string, projectID: string, id: string, commandID: string) {
    await access.requireProject(userID, projectID, true);
    await access.requireDevelopment(userID, projectID);
    const [previousRow] = await database.db
      .select({
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.id, id),
          eq(operationTable.kind, RELEASE_ACCESS_KIND),
          eq(operationTable.scopeType, "project"),
          eq(operationTable.scopeId, projectID),
          query<boolean>`${operationTable.payload}->>'scope' <> 'publish'`,
        ),
      );
    if (!previousRow) throw new CommandError("not-found", "Machine access not found");
    const previous = {
      name: String(previousRow.payload["name"] ?? ""),
      scope: previousRow.payload["scope"] as "git" | "packages",
    };
    return createAccess(userID, projectID, { commandID, ...previous }, id);
  }

  async function revokeAccess(userID: string, projectID: string, id: string) {
    return lock(projectID, async (sql) => {
      await authorize(sql, userID, projectID, true);
      const [grant] = await drizzleTransaction(sql)
        .select({ id: operationTable.id })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.id, id),
            eq(operationTable.kind, RELEASE_ACCESS_KIND),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, projectID),
            query<boolean>`${operationTable.payload}->>'scope' <> 'publish'`,
          ),
        );
      if (!grant) throw new CommandError("not-found", "Machine access not found");
      await revoke(id);
    });
  }

  return {
    access,
    project,
    lock,
    authorize,
    record,
    state,
    provisionGrant,
    grantIntent,
    revoke,
    cleanup,
    createAccess,
    rotateAccess,
    revokeAccess,
  };
}

export type ReleaseAccessGrants = ReturnType<typeof createReleaseAccessGrants>;
