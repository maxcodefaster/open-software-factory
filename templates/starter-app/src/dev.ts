import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { appProxyContext } from "./proxy.ts";

// Vite compiles absolute development module/HMR URLs against its base. Each
// Factory mount needs its own module graph; Start owns all application routing.
const servers = new Map<string, Promise<ViteDevServer>>();
const server = createServer(async (request, response) => {
  try {
    const basePath = appProxyContext(request.headers)?.basePath ?? "";
    const vite = await developmentServer(basePath);
    request.url = basePath + (request.url ?? "/");
    vite.middlewares(request, response, () => response.writeHead(404).end());
  } catch (error) {
    console.error("Development request failed", error);
    if (!response.headersSent) response.writeHead(503);
    response.end();
  }
});

function developmentServer(basePath: string) {
  let pending = servers.get(basePath);
  if (!pending) {
    if (servers.size >= 4) throw new Error("Too many application paths");
    pending = createViteServer({
      root: fileURLToPath(new URL("../", import.meta.url)),
      configLoader: "native",
      base: `${basePath}/`,
      server: { middlewareMode: true, ws: { server }, allowedHosts: true },
    });
    servers.set(basePath, pending);
  }
  return pending;
}

server.on("upgrade", (request) => {
  request.url = (appProxyContext(request.headers)?.basePath ?? "") + (request.url ?? "/");
});
await developmentServer("");
server.listen(Number(process.env.PORT ?? 4300), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void Promise.allSettled([...servers.values()].map(async (vite) => (await vite).close())).then(
      () => server.close(() => process.exit()),
    );
  });
