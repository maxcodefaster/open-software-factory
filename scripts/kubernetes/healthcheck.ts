import { resolve } from "node:path";

try {
  const { startupID } = await Bun.file(
    resolve(process.env["FACTORY_STATE_DIRECTORY"] ?? "/var/lib/factory", "kubernetes-ready.json"),
  ).json();
  const response = await fetch(
    `http://127.0.0.1:${process.env["FACTORY_PORT"] ?? "3000"}/health/ready`,
    { signal: AbortSignal.timeout(2000) },
  );
  const ready =
    startupID &&
    response.ok &&
    response.headers.get("x-open-factory") === "ready" &&
    response.headers.get("x-open-factory-startup") === startupID;
  await response.body?.cancel();
  if (!ready) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
