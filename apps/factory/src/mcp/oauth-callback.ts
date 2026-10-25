import { z } from "zod";
import { json } from "../http";
import type { createMCPConnections } from "./connections";

// The authorization server redirects a browser here. This is an external
// protocol, not a parallel UI command endpoint.
export function createMCPOAuthCallback(
  connections: Pick<ReturnType<typeof createMCPConnections>, "callback">,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/mcp/oauth/callback") return undefined;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    try {
      await connections.callback(userID, url.searchParams);
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
    } catch (cause) {
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return json({ error: "Invalid MCP callback" }, 400);
      throw cause;
    }
  };
}
