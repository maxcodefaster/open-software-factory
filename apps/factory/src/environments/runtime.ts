import { timingSafeEqual } from "node:crypto";
import { and, eq, sql as expression, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  environmentWrite,
  projectEnvironment,
  projectImagePreparation,
  runtimeAttempt,
  runtimeEnvironmentIntent,
  substrateBinding,
  substrateSource,
} from "../../../../packages/db/src/schema";
import {
  type EnvironmentBundle,
  environmentManifest,
  environmentMetadata,
  type ProjectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { json } from "../http";
import type { EnvironmentSecrets } from "./openbao";
import { emptyEnvironment } from "./openbao";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | DatabaseTransaction;
export type RuntimeEnvironmentIntent = {
  environment: ProjectEnvironment;
  version: number;
  secretKey: string | null;
};

export async function freezeRuntimeEnvironment(
  sql: SQL,
  attemptID: string,
): Promise<RuntimeEnvironmentIntent> {
  const db = drizzleTransaction(sql);
  const read = async () =>
    (
      await db
        .select({
          environment: expression<ProjectEnvironment>`${runtimeEnvironmentIntent.environment}`,
          version: runtimeEnvironmentIntent.version,
          secretKey: runtimeEnvironmentIntent.secretKey,
        })
        .from(runtimeEnvironmentIntent)
        .where(eq(runtimeEnvironmentIntent.runtimeAttemptId, attemptID))
    )[0];
  const retained = await read();
  if (retained) return retained;
  const [attempt] = await db
    .select({
      projectID: runtimeAttempt.projectId,
      publication: expression<boolean | null>`${runtimeAttempt.isolatedKind}='publication'`,
      environment: expression<ProjectEnvironment>`COALESCE(${projectImagePreparation.environment},CASE WHEN ${runtimeAttempt.isolatedKind}='staging' THEN 'main-preview' ELSE 'development' END)`,
    })
    .from(runtimeAttempt)
    .leftJoin(
      projectImagePreparation,
      eq(projectImagePreparation.runtimeAttemptId, runtimeAttempt.id),
    )
    .where(
      and(
        eq(runtimeAttempt.id, attemptID),
        eq(runtimeAttempt.state, "create-intended"),
        isNull(runtimeAttempt.stopIntendedAt),
      ),
    );
  if (!attempt) throw new Error("Runtime Environment selection requires active create intent");
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${attempt.projectID}:${attempt.environment}`}))`;
  const [current] = attempt.publication
    ? []
    : await db
        .select({ version: projectEnvironment.version, secretKey: projectEnvironment.secretKey })
        .from(projectEnvironment)
        .where(
          and(
            eq(projectEnvironment.projectId, attempt.projectID),
            eq(projectEnvironment.environment, attempt.environment),
          ),
        );
  await db
    .insert(runtimeEnvironmentIntent)
    .values({
      runtimeAttemptId: attemptID,
      environment: attempt.environment,
      version: current?.version ?? 0,
      secretKey: current?.secretKey ?? null,
    })
    .onConflictDoNothing({ target: runtimeEnvironmentIntent.runtimeAttemptId });
  const intent = await read();
  if (!intent) throw new Error("Runtime Environment intent was not recorded");
  return intent;
}

type RuntimeEnvironmentBundle = {
  variables: EnvironmentBundle["variables"];
  registries: Omit<EnvironmentBundle["registries"][number], "publish">[];
};

export function selectRuntimeEnvironment(
  bundle: EnvironmentBundle,
  verification: boolean,
): RuntimeEnvironmentBundle {
  return {
    variables: bundle.variables.filter(
      (variable) =>
        (!verification || variable.verification) && (variable.runtime || variable.build),
    ),
    // Publication permission belongs to Factory's persisted admission. It is
    // not part of the Connector's selected registry-credential protocol.
    registries: bundle.registries
      .filter((registry) => !verification || registry.verification)
      .map(({ publish: _publish, ...registry }) => registry),
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
        const db = drizzleTransaction(sql);
        const attempt = alias(runtimeAttempt, "attempt");
        const [runtime] = await db
          .select({
            generation: attempt.generation,
            parentHash: attempt.parentConnectorTokenHash,
            workspaceID: attempt.workspaceId,
            sourceCommitted: expression<boolean>`(${substrateSource.owner}='actor'
              AND ${substrateSource.writable}
              AND ${substrateSource.actorUid}=${substrateBinding.actorUid}
              AND ${substrateBinding.deleteIntendedAt} IS NULL AND ${substrateBinding.deletedAt} IS NULL)`,
            verification: expression<boolean>`COALESCE(${attempt.isolatedKind}='verification',false)`,
            secretKey: runtimeEnvironmentIntent.secretKey,
            version: runtimeEnvironmentIntent.version,
          })
          .from(attempt)
          .innerJoin(
            runtimeEnvironmentIntent,
            eq(runtimeEnvironmentIntent.runtimeAttemptId, attempt.id),
          )
          .leftJoin(substrateBinding, eq(substrateBinding.runtimeAttemptId, attempt.id))
          .leftJoin(substrateSource, eq(substrateSource.workspaceId, attempt.workspaceId))
          .where(
            and(
              eq(attempt.id, attemptID),
              inArray(attempt.state, ["create-intended", "starting", "ready"]),
              isNull(attempt.stopIntendedAt),
            ),
          )
          .for("share", { of: attempt });
        const hash = hashConnectorToken(token);
        if (
          !runtime ||
          (runtime.workspaceID !== null && runtime.sourceCommitted !== true) ||
          runtime.generation !== Number(request.headers.get("x-factory-runtime-generation")) ||
          runtime.parentHash.length !== hash.length ||
          !timingSafeEqual(Buffer.from(hash), Buffer.from(runtime.parentHash))
        )
          return denied();
        let bundle = emptyEnvironment;
        if (runtime.secretKey) {
          const stored = await secrets.read(runtime.secretKey);
          const [write] = await db
            .select({
              fingerprint: environmentWrite.fingerprint,
              commandID: environmentWrite.commandId,
              manifest: environmentWrite.manifest,
            })
            .from(environmentWrite)
            .where(
              and(
                eq(environmentWrite.secretKey, runtime.secretKey),
                eq(environmentWrite.state, "committed"),
              ),
            );
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
