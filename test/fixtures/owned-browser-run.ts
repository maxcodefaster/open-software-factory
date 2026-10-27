import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  productionBuildEnvironment,
  verificationEnvironment,
} from "../../scripts/testing/test-prerequisites";

const stateSchema = z.object({
  id: z.uuid(),
  postgres: z.object({ owner: z.uuid(), url: z.string() }),
});
function paths(id: string) {
  z.uuid().parse(id);
  return {
    state: resolve(".factory/test-results/browser-runs", id, "state.json"),
    evidence: resolve(".factory/test-results/browser-runs", id),
    build: resolve(".factory/test-results/application-builds", `browser-${id}`),
  };
}
export async function ownedBrowserEnvironment() {
  const id = process.env["FACTORY_BROWSER_RUN_ID"];
  if (!id) throw new Error("Owned browser setup did not run");
  const path = paths(id);
  const state = stateSchema.parse(JSON.parse(await readFile(path.state, "utf8")));
  if (state.id !== id) throw new Error("Owned browser run identity mismatch");
  process.env["FACTORY_BUILD_DIRECTORY"] = path.build;
  return {
    ...verificationEnvironment(process.env),
    FACTORY_BUILD_DIRECTORY: path.build,
    FACTORY_TEST_POSTGRES: JSON.stringify(state.postgres),
  };
}

if (import.meta.main) {
  const [command, id] = process.argv.slice(2);
  if (!id || !["setup", "close"].includes(command ?? ""))
    throw new Error("Invalid owned browser command");
  const path = paths(id);
  const { ownedPostgresServer, closeOwnedPostgresServer } = await import("./postgres-server");
  if (command === "setup") {
    await mkdir(dirname(path.evidence), { recursive: true });
    await mkdir(path.evidence);
    await mkdir(dirname(path.build), { recursive: true });
    // Both names are exclusive. Reusing an explicit ID must not replace another
    // invocation's build or lose the resource identity retained in its state.
    await mkdir(path.build);
    let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
    try {
      postgres = await ownedPostgresServer();
      await writeFile(path.state, JSON.stringify({ id, postgres: postgres.identity }), {
        flag: "wx",
      });
      const build = Bun.spawn([process.execPath, "--no-env-file", "run", "factory:build"], {
        env: {
          ...productionBuildEnvironment(verificationEnvironment(process.env)),
          FACTORY_BUILD_DIRECTORY: path.build,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      await writeFile(resolve(path.evidence, "build.log"), stdout + stderr);
      if (status !== 0) throw new Error("Owned browser build failed");
    } catch (cause) {
      await postgres?.dispose();
      await rm(path.build, { recursive: true, force: true });
      await rm(path.state, { force: true });
      throw cause;
    }
  } else {
    const state = await readFile(path.state, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (state) {
      const parsed = stateSchema.parse(JSON.parse(state));
      if (parsed.id !== id) throw new Error("Owned browser cleanup refused");
      await closeOwnedPostgresServer(parsed.postgres);
      await rm(path.build, { recursive: true, force: true });
      await rm(path.state);
    }
  }
}
