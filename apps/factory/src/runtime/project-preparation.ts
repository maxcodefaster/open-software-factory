import { createHash, timingSafeEqual } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  projectEnvironment,
  projectImagePreparation,
  runtimeAttempt,
  runtimeEnvironmentIntent,
  substrateBinding,
  substratePrebuild,
} from "../../../../packages/db/src/schema";
import type { ProjectEnvironment } from "../../../../packages/project-domain/src/environment";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { requireSetupReady } from "../setup/execution-gate";
import { substratePrebuildGrantIn } from "./substrate-prebuild-grant";

type Database = ReturnType<typeof createDatabase>;
const result = z
  .object({
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    image: z.string().regex(/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/),
  })
  .strict();

async function preparationUpload(request: Request) {
  if (Number(request.headers.get("content-length")) > 4096) return null;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return null;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) return null;
      chunks.push(next.value);
    }
    const parsed = result.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return parsed.success ? parsed.data : null;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createProjectPreparation(input: {
  database: Database;
  head(projectID: string): Promise<string>;
  start(id: string): Promise<void>;
  finish?(attemptID: string): Promise<void>;
  expire?(attemptID: string): Promise<void>;
}) {
  const sql = input.database.client;
  let draining: Promise<void> | undefined;
  async function ensure(projectID: string) {
    await requireSetupReady(sql, projectID);
    const revision = await input.head(projectID);
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(revision))
      throw new Error("Project default branch is unavailable");
    for (const environment of ["development", "main-preview"] as const) {
      await sql.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${projectID}:${environment}`}))`;
        const [settings] = await db
          .select({ version: expression<string>`${projectEnvironment.version}::text` })
          .from(projectEnvironment)
          .where(
            and(
              eq(projectEnvironment.projectId, projectID),
              eq(projectEnvironment.environment, environment),
            ),
          );
        const version = settings?.version ?? "0";
        const identity = createHash("sha256")
          .update(`${projectID}:${environment}:${revision}:${version}`)
          .digest("hex");
        const id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
        await db
          .insert(projectImagePreparation)
          .values({
            id,
            projectId: projectID,
            environment,
            revision,
            environmentVersion: expression`${version}::bigint`,
          })
          .onConflictDoNothing({
            target: [
              projectImagePreparation.projectId,
              projectImagePreparation.environment,
              projectImagePreparation.revision,
              projectImagePreparation.environmentVersion,
            ],
          });
      });
    }
  }
  async function drain() {
    if (draining) return draining;
    const task = (async () => {
      // One global active producer. Jobs coalesce to the newest requested recipe per environment.
      const connection = input.database.coordination();
      try {
        const [lock] = await connection<
          Array<{ held: boolean }>
        >`SELECT pg_try_advisory_lock(hashtext('project-image-preparation')) AS held`;
        if (!lock?.held) return;
        try {
          const db = drizzleTransaction(connection);
          const newer = alias(projectImagePreparation, "newer");
          const expired = await db
            .select({ id: runtimeAttempt.id })
            .from(projectImagePreparation)
            .innerJoin(
              runtimeAttempt,
              eq(runtimeAttempt.id, projectImagePreparation.runtimeAttemptId),
            )
            .where(
              and(
                eq(projectImagePreparation.state, "running"),
                inArray(runtimeAttempt.state, ["create-intended", "starting", "ready"]),
                isNull(runtimeAttempt.stopIntendedAt),
                lt(projectImagePreparation.updatedAt, expression`now()-interval '12 minutes'`),
              ),
            );
          for (const attempt of expired) await input.expire?.(attempt.id);
          const completed = await db
            .select({ id: runtimeAttempt.id })
            .from(projectImagePreparation)
            .innerJoin(
              runtimeAttempt,
              eq(runtimeAttempt.id, projectImagePreparation.runtimeAttemptId),
            )
            .where(
              and(
                eq(projectImagePreparation.state, "succeeded"),
                or(
                  and(
                    inArray(runtimeAttempt.state, ["starting", "ready"]),
                    isNull(runtimeAttempt.stopIntendedAt),
                  ),
                  inArray(runtimeAttempt.state, ["stop-intended", "stopping", "cleanup-failed"]),
                ),
              ),
            );
          for (const attempt of completed) await input.finish?.(attempt.id);
          await db
            .update(projectImagePreparation)
            .set({
              state: expression`CASE WHEN ${runtimeAttempt.failure} LIKE 'prebuild Compose cannot depend on the producer environment%' THEN 'unsupported' ELSE 'failed' END`,
              failure: expression`CASE WHEN ${runtimeAttempt.failure} LIKE 'prebuild Compose cannot depend on the producer environment%' THEN 'Image preparation was skipped: the Compose file references environment variables, which a prebuilt image cannot resolve. Normal startup remains available.' ELSE 'Image preparation was interrupted; normal startup remains available.' END`,
              updatedAt: expression`now()`,
            })
            .from(runtimeAttempt)
            .where(
              and(
                eq(projectImagePreparation.runtimeAttemptId, runtimeAttempt.id),
                eq(projectImagePreparation.state, "running"),
                or(
                  inArray(runtimeAttempt.state, ["stopped", "failed", "cleanup-failed"]),
                  exists(
                    db
                      .select({ attemptID: substrateBinding.runtimeAttemptId })
                      .from(substrateBinding)
                      .where(
                        and(
                          eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id),
                          isNotNull(substrateBinding.deletedAt),
                        ),
                      ),
                  ),
                ),
              ),
            );
          await db
            .update(projectImagePreparation)
            .set({
              state: "unsupported",
              failure: "Replaced by newer Project inputs.",
              updatedAt: expression`now()`,
            })
            .where(
              and(
                eq(projectImagePreparation.state, "pending"),
                exists(
                  db
                    .select({ id: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.projectId, projectImagePreparation.projectId),
                        eq(newer.environment, projectImagePreparation.environment),
                        gt(newer.createdAt, projectImagePreparation.createdAt),
                      ),
                    ),
                ),
              ),
            );
          // Unknown native cleanup retains this producer's admission. A
          // completed image alone cannot authorize another active producer.
          const active = await db
            .select({ id: projectImagePreparation.id })
            .from(projectImagePreparation)
            .leftJoin(
              runtimeAttempt,
              eq(runtimeAttempt.id, projectImagePreparation.runtimeAttemptId),
            )
            .where(
              or(
                eq(projectImagePreparation.state, "running"),
                exists(
                  db
                    .select({ attemptID: substrateBinding.runtimeAttemptId })
                    .from(substrateBinding)
                    .where(
                      and(
                        eq(substrateBinding.runtimeAttemptId, runtimeAttempt.id),
                        isNull(substrateBinding.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .limit(1);
          if (active.length) return;
          const [pending] = await db
            .select({ id: projectImagePreparation.id })
            .from(projectImagePreparation)
            .where(
              and(
                eq(projectImagePreparation.state, "pending"),
                notExists(
                  db
                    .select({ id: newer.id })
                    .from(newer)
                    .where(
                      and(
                        eq(newer.projectId, projectImagePreparation.projectId),
                        eq(newer.environment, projectImagePreparation.environment),
                        gt(newer.createdAt, projectImagePreparation.createdAt),
                      ),
                    ),
                ),
              ),
            )
            .orderBy(desc(projectImagePreparation.createdAt))
            .limit(1);
          if (pending) await input.start(pending.id);
        } finally {
          await connection`SELECT pg_advisory_unlock(hashtext('project-image-preparation'))`;
        }
      } finally {
        await connection.end({ timeout: 1 });
      }
    })();
    draining = task;
    try {
      await task;
    } finally {
      if (draining === task) draining = undefined;
    }
  }
  async function endpoint(request: Request, attemptID: string) {
    const denied = () =>
      new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!token) return denied();
    // Read the small upload before acquiring an attempt lock or a pool slot.
    // A disconnected/slow Connector must not block Stop or ordinary requests.
    const upload =
      request.method === "POST" ? await preparationUpload(request).catch(() => undefined) : null;
    if (upload === undefined)
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    if (request.method === "POST" && !upload) return denied();
    return sql
      .begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const attemptTable = alias(runtimeAttempt, "attempt");
        const [attempt] = await db
          .select({
            projectID: attemptTable.projectId,
            userID: attemptTable.createdBy,
            revision: attemptTable.revision,
            generation: attemptTable.generation,
            hash: attemptTable.parentConnectorTokenHash,
            environment: expression<ProjectEnvironment>`${runtimeEnvironmentIntent.environment}`,
            version: runtimeEnvironmentIntent.version,
            publicBuild: expression<boolean>`factory.image_build_is_public(${runtimeEnvironmentIntent.secretKey})`,
            jobID: projectImagePreparation.id,
            jobRevision: projectImagePreparation.revision,
            jobVersion: projectImagePreparation.environmentVersion,
            jobEnvironment: projectImagePreparation.environment,
            imageRepository: expression<
              string | null
            >`${substratePrebuild.intent}->>'imageRepository'`,
          })
          .from(attemptTable)
          .innerJoin(
            runtimeEnvironmentIntent,
            eq(runtimeEnvironmentIntent.runtimeAttemptId, attemptTable.id),
          )
          .leftJoin(
            projectImagePreparation,
            and(
              eq(projectImagePreparation.runtimeAttemptId, attemptTable.id),
              eq(attemptTable.isolatedKind, "prebuild"),
            ),
          )
          .leftJoin(
            substratePrebuild,
            and(
              eq(substratePrebuild.runtimeAttemptId, attemptTable.id),
              eq(substratePrebuild.preparationId, projectImagePreparation.id),
            ),
          )
          .where(
            and(
              eq(attemptTable.id, attemptID),
              inArray(attemptTable.state, ["create-intended", "starting", "ready"]),
              isNull(attemptTable.stopIntendedAt),
            ),
          )
          .for("share", { of: attemptTable });
        const hash = hashConnectorToken(token);
        if (
          !attempt ||
          attempt.generation !== Number(request.headers.get("x-factory-runtime-generation")) ||
          attempt.hash.length !== hash.length ||
          !timingSafeEqual(Buffer.from(hash), Buffer.from(attempt.hash))
        )
          return denied();
        if (request.method === "GET") {
          const [image] = await db
            .select({
              identity: projectImagePreparation.identity,
              image: projectImagePreparation.image,
            })
            .from(projectImagePreparation)
            .innerJoin(
              runtimeEnvironmentIntent,
              and(
                eq(
                  runtimeEnvironmentIntent.runtimeAttemptId,
                  projectImagePreparation.runtimeAttemptId,
                ),
                eq(runtimeEnvironmentIntent.environment, projectImagePreparation.environment),
                eq(runtimeEnvironmentIntent.version, projectImagePreparation.environmentVersion),
              ),
            )
            .where(
              and(
                eq(projectImagePreparation.projectId, attempt.projectID),
                eq(projectImagePreparation.revision, attempt.revision),
                eq(projectImagePreparation.state, "succeeded"),
                or(
                  and(
                    eq(projectImagePreparation.environment, attempt.environment),
                    eq(projectImagePreparation.environmentVersion, attempt.version),
                  ),
                  and(
                    expression`${attempt.publicBuild}`,
                    expression`factory.image_build_is_public(${runtimeEnvironmentIntent.secretKey})`,
                  ),
                ),
              ),
            )
            .orderBy(
              asc(
                expression`CASE WHEN ${attempt.publicBuild} THEN ${projectImagePreparation.environmentVersion} ELSE 0 END`,
              ),
              desc(projectImagePreparation.updatedAt),
            )
            .limit(1);
          return Response.json(image ?? null, { headers: { "cache-control": "no-store" } });
        }
        if (
          request.method !== "POST" ||
          !attempt.jobID ||
          attempt.jobRevision !== attempt.revision ||
          attempt.jobVersion !== attempt.version ||
          attempt.jobEnvironment !== attempt.environment
        )
          return denied();
        if (
          !upload ||
          !attempt.imageRepository ||
          !upload.image.startsWith(`${attempt.imageRepository}@`)
        )
          return denied();
        const [job] = await db
          .select({
            state: projectImagePreparation.state,
            identity: projectImagePreparation.identity,
            image: projectImagePreparation.image,
          })
          .from(projectImagePreparation)
          .where(eq(projectImagePreparation.id, attempt.jobID))
          .for("update");
        if (job?.state === "succeeded")
          return new Response(null, {
            status: job.identity === upload.identity && job.image === upload.image ? 204 : 409,
            headers: { "cache-control": "no-store" },
          });
        if (job?.state !== "running") return denied();
        try {
          await substratePrebuildGrantIn(
            transaction,
            attempt.projectID,
            attempt.jobID,
            attemptID,
            attempt.userID,
          );
        } catch {
          return denied();
        }
        await db
          .update(projectImagePreparation)
          .set({
            state: "succeeded",
            identity: upload.identity,
            image: upload.image,
            failure: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(projectImagePreparation.id, attempt.jobID),
              eq(projectImagePreparation.state, "running"),
            ),
          );
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      })
      .catch(() => new Response(null, { status: 503, headers: { "cache-control": "no-store" } }));
  }
  return { ensure, drain, endpoint };
}
