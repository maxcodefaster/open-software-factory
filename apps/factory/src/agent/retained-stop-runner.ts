import { lstat, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  cancelQueuedOpenCodeInput,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  interruptOpenCodeSession,
} from "./opencode-client";
import { retainedStopInput, retainedStopResult } from "./retained-stop-contract";

// This process receives only the retained native .git directory. It has no
// Project files, hooks, provider credentials or Factory execution capabilities.
async function main() {
  const input = retainedStopInput.parse(JSON.parse(process.env["FACTORY_RETAINED_STOP"] ?? ""));
  const database = "/native-session/factory-opencode.db";
  const file = await lstat(database);
  if (!file.isFile() || file.isSymbolicLink())
    throw new Error("The original native Session database is unavailable");
  const packaged = await Bun.file(
    "/opt/factory/opencode/server/node_modules/@opencode/server/package.json",
  ).json();
  if (packaged.version !== input.version)
    throw new Error("Retained Stop requires the exact admitted OpenCode version");
  await mkdir("/tmp/retained-stop-home", { recursive: true, mode: 0o700 });
  const password = crypto.randomUUID();
  const child = Bun.spawn([process.execPath, "/opt/factory/opencode/server/server.mjs"], {
    cwd: "/workspace/project",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/retained-stop-home",
      TMPDIR: "/tmp",
      OPENCODE_DB: database,
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      FACTORY_OPENCODE_HOST: "127.0.0.1",
      FACTORY_OPENCODE_CONFIG: JSON.stringify({
        providers: {},
        skills: [],
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const client = createOpenCodeClient((request, path) => {
    const target = new Request(`http://127.0.0.1:4096${path}`, request);
    target.headers.set(
      "authorization",
      `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    );
    return fetch(target);
  });
  let confirmed = false;
  try {
    const readiness = AbortSignal.timeout(45_000);
    for (;;) {
      readiness.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Retained native Session process exited");
      try {
        const info = await client.server.info({ signal: readiness });
        if (info.version !== input.version) throw new Error("Native Session version changed");
        break;
      } catch {
        readiness.throwIfAborted();
        await Bun.sleep(100);
      }
    }
    try {
      const session = await client.session.get({ sessionID: input.sessionID });
      if (
        session.id !== input.sessionID ||
        session.location.directory !== "/workspace/project" ||
        session.model?.providerID !== "factory" ||
        session.model.id !== input.modelID
      )
        throw new Error("The retained Session differs from its admitted configuration");
    } catch (cause) {
      const absent = z
        .object({
          _tag: z.literal("SessionNotFoundError"),
          sessionID: z.literal(input.sessionID),
        })
        .safeParse(cause);
      if (!absent.success) throw cause;
      confirmed = true;
    }
    if (!confirmed) {
      // Teardown may already have settled the input. Observe that native fact
      // before considering another interruption or cancellation.
      confirmed = await confirmSettledOpenCodeInput(client, input.sessionID, input.promptID);
      if (!confirmed) {
        const interrupted = await interruptOpenCodeSession(client, input.sessionID);
        confirmed =
          interrupted === "absent" ||
          (interrupted === "interrupted" &&
            (await cancelQueuedOpenCodeInput(client, input.sessionID, input.promptID)));
      }
    }
    if (!confirmed) throw new Error("Retained native input is not settled");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolve();
          }, 5_000);
        }),
      ]);
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(
    JSON.stringify(
      retainedStopResult.parse({
        ...input,
        confirmed,
        nativeProcessExited: true,
      }),
    ),
  );
}

if (import.meta.main) {
  await main().catch(() => {
    console.error(
      "Retained native Stop could not be confirmed. Existing source and Stop are retained.",
    );
    process.exitCode = 1;
  });
}
