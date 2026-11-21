import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";

const readiness = z.object({ fixtureBase: z.url(), id: z.uuid(), databaseURL: z.string() });
export type BrowserHost = z.infer<typeof readiness>;
type SpawnHost = (
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ReturnType<typeof spawnProcess>;

function spawnProcess(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Owned browser host command is empty");
  return spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Each call owns one host. The host owns its fresh database, cache and application. */
export async function ownedBrowserHost(
  options: {
    environment?: NodeJS.ProcessEnv;
    readinessTimeoutMS?: number;
    cleanupTimeoutMS?: number;
  } = {},
  spawnHost: SpawnHost = spawnProcess,
) {
  const host = spawnHost(
    ["mise", "exec", "--", "bun", "--no-env-file", "test/fixtures/skill-browser-host.ts"],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      env: verificationEnvironment(options.environment ?? process.env),
    },
  );
  const ready = Promise.withResolvers<BrowserHost>();
  const stopped = new Promise<number | null>((complete) => host.once("close", complete));
  host.once("error", () => ready.reject(new Error("Owned browser host could not start")));
  host.once("exit", (code, signal) =>
    ready.reject(new Error(`Owned browser host exited before readiness: ${code ?? signal}`)),
  );
  // Raw stdout/stderr can contain provider or authentication diagnostics. Publish only
  // the validated identity, and never attach raw output or parse errors to failures.
  host.stderr.resume();
  const lines = createInterface({ input: host.stdout });
  lines.on("line", (line) => {
    if (!line.startsWith('{"fixtureBase"')) return;
    try {
      ready.resolve(readiness.parse(JSON.parse(line)));
    } catch {
      ready.reject(new Error("Owned browser host sent invalid readiness"));
    }
  });
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      try {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
        let code: number | null;
        try {
          code = await bounded(
            stopped,
            options.cleanupTimeoutMS ?? 60_000,
            "Owned browser host resource cleanup unconfirmed",
          );
        } catch (cause) {
          // Stop only our local child. A forced exit never confirms resource cleanup.
          if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
          await stopped;
          throw cause;
        }
        if (code !== 0)
          throw new Error(`Owned browser host resource cleanup failed: ${code ?? host.signalCode}`);
      } finally {
        lines.close();
      }
    })());
  try {
    const fixture = await bounded(
      ready.promise,
      options.readinessTimeoutMS ?? 60_000,
      "Owned browser host readiness timed out",
    );
    console.info(`Owned browser host: ${fixture.id}`);
    return { ...fixture, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
