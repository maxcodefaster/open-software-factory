import {
  modelConnectionWrite,
  modelRoleConnectionInput,
} from "../../../../packages/conversation-domain/src/model-connection";
import { json } from "../http";
import type { createModelConnections } from "./connections";
import { providerCatalogue } from "./native";
import { z } from "zod";
import { deploymentModelConnections } from "./deployment";

export function createModelConnectionRoutes(
  connections: ReturnType<typeof createModelConnections>,
  requireManager: (userID: string) => Promise<void>,
  signingKey: string,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/model-connections")) return undefined;
    await requireManager(userID);
    if (path === "/api/model-connections" && request.method === "GET")
      return json({
        providers: providerCatalogue(),
        connections: await connections.list(userID),
        roles: await connections.roles(userID),
        deployment: deploymentModelConnections(signingKey).map(
          ({ apiKey: _secret, ...metadata }) => metadata,
        ),
      });
    if (path === "/api/model-connections/deployment" && request.method === "PUT") {
      const input = z
        .object({
          role: z.enum(["planning", "build"]),
          commandID: z.uuid(),
          version: z.number().int().nonnegative(),
        })
        .strict()
        .parse(await request.json());
      const configured = deploymentModelConnections(signingKey).find(
        (value) => value.role === input.role,
      );
      if (!configured?.configured || !configured.apiKey)
        return json({ error: "No deployment connection is configured for this role" }, 409);
      return json(
        await connections.save(userID, {
          commandID: input.commandID,
          connectionID: configured.connectionID,
          version: input.version,
          provider: configured.provider,
          endpoint: configured.endpoint,
          apiKey: configured.apiKey,
        }),
      );
    }
    if (path === "/api/model-connections/role" && request.method === "PUT") {
      const input = modelRoleConnectionInput.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Model role selection is invalid" }, 400);
      return json(await connections.selectRole(userID, input.data, request.signal));
    }
    const match = path.match(/^\/api\/model-connections\/([0-9a-f-]{36})$/);
    if (!match?.[1]) return new Response(null, { status: 404 });
    const id = match[1];
    if (request.method === "GET") return json(await connections.get(id, userID));
    if (request.method === "PUT") {
      const input = modelConnectionWrite.safeParse(await request.json().catch(() => null));
      if (!input.success || input.data.connectionID !== id)
        return json({ error: "Model connection is invalid" }, 400);
      return json(await connections.save(userID, input.data));
    }
    return new Response(null, { status: 405 });
  };
}
