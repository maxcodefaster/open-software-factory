import { z } from "zod";
import {
  mcpChoiceInput,
  mcpConnectInput,
  mcpReviewInput,
  mcpSaveInput,
} from "../../../../packages/conversation-domain/src/mcp-library";
import { CommandError } from "../command-error";
import { json } from "../http";
import type { createMCPConnections } from "./connections";

async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new CommandError("conflict", "A command body is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 128000) throw new CommandError("conflict", "MCP command is too large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}
export function createMCPRoutes(connections: ReturnType<typeof createMCPConnections>) {
  return async (request: Request, userId: string): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/mcp" && !url.pathname.startsWith("/api/mcp/")) return undefined;
    const library = connections.library;
    const projectId = url.searchParams.get("project") ?? undefined;
    if (projectId && !z.uuid().safeParse(projectId).success)
      return json({ error: "Invalid Project" }, 400);
    try {
      if (url.pathname === "/api/mcp") {
        if (request.method === "GET") return json(await library.view(userId, projectId));
        if (request.method === "POST")
          return json(await library.save(mcpSaveInput.parse(await body(request)), userId), 201);
      }
      if (url.pathname === "/api/mcp/choices" && request.method === "PUT")
        return json(await library.choose(mcpChoiceInput.parse(await body(request)), userId));
      if (url.pathname === "/api/mcp/share" && request.method === "POST") {
        const input = z
          .object({
            id: z.uuid(),
            revisionId: z.uuid(),
            target: z.enum(["project", "system"]),
            projectId: z.uuid().optional(),
          })
          .strict()
          .parse(await body(request));
        return json(
          await library.propose(input.id, input.revisionId, input.target, input.projectId, userId),
          201,
        );
      }
      const share = url.pathname.match(/^\/api\/mcp\/share\/([0-9a-f-]{36})\/accept$/);
      if (share?.[1] && request.method === "POST")
        return json(await library.accept(share[1], userId));
      if (url.pathname === "/api/mcp/oauth/callback" && request.method === "GET") {
        await connections.callback(userId, url.searchParams);
        return new Response(
          "MCP connected. Return to the MCP library in Settings to review and approve read-only access.",
          {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          },
        );
      }
      const route = url.pathname.match(
        /^\/api\/mcp\/([0-9a-f-]{36})\/(connect|review|grant|disconnect)$/,
      );
      if (!route?.[1]) return json({ error: "MCP action not found" }, 404);
      const id = route[1];
      if (route[2] === "connect" && request.method === "POST")
        return json(
          await connections.connect(id, userId, mcpConnectInput.parse(await body(request))),
        );
      if (route[2] === "review" && request.method === "PUT") {
        const input = mcpReviewInput.parse(await body(request));
        return json(await library.review(id, userId, input.expectedVersion, input.tools));
      }
      if (route[2] === "grant" && request.method === "PUT") {
        const input = z
          .object({
            projectId: z.uuid(),
            enabled: z.boolean(),
            expectedVersion: z.number().int().nonnegative(),
          })
          .strict()
          .parse(await body(request));
        return json(
          await library.grant(id, input.projectId, userId, input.enabled, input.expectedVersion),
        );
      }
      if (route[2] === "disconnect" && request.method === "POST")
        return json(await library.disconnect(id, userId));
      return new Response(null, { status: 405 });
    } catch (cause) {
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return json({ error: "Invalid MCP command" }, 400);
      throw cause;
    }
  };
}
