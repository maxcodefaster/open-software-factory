import type {
  FetchLike,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { and, eq, sql as expression, inArray, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { createDatabase } from "#db/client";
import { mcpConnection, operation } from "#db/schema";
import { CommandError } from "../command-error";
import type { createMCPLibrary } from "./controller";
import type { MCPSecrets } from "./secrets";

export const secretWritePayload = z.object({
  baseKey: z.string().nullable(),
  credentialEpoch: z.string(),
  secretKey: z.string(),
  digest: z.string(),
  refreshId: z.string().nullable().optional(),
});

export const connectPayload = z.object({
  commandId: z.string(),
  revisionId: z.string(),
  fingerprint: z.string(),
});

export const connectResult = z.object({
  authorizationUrl: z.string().nullable(),
});

export const oauthFlowPayload = z.object({
  credentialEpoch: z.string(),
  stateDigest: z.string(),
});

export type MCPDatabase = ReturnType<typeof createDatabase>;
export type MCPQueryDB = MCPDatabase["db"];

export type Material = {
  bearer?: string;
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: StoredOAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
};

export type SecretWrite = {
  id: string;
  connectionId: string;
  baseKey: string | null;
  credentialEpoch: string;
  secretKey: string;
  digest: string;
  state: string;
  refreshId: string | null;
};

export type MCPConnectionContext = {
  database: MCPDatabase;
  secrets: MCPSecrets;
  library: ReturnType<typeof createMCPLibrary>;
  fingerprint: (value: unknown) => string;
  callback: string;
  fetcher: FetchLike;
};

export async function advisoryLock(db: MCPQueryDB, key: string) {
  await db.execute(expression`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export function assertConnectionActive(
  connection: { credentialEpoch: string | null; state: string },
  expectedEpoch: string,
  message = "MCP authorization was replaced or disconnected",
) {
  if (connection.credentialEpoch !== expectedEpoch || connection.state === "revoked")
    throw new CommandError("forbidden", message);
}

export async function markConnectionReconnect(
  db: MCPQueryDB,
  id: string,
  epoch: string,
  onlyState?: "authorizing",
) {
  await db
    .update(mcpConnection)
    .set({ state: "reconnect" })
    .where(
      and(
        eq(mcpConnection.id, id),
        eq(mcpConnection.credentialEpoch, epoch),
        onlyState ? eq(mcpConnection.state, onlyState) : ne(mcpConnection.state, "revoked"),
      ),
    );
}

export async function markConnectionReview(
  db: MCPQueryDB,
  id: string,
  epoch: string,
  tools: typeof mcpConnection.$inferInsert.tools,
  currentState: "authorizing" | "ready",
  options?: { clearAllowed?: boolean; touchUpdatedAt?: boolean },
) {
  await db
    .update(mcpConnection)
    .set({
      state: "review",
      tools,
      ...(options?.clearAllowed ? { allowedTools: [] } : {}),
      version: expression<number>`${mcpConnection.version}+1`,
      ...(options?.touchUpdatedAt ? { updatedAt: expression<Date>`now()` } : {}),
    })
    .where(
      and(
        eq(mcpConnection.id, id),
        eq(mcpConnection.state, currentState),
        eq(mcpConnection.credentialEpoch, epoch),
      ),
    );
}

export async function completeOperation(
  db: MCPQueryDB,
  where: SQL | undefined,
  state: string,
  options?: {
    clearActiveKey?: boolean;
    error?: string;
    result?: Record<string, unknown>;
  },
) {
  return db
    .update(operation)
    .set({
      state,
      ...(options?.clearActiveKey ? { activeKey: null } : {}),
      ...(options?.error !== undefined ? { error: options.error } : {}),
      ...(options?.result !== undefined ? { result: options.result } : {}),
      updatedAt: expression<Date>`now()`,
      completedAt: expression<Date>`now()`,
    })
    .where(where)
    .returning({ id: operation.id });
}

export async function finishConnectionOperations(
  db: MCPQueryDB,
  connectionId: string,
  kind: string,
  fromStates: string[],
  toState: string,
  clearActiveKey: boolean,
) {
  await completeOperation(
    db,
    and(
      eq(operation.kind, kind),
      eq(operation.scopeType, "connection"),
      eq(operation.scopeId, connectionId),
      fromStates.length === 1
        ? eq(operation.state, fromStates[0] as string)
        : inArray(operation.state, fromStates),
    ),
    toState,
    { clearActiveKey },
  );
}
