import { json } from "../../http";
import { factoryRequestURL } from "../../request-origin";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type HealthServices = Pick<FactoryApplication, "planningCacheURL" | "startupID" | "factoryOrigin">;
export function createHealthProtocol(services: HealthServices) {
  const { planningCacheURL, startupID, factoryOrigin } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
      if (url.pathname === "/health/ready") {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response(null, { status: 405 });
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
