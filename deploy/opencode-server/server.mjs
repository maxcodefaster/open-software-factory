import { start } from "@opencode/server/process";
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateRetainedEvents } from "./retained-events.mjs";

// The published server has no compile-time libc marker. Select its native watcher explicitly.
if (process.platform === "linux") {
  const result = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const libc = version.includes("musl")
    ? "musl"
    : /GLIBC|GNU libc|GNU C Library/.test(version)
      ? "glibc"
      : null;
  if (!libc) throw new Error("OpenCode requires a recognized Linux libc");
  process.env.OPENCODE_PARCEL_WATCHER_PATH = `@parcel/watcher-linux-${process.arch}-${libc}`;
}

// The upstream CLI does not expose events.persist. Use the unchanged published server.
migrateRetainedEvents(process.env.OPENCODE_DB);
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* start({
        app: { name: "factory", version: "2.0.27", channel: "stable" },
        hostname: process.env.FACTORY_OPENCODE_HOST ?? "127.0.0.1",
        port: 4096,
        password: process.env.OPENCODE_PASSWORD,
        database: { path: process.env.OPENCODE_DB },
        events: { persist: true },
        models: { fetch: false },
        config: {
          directory: fileURLToPath(new URL("./config/", import.meta.url)),
          project: false,
          content: process.env.FACTORY_OPENCODE_CONFIG,
        },
      });
      yield* server.shutdown;
    }),
  ),
);
