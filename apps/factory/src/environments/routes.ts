import {
  environmentWrite,
  projectEnvironment,
} from "../../../../packages/project-domain/src/environment";
import { json } from "../http";
import { z } from "zod";
import type { createEnvironmentController } from "./controller";

export function createEnvironmentRoutes(
  controller: ReturnType<typeof createEnvironmentController>,
) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const match = new URL(request.url).pathname.match(
      /^\/api\/projects\/([0-9a-f-]{36})\/environments\/(development|main-preview)$/,
    );
    if (!match?.[1]) return undefined;
    const environment = projectEnvironment.parse(match[2]);
    const headers = { "cache-control": "no-store" };
    if (request.method === "GET")
      return json(await controller.get(match[1], userID, environment), 200, headers);
    if (request.method !== "PUT" && request.method !== "DELETE")
      return new Response(null, { status: 405 });
    if (Number(request.headers.get("content-length") ?? 0) > 2_097_152)
      return json({ error: "Environment settings are too large" }, 413, headers);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Environment settings are required" }, 400, headers);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2_097_152) {
          await reader.cancel();
          return json({ error: "Environment settings are too large" }, 413, headers);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const source = Buffer.concat(chunks).toString("utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      return json({ error: "Invalid environment settings" }, 400, headers);
    }
    if (request.method === "DELETE") {
      const input = z.object({ commandID: z.uuid() }).strict().safeParse(decoded);
      if (!input.success) return json({ error: "Invalid pending save identity" }, 400, headers);
      return json(
        await controller.discard(match[1], userID, environment, input.data.commandID),
        200,
        headers,
      );
    }
    const input = environmentWrite.safeParse(decoded);
    if (!input.success)
      return json(
        {
          error:
            "Environment settings are invalid. Check names, registry hosts and duplicate entries.",
        },
        400,
        headers,
      );
    return json(await controller.save(match[1], userID, environment, input.data), 200, headers);
  };
}
