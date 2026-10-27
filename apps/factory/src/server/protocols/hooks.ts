import type { FactoryApplication } from "../application";
import { protocolFailure } from "./failure";

type HookServices = Pick<FactoryApplication, "monitoringRoutes">;

export function createHooksProtocol({ monitoringRoutes }: HookServices) {
  return async (request: Request): Promise<Response> => {
    try {
      return (await monitoringRoutes.intake(request)) ?? new Response("Not found", { status: 404 });
    } catch (cause) {
      return protocolFailure(request, cause);
    }
  };
}
