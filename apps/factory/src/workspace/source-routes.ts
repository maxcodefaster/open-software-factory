import type { createWorkspaceSourceController } from "./source-controller";
import { json } from "../http";

export function createWorkspaceSourceRoutes(
  sources: ReturnType<typeof createWorkspaceSourceController>,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const personal = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/source-workspace\/ensure$/);
    if (personal?.[1]) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return json(await sources.ensurePersonal(personal[1], userID));
    }
    const change = path.match(/^\/api\/changes\/([0-9a-f-]{36})\/source-workspace\/ensure$/);
    if (change?.[1]) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return json(await sources.ensureChange(change[1], userID));
    }
    const workspace = path.match(
      /^\/api\/workspaces\/([0-9a-f-]{36})\/source(?:\/(ensure|stop|stat|list|read|write|mkdir|rename|delete|search|events))?$/,
    );
    if (!workspace?.[1]) return undefined;
    const workspaceID = workspace[1];
    const operation = workspace[2];
    if (!operation) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return json(await sources.get(workspaceID, userID));
    }
    if (operation === "ensure" || operation === "stop") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (operation === "ensure") return json(await sources.ensure(workspaceID, userID));
      await sources.stop(workspaceID, userID);
      return new Response(null, { status: 202 });
    }
    return sources.forward(workspaceID, userID, operation, request);
  };
}
