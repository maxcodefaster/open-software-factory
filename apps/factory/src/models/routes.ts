import {
  personalModelInput,
  projectModelInput,
} from "../../../../packages/conversation-domain/src/model-inheritance";
import type { createModelSettingsController } from "./controller";
import { json } from "../http";

export function createProjectModelRoutes(
  settings: ReturnType<typeof createModelSettingsController>,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const match = new URL(request.url).pathname.match(
      /^\/api\/projects\/([0-9a-f-]{36})\/model-settings(?:\/(personal))?$/,
    );
    if (!match?.[1]) return undefined;
    const projectID = match[1];
    if (request.method === "GET" && !match[2])
      return json(await settings.getInherited(projectID, userID));
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    const body: unknown = await request.json().catch(() => null);
    if (match[2]) {
      const input = personalModelInput.safeParse(body);
      if (!input.success) return json({ error: "Personal model settings are invalid" }, 400);
      return json(await settings.setPersonal(projectID, userID, input.data));
    }
    const input = projectModelInput.safeParse(body);
    if (!input.success) return json({ error: "Project model settings are invalid" }, 400);
    return json(await settings.setProject(projectID, userID, input.data));
  };
}
