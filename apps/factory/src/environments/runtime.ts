import { timingSafeEqual } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  environmentMetadata,
  environmentManifest,
  type EnvironmentBundle,
  type ProjectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import type { EnvironmentSecrets } from "./openbao";
import { emptyEnvironment } from "./openbao";
import { json } from "../http";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | TransactionSql;
export type RuntimeEnvironmentIntent = {
  environment: ProjectEnvironment;
  version: number;
  secretKey: string | null;
};

export async function freezeRuntimeEnvironment(
  sql: SQL,
  attemptID: string,
): Promise<RuntimeEnvironmentIntent> {
  const read = async () =>
    (
      await sql<
        RuntimeEnvironmentIntent[]
      >`SELECT environment,version::float8 AS version,secret_key AS "secretKey" FROM factory.runtime_environment_intent WHERE runtime_attempt_id=${attemptID}`
    )[0];
  const retained = await read();
  if (retained) return retained;
  const [attempt] = await sql<
    Array<{ projectID: string; environment: ProjectEnvironment }>
  >`SELECT project_id AS "projectID", COALESCE((SELECT environment FROM factory.project_image_preparation WHERE runtime_attempt_id=attempt.id),CASE WHEN isolated_kind='staging' THEN 'main-preview' ELSE 'development' END) AS environment FROM factory.runtime_attempt attempt WHERE id=${attemptID} AND state='create-intended' AND stop_intended_at IS NULL`;
  if (!attempt) throw new Error("Runtime Environment selection requires active create intent");
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${attempt.projectID}:${attempt.environment}`}))`;
  const [current] = await sql<
    Array<{ version: number; secretKey: string | null }>
  >`SELECT version::float8 AS version,secret_key AS "secretKey" FROM factory.project_environment WHERE project_id=${attempt.projectID} AND environment=${attempt.environment}`;
  await sql`INSERT INTO factory.runtime_environment_intent(runtime_attempt_id,environment,version,secret_key) VALUES(${attemptID},${attempt.environment},${current?.version ?? 0},${current?.secretKey ?? null}) ON CONFLICT(runtime_attempt_id) DO NOTHING`;
  const intent = await read();
  if (!intent) throw new Error("Runtime Environment intent was not recorded");
  return intent;
}

export function selectRuntimeEnvironment(
  bundle: EnvironmentBundle,
  verification: boolean,
): EnvironmentBundle {
  return {
    variables: bundle.variables.filter(
      (variable) =>
        (!verification || variable.verification) && (variable.runtime || variable.build),
    ),
    registries: bundle.registries.filter((registry) => !verification || registry.verification),
  };
}

export function createRuntimeEnvironmentEndpoint(database: Database, secrets: EnvironmentSecrets) {
  return async (request: Request, attemptID: string): Promise<Response> => {
    const denied = () =>
      new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    if (request.method !== "GET") return denied();
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!token) return denied();
    return database.client
      .begin(async (sql) => {
        const [runtime] = await sql<
          Array<{
            generation: number;
            parentHash: string;
            verification: boolean;
            secretKey: string | null;
            version: number;
          }>
        >`SELECT attempt.generation::float8 AS generation,attempt.parent_connector_token_hash AS "parentHash",COALESCE(attempt.isolated_kind='verification',false) AS verification,intent.secret_key AS "secretKey",intent.version::float8 AS version FROM factory.runtime_attempt attempt JOIN factory.runtime_environment_intent intent ON intent.runtime_attempt_id=attempt.id WHERE attempt.id=${attemptID} AND attempt.state IN ('create-intended','starting','ready') AND attempt.stop_intended_at IS NULL FOR SHARE OF attempt`;
        const hash = hashConnectorToken(token);
        if (
          !runtime ||
          runtime.generation !== Number(request.headers.get("x-factory-runtime-generation")) ||
          runtime.parentHash.length !== hash.length ||
          !timingSafeEqual(Buffer.from(hash), Buffer.from(runtime.parentHash))
        )
          return denied();
        let bundle = emptyEnvironment;
        if (runtime.secretKey) {
          const stored = await secrets.read(runtime.secretKey);
          const [write] = await sql<
            Array<{ fingerprint: string; commandID: string; manifest: unknown }>
          >`SELECT fingerprint,command_id AS "commandID",manifest FROM factory.environment_write WHERE secret_key=${runtime.secretKey} AND state='committed'`;
          if (
            !stored ||
            !write ||
            stored.commandID !== write.commandID ||
            stored.fingerprint !== write.fingerprint ||
            JSON.stringify(environmentMetadata(stored.bundle)) !==
              JSON.stringify(environmentManifest.parse(write.manifest))
          )
            return json({ error: "Runtime environment is unavailable" }, 503, {
              "cache-control": "no-store",
            });
          bundle = stored.bundle;
        }
        return json(
          {
            version: runtime.version,
            bundle: selectRuntimeEnvironment(bundle, runtime.verification),
          },
          200,
          { "cache-control": "no-store" },
        );
      })
      .catch(() =>
        json({ error: "Runtime environment is unavailable" }, 503, { "cache-control": "no-store" }),
      );
  };
}
