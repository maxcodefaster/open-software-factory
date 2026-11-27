import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, sql as expression, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation as operationTable, runtimeAttempt, substrateSource } from "#db/schema";
import {
  type EnvironmentBundle,
  environmentManifest,
  environmentMetadata,
  type ProjectEnvironment,
} from "#project-domain/environment";
import { hashConnectorToken, runtimeProjectEntryToken } from "#runtime-domain/identity";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { CommandError } from "../command-error";
import { json } from "../http";
import {
  nativeInputStopIn,
  nativeProjectEntryIn,
  substrateRuntimePrincipalIn,
  substrateWorkspaceGrantIn,
} from "../runtime/source-api";
import type { EnvironmentSecrets } from "./openbao";
import { emptyEnvironment } from "./openbao";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"] | DatabaseTransaction;
const ENVIRONMENT_INTENT_KIND = "runtime.environment_intent";
const ENVIRONMENT_INTENT_SCOPE_TYPE = "runtime_attempt";
const environmentIntentIdempotencyKey = (attemptID: string) =>
  `${ENVIRONMENT_INTENT_KIND}:${attemptID}`;
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
  const read = async (): Promise<RuntimeEnvironmentIntent | undefined> => {
    const [row] = await db
      .select({
        payload: operationTable.payload,
      })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, ENVIRONMENT_INTENT_KIND),
          eq(operationTable.scopeType, ENVIRONMENT_INTENT_SCOPE_TYPE),
          eq(operationTable.scopeId, attemptID),
          eq(operationTable.idempotencyKey, environmentIntentIdempotencyKey(attemptID)),
        ),
      );
    if (!row) return undefined;
    const environment = row.payload["environment"];
    const version = row.payload["version"];
    const secretKey = row.payload["secretKey"];
    if (
      (environment !== "development" && environment !== "main-preview") ||
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 0 ||
      (secretKey !== null && typeof secretKey !== "string")
    )
      throw new Error("Runtime Environment intent is malformed");
    return { environment, version, secretKey };
  };
  const retained = await read();
  if (retained) return retained;
  const [attempt] = await db
    .select({
      projectID: runtimeAttempt.projectId,
      publication: expression<boolean | null>`${runtimeAttempt.isolatedKind}='publication'`,
      environment: expression<ProjectEnvironment>`CASE WHEN ${runtimeAttempt.isolatedKind}='staging' THEN 'main-preview' ELSE 'development' END`,
    })
    .from(runtimeAttempt)
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
        .select({ payload: operationTable.payload })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, "environments.environment"),
            eq(operationTable.scopeType, "project"),
            eq(operationTable.scopeId, attempt.projectID),
            eq(
              operationTable.idempotencyKey,
              `environments.environment:${attempt.projectID}:${attempt.environment}`,
            ),
          ),
        );
  const currentVersion =
    current && current.payload["version"] !== undefined && current.payload["version"] !== null
      ? Number(current.payload["version"])
      : 0;
  const currentSecretKey =
    current && typeof current.payload["secretKey"] === "string"
      ? current.payload["secretKey"]
      : null;
  await db
    .insert(operationTable)
    .values({
      id: crypto.randomUUID(),
      kind: ENVIRONMENT_INTENT_KIND,
      scopeType: ENVIRONMENT_INTENT_SCOPE_TYPE,
      scopeId: attemptID,
      idempotencyKey: environmentIntentIdempotencyKey(attemptID),
      state: "recorded",
      payload: {
        environment: attempt.environment,
        version: currentVersion,
        secretKey: currentSecretKey,
      },
    })
    .onConflictDoNothing({ target: operationTable.idempotencyKey });
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
      (variable) => variable.runtime && (!verification || variable.verification),
    ),
  };
}

export function createRuntimeEnvironmentEndpoint(
  database: Database,
  secrets: EnvironmentSecrets,
  secret?: string,
  sourceTransport?: {
    sourceConnected(attemptID: string): boolean;
    sourceEpoch(attemptID: string): number | undefined;
  },
) {
  return async (request: Request, attemptID: string): Promise<Response> => {
    const denied = () =>
      new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    const forbidden = () =>
      new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
    const pendingSource = () =>
      json({ error: "Runtime Source grant is pending" }, 409, {
        "cache-control": "no-store",
      });
    if (request.method !== "GET") return denied();
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!token) return denied();
    const nativeEntry = request.headers.has("X-Factory-Runtime-Container");
    return database.client
      .begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const attempt = alias(runtimeAttempt, "attempt");
        const environmentIntent = alias(operationTable, "environment_intent");
        const [runtime] = await db
          .select({
            generation: attempt.generation,
            parentHash: attempt.parentConnectorTokenHash,
            workspaceID: attempt.workspaceId,
            sourceCommitted: expression<boolean>`(${substrateSource.owner}='actor'
              AND ${substrateSource.writable}
              AND ${substrateSource.actorUid}=${attempt.actorUid}
              AND ${attempt.deleteIntendedAt} IS NULL AND ${attempt.deletedAt} IS NULL)`,
            verification: expression<boolean>`COALESCE(${attempt.isolatedKind}='verification',false)`,
            environmentPayload: environmentIntent.payload,
          })
          .from(attempt)
          .innerJoin(
            environmentIntent,
            and(
              eq(environmentIntent.kind, ENVIRONMENT_INTENT_KIND),
              eq(environmentIntent.scopeType, ENVIRONMENT_INTENT_SCOPE_TYPE),
              eq(
                environmentIntent.idempotencyKey,
                expression`'runtime.environment_intent:' || ${attempt.id}::text`,
              ),
            ),
          )
          .leftJoin(substrateSource, eq(substrateSource.workspaceId, attempt.workspaceId))
          .where(
            and(
              eq(attempt.id, attemptID),
              inArray(attempt.state, ["create-intended", "starting", "ready"]),
              isNull(attempt.stopIntendedAt),
            ),
          )
          .for("share", { of: attempt });
        if (!runtime) return denied();
        const secretKey =
          typeof runtime.environmentPayload["secretKey"] === "string"
            ? runtime.environmentPayload["secretKey"]
            : null;
        const version = Number(runtime.environmentPayload["version"]);
        let admittedSourceEpoch: number | undefined;
        if (nativeEntry) {
          const container = request.headers.get("X-Factory-Runtime-Container") ?? "";
          let expected: string;
          try {
            expected = runtimeProjectEntryToken(
              secret ?? "",
              attemptID,
              runtime.generation,
              container,
            );
          } catch {
            return denied();
          }
          if (
            request.headers.get("X-Factory-Runtime-Generation") !== String(runtime.generation) ||
            token.length !== expected.length ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
          )
            return denied();
          const binding = await nativeProjectEntryIn(sql, attemptID);
          if (request.headers.get("X-Factory-Runtime-Actor-UID") !== binding.actorUID)
            return forbidden();
          const frozen = binding.projectTemplate;
          if (
            !frozen ||
            typeof frozen !== "object" ||
            !("content" in frozen) ||
            typeof frozen.content !== "string" ||
            !("sha256" in frozen) ||
            createHash("sha256").update(frozen.content).digest("hex") !== frozen.sha256
          )
            return forbidden();
          try {
            if (
              !parseSubstrateProjectTemplate(frozen.content).containers.some(
                (entry) => entry.name === container,
              )
            )
              return forbidden();
          } catch {
            return forbidden();
          }
          if (binding.workspaceID) {
            // Match Source restore's current execution principal/Workspace grant,
            // but never inherit its stop-only cleanup continuation.
            if (await nativeInputStopIn(sql, attemptID)) return forbidden();
            const principal = await substrateRuntimePrincipalIn(sql, attemptID);
            await substrateWorkspaceGrantIn(database, sql, binding.workspaceID, principal);
            const [source] = await db
              .select({
                owner: substrateSource.owner,
                actorUID: substrateSource.actorUid,
                writable: substrateSource.writable,
                epoch: substrateSource.writerEpoch,
              })
              .from(substrateSource)
              .where(eq(substrateSource.workspaceId, binding.workspaceID))
              .for("share");
            if (!source || source.owner === "service") return pendingSource();
            if (source.actorUID !== binding.actorUID || !source.writable) return forbidden();
            if (sourceTransport?.sourceEpoch(attemptID) !== source.epoch) return pendingSource();
            admittedSourceEpoch = source.epoch;
          }
          if (!sourceTransport?.sourceConnected(attemptID)) return pendingSource();
          admittedSourceEpoch ??= sourceTransport.sourceEpoch(attemptID);
          if (admittedSourceEpoch === undefined) return pendingSource();
        } else {
          // This is the existing Parent environment operation, never a fallback
          // for requests presenting native Project entry identity.
          const hash = hashConnectorToken(token);
          if (
            (runtime.workspaceID !== null && runtime.sourceCommitted !== true) ||
            runtime.generation !== Number(request.headers.get("x-factory-runtime-generation")) ||
            runtime.parentHash.length !== hash.length ||
            !timingSafeEqual(Buffer.from(hash), Buffer.from(runtime.parentHash))
          )
            return denied();
        }
        let bundle = emptyEnvironment;
        if (secretKey) {
          const stored = await secrets.read(secretKey);
          const [writeRow] = await db
            .select({
              commandID: operationTable.id,
              payload: operationTable.payload,
            })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, "environments.write"),
                eq(operationTable.idempotencyKey, `environments.write:${secretKey}`),
                eq(operationTable.state, "committed"),
              ),
            );
          const write = writeRow
            ? {
                commandID: writeRow.commandID,
                fingerprint:
                  typeof writeRow.payload["fingerprint"] === "string"
                    ? writeRow.payload["fingerprint"]
                    : null,
                manifest: writeRow.payload["manifest"],
              }
            : undefined;
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
        const selected = selectRuntimeEnvironment(bundle, runtime.verification);
        if (nativeEntry) {
          // Keep the native entry contract aligned with Go's nativeProjectVariable:
          // Project settings cannot replace the Actor's identity, proxy or TLS trust.
          const transportVariables = new Set([
            "SSL_CERT_FILE",
            "GIT_SSL_CAINFO",
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "ALL_PROXY",
          ]);
          if (
            selected.variables.some(
              (variable) =>
                variable.name.startsWith("ATE_") ||
                transportVariables.has(variable.name.toUpperCase()),
            )
          )
            return forbidden();
          // The Parent announces Source only after initialization/restore. A
          // connection lost during a secret read cannot admit Project execution.
          if (!sourceTransport?.sourceConnected(attemptID)) return pendingSource();
          if (sourceTransport.sourceEpoch(attemptID) !== admittedSourceEpoch)
            return pendingSource();
        }
        return json(
          {
            version,
            bundle: selected,
          },
          200,
          { "cache-control": "no-store" },
        );
      })
      .catch((cause) => {
        if (
          nativeEntry &&
          cause instanceof CommandError &&
          ["forbidden", "not-found", "conflict", "invalid"].includes(cause.code)
        )
          return forbidden();
        return json({ error: "Runtime environment is unavailable" }, 503, {
          "cache-control": "no-store",
        });
      });
  };
}
