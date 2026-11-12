import type { createDeveloperIDEController } from "./developer-ide-controller";
import type { createWorkspaceSourceController } from "./source-controller";
import type { createWorkspaceSharing } from "./sharing";
import type { WorkspaceShareInput } from "../../../../packages/workspace-domain/src/sharing";
import { CommandError } from "../command-error";
import type { createWorkspaceCollaboration } from "./collaboration";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { workspaceAuthorityIn } from "../access/workspace";
import type { createWorkspaceSubmission, workspaceSubmissionInput } from "./submission";
import type { z } from "zod";

export function createWorkspaceService(options: {
  sources: Pick<
    ReturnType<typeof createWorkspaceSourceController>,
    "get" | "ensure" | "ensurePersonal" | "ensureChange" | "stop"
  >;
  editors: Pick<ReturnType<typeof createDeveloperIDEController>, "get" | "ensure" | "stop">;
  revokeEditor(userID: string): void | Promise<void>;
  sharing?: ReturnType<typeof createWorkspaceSharing>;
  collaboration?: ReturnType<typeof createWorkspaceCollaboration>;
  database?: ReturnType<typeof createDatabase>;
  submission?: ReturnType<typeof createWorkspaceSubmission>;
}) {
  return {
    inspectSubmission(userID: string, workspaceID: string) {
      if (!options.submission) throw new CommandError("unavailable", "Submission is unavailable");
      return options.submission.inspect(userID, workspaceID);
    },
    submit(userID: string, input: z.infer<typeof workspaceSubmissionInput>) {
      if (!options.submission) throw new CommandError("unavailable", "Submission is unavailable");
      return options.submission.submit(userID, input);
    },
    async available(userID: string, projectID: string) {
      const database = options.database;
      if (!database) throw new CommandError("unavailable", "Workspace listing is unavailable");
      await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
      return database.client<
        {
          workspaceID: string;
          ownerID: string | null;
          name: string;
          kind: string;
          collaborative: boolean;
        }[]
      >`
        SELECT workspace.id AS "workspaceID",workspace.owner_user_id AS "ownerID",COALESCE(person.name,ticket.title,'Ticket') AS name,
          workspace.kind,workspace.collaboration_enabled AS collaborative
        FROM factory.development_workspace workspace LEFT JOIN auth."user" person ON person.id=workspace.owner_user_id
        LEFT JOIN factory.ticket ticket ON ticket.id=workspace.ticket_id
        WHERE workspace.project_id=${projectID} AND (workspace.kind='ticket' OR workspace.owner_user_id=${userID} OR EXISTS(
          SELECT 1 FROM factory.workspace_share WHERE workspace_id=workspace.id AND user_id=${userID} AND revoked_at IS NULL))
        ORDER BY workspace.created_at,workspace.id`;
    },
    async collaboration(userID: string, workspaceID: string) {
      if (!options.database || !options.collaboration)
        throw new CommandError("unavailable", "Shared editing is unavailable");
      const access = await options.database.client.begin((sql) =>
        workspaceAuthorityIn(sql, workspaceID, userID),
      );
      return {
        workspaceID,
        ownerID: access.ownerID,
        kind: access.kind,
        collaborative: access.collaborative,
        permission: access.permission,
        participants: await options.collaboration.participants(workspaceID, userID),
      };
    },
    enableCollaboration(userID: string, workspaceID: string, commandID: string) {
      if (!options.collaboration)
        throw new CommandError("unavailable", "Shared editing is unavailable");
      return options.collaboration.enable(userID, workspaceID, commandID);
    },
    getSharing(userID: string, workspaceID: string) {
      if (!options.sharing)
        throw new CommandError("unavailable", "Workspace sharing is unavailable");
      return options.sharing.view(userID, workspaceID);
    },
    share(userID: string, input: WorkspaceShareInput) {
      if (!options.sharing)
        throw new CommandError("unavailable", "Workspace sharing is unavailable");
      return options.sharing.decide(userID, input);
    },
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
