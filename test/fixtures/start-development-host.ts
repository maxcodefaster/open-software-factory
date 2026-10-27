import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const cacheDirectory = resolve(
  ".factory/test-results/vite",
  `start-development-${crypto.randomUUID()}`,
);
const server = await createServer({
  configFile: "apps/factory/vite.config.ts",
  cacheDir: cacheDirectory,
  server: { host: "127.0.0.1", port: 0 },
});
const shutdown = Promise.withResolvers<void>();
process.once("SIGTERM", () => shutdown.resolve());
process.once("SIGINT", () => shutdown.resolve());
try {
  await server.listen();
  console.log(
    JSON.stringify({ developmentBase: server.resolvedUrls?.local[0]?.replace(/\/$/, "") }),
  );
  await shutdown.promise;
} finally {
  await server.close();
  await rm(cacheDirectory, { recursive: true, force: true });
}
