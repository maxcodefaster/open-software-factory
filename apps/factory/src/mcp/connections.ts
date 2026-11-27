import { createHmac } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { MCPAssignment } from "#conversation-domain/mcp-library";
import { CommandError } from "../command-error";
import { completeOAuthCallback, connectMCP } from "./connection-lifecycle";
import {
  type MCPConnectionContext,
  type MCPDatabase,
  markConnectionReview,
} from "./connection-state";
import { canonicalMCPJSON, createMCPLibrary } from "./controller";
import { secureMCPFetch } from "./network";
import { createRemoteConnection } from "./oauth-provider";
import { recoverSecretWrites } from "./secret-store";
import type { MCPSecrets } from "./secrets";

export function createMCPConnections(
  database: MCPDatabase,
  secrets: MCPSecrets,
  signingKey: string,
  factoryOrigin: string,
  fetcher: FetchLike = secureMCPFetch,
) {
  const library = createMCPLibrary(database);
  const ctx: MCPConnectionContext = {
    database,
    secrets,
    library,
    fingerprint: (value: unknown) =>
      createHmac("sha256", signingKey).update(canonicalMCPJSON(value)).digest("hex"),
    callback: new URL("/api/mcp/oauth/callback", factoryOrigin).href,
    fetcher,
  };

  const authorizeAssignment = (assignment: MCPAssignment, projectId: string, userId: string) =>
    database.client.begin(async (sql) => {
      const connection = await library.connectionIn(sql, assignment.connectionId);
      await library.usableIn(sql, connection, projectId, userId);
      if (
        connection.revisionId !== assignment.revisionId ||
        connection.credentialEpoch !== assignment.credentialEpoch ||
        assignment.tools.some(
          (selected) =>
            !connection.allowedTools.some(
              (tool) => tool.name === selected.name && tool.digest === selected.digest,
            ),
        )
      )
        throw new CommandError("forbidden", "MCP access was changed or revoked");
    });

  return {
    library,
    authorizeAssignment,
    recover: () => recoverSecretWrites(ctx),
    connect: (id: string, userId: string, value: unknown) => connectMCP(ctx, id, userId, value),
    callback: (userId: string, params: URLSearchParams) =>
      completeOAuthCallback(ctx, userId, params),
    async call(
      assignment: MCPAssignment,
      projectId: string,
      userId: string,
      name: string,
      args: Record<string, unknown>,
      authorize: () => Promise<void>,
      signal: AbortSignal,
    ) {
      const expected = assignment.tools.find((tool) => tool.name === name);
      if (!expected) throw new CommandError("forbidden", "This MCP tool was not admitted");
      signal.throwIfAborted();
      const validate = async () => {
        signal.throwIfAborted();
        await authorizeAssignment(assignment, projectId, userId);
        signal.throwIfAborted();
      };
      const checkAuthority = async () => {
        await authorize();
        await validate();
      };
      await checkAuthority();
      const client = await createRemoteConnection(
        ctx,
        assignment.connectionId,
        undefined,
        assignment.credentialEpoch,
        checkAuthority,
        signal,
      );
      try {
        await client.connect();
        const tools = await client.tools();
        if (!tools.some((tool) => tool.name === name && tool.digest === expected.digest)) {
          await checkAuthority();
          await markConnectionReview(
            database.db,
            assignment.connectionId,
            assignment.credentialEpoch,
            tools,
            "ready",
            { clearAllowed: true, touchUpdatedAt: true },
          );
          throw new CommandError(
            "conflict",
            "The MCP tool changed. Review the connection in Settings",
          );
        }
        await checkAuthority();
        const result = await client.client.callTool(
          { name, arguments: args },
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          },
        );
        await checkAuthority();
        // Tool results are untrusted source data, not instructions or authority.
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (Buffer.byteLength(text) > 64000)
          throw new CommandError("conflict", "MCP result exceeds the context limit");
        return { content: text, isError: result.isError === true };
      } catch (cause) {
        if (cause instanceof CommandError) throw cause;
        throw new CommandError(
          "unavailable",
          "MCP lookup failed. Check connection status in Settings",
        );
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
