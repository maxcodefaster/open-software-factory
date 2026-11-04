import { AsyncLocalStorage } from "node:async_hooks";

type Result = { stdout: string; stderr: string; exitCode: number };
type Held = { at: number; result: Promise<Result> };

// A locked Factorybox operation inspects the exact Namespace, claim, Pod, node
// and native epoch before each command it dispatches, so Start, Resume and
// preparation repeat the same five reads within a second. Reuse those reads
// for a moment inside one operation, never across operations, after a failed
// command, or after a command that is not a native read.
export function createInspectionReuse(
  reuseMS = 2_000,
  now: () => number = performance.now.bind(performance),
) {
  const scopes = new AsyncLocalStorage<Map<string, Held>>();
  return {
    scope<T>(action: () => T): T {
      return scopes.run(new Map(), action);
    },
    run(
      args: readonly string[],
      input: string | undefined,
      send: () => Promise<Result>,
    ): Promise<Result> {
      const reads = scopes.getStore();
      if (!reads) return send();
      const key = input === undefined ? inspectionKey(args) : null;
      if (!key) {
        if (!observationOnly(args)) reads.clear();
        return send().then((value) => {
          if (value.exitCode !== 0) reads.clear();
          return value;
        });
      }
      const held = reads.get(key);
      if (held && now() - held.at < reuseMS) return held.result;
      const entry: Held = { at: now(), result: send() };
      reads.set(key, entry);
      entry.result.then(
        (value) => {
          entry.at = now();
          if (value.exitCode !== 0) reads.clear();
        },
        () => reads.clear(),
      );
      return entry.result;
    },
  };
}

// Only reads that describe the worker's identity are reusable: the four
// Kubernetes objects and the native supervisor status.
function inspectionKey(args: readonly string[]) {
  const [verb, kind] = args;
  if (verb === "get" && ["namespace", "pvc", "pod", "node"].includes(kind ?? ""))
    return JSON.stringify(args);
  if (verb === "exec" && args.at(-3) === "--" && args.at(-1) === "worker-status")
    return JSON.stringify(args);
  return null;
}

// Kubernetes reads and native state or capacity reads cannot change the
// Kubernetes objects or the worker identity. Any other command may, so it
// ends reuse.
function observationOnly(args: readonly string[]) {
  if (args[0] === "get") return true;
  const epoch = args.indexOf("--worker-epoch");
  return epoch >= 0 && ["state", "capacity"].includes(args[epoch + 2] ?? "");
}
