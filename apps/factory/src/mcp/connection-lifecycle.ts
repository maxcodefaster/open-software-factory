import { randomBytes } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { and, eq, sql as expression, gt } from "drizzle-orm";
import { mcpConnectInput } from "#conversation-domain/mcp-library";
import { drizzleTransaction } from "#db/client";
import { mcpConnection, operation } from "#db/schema";
import { CommandError } from "../command-error";
import {
  advisoryLock,
  completeOperation,
  connectPayload,
  connectResult,
  finishConnectionOperations,
  type MCPConnectionContext,
  markConnectionReconnect,
  markConnectionReview,
  oauthFlowPayload,
} from "./connection-state";
import { mcpDigest } from "./controller";
import { createRemoteConnection } from "./oauth-provider";
import { persistMaterial } from "./secret-store";

type ConnectInput = typeof mcpConnectInput._output;

async function admitConnection(
  ctx: MCPConnectionContext,
  id: string,
  userId: string,
  input: ConnectInput,
  commandFingerprint: string,
) {
  return ctx.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    await ctx.library.authorizeIn(sql, id, userId);
    await advisoryLock(db, `mcp-connect:${id}`);
    const [previous] = await db
      .select({
        id: operation.id,
        connectionId: operation.scopeId,
        createdBy: operation.createdBy,
        state: operation.state,
        payload: operation.payload,
        result: operation.result,
      })
      .from(operation)
      .where(eq(operation.idempotencyKey, `mcp.connect:${input.commandId}`));
    if (previous) {
      const previousPayload = connectPayload.parse(previous.payload);
      if (
        previous.connectionId !== id ||
        previousPayload.revisionId !== input.revisionId ||
        previous.createdBy !== userId ||
        previousPayload.fingerprint !== commandFingerprint
      )
        throw new CommandError("conflict", "MCP command identity was reused");
      if (previous.state !== "completed")
        throw new CommandError(
          "conflict",
          "This connection attempt is incomplete. Start a new explicit connection",
        );
      const current = await ctx.library.connectionIn(sql, id);
      if (
        current.credentialEpoch !== input.commandId ||
        ["reconnect", "revoked"].includes(current.state)
      )
        throw new CommandError(
          "conflict",
          "This authorization was replaced or failed. Start a new explicit connection",
        );
      const previousResult = previous.result ? connectResult.parse(previous.result) : null;
      return {
        replay: true as const,
        operationId: previous.id,
        authorizationUrl:
          current.state === "authorizing" ? (previousResult?.authorizationUrl ?? null) : null,
        authentication: null,
      };
    }
    const revision = await ctx.library.revisionIn(sql, input.revisionId);
    if (revision.libraryId !== id)
      throw new CommandError("conflict", "MCP revision belongs to another entry");
    const [existing] = await db
      .select({ version: mcpConnection.version })
      .from(mcpConnection)
      .where(eq(mcpConnection.id, id));
    if ((existing?.version ?? 0) !== input.expectedVersion)
      throw new CommandError("conflict", "The MCP connection changed. Reload before connecting");
    if (revision.content.authentication === "bearer" && !input.token)
      throw new CommandError("conflict", "Enter the read-only access token");
    if (revision.content.authentication !== "bearer" && input.token)
      throw new CommandError("conflict", "This MCP connection does not accept a bearer token");
    await db
      .insert(mcpConnection)
      .values({
        id,
        revisionId: input.revisionId,
        state: "authorizing",
        authorizedBy: userId,
        credentialEpoch: input.commandId,
      })
      .onConflictDoUpdate({
        target: mcpConnection.id,
        set: {
          revisionId: input.revisionId,
          state: "authorizing",
          version: expression<number>`${mcpConnection.version}+1`,
          secretKey: null,
          tools: [],
          allowedTools: [],
          authorizedBy: userId,
          credentialEpoch: input.commandId,
          updatedAt: expression<Date>`now()`,
        },
      });
    await finishConnectionOperations(db, id, "mcp.secret_write", ["intended"], "superseded", true);
    await finishConnectionOperations(
      db,
      id,
      "mcp.oauth_flow",
      ["pending", "exchanging"],
      "failed",
      false,
    );
    await finishConnectionOperations(db, id, "mcp.connect", ["running"], "uncertain", true);
    await finishConnectionOperations(db, id, "mcp.token_refresh", ["intended"], "uncertain", true);
    const connectOperationId = crypto.randomUUID();
    await db.insert(operation).values({
      id: connectOperationId,
      kind: "mcp.connect",
      scopeType: "connection",
      scopeId: id,
      idempotencyKey: `mcp.connect:${input.commandId}`,
      activeKey: `mcp.connect:${id}`,
      state: "running",
      payload: {
        commandId: input.commandId,
        revisionId: input.revisionId,
        fingerprint: commandFingerprint,
      },
      createdBy: userId,
    });
    return {
      replay: false as const,
      operationId: connectOperationId,
      authorizationUrl: null,
      authentication: revision.content.authentication,
    };
  });
}

export async function connectMCP(
  ctx: MCPConnectionContext,
  id: string,
  userId: string,
  value: unknown,
) {
  const input = mcpConnectInput.parse(value);
  const commandFingerprint = ctx.fingerprint({ id, userId, input });
  const admission = await admitConnection(ctx, id, userId, input, commandFingerprint);
  if (admission.replay) return { authorizationUrl: admission.authorizationUrl };
  let client: Awaited<ReturnType<typeof createRemoteConnection>> | undefined;
  try {
    if (input.token) await persistMaterial(ctx, id, { bearer: input.token }, input.commandId);
    const state =
      admission.authentication === "oauth" ? randomBytes(32).toString("base64url") : undefined;
    if (state) {
      const stateDigest = mcpDigest(state);
      await ctx.database.db.insert(operation).values({
        id: crypto.randomUUID(),
        kind: "mcp.oauth_flow",
        scopeType: "connection",
        scopeId: id,
        idempotencyKey: `mcp.oauth_flow:${stateDigest}`,
        state: "pending",
        payload: { credentialEpoch: input.commandId, stateDigest },
        createdBy: userId,
        leaseExpiresAt: expression<Date>`now()+interval '10 minutes'`,
      });
    }
    client = await createRemoteConnection(ctx, id, state, input.commandId);
    try {
      await client.connect();
      const tools = await client.tools();
      await markConnectionReview(ctx.database.db, id, input.commandId, tools, "authorizing");
    } catch (cause) {
      if (!(cause instanceof UnauthorizedError) || !client.redirect()) throw cause;
    }
    const authorizationUrl = client.redirect() ?? null;
    await completeOperation(ctx.database.db, eq(operation.id, admission.operationId), "completed", {
      clearActiveKey: true,
      result: { authorizationUrl },
    });
    return { authorizationUrl };
  } catch {
    await completeOperation(ctx.database.db, eq(operation.id, admission.operationId), "failed", {
      clearActiveKey: true,
      error: "Could not connect to the MCP server",
    });
    await markConnectionReconnect(ctx.database.db, id, input.commandId, "authorizing");
    throw new CommandError(
      "unavailable",
      "Could not connect to the MCP server. Check its endpoint, account access and OAuth callback allowlist",
    );
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function completeOAuthCallback(
  ctx: MCPConnectionContext,
  userId: string,
  params: URLSearchParams,
) {
  const state = params.get("state");
  if (!state || !params.get("code") || params.has("error"))
    throw new CommandError("conflict", "MCP authorization was cancelled or is invalid");
  const flow = await ctx.database.client.begin(async (sql) => {
    const db = drizzleTransaction(sql);
    const [row] = await db
      .select({
        id: operation.id,
        connectionId: operation.scopeId,
        payload: operation.payload,
      })
      .from(operation)
      .where(
        and(
          eq(operation.kind, "mcp.oauth_flow"),
          eq(operation.idempotencyKey, `mcp.oauth_flow:${mcpDigest(state)}`),
          eq(operation.createdBy, userId),
          eq(operation.state, "pending"),
          gt(operation.leaseExpiresAt, expression<Date>`now()`),
        ),
      )
      .for("update");
    if (!row)
      throw new CommandError(
        "forbidden",
        "MCP authorization has expired or belongs to another session",
      );
    const { credentialEpoch } = oauthFlowPayload.parse(row.payload);
    const flow = { id: row.id, connectionId: row.connectionId, credentialEpoch };
    await ctx.library.authorizeIn(sql, flow.connectionId, userId);
    const connection = await ctx.library.connectionIn(sql, flow.connectionId);
    if (connection.credentialEpoch !== flow.credentialEpoch || connection.state !== "authorizing")
      throw new CommandError("conflict", "MCP authorization was replaced");
    await db
      .update(operation)
      .set({ state: "exchanging", updatedAt: expression<Date>`now()` })
      .where(eq(operation.id, flow.id));
    return flow;
  });
  let client: Awaited<ReturnType<typeof createRemoteConnection>> | undefined;
  try {
    client = await createRemoteConnection(ctx, flow.connectionId, undefined, flow.credentialEpoch);
    await client.transport.finishAuth(params);
    const connected = await createRemoteConnection(
      ctx,
      flow.connectionId,
      undefined,
      flow.credentialEpoch,
    );
    try {
      await connected.connect();
      const tools = await connected.tools();
      await ctx.database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await ctx.library.authorizeIn(sql, flow.connectionId, userId);
        const [active] = await db
          .select({ id: operation.id })
          .from(operation)
          .where(
            and(
              eq(operation.id, flow.id),
              eq(operation.kind, "mcp.oauth_flow"),
              eq(operation.state, "exchanging"),
            ),
          )
          .for("update");
        if (!active) throw new CommandError("conflict", "MCP authorization was replaced");
        await markConnectionReview(
          db,
          flow.connectionId,
          flow.credentialEpoch,
          tools,
          "authorizing",
        );
        await completeOperation(db, eq(operation.id, flow.id), "completed");
      });
    } finally {
      await connected.close().catch(() => {});
    }
    return { connected: true };
  } catch {
    await completeOperation(ctx.database.db, eq(operation.id, flow.id), "failed", {
      error: "MCP authorization could not be completed",
    });
    await markConnectionReconnect(
      ctx.database.db,
      flow.connectionId,
      flow.credentialEpoch,
      "authorizing",
    );
    throw new CommandError(
      "unavailable",
      "MCP authorization could not be completed. Start a new connection in Settings",
    );
  } finally {
    await client?.close().catch(() => {});
  }
}
