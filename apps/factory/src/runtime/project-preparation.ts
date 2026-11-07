import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { ProjectEnvironment } from "../../../../packages/project-domain/src/environment";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { requireSetupReady } from "../setup/execution-gate";

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
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${projectID}:${environment}`}))`;
        const [settings] = await transaction<
          Array<{ version: string }>
        >`SELECT version::text AS version FROM factory.project_environment WHERE project_id=${projectID} AND environment=${environment}`;
        const version = settings?.version ?? "0";
        const identity = createHash("sha256")
          .update(`${projectID}:${environment}:${revision}:${version}`)
          .digest("hex");
        const id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
        await transaction`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version) VALUES(${id},${projectID},${environment},${revision},${version}) ON CONFLICT(project_id,environment,revision,environment_version) DO NOTHING`;
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
          const expired = await connection<
            Array<{ id: string }>
          >`SELECT attempt.id FROM factory.project_image_preparation preparation JOIN factory.runtime_attempt attempt ON attempt.id=preparation.runtime_attempt_id WHERE preparation.state='running' AND attempt.state IN ('create-intended','starting','ready') AND attempt.stop_intended_at IS NULL AND preparation.updated_at<now()-interval '12 minutes'
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=attempt.id)`;
          for (const attempt of expired) await input.expire?.(attempt.id);
          const completed = await connection<
            Array<{ id: string }>
          >`SELECT attempt.id FROM factory.project_image_preparation preparation JOIN factory.runtime_attempt attempt ON attempt.id=preparation.runtime_attempt_id WHERE preparation.state='succeeded' AND attempt.state IN ('starting','ready') AND attempt.stop_intended_at IS NULL`;
          for (const attempt of completed) await input.finish?.(attempt.id);
          await connection`UPDATE factory.project_image_preparation preparation SET state=CASE WHEN attempt.failure LIKE 'prebuild Compose cannot depend on the producer environment%' THEN 'unsupported' ELSE 'failed' END,failure=CASE WHEN attempt.failure LIKE 'prebuild Compose cannot depend on the producer environment%' THEN 'Image preparation was skipped: the Compose file references environment variables, which a prebuilt image cannot resolve. Normal startup remains available.' ELSE 'Image preparation was interrupted; normal startup remains available.' END,updated_at=now()
            FROM factory.runtime_attempt attempt WHERE preparation.runtime_attempt_id=attempt.id AND preparation.state='running'
              AND (attempt.state IN ('stopped','failed','cleanup-failed') OR (attempt.state='stopping' AND EXISTS(
                SELECT 1 FROM factory.factorybox_lifecycle_operation deletion JOIN factory.factorybox_runtime native ON native.runtime_attempt_id=deletion.runtime_attempt_id
                WHERE deletion.runtime_attempt_id=attempt.id AND deletion.action='delete' AND deletion.completed_at IS NOT NULL
                  AND deletion.observation->>'phase'='deleted' AND deletion.observation->>'id'=native.request->>'sandboxID')))`;
          await connection`UPDATE factory.project_image_preparation preparation SET state='unsupported',failure='Replaced by newer Project inputs.',updated_at=now() WHERE state='pending' AND EXISTS(SELECT 1 FROM factory.project_image_preparation newer WHERE newer.project_id=preparation.project_id AND newer.environment=preparation.environment AND newer.created_at>preparation.created_at)`;
          // A confirmed native Delete means this producer is no longer live.
          // Keep failed backing cleanup and its storage ownership retained,
          // without making it an indefinite global image-production lock.
          const active =
            await connection`SELECT preparation.id FROM factory.project_image_preparation preparation LEFT JOIN factory.runtime_attempt attempt ON attempt.id=preparation.runtime_attempt_id
              WHERE preparation.state='running' OR (attempt.state IN ('create-intended','starting','ready','stop-intended','stopping','cleanup-failed') AND NOT EXISTS(
                SELECT 1 FROM factory.factorybox_lifecycle_operation deletion JOIN factory.factorybox_runtime native ON native.runtime_attempt_id=deletion.runtime_attempt_id
                WHERE deletion.runtime_attempt_id=attempt.id AND deletion.action='delete' AND deletion.completed_at IS NOT NULL
                  AND deletion.observation->>'phase'='deleted' AND deletion.observation->>'id'=native.request->>'sandboxID')) LIMIT 1`;
          if (active.length) return;
          const [pending] = await connection<
            Array<{ id: string }>
          >`SELECT preparation.id FROM factory.project_image_preparation preparation WHERE state='pending' AND NOT EXISTS(SELECT 1 FROM factory.project_image_preparation newer WHERE newer.project_id=preparation.project_id AND newer.environment=preparation.environment AND newer.created_at>preparation.created_at) ORDER BY created_at DESC LIMIT 1`;
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
        const [attempt] = await transaction<
          Array<{
            projectID: string;
            revision: string;
            generation: number;
            hash: string;
            environment: ProjectEnvironment;
            version: number;
            jobID: string | null;
            jobRevision: string | null;
            jobVersion: number | null;
            imageRepository: string | null;
            jobEnvironment: string | null;
            publicBuild: boolean;
          }>
        >`SELECT attempt.project_id AS "projectID",attempt.revision,attempt.generation::float8 AS generation,attempt.parent_connector_token_hash AS hash,intent.environment,intent.version::float8 AS version,factory.image_build_is_public(intent.secret_key) AS "publicBuild",preparation.id AS "jobID",preparation.revision AS "jobRevision",preparation.environment_version::float8 AS "jobVersion",preparation.environment AS "jobEnvironment",split_part(artifact.runtime_host_image,'/',1)||'/open-factory/prebuilds/'||attempt.project_id::text AS "imageRepository" FROM factory.runtime_attempt attempt JOIN factory.runtime_environment_intent intent ON intent.runtime_attempt_id=attempt.id LEFT JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id LEFT JOIN factory.project_image_preparation preparation ON preparation.runtime_attempt_id=attempt.id AND attempt.isolated_kind='prebuild' WHERE attempt.id=${attemptID} AND attempt.state IN ('create-intended','starting','ready') AND attempt.stop_intended_at IS NULL FOR SHARE OF attempt`;
        const hash = hashConnectorToken(token);
        if (
          !attempt ||
          attempt.generation !== Number(request.headers.get("x-factory-runtime-generation")) ||
          attempt.hash.length !== hash.length ||
          !timingSafeEqual(Buffer.from(hash), Buffer.from(attempt.hash))
        )
          return denied();
        if (request.method === "GET") {
          const [image] = await transaction<
            Array<{ identity: string; image: string }>
          >`SELECT preparation.identity,preparation.image FROM factory.project_image_preparation preparation
            JOIN factory.runtime_environment_intent producer_environment ON producer_environment.runtime_attempt_id=preparation.runtime_attempt_id
              AND producer_environment.environment=preparation.environment AND producer_environment.version=preparation.environment_version
            WHERE preparation.project_id=${attempt.projectID}
              AND preparation.revision=${attempt.revision} AND preparation.state='succeeded'
              AND ((preparation.environment=${attempt.environment} AND preparation.environment_version=${attempt.version}) OR
                (${attempt.publicBuild} AND factory.image_build_is_public(producer_environment.secret_key)))
            ORDER BY CASE WHEN ${attempt.publicBuild} THEN preparation.environment_version ELSE 0 END,
              preparation.updated_at DESC LIMIT 1`;
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
        const [job] = await transaction<
          Array<{ state: string; identity: string | null; image: string | null }>
        >`SELECT state,identity,image FROM factory.project_image_preparation WHERE id=${attempt.jobID} FOR UPDATE`;
        if (job?.state === "succeeded")
          return new Response(null, {
            status: job.identity === upload.identity && job.image === upload.image ? 204 : 409,
            headers: { "cache-control": "no-store" },
          });
        if (job?.state !== "running") return denied();
        await transaction`UPDATE factory.project_image_preparation SET state='succeeded',identity=${upload.identity},image=${upload.image},failure=NULL,updated_at=now() WHERE id=${attempt.jobID} AND state='running'`;
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      })
      .catch(() => new Response(null, { status: 503, headers: { "cache-control": "no-store" } }));
  }
  return { ensure, drain, endpoint };
}
