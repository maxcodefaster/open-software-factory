import { createHmac } from "node:crypto";
import { and, asc, desc, eq, sql as expression } from "drizzle-orm";
import {
  type ModelConnectionView,
  type ModelConnectionWrite,
  modelConnectionWrite,
} from "#conversation-domain/model-connection";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { administrator, modelConnectionVersion, operation as operationTable } from "#db/schema";
import { CommandError } from "../command-error";
import { validateModelEndpoint } from "./native";
import type { ModelSecrets, StoredModelConnection } from "./secrets";

export type ModelsDatabase = ReturnType<typeof createDatabase>;

export const MODEL_CONNECTION_WRITE_KIND = "models.connection_write";
export const CONNECTION_SCOPE_TYPE = "connection";

const connectionWriteActiveKey = (connectionID: string) =>
  `${MODEL_CONNECTION_WRITE_KIND}:${connectionID}`;
const connectionWriteIdempotencyKey = (secretKey: string) =>
  `${MODEL_CONNECTION_WRITE_KIND}:${secretKey}`;

export type ConnectionWritePhase = "write-intended" | "committed";

export const CONNECTION_WRITE_TRANSITIONS: Record<
  ConnectionWritePhase,
  readonly ConnectionWritePhase[]
> = {
  "write-intended": ["committed"],
  committed: [],
};

export function canTransitionConnectionWrite(
  from: ConnectionWritePhase,
  to: ConnectionWritePhase,
): boolean {
  return CONNECTION_WRITE_TRANSITIONS[from].includes(to);
}

export type ConnectionWritePayload = {
  connectionID: string;
  baseVersion: number;
  provider: "openai" | "anthropic" | "deepseek";
  endpoint: string;
  fingerprint: string;
  secretKey: string;
};

export type ConnectionWriteIntent = ConnectionWritePayload & {
  commandID: string;
  state: ConnectionWritePhase;
  createdBy: string;
};

export function connectionConflict(): CommandError {
  return new CommandError(
    "conflict",
    "Model connection changed or a save is pending. Reload or retry the same save.",
  );
}

export async function requireSystemManager(sql: DatabaseTransaction, userID: string) {
  const [row] = await drizzleTransaction(sql)
    .select({ userID: administrator.userId })
    .from(administrator)
    .where(eq(administrator.userId, userID))
    .for("share");
  if (!row) throw new CommandError("forbidden", "System Manager access required");
}

export async function lockConnection(sql: DatabaseTransaction, id: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`model-connection:${id}`}))`;
}

export async function readCurrentConnectionVersion(sql: DatabaseTransaction, id: string) {
  const [row] = await drizzleTransaction(sql)
    .select({
      version: modelConnectionVersion.version,
      provider: modelConnectionVersion.provider,
      endpoint: modelConnectionVersion.endpoint,
      secretKey: modelConnectionVersion.secretKey,
    })
    .from(modelConnectionVersion)
    .where(eq(modelConnectionVersion.connectionId, id))
    .orderBy(desc(modelConnectionVersion.version))
    .limit(1);
  return row;
}

export async function readConnectionWriteIntent(
  sql: DatabaseTransaction,
  commandID: string,
): Promise<ConnectionWriteIntent | undefined> {
  const [row] = await drizzleTransaction(sql)
    .select({
      commandID: operationTable.id,
      connectionID: operationTable.scopeId,
      state: operationTable.state,
      createdBy: operationTable.createdBy,
      payload: operationTable.payload,
    })
    .from(operationTable)
    .where(
      and(eq(operationTable.id, commandID), eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND)),
    );
  if (!row?.createdBy) return undefined;
  const payload = row.payload as ConnectionWritePayload;
  return {
    commandID: row.commandID,
    connectionID: payload.connectionID ?? row.connectionID,
    baseVersion: Number(payload.baseVersion),
    provider: payload.provider,
    endpoint: payload.endpoint,
    fingerprint: payload.fingerprint,
    secretKey: payload.secretKey,
    state: row.state as ConnectionWritePhase,
    createdBy: row.createdBy,
  };
}

export async function settleConnectionWrite(
  database: ModelsDatabase,
  row: ConnectionWriteIntent,
  stored: StoredModelConnection,
): Promise<void> {
  if (
    stored.commandID !== row.commandID ||
    stored.connectionID !== row.connectionID ||
    stored.fingerprint !== row.fingerprint ||
    stored.provider !== row.provider ||
    stored.endpoint !== row.endpoint
  )
    throw new CommandError("unavailable", "Stored model connection does not match its save intent");
  await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await lockConnection(sql, row.connectionID);
    await requireSystemManager(sql, row.createdBy);
    const latest = await readConnectionWriteIntent(sql, row.commandID);
    if (latest?.state === "committed") return;
    if (
      !latest ||
      !canTransitionConnectionWrite(latest.state, "committed") ||
      ((await readCurrentConnectionVersion(sql, row.connectionID))?.version ?? 0) !==
        row.baseVersion
    )
      throw connectionConflict();
    await db.insert(modelConnectionVersion).values({
      connectionId: row.connectionID,
      version: row.baseVersion + 1,
      provider: row.provider,
      endpoint: row.endpoint,
      secretKey: row.secretKey,
      createdBy: row.createdBy,
    });
    await db
      .update(operationTable)
      .set({
        state: "committed",
        activeKey: null,
        updatedAt: expression`now()`,
        completedAt: expression`now()`,
      })
      .where(
        and(
          eq(operationTable.id, row.commandID),
          eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
          eq(operationTable.state, "write-intended"),
        ),
      );
  });
}

export async function saveModelConnection(params: {
  database: ModelsDatabase;
  secrets: ModelSecrets;
  signingKey: string;
  endpointOrigins: readonly string[];
  getView: (connectionID: string, userID: string) => Promise<ModelConnectionView>;
  userID: string;
  value: ModelConnectionWrite;
}): Promise<ModelConnectionView> {
  const { database, secrets, signingKey, endpointOrigins, getView, userID, value } = params;
  const input = modelConnectionWrite.parse(value);
  const endpoint = validateModelEndpoint(input, endpointOrigins);
  const fingerprint = createHmac("sha256", signingKey)
    .update(JSON.stringify({ ...input, endpoint }))
    .digest("hex");
  const row = await database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await lockConnection(sql, input.connectionID);
    await requireSystemManager(sql, userID);
    if (!secrets.configured)
      throw new CommandError("unavailable", "Connect OpenBao before saving provider credentials");
    const previous = await readConnectionWriteIntent(sql, input.commandID);
    if (previous) {
      if (
        previous.fingerprint !== fingerprint ||
        previous.createdBy !== userID ||
        previous.connectionID !== input.connectionID
      )
        throw connectionConflict();
      return previous;
    }
    const active = await readCurrentConnectionVersion(sql, input.connectionID);
    if ((active?.version ?? 0) !== input.version) throw connectionConflict();
    if (active && active.provider !== input.provider)
      throw new CommandError("conflict", "Create a separate connection for a different provider");
    const [pending] = await db
      .select({ commandID: operationTable.id })
      .from(operationTable)
      .where(
        and(
          eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
          eq(operationTable.scopeType, CONNECTION_SCOPE_TYPE),
          eq(operationTable.scopeId, input.connectionID),
          eq(operationTable.state, "write-intended"),
        ),
      );
    if (pending) throw connectionConflict();
    const next: ConnectionWriteIntent = {
      commandID: input.commandID,
      connectionID: input.connectionID,
      baseVersion: input.version,
      provider: input.provider,
      endpoint,
      fingerprint,
      secretKey: `models/${input.connectionID}/${input.commandID}`,
      state: "write-intended",
      createdBy: userID,
    };
    await db.insert(operationTable).values({
      id: next.commandID,
      kind: MODEL_CONNECTION_WRITE_KIND,
      scopeType: CONNECTION_SCOPE_TYPE,
      scopeId: next.connectionID,
      idempotencyKey: connectionWriteIdempotencyKey(next.secretKey),
      activeKey: connectionWriteActiveKey(next.connectionID),
      state: "write-intended",
      payload: {
        connectionID: next.connectionID,
        baseVersion: next.baseVersion,
        provider: next.provider,
        endpoint,
        fingerprint,
        secretKey: next.secretKey,
      },
      result: null,
      error: null,
      createdBy: userID,
      completedAt: null,
    });
    return next;
  });
  if (row.state === "committed") return getView(input.connectionID, userID);
  let stored = await secrets.read(row.secretKey);
  if (!stored) {
    const candidate: StoredModelConnection = {
      commandID: row.commandID,
      connectionID: row.connectionID,
      provider: row.provider,
      endpoint: row.endpoint,
      fingerprint: row.fingerprint,
      apiKey: input.apiKey,
    };
    try {
      await secrets.create(row.secretKey, candidate);
      stored = candidate;
    } catch {
      stored = await secrets.read(row.secretKey);
      if (!stored)
        throw new CommandError(
          "unavailable",
          "Model save is unconfirmed. Retry the same save; current settings remain active.",
        );
    }
  }
  await settleConnectionWrite(database, row, stored);
  return getView(input.connectionID, userID);
}

export async function recoverPendingConnectionWrites(
  database: ModelsDatabase,
  secrets: ModelSecrets,
): Promise<void> {
  if (!secrets.configured) return;
  const rows = await database.db
    .select({ commandID: operationTable.id })
    .from(operationTable)
    .where(
      and(
        eq(operationTable.kind, MODEL_CONNECTION_WRITE_KIND),
        eq(operationTable.state, "write-intended"),
      ),
    )
    .orderBy(asc(operationTable.createdAt))
    .limit(32);
  for (const { commandID } of rows) {
    const row = await database.client.begin((sql) => readConnectionWriteIntent(sql, commandID));
    if (row?.state !== "write-intended") continue;
    const stored = await secrets.read(row.secretKey);
    if (stored) await settleConnectionWrite(database, row, stored);
  }
}
