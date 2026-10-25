import type { createDatabase } from "../../../../packages/db/src/client";
import type { z } from "zod";
import { setupReadiness } from "../../../../packages/project-domain/src/setup";
import type {
  SetupTask,
  ProjectSetupView,
  SetupInspectionView,
  projectSetupSave,
  projectSetupCreate,
} from "../../../../packages/project-domain/src/setup";
import { createAccessController } from "../access/controller";
import { CommandError } from "../command-error";
import type { createProjectSetupController } from "./controller";
import type { createSetupInspection } from "./inspection";
import type { createSetupReadiness } from "./readiness";

export function createSetupService(options: {
  database: ReturnType<typeof createDatabase>;
  drafts: ReturnType<typeof createProjectSetupController>;
  inspection: ReturnType<typeof createSetupInspection>;
  readiness: ReturnType<typeof createSetupReadiness>;
}) {
  const access = createAccessController(options.database);
  function confirmed<T extends ProjectSetupView | SetupInspectionView>(
    value: T | null | undefined,
  ): T {
    if (!value)
      throw new CommandError(
        "unavailable",
        "Setup outcome is unconfirmed. Refresh its status before retrying.",
      );
    return value;
  }
  return {
    draft: options.drafts.view,
    begin: options.drafts.begin,
    async save(userID: string, input: z.output<typeof projectSetupSave>) {
      return confirmed(await options.drafts.save(userID, input));
    },
    async create(userID: string, input: z.output<typeof projectSetupCreate>) {
      return confirmed(await options.drafts.create(userID, input));
    },
    async check(userID: string, id: string) {
      return confirmed(await options.drafts.check(userID, id));
    },
    async retry(userID: string, id: string) {
      return confirmed(await options.drafts.retry(userID, id));
    },
    async inspection(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      return options.inspection.view(projectID, userID);
    },
    async inspect(
      userID: string,
      projectID: string,
      id: string,
      continuation: Parameters<typeof options.inspection.start>[3],
    ) {
      await access.requireProject(userID, projectID);
      return confirmed(await options.inspection.start(projectID, userID, id, continuation));
    },
    async confirm(userID: string, projectID: string, id: string) {
      await access.requireProject(userID, projectID);
      return confirmed(await options.inspection.confirm(projectID, userID, id));
    },
    async stop(userID: string, projectID: string, id: string) {
      await access.requireProject(userID, projectID);
      return confirmed(await options.inspection.stop(projectID, userID, id));
    },
    async readiness(userID: string, projectID: string) {
      await access.requireProject(userID, projectID);
      return setupReadiness.parse(await options.readiness.status(projectID, userID));
    },
    async retryTask(userID: string, projectID: string, task: SetupTask) {
      await access.requireProject(userID, projectID);
      const [intent] = await options.database
        .client`SELECT kind FROM factory.project_repository_intent WHERE project_id=${projectID}`;
      await options.readiness.retry(projectID, userID, task, intent?.["kind"] === "starter");
      return setupReadiness.parse(await options.readiness.status(projectID, userID));
    },
  };
}
