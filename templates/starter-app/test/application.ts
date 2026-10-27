import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { createDatabase } from "../src/db/client.ts";

export async function startApplication() {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(address.port),
      BETTER_AUTH_URL: "http://localhost:4300",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = once(child, "exit");
  const database = createDatabase();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      child.kill("SIGTERM");
      const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        await database.sql.end({ timeout: 5 });
      }
    })());
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Starter exited: ${output}`);
      const healthy = await fetch(`${base}/health`).catch(() => undefined);
      if (healthy?.ok) return { base, database, close };
      await setTimeout(50);
    }
    throw new Error(`Starter did not become healthy: ${output}`);
  } catch (error) {
    await close();
    throw error;
  }
}
