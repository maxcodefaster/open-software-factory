import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { runProcess } from "../../scripts/owned-client-process";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";
import { prepareBrowserBuild } from "./browser-build";

const stateSchema = z.object({
  id: z.uuid(),
  postgres: z.object({ owner: z.uuid(), url: z.string() }),
  build: z.object({ directory: z.string().min(1), ownership: z.enum(["owned", "borrowed"]) }),
});
function paths(id: string) {
  z.uuid().parse(id);
  return {
    state: resolve(".factory/test-results/browser-runs", id, "state.json"),
    evidence: resolve(".factory/test-results/browser-runs", id),
    build: resolve(".factory/test-results/application-builds", `browser-${id}`),
  };
}
function parseState(source: string, id: string) {
  const state = stateSchema.parse(JSON.parse(source));
  if (
    state.id !== id ||
    state.build.directory !== resolve(state.build.directory) ||
    (state.build.ownership === "owned" && state.build.directory !== paths(id).build)
  )
    throw new Error("Owned browser run identity mismatch");
  return state;
}
export async function ownedBrowserEnvironment() {
  const id = process.env["FACTORY_BROWSER_RUN_ID"];
  if (!id) throw new Error("Owned browser setup did not run");
  const path = paths(id);
  const state = parseState(await readFile(path.state, "utf8"), id);
  process.env["FACTORY_BUILD_DIRECTORY"] = state.build.directory;
  return {
    ...verificationEnvironment(process.env),
    FACTORY_BUILD_DIRECTORY: state.build.directory,
    FACTORY_TEST_POSTGRES: JSON.stringify(state.postgres),
  };
}

if (import.meta.main) {
  const [command, id] = process.argv.slice(2);
  if (!id || !["setup", "close"].includes(command ?? ""))
    throw new Error("Invalid owned browser command");
  const path = paths(id);
  const cancellation = new AbortController();
  let interrupted: number | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal === "SIGINT" ? 130 : 143;
    process.exitCode = interrupted;
    if (!cancellation.signal.aborted) cancellation.abort(signal);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const { ownedPostgresServer, closeOwnedPostgresServer } = await import("./postgres-server");
    if (command === "setup") {
      await mkdir(dirname(path.evidence), { recursive: true });
      cancellation.signal.throwIfAborted();
      await mkdir(path.evidence);
      // A borrowed build does not claim this name, but a pre-existing artifact
      // still refuses reuse of the run ID before PostgreSQL is admitted.
      if (
        await lstat(path.build)
          .then(() => true)
          .catch((cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
            return false;
          })
      )
        throw Object.assign(new Error(`EEXIST: browser build already exists: ${path.build}`), {
          code: "EEXIST",
        });
      const environment = verificationEnvironment(process.env);
      const ownership = environment["FACTORY_BUILD_DIRECTORY"] ? "borrowed" : "owned";
      let disposeBuild: (() => Promise<void>) | undefined;
      let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
      try {
        disposeBuild = await prepareBrowserBuild(
          environment,
          async (env, signal) => {
            const build = await runProcess(
              [process.execPath, "--no-env-file", "run", "factory:build"],
              {
                env,
                signal,
                allowFailure: true,
              },
            );
            await writeFile(resolve(path.evidence, "build.log"), build.stdout + build.stderr);
            if (build.code !== 0) throw new Error("Owned browser build failed");
          },
          cancellation.signal,
          path.build,
        );
        cancellation.signal.throwIfAborted();
        postgres = await ownedPostgresServer();
        await writeFile(
          path.state,
          JSON.stringify({
            id,
            postgres: postgres.identity,
            build: { directory: resolve(environment["FACTORY_BUILD_DIRECTORY"] ?? ""), ownership },
          }),
          {
            flag: "wx",
          },
        );
        cancellation.signal.throwIfAborted();
      } catch (cause) {
        // Retain the state and build when PostgreSQL cleanup is unconfirmed.
        await postgres?.dispose();
        await disposeBuild?.();
        await rm(path.state, { force: true });
        throw cause;
      }
    } else {
      const state = await readFile(path.state, "utf8").catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined;
        throw cause;
      });
      if (state) {
        const parsed = parseState(state, id);
        await closeOwnedPostgresServer(parsed.postgres);
        if (parsed.build.ownership === "owned")
          await rm(parsed.build.directory, { recursive: true, force: true });
        await rm(path.state);
      }
    }
  } catch (cause) {
    if (!cancellation.signal.aborted || cause !== cancellation.signal.reason) throw cause;
  } finally {
    if (interrupted !== undefined) process.exitCode = interrupted;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
