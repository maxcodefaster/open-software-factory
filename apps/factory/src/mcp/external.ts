import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { CommandError } from "../command-error";
import { json } from "../http";
import { createWorkspaceLifecycle } from "../workspace/api";
import { registerCommandTools } from "./external-commands";
import { registerDocumentTools } from "./external-documents";
import { registerFileTools } from "./external-files";
import type {
  ExternalMCPActor,
  ExternalMCPServices,
  RegisterExternalTool,
} from "./external-schemas";
import { registerWorkspaceTools } from "./external-workspaces";

/** The existing Factory MCP gains a user-authenticated transport, not a second execution service. */
export function createExternalFactoryMCP(services: ExternalMCPServices) {
  const { database, factoryAuth, factoryOrigin, runtimeController } = services;
  const lifecycle = createWorkspaceLifecycle(database, runtimeController);

  return async (request: Request): Promise<Response> => {
    if (request.headers.has("origin") && request.headers.get("origin") !== factoryOrigin)
      return json({ error: "MCP browser origin is not allowed" }, 403);
    let actor: ExternalMCPActor;
    try {
      actor = await factoryAuth.mcpSession(request);
    } catch {
      return json({ error: "Factory MCP authentication required" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${factoryOrigin}/.well-known/oauth-protected-resource/api/mcp"`,
        "cache-control": "no-store",
      });
    }
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "factory", version: "1.0.0" });
        const tool: RegisterExternalTool = <T extends z.ZodObject>(
          name: string,
          description: string,
          schema: T,
          write: boolean,
          execute: (value: z.output<T>) => Promise<unknown>,
        ) => {
          if (write && !actor.scopes.includes("factory:work")) return;
          server.registerTool(
            name,
            {
              description,
              inputSchema: schema.shape,
              annotations: { readOnlyHint: !write },
            },
            async (args) => {
              try {
                const verified = await factoryAuth.mcpSession(request);
                if (
                  verified.userID !== actor.userID ||
                  (write && !verified.scopes.includes("factory:work"))
                )
                  throw new CommandError("forbidden", "MCP authority changed");
                const result = await execute(schema.parse(args));
                return {
                  content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }],
                };
              } catch (cause) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify({
                        error:
                          cause instanceof CommandError
                            ? { code: cause.code, message: cause.message }
                            : {
                                code: "unavailable",
                                message:
                                  "Factory could not confirm this operation. Observe its existing identity; do not replay it.",
                              },
                      }),
                    },
                  ],
                };
              }
            },
          );
        };
        const context = { services, actor, request, tool };
        registerWorkspaceTools(context, lifecycle);
        registerDocumentTools(context);
        registerCommandTools(context);
        registerFileTools(context);
        return server;
      },
      { responseMode: "json", maxRequestBodySize: 256 << 10 },
    );
    try {
      const response = await handler.fetch(request);
      return new Response(response.body ? await response.arrayBuffer() : null, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      await handler.close();
    }
  };
}
