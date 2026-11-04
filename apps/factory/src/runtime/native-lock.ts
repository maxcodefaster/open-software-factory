import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { createDatabase } from "../../../../packages/db/src/client";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";

type Database = ReturnType<typeof createDatabase>;
type SQL = Database["client"];
type Result = { stdout: string; stderr: string; exitCode: number };
type Transport = (
  args: string[],
  input?: string,
  limits?: { timeoutMS: number; outputBytes: number },
) => Promise<Result>;

// The worker's native controller takes a non-blocking flock for every store
// command, including state reads. Two commands in flight therefore fail with
// EWOULDBLOCK instead of queueing. Factory serializes each native command
// across every process with the advisory lock `factorybox-worker-lifecycle`
// and holds it only for the command itself. Image export, Kubernetes reads and
// DB-only steps run without it.
//
// Foreground commands announce themselves on a second, shared key
// (`factorybox-worker-foreground`) while they wait for or hold the native key.
// Background sweeps take the native key only with a try-lock and only when no
// foreground command is announced. A sweep therefore delays a foreground
// command by at most one native call.

/** A background sweep gave way to foreground work. Nothing was dispatched; retry on the next sweep. */
export class NativeSlotBusyError extends Error {
  constructor() {
    super("Factorybox native worker stayed busy with foreground work; background work deferred");
  }
}

export type NativePriority = "foreground" | "background";

export type NativeLeaseTiming = {
  waitedMS: number;
  heldMS: number;
  acquisitions: number;
};

export type NativeLease = {
  readonly priority: NativePriority;
  readonly held: boolean;
  readonly timing: NativeLeaseTiming;
  acquire(): Promise<void>;
  release(): Promise<void>;
  around<T>(action: () => Promise<T>): Promise<T>;
};

type Clock = { now(): number; sleep(ms: number): Promise<unknown> };
const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export function createNativeLease(
  connection: SQL,
  priority: NativePriority,
  deadline: () => number = () => performance.now() + nativeLifecycleWindowMS,
  options: { pollMS?: number; maxWaitMS?: number; clock?: Clock } = {},
): NativeLease {
  const clock = options.clock ?? realClock;
  const pollMS = options.pollMS ?? 200;
  const maxWaitMS = options.maxWaitMS ?? 30_000;
  const timing: NativeLeaseTiming = { waitedMS: 0, heldMS: 0, acquisitions: 0 };
  let held = false;
  let heldSince = 0;
  let announced = false;

  async function foreground() {
    const remaining = Math.ceil(deadline() - clock.now());
    if (remaining <= 0) throw new Error("Factorybox worker deadline expired before admission");
    await connection`SELECT set_config('lock_timeout',${`${remaining}ms`},false)`;
    await connection`SELECT pg_advisory_lock_shared(hashtext('factorybox-worker-foreground'))`;
    announced = true;
    await connection`SELECT pg_advisory_lock(hashtext('factorybox-worker-lifecycle'))`;
  }
  async function background(started: number) {
    for (;;) {
      const [idle] = await connection<
        Array<{ granted: boolean }>
      >`SELECT pg_try_advisory_lock(hashtext('factorybox-worker-foreground')) AS granted`;
      if (idle?.granted) {
        try {
          const [taken] = await connection<
            Array<{ granted: boolean }>
          >`SELECT pg_try_advisory_lock(hashtext('factorybox-worker-lifecycle')) AS granted`;
          if (taken?.granted) return;
        } finally {
          await connection`SELECT pg_advisory_unlock(hashtext('factorybox-worker-foreground'))`;
        }
      }
      if (clock.now() >= deadline() || clock.now() - started >= maxWaitMS)
        throw new NativeSlotBusyError();
      await clock.sleep(pollMS);
    }
  }
  async function unannounce() {
    if (!announced) return;
    announced = false;
    await connection`SELECT pg_advisory_unlock_shared(hashtext('factorybox-worker-foreground'))`;
  }
  const lease: NativeLease = {
    priority,
    get held() {
      return held;
    },
    timing,
    async acquire() {
      if (held) return;
      const started = clock.now();
      try {
        if (priority === "foreground") await foreground();
        else await background(started);
      } catch (cause) {
        await unannounce().catch(() => undefined);
        throw cause;
      }
      held = true;
      heldSince = clock.now();
      timing.waitedMS += heldSince - started;
      timing.acquisitions += 1;
    },
    async release() {
      if (!held) return;
      held = false;
      timing.heldMS += clock.now() - heldSince;
      try {
        await connection`SELECT pg_advisory_unlock(hashtext('factorybox-worker-lifecycle'))`;
      } finally {
        await unannounce();
      }
    },
    async around(action) {
      if (held) return action();
      await lease.acquire();
      try {
        return await action();
      } finally {
        await lease.release();
      }
    },
  };
  return lease;
}

const leases = new AsyncLocalStorage<NativeLease>();

const inFlightOperations = new Set<Promise<unknown>>();
/** Register a native lifecycle operation so shutdown can wait for it instead of cutting it off. */
export function trackNativeOperation<T>(operation: Promise<T>) {
  inFlightOperations.add(operation);
  const done = () => void inFlightOperations.delete(operation);
  operation.then(done, done);
  return operation;
}
/**
 * Wait for running native lifecycle operations. An operation interrupted between its
 * intent and its outcome stays unconfirmed, so a restart waits up to `timeoutMs` first.
 */
export async function drainNativeOperations(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (inFlightOperations.size && Date.now() < deadline)
    await Promise.race([
      Promise.allSettled([...inFlightOperations]),
      new Promise((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
    ]);
  return inFlightOperations.size;
}

/** Run `action` with `lease` as the current native lease. The caller releases it. */
export function withNativeLease<T>(lease: NativeLease, action: () => Promise<T>) {
  return leases.run(lease, action);
}
export function currentNativeLease() {
  return leases.getStore();
}
/** Hold the current native lease until `releaseNativeDispatch`, for intent-before-effect dispatch. */
export async function acquireNativeDispatch() {
  await currentNativeLease()?.acquire();
}
export async function releaseNativeDispatch() {
  await currentNativeLease()?.release();
}

const consumerProgram = readFileSync(
  new URL("../../../../packages/runtime-kubernetes/src/factorybox/consumer.py", import.meta.url),
  "utf8",
);
/**
 * Whether one kubectl invocation reaches the native controller. Supervisor
 * status and the consumer image exporter (which keeps its own file lock) never
 * do. Every other exec into the worker counts as a controller command.
 */
export function needsNativeController(args: readonly string[]) {
  if (args[0] !== "exec") return false;
  const separator = args.indexOf("--");
  if (separator < 0) return false;
  const [program, first, third] = args.slice(separator + 1);
  if (program?.endsWith("/factorybox")) return first !== "worker-status";
  if (program === "python3" && first === "-c") return third !== consumerProgram;
  return true;
}

/** Wrap a transport so a controller command holds the current native lease for exactly one call. */
export function gatedFactoryboxTransport<T extends Transport>(base: T): T {
  const gated = (...args: Parameters<Transport>) => {
    const lease = leases.getStore();
    if (!lease || lease.held || !needsNativeController(args[0])) return base(...args);
    return lease.around(() => base(...args));
  };
  return gated as T;
}
