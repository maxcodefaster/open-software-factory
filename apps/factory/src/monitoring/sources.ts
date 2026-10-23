import type { MCPLibraryView } from "../../../../packages/conversation-domain/src/mcp-library";

export function monitoringSourceAvailable(
  entry: MCPLibraryView["entries"][number],
  projectId: string,
) {
  const connection = entry.connection;
  const revision = entry.revisions.find((item) => item.id === connection?.revisionId);
  return (
    entry.scope !== "personal" &&
    (entry.scope !== "project" || entry.projectId === projectId) &&
    connection?.state === "ready" &&
    Boolean(connection.allowedTools.length) &&
    Boolean(
      revision?.content.roles.includes("planning") && revision.content.roles.includes("build"),
    ) &&
    (entry.scope !== "system" || connection.projectGrants.includes(projectId))
  );
}
