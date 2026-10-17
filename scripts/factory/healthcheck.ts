import { resolve } from "node:path";

try {
  const { startupID } = await Bun.file(
    resolve(process.env["FACTORY_STATE_DIRECTORY"] ?? ".factory", "server.json"),
  ).json();
  const [server, cache] = await Promise.all([
    fetch(`http://127.0.0.1:${process.env["FACTORY_LOCAL_PORT"] || 3000}/api/session`, {
      signal: AbortSignal.timeout(1_000),
    }),
    fetch(`http://127.0.0.1:${process.env["FACTORY_LOCAL_ZERO_PORT"] || 4948}/keepalive`, {
      signal: AbortSignal.timeout(1_000),
    }),
  ]);
  if (
    !server.ok ||
    !cache.ok ||
    !startupID ||
    server.headers.get("x-open-factory") !== "ready" ||
    server.headers.get("x-open-factory-startup") !== startupID
  )
    process.exitCode = 1;
  await Promise.all([server.body?.cancel(), cache.body?.cancel()]);
} catch {
  process.exitCode = 1;
}
