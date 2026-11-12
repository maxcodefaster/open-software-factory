// A controlled read-only transport experiment. The existing conformance adapter
// still owns exact worker admission, the native deadline and resource cleanup.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { percentile } from "./benchmark-model";
import { factoryboxExecutable } from "./benchmark-profile";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/preflight-benchmark", owner);
const image = process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"];
if (!image || !/@sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Pinned runtime image is required");
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const runtime = createConformanceRuntime(
  owner,
  image,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  directory,
);
const samples: { combined: boolean; elapsedMS: number; calls: number }[] = [];
try {
  await runtime.prepare();
  const { input, identity } = runtime.target();
  const prefix = [
    "exec",
    input.podName,
    "-n",
    input.namespace,
    "-c",
    "worker",
    "--",
    factoryboxExecutable,
  ];
  const pinned = [
    "--worker-run-root",
    "/run/factorybox",
    "--worker-store-id",
    identity.storeID,
    "--worker-epoch",
    identity.epoch,
  ];
  const invoke = async (args: string[]) => {
    const response = await runCommand(kubernetesCommand([...prefix, ...args]), undefined, {
      timeoutMS: 15_000,
      outputBytes: 32_768,
    });
    if (response.exitCode !== 0) throw new Error("Read-only preflight failed");
    return JSON.parse(response.stdout);
  };
  const verify = (
    worker: { store_id: string; epoch: string; supervisor_sha256: string },
    capacity: { root: string; new_write_admitted: boolean },
  ) => {
    if (
      worker.store_id !== identity.storeID ||
      worker.epoch !== identity.epoch ||
      worker.supervisor_sha256 !== identity.executableSHA256 ||
      capacity.root !== identity.controllerRoot ||
      !capacity.new_write_admitted
    )
      throw new Error("Preflight changed its original worker or write admission");
  };
  await save("preflight-intent.json", {
    identity,
    order: "Ten ABBA blocks; 20 measurements per mode",
    scope: "Read-only worker-status and capacity, not pause or App startup",
    profiling: false,
  });
  for (let block = 0; block < 10; block++)
    for (const combined of [false, true, true, false]) {
      const started = performance.now();
      if (combined) {
        const result = await invoke([...pinned, "--include-worker-status", "capacity"]);
        verify(result.worker, result.capacity);
      } else {
        const worker = await invoke(["worker-status"]);
        const capacity = await invoke([...pinned, "capacity"]);
        verify(worker, capacity);
      }
      samples.push({ combined, elapsedMS: performance.now() - started, calls: combined ? 1 : 2 });
    }
  await save("samples.json", samples);
  await runtime.passed();
} finally {
  await runtime.cleanup();
}
const summary = (combined: boolean) => {
  const values = samples
    .filter((sample) => sample.combined === combined)
    .map((sample) => sample.elapsedMS);
  return {
    samples: values.length,
    medianMS: percentile(values, 0.5),
    meanMS: values.reduce((total, value) => total + value, 0) / values.length,
  };
};
await save("result.json", {
  passed: true,
  baseline: summary(false),
  combined: summary(true),
  scope: "Controlled local read-only preflight only; not end-to-end or AKS qualification",
});
console.log(
  JSON.stringify({
    evidence: directory,
    passed: true,
    baseline: summary(false),
    combined: summary(true),
  }),
);
