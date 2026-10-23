import { createHash } from "node:crypto";
import { z } from "zod";
import {
  monitoringChange,
  monitoringSave,
} from "../../../../packages/conversation-domain/src/monitoring";
import { CommandError } from "../command-error";
import { json } from "../http";
import type { createMonitoringController } from "./controller";
import { monitoringSignals } from "./payload";

async function boundedBody(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new CommandError("conflict", "Webhook body is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("JSON body required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CommandError("conflict", "Webhook body timed out")),
      10_000,
    );
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new CommandError("conflict", "Webhook body is too large");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}
function response(value: unknown, status: number, headers?: HeadersInit) {
  const result = json(value, status);
  result.headers.set("cache-control", "no-store");
  result.headers.set("referrer-policy", "no-referrer");
  new Headers(headers).forEach((value, key) => {
    result.headers.set(key, value);
  });
  return result;
}

export function createMonitoringRoutes(controller: ReturnType<typeof createMonitoringController>) {
  return {
    async intake(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (!/^\/hooks\/(?:inputs|monitoring)\//.test(url.pathname)) return undefined;
      const route = url.pathname.match(
        /^\/hooks\/(?:inputs|monitoring)\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{43})$/,
      );
      if (
        !route?.[1] ||
        !route[2] ||
        !z.uuid().safeParse(route[1]).success ||
        request.headers.has("origin") ||
        !(await controller.authenticate(route[1], route[2]))
      )
        return response({ error: "Webhook not found" }, 404);
      if (request.method !== "POST") return response({ error: "Use POST" }, 405, { allow: "POST" });
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
      if (!contentType || !/^application\/(?:[a-z0-9.-]+\+)?json$/i.test(contentType))
        return response({ error: "Send application/json" }, 415);
      try {
        const raw = await boundedBody(request, 128 * 1024);
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        let signals: ReturnType<typeof monitoringSignals>;
        try {
          signals = monitoringSignals(payload);
        } catch (cause) {
          return response({ error: cause instanceof Error ? cause.message : "Invalid alert" }, 400);
        }
        const result = await controller.receive(
          route[1],
          route[2],
          createHash("sha256").update(raw).digest("hex"),
          signals,
        );
        if (result.limited)
          return response({ error: "Webhook rate limit reached" }, 429, { "retry-after": "60" });
        return response(
          {
            accepted: result.accepted,
            duplicates: result.duplicates,
            ignored: result.ignored,
          },
          202,
        );
      } catch (cause) {
        if (cause instanceof SyntaxError || cause instanceof TypeError)
          return response({ error: "Send a valid UTF-8 JSON object" }, 400);
        if (cause instanceof CommandError)
          return response({ error: cause.message }, cause.code === "not-found" ? 404 : 409);
        throw cause;
      }
    },
    async settings(request: Request, userId: string): Promise<Response | undefined> {
      const route = new URL(request.url).pathname.match(
        /^\/api\/projects\/([0-9a-f-]{36})\/inputs(?:\/([0-9a-f-]{36})\/(disable|rotate))?$/,
      );
      if (!route?.[1]) return undefined;
      if (!z.uuid().safeParse(route[1]).success) return response({ error: "Invalid Project" }, 400);
      try {
        if (!route[2]) {
          if (request.method === "GET")
            return response(await controller.view(route[1], userId), 200);
          if (request.method === "PUT")
            return response(
              await controller.save(
                route[1],
                userId,
                monitoringSave.parse(
                  JSON.parse((await boundedBody(request, 16_000)).toString("utf8")),
                ),
              ),
              200,
            );
        } else if (request.method === "POST" && (route[3] === "disable" || route[3] === "rotate")) {
          return response(
            await controller.change(
              route[1],
              route[2],
              userId,
              route[3],
              monitoringChange.parse(
                JSON.parse((await boundedBody(request, 16_000)).toString("utf8")),
              ),
            ),
            200,
          );
        }
        return response({ error: "Method not allowed" }, 405);
      } catch (cause) {
        if (cause instanceof z.ZodError || cause instanceof SyntaxError)
          return response({ error: "Invalid Input settings" }, 400);
        throw cause;
      }
    },
  };
}
