import type { ProjectEnvironment } from "../../../../packages/project-domain/src/environment";
import type { createEnvironmentController } from "./controller";

export interface EnvironmentSaveDecision {
  readonly userID: string;
  readonly environment: ProjectEnvironment;
  readonly commandID: string;
  readonly version: number;
}

export function createEnvironmentService(
  controller: Pick<ReturnType<typeof createEnvironmentController>, "get" | "discard" | "save">,
  prepare: (projectID: string, decision: EnvironmentSaveDecision) => Promise<unknown>,
) {
  return {
    get: controller.get,
    discard: controller.discard,
    async save(...args: Parameters<typeof controller.save>) {
      const result = await controller.save(...args);
      // This is the same post-save admission as the former HTTP adapter.
      // A preparation failure never replays the already committed secret save.
      void prepare(args[0], {
        userID: args[1],
        environment: args[2],
        commandID: args[3].commandID,
        version: result.version,
      }).catch(() => console.error("Project image preparation admission needs retry"));
      return result;
    },
  };
}
