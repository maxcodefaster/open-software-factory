import { factoryRequestURL } from "./request-origin";
import { runtimeAppOriginRoute } from "./runtime-origins";

// An isolated App hostname owns its entire origin. Root-relative pages,
// framework commands, assets and sockets must never reach Factory's document
// or Server Function handler. The existing authenticated runtime protocol
// still owns admission and forwarding after this URL normalization.
export function runtimeAppRequest(request: Request, factoryOrigin: string) {
  const url = factoryRequestURL(request, factoryOrigin);
  const app = runtimeAppOriginRoute(factoryOrigin, url);
  if (!app) return request;
  const prefix = `/runtime/${app.attemptID}/preview/${app.channel}`;
  const existing =
    url.pathname === prefix ||
    url.pathname.startsWith(`${prefix}/`) ||
    (app.channel === "app" && url.pathname.startsWith(`/runtime/${app.attemptID}/app/`));
  if (!existing) url.pathname = `${prefix}${url.pathname}`;
  return new Request(url, request);
}
