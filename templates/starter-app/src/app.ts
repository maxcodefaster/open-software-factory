import { createServer as httpServer } from "node:http";
import { createServer as viteServer, type ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { createDatabase } from "./db/client.ts";
import { createAuth } from "./auth.ts";

export function createApplication(
  options: { databaseURL?: string; baseURL?: string; secret?: string } = {},
) {
  const port = Number(process.env.PORT ?? 4300);
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`;
  const database = createDatabase(options.databaseURL);
  const editors = new Map<string, Promise<ViteDevServer>>();
  function devServer(basePath: string) {
    let pending = editors.get(basePath);
    if (!pending) {
      if (editors.size >= 4) throw new Error("Too many application paths");
      pending = viteServer({
        configLoader: "native",
        base: `${basePath}/`,
        server: { middlewareMode: true, ws: { server }, allowedHosts: true },
        appType: "spa",
      });
      editors.set(basePath, pending);
    }
    return pending;
  }
  const auths = new Map<string, ReturnType<typeof createAuth>>();
  function requestAuth(request: import("node:http").IncomingMessage) {
    const forwardedHost = request.headers["x-forwarded-host"];
    const forwardedProtocol = request.headers["x-forwarded-proto"];
    const prefix = request.headers["x-forwarded-prefix"];
    const valid =
      typeof forwardedHost === "string" &&
      /^[a-f0-9]{32}\.app\.runtime\.localhost(?::\d+)?$/.test(forwardedHost) &&
      ["http", "https"].includes(String(forwardedProtocol)) &&
      typeof prefix === "string" &&
      /^\/runtime\/[a-f0-9-]{36}\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(prefix);
    const origin = valid ? `${forwardedProtocol}://${forwardedHost}` : baseURL;
    const basePath = valid ? prefix : "";
    const key = origin + basePath;
    let auth = auths.get(key);
    if (!auth) {
      if (auths.size >= 16) throw new Error("Too many auth origins");
      auth = createAuth(database, {
        baseURL: origin,
        basePath,
        secret: options.secret ?? process.env.BETTER_AUTH_SECRET ?? "",
      });
      auths.set(key, auth);
    }
    return { auth, basePath, origin };
  }
  const server = httpServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", baseURL).pathname;
      const { auth, basePath, origin } = requestAuth(request);
      if (path.startsWith("/api/auth/")) {
        request.url = basePath + (request.url ?? "/");
        request.headers.host = new URL(origin).host;
        await toNodeHandler(auth)(request, response);
        return;
      }
      if (path === "/health") {
        await database.sql`SELECT 1`;
        response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        return;
      }
      if (path === "/api/session") {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        response.writeHead(session ? 200 : 401, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify(session ? { name: session.user.name } : { error: "Sign in required" }),
        );
        return;
      }
      if (path.startsWith("/api/")) {
        response.writeHead(404).end();
        return;
      }
      if (path === "/") {
        const vite = await devServer(basePath);
        const html = await vite.transformIndexHtml(
          `${basePath}/`,
          await readFile("index.html", "utf8"),
        );
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(html.replace("<head>", `<head><base href="${basePath}/">`));
        return;
      }
      const vite = await devServer(basePath);
      request.url = basePath + (request.url ?? "/");
      vite.middlewares(request, response);
    } catch {
      response
        .writeHead(503, { "content-type": "application/json" })
        .end('{"error":"Service unavailable"}');
    }
  });
  server.on("upgrade", (request) => {
    request.url = requestAuth(request).basePath + (request.url ?? "/");
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    database,
    close() {
      closing ??= (async () => {
        await Promise.allSettled(
          [...editors.values()].map(async (pending) => (await pending).close()),
        );
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        await database.sql.end({ timeout: 5 });
      })();
      return closing;
    },
  };
}
