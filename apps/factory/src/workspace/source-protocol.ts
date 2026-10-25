import type { createWorkspaceSourceController } from "./source-controller";

export function createWorkspaceSourceProtocol(
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "forward">,
) {
  // The unchanged Theia extension uses this scoped file/watch protocol.
  // Product lifecycle commands are named Server Functions, never this adapter.
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const workspace = path.match(
      /^\/api\/workspaces\/([0-9a-f-]{36})\/source\/(stat|list|read|write|mkdir|rename|delete|search|events)$/,
    );
    if (!workspace?.[1]) return undefined;
    const workspaceID = workspace[1];
    const operation = workspace[2];
    if (!operation) return undefined;
    return sources.forward(workspaceID, userID, operation, request);
  };
}
