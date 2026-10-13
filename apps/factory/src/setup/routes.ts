import { z } from "zod";
import { json } from "../http";
import type { createProjectSetupController } from "./controller";

export function createProjectSetupRoutes(
  controller: ReturnType<typeof createProjectSetupController>,
) {
  return async (request: Request, userID: string) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/project-setup") {
      if (request.method === "GET") return json(await controller.view(userID));
      if (request.method === "POST") return json(await controller.begin(userID));
      if (request.method === "PUT")
        return json(await controller.save(userID, await request.json()));
    }
    if (path === "/api/project-setup/create" && request.method === "POST")
      return json(await controller.create(userID, await request.json()));
    if (path === "/api/project-setup/check" && request.method === "POST") {
      const input = z
        .object({ id: z.uuid() })
        .strict()
        .parse(await request.json());
      return json(await controller.check(userID, input.id));
    }
    if (path === "/api/project-setup/retry" && request.method === "POST") {
      const input = z
        .object({ id: z.uuid() })
        .strict()
        .parse(await request.json());
      return json(await controller.retry(userID, input.id));
    }
    return new Response(null, { status: 405 });
  };
}
