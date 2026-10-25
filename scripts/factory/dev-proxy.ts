import type { IncomingMessage } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

function loopbackURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Factory development services must use credential-free loopback HTTP URLs");
  return url;
}

function requestOrigin(request: IncomingMessage) {
  return loopbackURL(`http://${request.headers.host}`).origin;
}

function ownOrigin(request: IncomingMessage) {
  try {
    return (
      typeof request.headers.origin === "string" &&
      new URL(request.headers.origin).origin === requestOrigin(request)
    );
  } catch {
    return false;
  }
}

export function factoryDevelopmentProxy(): Plugin {
  let backend: URL;
  const zeroPrefix = "/__factory_zero";
  return {
    name: "factory-local-development",
    apply: "serve",
    async config() {
      backend = loopbackURL(process.env["FACTORY_DEV_BACKEND_URL"] ?? "http://127.0.0.1:3000");
      let zero: URL;
      try {
        const response = await fetch(new URL("/health/ready", backend), {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        const readiness: unknown = await response.json();
        if (
          !response.ok ||
          !readiness ||
          typeof readiness !== "object" ||
          !("planningCacheURL" in readiness) ||
          typeof readiness.planningCacheURL !== "string"
        )
          throw new Error("Missing planning service");
        zero = loopbackURL(readiness.planningCacheURL);
      } catch {
        throw new Error(
          "Factory development backend is unavailable. Start factory:up before factory:dev, or set FACTORY_DEV_BACKEND_URL to its loopback URL.",
        );
      }
      const api: ProxyOptions = {
        target: backend.origin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            // Only translate requests from this frontend. Foreign origins keep
            // their identity and are rejected by Factory's existing CSRF fence.
            if (ownOrigin(incoming)) outgoing.setHeader("origin", backend.origin);
          });
        },
      };
      const planning: ProxyOptions = {
        target: zero.origin,
        ws: true,
        rewrite: (path) => path.slice(zeroPrefix.length) || "/",
        configure(proxy) {
          proxy.on("proxyReqWs", (outgoing, incoming, socket) => {
            if (!ownOrigin(incoming)) {
              outgoing.destroy();
              socket.destroy();
              return;
            }
            // Zero forwards the WebSocket origin to Factory's mutation hook.
            outgoing.setHeader("origin", backend.origin);
          });
        },
      };
      return {
        server: {
          host: "127.0.0.1",
          proxy: { "/api": api, "/_server": api, "/health": api, [zeroPrefix]: planning },
        },
      };
    },
  };
}
