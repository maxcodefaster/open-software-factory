import type { createDatabase } from "../../../../packages/db/src/client";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import type { createAccessController } from "../access/controller";
import type { createProjectAppPreviews } from "../access/previews";
import {
  appPreviewsSchema,
  attemptsResponseSchema,
  changeSchema,
  changesResponseSchema,
  runtimeAttemptSchema,
} from "../api-contracts";
import type { createChangeController } from "../change/controller";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "./controller";

export function createRuntimeService(options: {
  database: ReturnType<typeof createDatabase>;
  access: Pick<
    ReturnType<typeof createAccessController>,
    "requireProject" | "requireChange" | "requireRuntime" | "requireDevelopment"
  >;
  changes: Pick<ReturnType<typeof createChangeController>, "list" | "cancel" | "get">;
  runtime: Pick<
    ReturnType<typeof createRuntimeController>,
    "list" | "ensureStaging" | "start" | "startPersisted" | "startFresh" | "stop"
  >;
  previews: ReturnType<typeof createProjectAppPreviews>;
  closeBrowser(changeID: string): Promise<unknown>;
  cancelDelivery(changeID: string): Promise<unknown>;
  revokeAttempt(attemptID: string): void;
  suspendAttempt(attemptID: string): void;
}) {
  const time = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const attempt = (row: Awaited<ReturnType<typeof options.runtime.ensureStaging>>) => {
    if (!row)
      throw new CommandError(
        "unavailable",
        "Runtime response is unconfirmed. Observe this same runtime before retrying.",
      );
    return runtimeAttemptSchema.parse({
      ...row,
      createdAt: time(row.createdAt),
      updatedAt: time(row.updatedAt),
    });
  };
  return {
    async startPersonal(userID: string, projectID: string) {
      await options.access.requireDevelopment(userID, projectID);
      return attempt(await options.runtime.start(projectID, userID));
    },
    async startTicket(userID: string, changeID: string) {
      const projectID = await options.access.requireChange(userID, changeID);
      await options.access.requireDevelopment(userID, projectID);
      const [workspace] = await options.database.client<{ id: string }[]>`
        SELECT id FROM factory.development_workspace WHERE change_id=${changeID}`;
      if (!workspace)
        throw new CommandError(
          "conflict",
          "Prepare source and take over editing before starting compute",
        );
      await options.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspace.id, userID),
      );
      return attempt(await options.runtime.startPersisted(changeID, userID));
    },
    async stop(userID: string, attemptID: string) {
      await options.access.requireRuntime(userID, attemptID, "ide");
      const [workspace] = await options.database.client<{ id: string | null }[]>`
        SELECT workspace_id AS id FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (workspace?.id) {
        const workspaceID = workspace.id;
        await options.database.client.begin((sql) =>
          workspaceAuthorityIn(sql, workspaceID, userID, true),
        );
      }
      try {
        return attempt(await options.runtime.stop(attemptID));
      } finally {
        options.revokeAttempt(attemptID);
        options.suspendAttempt(attemptID);
      }
    },
    async startFresh(userID: string, attemptID: string) {
      await options.access.requireRuntime(userID, attemptID, "ide");
      const [workspace] = await options.database.client<
        Array<{ id: string | null; projectID: string }>
      >`SELECT workspace_id AS id,project_id AS "projectID" FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!workspace?.id) throw new CommandError("not-found", "Runtime Attempt not found");
      await options.access.requireDevelopment(userID, workspace.projectID);
      const workspaceID = workspace.id;
      await options.database.client.begin((sql) =>
        workspaceWriteAuthorityIn(sql, workspaceID, userID),
      );
      return attempt(await options.runtime.startFresh(attemptID, userID));
    },
    async cancelChange(userID: string, changeID: string) {
      const projectID = await options.access.requireChange(userID, changeID);
      await options.access.requireDevelopment(userID, projectID);
      await options.changes.cancel(changeID);
      await options.closeBrowser(changeID);
      await options.cancelDelivery(changeID);
      return changeSchema.parse(await options.changes.get(changeID));
    },
    async changes(userID: string, projectID?: string) {
      if (projectID) await options.access.requireProject(userID, projectID);
      const rows = await options.changes.list(projectID, userID);
      return changesResponseSchema.parse({
        changes: rows.map((row) => ({ ...row, deliveryApprovedAt: time(row.deliveryApprovedAt) })),
      });
    },
    async attempts(userID: string, projectID?: string) {
      if (projectID) await options.access.requireProject(userID, projectID);
      const rows = await options.runtime.list(projectID, userID);
      return attemptsResponseSchema.parse({
        attempts: rows.map((row) => ({
          ...row,
          createdAt: time(row.createdAt),
          updatedAt: time(row.updatedAt),
        })),
      });
    },
    async previews(userID: string, projectID: string) {
      await options.access.requireProject(userID, projectID);
      return appPreviewsSchema.parse({ previews: await options.previews(projectID, userID) });
    },
    async ensureStaging(userID: string, projectID: string) {
      await options.access.requireProject(userID, projectID);
      return attempt(await options.runtime.ensureStaging(projectID, userID));
    },
  };
}
