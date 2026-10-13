import URI from "@theia/core/lib/common/uri";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";

export function requestedWorkspace(href: string): string | undefined {
  const url = new URL(href);
  try {
    const resource = new URI(decodeURI(url.hash.slice(1)));
    if (resource.scheme === workspaceScheme) return workspaceResource(resource).workspaceID;
  } catch {
    // A malformed fragment cannot change the meaning of the explicit query.
  }
  return url.searchParams.get("workspace") ?? undefined;
}

export function selectedWorkspaceLocation(href: string, root: URI): string {
  const { workspaceID, path } = workspaceResource(root);
  if (path) throw new Error("Workspace selection requires its root");
  const url = new URL(href);
  url.searchParams.set("workspace", workspaceID);
  url.hash = encodeURI(root.toString());
  return url.href;
}
