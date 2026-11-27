import { and, eq, sql as expression, gt, ne } from "drizzle-orm";
import { drizzleTransaction } from "#db/client";
import { mcpConnection, operation } from "#db/schema";
import { CommandError } from "../command-error";
import {
  advisoryLock,
  assertConnectionActive,
  completeOperation,
  type Material,
  type MCPConnectionContext,
  type SecretWrite,
  secretWritePayload,
} from "./connection-state";

export async function readMaterial(
  ctx: MCPConnectionContext,
  id: string,
  epoch?: string,
): Promise<Material> {
  const connection = await ctx.database.client.begin((sql) => ctx.library.connectionIn(sql, id));
  if (epoch && connection.credentialEpoch !== epoch)
    throw new CommandError("conflict", "MCP authorization was replaced");
  if (connection.state === "revoked")
    throw new CommandError("forbidden", "MCP connection was disconnected");
  if (!connection.secretKey) return {};
  const stored = await ctx.secrets.read(connection.secretKey);
  if (!stored || stored.connectionId !== id || ctx.fingerprint(stored.material) !== stored.digest)
    throw new CommandError("unavailable", "The MCP credential is unavailable");
  return stored.material as Material;
}

export async function settleSecretWrite(ctx: MCPConnectionContext, write: SecretWrite) {
  const stored = await ctx.secrets.read(write.secretKey);
  if (!stored) return false;
  if (
    stored.connectionId !== write.connectionId ||
    stored.commandId !== write.id ||
    stored.digest !== write.digest ||
    ctx.fingerprint(stored.material) !== write.digest
  )
    throw new CommandError("unavailable", "MCP secret does not match its durable write intent");
  const committed = await ctx.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await advisoryLock(db, `mcp-secret:${write.connectionId}`);
    const writeWhere = and(eq(operation.id, write.id), eq(operation.kind, "mcp.secret_write"));
    const [current] = await db
      .select({ state: operation.state })
      .from(operation)
      .where(writeWhere)
      .for("update");
    if (current?.state !== "intended") return current?.state === "committed";
    const [actor] = await db
      .select({ id: mcpConnection.authorizedBy })
      .from(mcpConnection)
      .where(eq(mcpConnection.id, write.connectionId));
    try {
      if (!actor) throw new CommandError("not-found", "MCP connection not found");
      await ctx.library.authorizeIn(sql, write.connectionId, actor.id);
    } catch (cause) {
      if (!(cause instanceof CommandError) || !["forbidden", "not-found"].includes(cause.code))
        throw cause;
      await completeOperation(db, writeWhere, "superseded", { clearActiveKey: true });
      return false;
    }
    const updated = await db
      .update(mcpConnection)
      .set({ secretKey: write.secretKey, updatedAt: expression<Date>`now()` })
      .where(
        and(
          eq(mcpConnection.id, write.connectionId),
          expression<boolean>`${mcpConnection.secretKey} IS NOT DISTINCT FROM ${write.baseKey}`,
          eq(mcpConnection.credentialEpoch, write.credentialEpoch),
          ne(mcpConnection.state, "revoked"),
        ),
      )
      .returning({ id: mcpConnection.id });
    await completeOperation(db, writeWhere, updated.length ? "committed" : "superseded", {
      clearActiveKey: true,
    });
    if (updated.length && write.refreshId) {
      const renewed = await completeOperation(
        db,
        and(
          eq(operation.id, write.refreshId),
          eq(operation.kind, "mcp.token_refresh"),
          eq(operation.scopeType, "connection"),
          eq(operation.scopeId, write.connectionId),
          expression<boolean>`${operation.payload}->>'credentialEpoch' = ${write.credentialEpoch}`,
        ),
        "committed",
        { clearActiveKey: true },
      );
      if (renewed.length)
        await db
          .update(mcpConnection)
          .set({ state: "ready" })
          .where(
            and(
              eq(mcpConnection.id, write.connectionId),
              eq(mcpConnection.credentialEpoch, write.credentialEpoch),
              eq(mcpConnection.state, "reconnect"),
              gt(expression<number>`jsonb_array_length(${mcpConnection.allowedTools})`, 0),
            ),
          );
    }
    return updated.length > 0;
  });
  if (!committed)
    throw new CommandError("conflict", "MCP credentials changed or were disconnected");
  return true;
}

export async function persistMaterial(
  ctx: MCPConnectionContext,
  id: string,
  value: Material,
  epoch: string,
  refreshId?: string,
) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 131072)
    throw new CommandError("conflict", "MCP authorization metadata exceeds its storage limit");
  const snapshot = JSON.parse(encoded) as Material;
  const digest = ctx.fingerprint(snapshot);
  const write = await ctx.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await advisoryLock(db, `mcp-secret:${id}`);
    const connection = await ctx.library.connectionIn(sql, id);
    assertConnectionActive(connection, epoch, "MCP connection was disconnected or replaced");
    const [pending] = await db
      .select({ id: operation.id })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "mcp.secret_write"),
          eq(operation.scopeType, "connection"),
          eq(operation.scopeId, id),
          eq(operation.state, "intended"),
        ),
      );
    if (pending) throw new CommandError("conflict", "An MCP credential write needs recovery");
    const writeId = crypto.randomUUID();
    const secretKey = `mcp/${id}/${writeId}`;
    await db.insert(operation).values({
      id: writeId,
      kind: "mcp.secret_write",
      scopeType: "connection",
      scopeId: id,
      idempotencyKey: `mcp.secret_write:${secretKey}`,
      activeKey: `mcp.secret_write:${id}`,
      state: "intended",
      payload: {
        baseKey: connection.secretKey,
        credentialEpoch: epoch,
        secretKey,
        digest,
        refreshId: refreshId ?? null,
      },
      createdBy: connection.authorizedBy,
    });
    return {
      id: writeId,
      connectionId: id,
      baseKey: connection.secretKey,
      credentialEpoch: epoch,
      secretKey,
      digest,
      state: "intended",
      refreshId: refreshId ?? null,
    };
  });
  await ctx.secrets.create(write.secretKey, {
    commandId: write.id,
    connectionId: id,
    digest,
    material: snapshot,
  });
  await settleSecretWrite(ctx, write);
}

export async function recoverSecretWrites(ctx: MCPConnectionContext) {
  const rows = await ctx.database.db
    .select({
      id: operation.id,
      connectionId: operation.scopeId,
      payload: operation.payload,
      state: operation.state,
    })
    .from(operation)
    .where(and(eq(operation.kind, "mcp.secret_write"), eq(operation.state, "intended")));
  for (const row of rows) {
    const parsed = secretWritePayload.parse(row.payload);
    const write: SecretWrite = {
      id: row.id,
      connectionId: row.connectionId,
      baseKey: parsed.baseKey,
      credentialEpoch: parsed.credentialEpoch,
      secretKey: parsed.secretKey,
      digest: parsed.digest,
      state: row.state,
      refreshId: parsed.refreshId ?? null,
    };
    try {
      await settleSecretWrite(ctx, write);
    } catch (cause) {
      if (
        !(cause instanceof CommandError) ||
        !["conflict", "forbidden", "not-found"].includes(cause.code)
      )
        throw cause;
    }
  }
  // Never replay an authorization-code exchange or rotating refresh after a
  // crash. A new explicit Connect creates a new authorization intent.
}
