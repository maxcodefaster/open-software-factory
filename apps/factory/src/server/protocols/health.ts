import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { json } from "../../http";
import { factoryRequestURL } from "../../request-origin";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type HealthServices = Pick<FactoryApplication, "planningCacheURL" | "startupID" | "factoryOrigin">;
export function createHealthProtocol(
  services: HealthServices,
  installationStateDirectory = process.env["FACTORY_STATE_DIRECTORY"] ?? "/var/lib/factory",
) {
  const { planningCacheURL, startupID, factoryOrigin } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
      if (url.pathname === "/health/ready") {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response(null, { status: 405 });
        if (url.searchParams.get("installation") === "complete") {
          // Check the supervisor's exact startup marker in the existing server.
          // A port accepting HTTP is not proof that installation bootstrap has
          // finished. Avoid spawning a container exec for every readiness poll.
          const completed = await readFile(
            resolve(installationStateDirectory, "kubernetes-ready.json"),
            "utf8",
          )
            .then((text) => JSON.parse(text)?.startupID === startupID)
            .catch(() => false);
          if (!completed) return json({ ready: false }, 503, { "cache-control": "no-store" });
        }
        return json({ ready: true, planningCacheURL }, 200, {
          "x-open-factory": "ready",
          "x-open-factory-startup": startupID,
          "cache-control": "no-store",
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (cause) {
      return protocolFailure(request, cause);
    }
  };
}
