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
        const response = await fetch(new URL("/api/session", backend), {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        const session: unknown = await response.json();
        if (
          !response.ok ||
          !session ||
          typeof session !== "object" ||
          !("zeroCacheURL" in session) ||
          typeof session.zeroCacheURL !== "string"
        )
          throw new Error("Missing planning service");
        zero = loopbackURL(session.zeroCacheURL);
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
      return { server: { host: "127.0.0.1", proxy: { "/api": api, [zeroPrefix]: planning } } };
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "GET" || request.url?.split("?")[0] !== "/api/session")
          return next();
        try {
          const headers = new Headers();
          if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
          const upstream = await fetch(new URL(request.url, backend), {
            headers,
            signal: AbortSignal.timeout(5000),
            redirect: "manual",
          });
          const value = (await upstream.json()) as { zeroCacheURL?: string };
          if (upstream.ok && value.zeroCacheURL) {
            const zero = loopbackURL(value.zeroCacheURL);
            value.zeroCacheURL = `${requestOrigin(request)}${zeroPrefix}${zero.pathname.replace(/\/$/, "")}`;
          }
          response.statusCode = upstream.status;
          response.setHeader("content-type", "application/json");
          response.setHeader("cache-control", "no-store");
          const cookies = upstream.headers.getSetCookie();
          if (cookies.length) response.setHeader("set-cookie", cookies);
          response.end(JSON.stringify(value));
        } catch {
          response.statusCode = 502;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ error: "Factory development backend is unavailable" }));
        }
      });
    },
  };
}
