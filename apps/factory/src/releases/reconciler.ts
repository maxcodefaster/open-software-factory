import { and, eq, sql as query } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { operation as operationTable, projectRelease, runtimeAttempt } from "#db/schema";
import {
  type ReleaseArtifact,
  releaseArtifact,
  releasePackageOwner,
} from "#project-domain/release";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import type { ReleaseAccessGrants, ReleaseControllerOptions } from "./access-grants";

const safeReconcileErrors = new Set([
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

export function createReleaseReconciler(
  options: ReleaseControllerOptions,
  grants: ReleaseAccessGrants,
) {
  const { forge, publication, secrets, runtime } = options;
  const { authorize, cleanup, lock, project, record, state } = grants;

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
              .update(operationTable)
              .set({
                payload: query`jsonb_set(${operationTable.payload}, '{dispatchIntendedAt}', to_jsonb(now()))`,
                updatedAt: query`now()`,
              })
              .where(
                and(
                  eq(operationTable.id, row.attemptID),
                  eq(operationTable.kind, "releases.attempt"),
                  query<boolean>`(${operationTable.payload}->>'dispatchIntendedAt') IS NULL`,
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
            .update(operationTable)
            .set({
              payload: query`jsonb_set(${operationTable.payload}, '{runId}', to_jsonb(${row.runID}::bigint))`,
              updatedAt: query`now()`,
            })
            .where(
              and(
                eq(operationTable.id, row.attemptID),
                eq(operationTable.kind, "releases.attempt"),
              ),
            );
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
                .update(operationTable)
                .set({
                  payload: query`jsonb_set(${operationTable.payload}, '{jobHandle}', to_jsonb(${row.jobHandle}::text))`,
                  updatedAt: query`now()`,
                })
                .where(
                  and(
                    eq(operationTable.id, row.attemptID),
                    eq(operationTable.kind, "releases.attempt"),
                  ),
                );
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
                .update(operationTable)
                .set({
                  payload: query`${operationTable.payload} || jsonb_build_object(
                    'runnerId', ${runner.id}::bigint,
                    'runnerUuid', ${runner.uuid}::text,
                    'runnerToken', ${runner.token}::text
                  )`,
                  updatedAt: query`now()`,
                })
                .where(
                  and(
                    eq(operationTable.id, row.attemptID),
                    eq(operationTable.kind, "releases.attempt"),
                  ),
                );
            }
            await state(row, "running");
            await runtime.startPublication(row.attemptID, row.createdBy);
            return;
          }
          await state(row, "checking");
          const [grant] = await db
            .select({
              id: operationTable.id,
              username: query<string>`${operationTable.payload}->>'username'`,
            })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "releases.access"),
                query<boolean>`${operationTable.payload}->>'releaseId' = ${row.id}`,
                query<boolean>`${operationTable.payload}->>'scope' = 'publish'`,
                eq(operationTable.state, "active"),
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
            const observedArtifact = await publication.manifest(
              releasePackageOwner(row.projectID),
              name,
              row.version,
              credential.username,
              credential.token,
            );
            if ((kind === "chart") !== observedArtifact.helm)
              throw new Error("Artifact type differs from the release contract");
            artifacts.push(releaseArtifact.parse({ kind, name, digest: observedArtifact.digest }));
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
          const txDb = drizzleTransaction(tx);
          await txDb
            .update(operationTable)
            .set({ state: "published", updatedAt: query`now()` })
            .where(
              and(
                eq(operationTable.id, row.attemptID),
                eq(operationTable.kind, "releases.attempt"),
              ),
            );
          await txDb
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
          await state(
            row,
            "uncertain",
            safeReconcileErrors.has(message) ||
              /^Forgejo publication operation failed \(\d{3}\)$/.test(message)
              ? message
              : "Publication outcome needs reconciliation. Existing artifacts have not been rolled back.",
          );
        }
      }
    });
  }

  return { reconcileOne };
}
