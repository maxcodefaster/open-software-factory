import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { z } from "zod";
import upstream from "../../../../upstream.json";
import {
  cancelQueuedOpenCodeInput,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  interruptOpenCodeSession,
} from "./opencode-client";

// Fixed native-Actor paths. This process has no Project checkout at the
// Session's recorded location, no Factory capability and no provider config.
const database = "/home/rootless/persist/project/.git/factory-opencode.db";
const location = "/workspace/project";
const input = z.strictObject({
  stopID: z.uuid(),
  attemptID: z.uuid(),
  sessionID: z.string().regex(/^ses_[a-zA-Z0-9_-]+$/),
  promptID: z.string().regex(/^msg_[a-zA-Z0-9_-]+$/),
  modelID: z.string().min(1).max(200),
  version: z.literal(upstream.openCode.version),
  mode: z.enum(["interrupt", "observe"]),
});

async function main() {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 8192) {
        await reader.cancel();
        throw new Error("Input Stop assignment exceeds its bound");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  const target = input.parse(JSON.parse(text));
  const info = await lstat(database);
  if (!info.isFile() || info.nlink !== 1)
    throw new Error("Original private Session database is not a single regular file");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await lstat(`${database}${suffix}`).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    if (sidecar && (!sidecar.isFile() || sidecar.nlink !== 1))
      throw new Error("Private Session sidecar is not a single regular file");
  }
  const packaged = await Bun.file(
    "/opt/factory/opencode/server/node_modules/@opencode/server/package.json",
  ).json();
  if (packaged.version !== target.version)
    throw new Error("Input Stop requires the exact admitted OpenCode version");
  await mkdir(location, { recursive: true, mode: 0o700 });
  const directory = await lstat(location);
  if (!directory.isDirectory() || (await readdir(location)).length)
    throw new Error("Input Stop requires an empty, private Session location");
  const home = await mkdtemp("/tmp/factory-input-stop-");
  const password = crypto.randomUUID();
  const child = Bun.spawn([process.execPath, "/opt/factory/opencode/server/server.mjs"], {
    cwd: location,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
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
    const url = new URL(path, "http://127.0.0.1:4096");
    if (url.origin !== "http://127.0.0.1:4096") throw new Error("Input Stop target changed");
    const forwarded = new Request(url, request);
    forwarded.headers.set(
      "authorization",
      `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    );
    return fetch(forwarded, { redirect: "error" });
  });
  let confirmed = false;
  try {
    const readiness = AbortSignal.timeout(45_000);
    for (;;) {
      readiness.throwIfAborted();
      if (child.exitCode !== null) throw new Error("Input Stop engine exited before readiness");
      const server = await client.server.info({ signal: readiness }).catch(() => null);
      if (!server) {
        readiness.throwIfAborted();
        await Bun.sleep(100);
        continue;
      }
      if (server.version !== target.version) throw new Error("Input Stop engine version changed");
      break;
    }
    let absent = false;
    try {
      const session = await client.session.get({ sessionID: target.sessionID });
      if (
        session.id !== target.sessionID ||
        session.location.directory !== location ||
        session.model?.providerID !== "factory" ||
        session.model.id !== target.modelID
      )
        throw new Error("Input Stop Session differs from its admitted identity");
    } catch (cause) {
      const missing = z
        .object({ _tag: z.literal("SessionNotFoundError"), sessionID: z.literal(target.sessionID) })
        .safeParse(cause);
      if (!missing.success) throw cause;
      absent = true;
    }
    if (absent) confirmed = true;
    else if (target.mode === "observe") {
      confirmed = await confirmSettledOpenCodeInput(client, target.sessionID, target.promptID);
    } else {
      const interruption = await interruptOpenCodeSession(client, target.sessionID);
      confirmed =
        interruption === "absent" ||
        (interruption === "interrupted" &&
          (await cancelQueuedOpenCodeInput(client, target.sessionID, target.promptID)) &&
          (await confirmSettledOpenCodeInput(client, target.sessionID, target.promptID)));
    }
    if (!confirmed) throw new Error("Input Stop remains unconfirmed");
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
      await rm(home, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ ...target, confirmed, engineExited: true }));
}

if (import.meta.main) {
  await main().catch(() => {
    console.error("Native input Stop could not be confirmed; retained Source was not discarded");
    process.exitCode = 1;
  });
}
