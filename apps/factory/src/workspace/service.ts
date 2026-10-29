import type { createDeveloperIDEController } from "./developer-ide-controller";
import type { createWorkspaceSourceController } from "./source-controller";

export function createWorkspaceService(options: {
  sources: Pick<
    ReturnType<typeof createWorkspaceSourceController>,
    "get" | "ensure" | "ensurePersonal" | "ensureChange" | "stop"
  >;
  editors: Pick<ReturnType<typeof createDeveloperIDEController>, "get" | "ensure" | "stop">;
  revokeEditor(userID: string): void | Promise<void>;
}) {
  return {
    getSource: (userID: string, workspaceID: string) => options.sources.get(workspaceID, userID),
    ensureSource: (userID: string, workspaceID: string) =>
      options.sources.ensure(workspaceID, userID),
    ensurePersonalSource: (userID: string, projectID: string) =>
      options.sources.ensurePersonal(projectID, userID),
    ensureChangeSource: (userID: string, changeID: string) =>
      options.sources.ensureChange(changeID, userID),
    stopSource: (userID: string, workspaceID: string) => options.sources.stop(workspaceID, userID),
    getEditor: (userID: string) => options.editors.get(userID),
    ensureEditor: (userID: string, projectID: string) => options.editors.ensure(projectID, userID),
    async stopEditor(userID: string) {
      // Revoke established grants only after the same controller has recorded
      // Stop. Losing a browser response does not roll back that decision.
      await options.editors.stop(userID);
      await options.revokeEditor(userID);
    },
  };
}
