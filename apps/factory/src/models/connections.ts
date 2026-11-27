import { and, asc, desc, eq, sql as expression } from "drizzle-orm";
import type { z } from "zod";
import {
  type ModelConnectionReference,
  type ModelConnectionView,
  type ModelConnectionWrite,
  type modelRoleConnectionInput,
  modelRoleConnectionView,
} from "#conversation-domain/model-connection";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { modelConnectionVersion, modelSettings, operation as operationTable } from "#db/schema";
import { CommandError } from "../command-error";
import {
  MODEL_ROLE_PROBE_KIND,
  recoverAbandonedRoleProbes,
  selectModelRole,
} from "./connection-probes";
import {
  CONNECTION_SCOPE_TYPE,
  type ConnectionWritePayload,
  MODEL_CONNECTION_WRITE_KIND,
  readCurrentConnectionVersion,
  recoverPendingConnectionWrites,
  requireSystemManager,
  saveModelConnection,
} from "./connection-writes";
import { deploymentModelConnections } from "./deployment";
import type { ResolvedModelConnection } from "./inference-contracts";
import { validateModelEndpoint } from "./native";
import { probeModel } from "./probe";
import type { ModelSecrets } from "./secrets";

export function createModelConnections(
  database: ReturnType<typeof createDatabase>,
  secrets: ModelSecrets,
  signingKey: string,
  allowedOrigins: readonly string[] = [],
  probe = probeModel,
) {
  const endpointOrigins = [
    ...new Set([
      ...allowedOrigins,
      ...deploymentModelConnections(signingKey).flatMap((value) =>
        value.configured && value.endpoint ? [new URL(value.endpoint).origin] : [],
      ),
    ]),
  ];

  async function get(connectionID: string, userID: string): Promise<ModelConnectionView> {
    return database.client.begin(async (sql) => {
      await requireSystemManager(sql, userID);
      const row = await readCurrentConnectionVersion(sql, connectionID);
      const [pendingRow] = await drizzleTransaction(sql)
        .select({
          commandID: operationTable.id,
          payload: operationTable.payload,
        })
        .from(operationTable)
        .where(
          and(
            eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
            eq(operationTable.scopeType, CONNECTION_SCOPE_TYPE),
            eq(operationTable.scopeId, connectionID),
            eq(operationTable.state, "write-intended"),
          ),
        );
      const pending = pendingRow
        ? {
            commandID: pendingRow.commandID,
            provider: (pendingRow.payload as ConnectionWritePayload).provider,
            endpoint: (pendingRow.payload as ConnectionWritePayload).endpoint,
          }
        : undefined;
      const metadata = row ?? pending;
      if (!metadata) throw new CommandError("not-found", "Model connection not found");
      return {
        connectionID,
        version: row?.version ?? 0,
        provider: metadata.provider,
        endpoint: metadata.endpoint,
        configured: Boolean(row),
        pendingCommandID: pending?.commandID ?? null,
      };
    });
  }

  async function resolve(connectionID: string, version: number): Promise<ResolvedModelConnection> {
    const [row] = await database.db
      .select({
        version: modelConnectionVersion.version,
        provider: modelConnectionVersion.provider,
        endpoint: modelConnectionVersion.endpoint,
        secretKey: modelConnectionVersion.secretKey,
        commandID: operationTable.id,
        fingerprint: expression<string>`${operationTable.payload}->>'fingerprint'`,
      })
      .from(modelConnectionVersion)
      .innerJoin(
        operationTable,
        and(
          eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
          eq(
            operationTable.idempotencyKey,
            expression`'models.connection_write:' || ${modelConnectionVersion.secretKey}`,
          ),
        ),
      )
      .where(
        and(
          eq(modelConnectionVersion.connectionId, connectionID),
          eq(modelConnectionVersion.version, version),
        ),
      );
    if (!row) throw new CommandError("unavailable", "The admitted model connection is unavailable");
    validateModelEndpoint({ provider: row.provider, endpoint: row.endpoint }, endpointOrigins);
    const stored = await secrets.read(row.secretKey);
    if (
      !stored ||
      stored.connectionID !== connectionID ||
      stored.provider !== row.provider ||
      stored.endpoint !== row.endpoint ||
      stored.commandID !== row.commandID ||
      stored.fingerprint !== row.fingerprint
    )
      throw new CommandError("unavailable", "The admitted model credential is unavailable");
    return { provider: stored.provider, baseURL: row.endpoint, apiKey: stored.apiKey };
  }

  return {
    get,
    resolve,
    async roles(userID: string) {
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await requireSystemManager(sql, userID);
        const result = [];
        for (const role of ["planning", "build"] as const) {
          const [activeRow] = await db
            .select({
              connectionID: modelSettings.connectionId,
              version: modelSettings.connectionVersion,
              modelId: expression<string>`${modelSettings.settings}->>'modelId'`,
            })
            .from(modelSettings)
            .where(
              and(eq(modelSettings.scopeType, "role_connection"), eq(modelSettings.scopeKey, role)),
            );
          const active =
            activeRow?.connectionID && activeRow.version !== null
              ? {
                  connectionID: activeRow.connectionID,
                  version: activeRow.version,
                  modelId: activeRow.modelId,
                }
              : null;
          const [check] = await db
            .select({
              commandID: operationTable.id,
              state: operationTable.state,
              result: operationTable.result,
            })
            .from(operationTable)
            .where(
              and(
                eq(operationTable.kind, MODEL_ROLE_PROBE_KIND),
                expression`${operationTable.payload}->>'role' = ${role}`,
              ),
            )
            .orderBy(desc(operationTable.createdAt), desc(operationTable.id))
            .limit(1);
          result.push(
            modelRoleConnectionView.parse({ role, active: active ?? null, check: check ?? null }),
          );
        }
        return result;
      });
    },
    selectRole: (
      userID: string,
      value: z.output<typeof modelRoleConnectionInput>,
      signal: AbortSignal,
    ) => selectModelRole({ database, resolve, probe, userID, value, signal }),
    async reference(
      role: "planning" | "build",
      sql: DatabaseTransaction,
    ): Promise<ModelConnectionReference | undefined> {
      const [row] = await drizzleTransaction(sql)
        .select({
          connectionID: modelSettings.connectionId,
          version: modelSettings.connectionVersion,
        })
        .from(modelSettings)
        .where(
          and(eq(modelSettings.scopeType, "role_connection"), eq(modelSettings.scopeKey, role)),
        );
      if (!row?.connectionID || row.version === null) return undefined;
      return { connectionID: row.connectionID, version: row.version };
    },
    async list(userID: string) {
      const ids = await database.client.begin(async (sql) => {
        await requireSystemManager(sql, userID);
        return drizzleTransaction(sql)
          .selectDistinct({ id: operationTable.scopeId })
          .from(operationTable)
          .where(
            and(
              eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
              eq(operationTable.scopeType, CONNECTION_SCOPE_TYPE),
            ),
          )
          .orderBy(asc(operationTable.scopeId));
      });
      return Promise.all(ids.map(({ id }) => get(id, userID)));
    },
    save: (userID: string, value: ModelConnectionWrite) =>
      saveModelConnection({
        database,
        secrets,
        signingKey,
        endpointOrigins,
        getView: get,
        userID,
        value,
      }),
    async recover() {
      await recoverAbandonedRoleProbes(database);
      await recoverPendingConnectionWrites(database, secrets);
    },
  };
}
