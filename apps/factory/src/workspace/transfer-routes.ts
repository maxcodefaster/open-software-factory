import { z } from "zod";
import type { createIdentityConfiguration } from "../access/identity-configuration";
import { CommandError } from "../command-error";
import { json } from "../http";
import type { createWorkspaceContainerFiles } from "./container-files";

export function createWorkspaceTransferRoutes(options: {
  identity: Pick<ReturnType<typeof createIdentityConfiguration>, "mcpSession">;
  files: ReturnType<typeof createWorkspaceContainerFiles>;
  origin: string;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const id = url.pathname.match(/^\/api\/workspace-transfers\/([0-9a-f-]{36})$/)?.[1];
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (!id) return json({ error: "File transfer not found" }, 404, headers);
    if (request.headers.has("origin") && request.headers.get("origin") !== options.origin)
      return json({ error: "File transfer origin is not allowed" }, 403, headers);
    let actor: Awaited<ReturnType<typeof options.identity.mcpSession>>;
    try {
      actor = await options.identity.mcpSession(request);
    } catch {
      return json({ error: "Factory MCP authentication required" }, 401, {
        ...headers,
        "www-authenticate": `Bearer resource_metadata="${options.origin}/.well-known/oauth-protected-resource/api/mcp"`,
      });
    }
    if (!actor.scopes.includes("factory:work"))
      return json({ error: "Factory development scope required" }, 403, headers);
    try {
      const offset = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(128 << 20)
        .parse(url.searchParams.get("offset") ?? 0);
      if (request.method === "PUT") {
        const reader = request.body?.getReader();
        if (!reader) throw new CommandError("invalid", "Upload chunk body is required");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > 256 << 10) {
              await reader.cancel();
              throw new CommandError("invalid", "Upload chunk exceeds 256 KiB");
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        return json(
          await options.files.upload(actor.userID, id, offset, Buffer.concat(chunks, length)),
          200,
          headers,
        );
      }
      if (request.method === "GET") {
        const limit = z.coerce
          .number()
          .int()
          .positive()
          .max(256 << 10)
          .parse(url.searchParams.get("limit") ?? 256 << 10);
        const result = await options.files.download(actor.userID, id, offset, limit);
        return new Response(result.content, {
          headers: {
            ...headers,
            "content-type": "application/octet-stream",
            "content-length": String(result.content.length),
            "content-disposition": "attachment",
            "x-factory-offset": String(result.offset),
            "x-factory-next-offset": String(result.nextOffset),
            "x-factory-complete": String(result.complete),
            "x-factory-file-bytes": String(result.bytes),
            "x-factory-sha256": result.sha256 ?? "",
          },
        });
      }
      return json({ error: "Use GET for download chunks or PUT for upload chunks" }, 405, {
        ...headers,
        allow: "GET, PUT",
      });
    } catch (cause) {
      if (cause instanceof z.ZodError)
        return json({ error: "File transfer arguments are invalid" }, 400, headers);
      return json(
        {
          error:
            cause instanceof CommandError
              ? cause.message
              : "File transfer outcome is unconfirmed. Observe the existing transfer ID before continuing.",
        },
        cause instanceof CommandError ? cause.status : 503,
        headers,
      );
    }
  };
}
