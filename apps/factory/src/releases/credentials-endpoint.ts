import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, sql as query } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { operation as operationTable, runtimeAttempt } from "#db/schema";
import { releasePackageOwner } from "#project-domain/release";
import { runtimePublicationToken } from "#runtime-domain/identity";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { ReleaseAccessGrants, ReleaseControllerOptions } from "./access-grants";

export function createReleaseCredentialsEndpoint(
  options: ReleaseControllerOptions,
  grants: ReleaseAccessGrants,
) {
  const { database, publication, secrets } = options;
  const { authorize, grantIntent, lock, project, provisionGrant, record } = grants;

  async function credentials(request: Request, attemptID: string) {
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
      .select({ releaseID: operationTable.scopeId })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.id, attemptID),
          eq(operationTable.kind, "releases.attempt"),
          eq(operationTable.scopeType, "project_release"),
        ),
      );
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
        .select({ id: operationTable.id })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, "releases.access"),
            query<boolean>`${operationTable.payload}->>'releaseId' = ${row.id}`,
            query<boolean>`${operationTable.payload}->>'scope' = 'publish'`,
            inArray(operationTable.state, ["pending", "active"]),
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
          .update(operationTable)
          .set({
            payload: query`jsonb_set(${operationTable.payload}, '{tokenId}', to_jsonb(${token.id}::bigint))`,
            updatedAt: query`now()`,
          })
          .where(and(eq(operationTable.id, grant.id), eq(operationTable.kind, "releases.access")));
      }
      // Recover a lost DB acknowledgement after the immutable secret was sealed.
      await db
        .update(operationTable)
        .set({
          state: "active",
          activeKey: `releases.access.publish:${row.id}`,
          updatedAt: query`now()`,
        })
        .where(and(eq(operationTable.id, grant.id), eq(operationTable.kind, "releases.access")));
      return Response.json(
        {
          username: credential.username,
          token: credential.token,
          packageOwner: releasePackageOwner(row.projectID),
        },
        { headers: { "cache-control": "no-store" } },
      );
    });
  }

  return { credentials };
}
