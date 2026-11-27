import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CommandError } from "../command-error";
import type { RuntimeHub } from "../runtime/transport-api";
import type { PrivateObjects } from "../storage/objects";
import { confirmInitialSourcePublication, materializeInitialSource } from "./source-initialization";
import {
  checkedBundle,
  objectKey,
  type SourceCheckpoint,
  sourceCheckpoint,
  verifiedManifest,
} from "./substrate-source-checkpoints";
import {
  type ClassifiedSourceLease,
  readSourceWriter,
  type ServiceSourceLease,
  type SourceDatabase,
  type SourceSQL,
} from "./substrate-source-state";

type SourceHostProcess = {
  epoch: number;
  base: string;
  token: string;
  socket: string;
  directory: string;
  child: ReturnType<typeof Bun.spawn>;
  ready: Promise<void>;
};

export type SourceHostManager = ReturnType<typeof createSourceHostManager>;

export function createSourceHostManager(
  database: SourceDatabase,
  hub: RuntimeHub,
  objects: PrivateObjects,
) {
  const root = resolve(
    process.env["FACTORY_STATE_DIRECTORY"] ?? "/var/lib/factory",
    "workspace-source",
  );
  const binary =
    process.env["FACTORY_SOURCE_SERVICE_BINARY"] ?? "/usr/local/bin/factory-runtime-connector";
  const hosts = new Map<string, SourceHostProcess>();

  async function stopHost(workspaceID: string) {
    const host = hosts.get(workspaceID);
    if (!host) return;
    host.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CommandError(
                  "unavailable",
                  "Source service termination is unconfirmed; owner was not transferred",
                ),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    hosts.delete(workspaceID);
    await rmdir(host.directory).catch(() => {}); // empty, exact owned IPC directory only
  }

  async function materialize(saved: SourceCheckpoint, base: string) {
    await verifiedManifest(objects, saved);
    const marker = join(base, "confirmed.json");
    try {
      if ((await readFile(marker, "utf8")) !== JSON.stringify(saved))
        throw new Error("Source materialization identity changed");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await lstat(base);
      throw new CommandError("unavailable", "Unconfirmed existing Source was preserved");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A previous incomplete extraction is never reused or deleted. New staging
    // identity, validated complete archive and its marker publish together. A
    // process crash must not leave a published tree without its confirmation.
    await mkdir(dirname(base), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(base), `staging-${saved.id}-`));
    const file = join(staging, "source.tar");
    const output = await open(file, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      for (let i = 0; i < saved.bundle.chunks.length; i++) {
        const bytes = checkedBundle(await objects.read(objectKey(saved, `chunk-${i}`)), saved, i);
        hash.update(bytes);
        await output.writeFile(bytes);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    if (hash.digest("hex") !== saved.bundle.sha256)
      throw new CommandError("unavailable", "Source bundle checksum differs; old data retained");
    const child = Bun.spawn([binary, "source-materialize", file, join(staging, "project")], {
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    if (await child.exited)
      throw new CommandError(
        "unavailable",
        "Source metadata/materialization is unsupported or corrupt; old data retained",
      );
    const confirmation = await open(join(staging, "confirmed.json"), "wx", 0o600);
    try {
      await confirmation.writeFile(JSON.stringify(saved));
      await confirmation.sync();
    } finally {
      await confirmation.close();
    }
    const staged = await open(staging, "r");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    // The existing Workspace lock excludes another publication or file writer.
    await rename(staging, base);
    const parent = await open(dirname(base), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async function ensureService(state: ServiceSourceLease, sql: SourceSQL) {
    const retained = hosts.get(state.workspaceID);
    const seedBased = state.seed !== null && state.serviceBase === state.seed.id;
    if (
      retained?.base === state.serviceBase &&
      retained.child.exitCode === null &&
      (retained.epoch === state.writerEpoch || !state.writable) &&
      (!seedBased || state.seedConfirmedAt !== null)
    ) {
      await retained.ready;
      return retained;
    }
    if (retained) await stopHost(state.workspaceID);
    const base = join(root, state.workspaceID, state.serviceBase);
    // Its base stays fixed throughout offline edits and freeze retries. Never
    // import a prior checkpoint over an existing service-owned dirty tree.
    if (seedBased && state.seed) {
      if (state.actorUID !== null || state.seed.workspaceID !== state.workspaceID)
        throw new CommandError("unavailable", "Initial Source owner identity changed");
      await materializeInitialSource(binary, root, state.seed, state.seedConfirmedAt !== null);
      if (!state.seedConfirmedAt)
        await confirmInitialSourcePublication(database, state.workspaceID, state.seed.id);
    } else {
      if (!state.checkpoint)
        throw new CommandError("unavailable", "Independent Source checkpoint is unavailable");
      const marker = join(base, "confirmed.json");
      if (
        !(await stat(marker).then(
          () => true,
          () => false,
        ))
      ) {
        if (state.checkpoint.id !== state.serviceBase)
          throw new CommandError(
            "unavailable",
            "Service-owned Source is missing; reinitialization refused",
          );
        await materialize(state.checkpoint, base);
      }
      let materialized: SourceCheckpoint;
      try {
        materialized = sourceCheckpoint.parse(JSON.parse(await readFile(marker, "utf8")));
      } catch {
        throw new CommandError(
          "unavailable",
          "Source materialization identity changed; existing data was preserved",
        );
      }
      if (
        materialized.id !== state.serviceBase ||
        materialized.workspaceID !== state.workspaceID ||
        materialized.actorUID !== state.actorUID ||
        materialized.writerEpoch >= state.writerEpoch ||
        materialized.generation > state.generation
      )
        throw new CommandError(
          "unavailable",
          "Source materialization identity changed; existing data was preserved",
        );
      await verifiedManifest(objects, materialized);
    }
    const role = await readSourceWriter(state, sql);
    const access = {
      workspaceId: state.workspaceID,
      serviceId: `source-${state.workspaceID.replaceAll("-", "")}`,
      epoch: state.writerEpoch,
      ownerEpoch: state.writerEpoch,
      writerEpoch: role.epoch,
      readOnly: !role.writable,
      token: randomBytes(32).toString("hex"),
    };
    const directory = await mkdtemp(join(tmpdir(), "factory-source-"));
    const socket = join(directory, "api.sock");
    const child = Bun.spawn([binary, "source-host"], {
      stdin: new Blob([JSON.stringify({ root: join(base, "project"), socket, access })]),
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const host: SourceHostProcess = {
      epoch: state.writerEpoch,
      base: state.serviceBase,
      token: access.token,
      socket,
      directory,
      child,
      ready: Promise.resolve(),
    };
    host.ready = (async () => {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null)
          throw new CommandError("unavailable", "Independent Source process exited");
        try {
          const result = await fetch(
            `http://source.internal/v1/workspaces/${state.workspaceID}/stat`,
            {
              unix: socket,
              method: "POST",
              body: '{"path":""}',
              headers: {
                authorization: `Bearer ${access.token}`,
                "X-Factory-Source-Service": access.serviceId,
                "X-Factory-Source-Epoch": String(access.epoch),
              },
              signal: AbortSignal.timeout(1000),
            },
          );
          if (result.ok) {
            await result.body?.cancel();
            return;
          }
          await result.body?.cancel();
        } catch {
          /* bounded connection readiness only */
        }
        await Bun.sleep(100);
      }
      throw new CommandError("unavailable", "Independent Source connection is unconfirmed");
    })();
    hosts.set(state.workspaceID, host);
    await host.ready;
    return host;
  }

  async function request(
    workspaceID: string,
    attemptID: string | null,
    state: ClassifiedSourceLease,
    operation: string,
    req: Request,
    sql: SourceSQL,
  ) {
    if (state.owner === "actor") {
      if (!attemptID) throw new CommandError("unavailable", "Actor Source binding is unavailable");
      return hub.request(attemptID, "source", req, `/v1/workspaces/${workspaceID}/${operation}`);
    }
    const host = await ensureService(state, sql);
    return fetch(`http://source.internal/v1/workspaces/${workspaceID}/${operation}`, {
      unix: host.socket,
      method: req.method,
      redirect: "error",
      signal: req.signal,
      headers: {
        authorization: `Bearer ${host.token}`,
        "X-Factory-Source-Service": `source-${workspaceID.replaceAll("-", "")}`,
        "X-Factory-Source-Epoch": String(host.epoch),
        "X-Factory-Writer-Epoch": req.headers.get("X-Factory-Writer-Epoch") ?? "",
        "content-type": "application/json",
      },
      ...(req.method === "GET" ? {} : { body: await req.arrayBuffer() }),
    });
  }

  return {
    stopHost,
    ensureService,
    request,
    async close() {
      for (const workspace of hosts.keys()) await stopHost(workspace);
    },
  };
}
