import type { createDeveloperIDEController } from "./developer-ide-controller";
import { json } from "../http";

export function createDeveloperIDERoutes(
  editors: ReturnType<typeof createDeveloperIDEController>,
  onStop: (userID: string) => void,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const ensure = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/developer-ide\/ensure$/);
    if (ensure?.[1]) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return json(await editors.ensure(ensure[1], userID), 202);
    }
    if (path === "/api/developer-ide") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return json(await editors.get(userID));
    }
    if (path === "/api/developer-ide/stop") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      await editors.stop(userID);
      onStop(userID);
      return new Response(null, { status: 202 });
    }
    return undefined;
  };
}
