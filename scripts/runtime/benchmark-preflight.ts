import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import type { FactoryboxWorkerIdentity } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { benchmarkCommandKind, factoryboxExecutable } from "./benchmark-profile";

// A benchmark-only experiment. The product adapter still validates Kubernetes
// UIDs, the complete worker status and capacity before marking dispatch attempted.
// Only two consecutive read-only observations in one pause request are combined;
// the native pause independently performs storage/identity admission as before.
export function combinedBenchmarkPreflight(
  enabled: boolean,
  phase: () => string,
  identity: () => FactoryboxWorkerIdentity,
  command: typeof runCommand = runCommand,
): typeof runCommand {
  let cached:
    | { phase: string; arguments: string; result: Awaited<ReturnType<typeof runCommand>> }
    | undefined;
  return async (args, body, limits) => {
    if (!enabled) return command(args, body, limits);
    const currentPhase = phase();
    const kind = benchmarkCommandKind(args);
    if (
      cached &&
      cached.phase === currentPhase &&
      cached.arguments === JSON.stringify(args) &&
      body === undefined &&
      kind === "factorybox:capacity"
    ) {
      const result = cached.result;
      cached = undefined;
      return result;
    }
    cached = undefined;
    if (!currentPhase.endsWith(":pause") || kind !== "factorybox:worker-status")
      return command(args, body, limits);
    const index = args.indexOf(factoryboxExecutable);
    if (index < 0 || !args.slice(0, index).includes("exec")) return command(args, body, limits);
    const expected = identity();
    const result = await command(
      [
        ...args.slice(0, index + 1),
        "--worker-run-root",
        "/run/factorybox",
        "--worker-store-id",
        expected.storeID,
        "--worker-epoch",
        expected.epoch,
        "--include-worker-status",
        "capacity",
      ],
      body,
      limits,
    );
    if (result.exitCode !== 0) return result;
    const envelope = JSON.parse(result.stdout) as {
      schema: number;
      worker: {
        store_id: string;
        epoch: string;
        boot_id: string;
        supervisor_sha256: string;
        lifecycle: { root: string };
      };
      capacity: { root: string };
    };
    if (
      envelope.schema !== 1 ||
      envelope.worker?.store_id !== expected.storeID ||
      envelope.worker?.epoch !== expected.epoch ||
      envelope.worker?.boot_id !== expected.bootID ||
      envelope.worker?.supervisor_sha256 !== expected.executableSHA256 ||
      envelope.worker?.lifecycle?.root !== expected.controllerRoot ||
      envelope.capacity?.root !== expected.controllerRoot
    )
      throw new Error("Combined benchmark preflight belongs to another worker or controller");
    cached = {
      phase: currentPhase,
      arguments: JSON.stringify([
        ...args.slice(0, index + 1),
        "--worker-run-root",
        "/run/factorybox",
        "--worker-store-id",
        expected.storeID,
        "--worker-epoch",
        expected.epoch,
        "capacity",
      ]),
      result: { ...result, stdout: JSON.stringify(envelope.capacity) },
    };
    return { ...result, stdout: JSON.stringify(envelope.worker) };
  };
}
