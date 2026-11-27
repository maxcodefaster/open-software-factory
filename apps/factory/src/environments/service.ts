import type { createEnvironmentController } from "./controller";

export function createEnvironmentService(
  controller: Pick<ReturnType<typeof createEnvironmentController>, "get" | "discard" | "save">,
) {
  return {
    get: controller.get,
    discard: controller.discard,
    save: controller.save,
  };
}
