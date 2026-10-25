import type { createEnvironmentController } from "./controller";

export function createEnvironmentService(
  controller: Pick<ReturnType<typeof createEnvironmentController>, "get" | "discard" | "save">,
  prepare: (projectID: string) => Promise<unknown>,
) {
  return {
    get: controller.get,
    discard: controller.discard,
    async save(...args: Parameters<typeof controller.save>) {
      const result = await controller.save(...args);
      // This is the same post-save admission as the former HTTP adapter.
      // A preparation failure never replays the already committed secret save.
      void prepare(args[0]).catch(() =>
        console.error("Project image preparation admission needs retry"),
      );
      return result;
    },
  };
}
