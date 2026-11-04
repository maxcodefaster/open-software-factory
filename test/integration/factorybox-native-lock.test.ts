import { expect, test } from "bun:test";
import {
  acquireNativeDispatch,
  createNativeLease,
  gatedFactoryboxTransport,
  NativeSlotBusyError,
  needsNativeController,
  releaseNativeDispatch,
  withNativeLease,
} from "../../apps/factory/src/runtime/native-lock";
import { factoryProcess } from "../fixtures/factory-process";

const controller = (action: string) => [
  "exec",
  "worker-pod",
  "-n",
  "factory",
  "-c",
  "worker",
  "--",
  "/opt/factorybox/factorybox",
  "--worker-run-root",
  "/run/factorybox",
  "--worker-store-id",
  "store",
  "--worker-epoch",
  "epoch",
  action,
];
const exporter = [
  "exec",
  "-i",
  "worker-pod",
  "-n",
  "factory",
  "-c",
  "worker",
  "--",
  "python3",
  "-c",
];
const ok = { stdout: "{}", stderr: "", exitCode: 0 };

// Each Database connection is a separate PostgreSQL session, which is what a
// separate Factory process is to an advisory lock.
test("two Starts overlap their exports but never their native commands, and retirement yields to a waiting foreground command", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const connections: ReturnType<typeof database.coordination>[] = [];
  const open = () => {
    const connection = database.coordination();
    connections.push(connection);
    return connection;
  };
  const sleep = (ms: number) => Bun.sleep(ms);
  try {
    let exporters = 0;
    let maxExporters = 0;
    let natives = 0;
    let maxNatives = 0;
    const order: string[] = [];
    const base = async (args: string[]) => {
      const native = needsNativeController(args);
      const label = native ? (args.at(-1) ?? "native") : "export";
      if (native) {
        natives += 1;
        maxNatives = Math.max(maxNatives, natives);
      } else {
        exporters += 1;
        maxExporters = Math.max(maxExporters, exporters);
      }
      order.push(`+${label}`);
      await sleep(native ? 120 : 400);
      order.push(`-${label}`);
      if (native) natives -= 1;
      else exporters -= 1;
      return ok;
    };
    const transport = gatedFactoryboxTransport(base);
    const consumer = await Bun.file(
      "packages/runtime-kubernetes/src/factorybox/consumer.py",
    ).text();

    async function start(name: string, exportFirst = true) {
      const connection = open();
      const lease = createNativeLease(connection, "foreground", () => performance.now() + 30_000);
      await withNativeLease(lease, async () => {
        // Image export: no native lock.
        if (exportFirst) await transport([...exporter, consumer]);
        // Intent, then dispatch under one lease.
        await acquireNativeDispatch();
        order.push(`intent-${name}`);
        await transport(controller("start"));
        await releaseNativeDispatch();
      });
      await lease.release();
    }
    await Promise.all([start("a"), start("b")]);
    expect(maxExporters).toBe(2);
    expect(maxNatives).toBe(1);
    // Neither dispatch begins before the other one ended.
    const starts = order.filter((entry) => entry.endsWith("start"));
    expect(starts).toEqual(["+start", "-start", "+start", "-start"]);

    // A sweep takes the native lock one call at a time and yields between
    // calls to a foreground command that is already waiting.
    order.length = 0;
    const sweepConnection = open();
    const sweep = createNativeLease(
      sweepConnection,
      "background",
      () => performance.now() + 30_000,
      {
        pollMS: 20,
      },
    );
    const sweeping = withNativeLease(sweep, async () => {
      for (const action of ["retire-checkpoint", "retire-resume", "retire-sandbox"])
        await transport(controller(action));
    });
    await sleep(60);
    const foreground = start("fg", false);
    await Promise.all([sweeping, foreground]);
    const native = order.filter((entry) => entry.startsWith("+") && entry !== "+export");
    // The foreground Start's dispatch ran before the sweep's second call.
    expect(native.indexOf("+start")).toBe(1);
    expect(native).toEqual(["+retire-checkpoint", "+start", "+retire-resume", "+retire-sandbox"]);
    expect(maxNatives).toBe(1);
  } finally {
    await Promise.all(connections.map((connection) => connection.end({ timeout: 1 })));
    await database.client.end({ timeout: 2 });
  }
}, 30_000);

test("a background sweep gives up without dispatching while foreground work holds the worker, and a foreground wait honors its deadline", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  const held = database.coordination();
  const sweeper = database.coordination();
  const waiter = database.coordination();
  try {
    const foreground = createNativeLease(held, "foreground", () => performance.now() + 10_000);
    await foreground.acquire();
    const sweep = createNativeLease(sweeper, "background", () => performance.now() + 10_000, {
      pollMS: 10,
      maxWaitMS: 120,
    });
    await expect(sweep.acquire()).rejects.toBeInstanceOf(NativeSlotBusyError);
    expect(sweep.held).toBe(false);
    const late = createNativeLease(waiter, "foreground", () => performance.now() + 150);
    await expect(late.acquire()).rejects.toThrow();
    expect(late.held).toBe(false);
    await foreground.release();
    // Both leases leave nothing behind on the shared keys.
    await sweep.acquire();
    await sweep.release();
    await late.acquire();
    await late.release();
    const leftovers = await database.client`SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype='advisory' AND granted AND pid IN (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())`;
    expect(leftovers[0]?.["count"]).toBe(0);
  } finally {
    await Promise.all([held, sweeper, waiter].map((connection) => connection.end({ timeout: 1 })));
    await database.client.end({ timeout: 2 });
  }
}, 30_000);
