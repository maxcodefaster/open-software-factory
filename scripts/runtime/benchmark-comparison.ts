// Independent, serial A/B/B/A trials. Every child benchmark owns its namespace,
// native deadline, operation identities, integrity checks and failure retention.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { percentile } from "./benchmark-model";

const root = resolve(import.meta.dir, "../..");
const directory = resolve(
  root,
  ".factory/test-results/runtime-performance-comparison",
  crypto.randomUUID(),
);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const benchmark = resolve(import.meta.dir, "benchmark.ts");
const source = createHash("sha256")
  .update(await readFile(benchmark))
  .digest("hex");
const order = [false, true, true, false];
await save("intent.json", {
  order: ["baseline", "combined", "combined", "baseline"],
  benchmarkSHA256: source,
  workerImage: process.env["FACTORY_FACTORYBOX_WORKER_IMAGE"],
  executableSHA256: process.env["FACTORY_FACTORYBOX_EXECUTABLE_SHA256"],
  cycles: 10,
  memoryMiB: 256,
  profiling: false,
  readyProbe: false,
  cache: "Fresh worker for each trial; no host image-cache purge; serial ABBA order",
  timing: "Unchanged full memory-integrity App probe, including Kubernetes transport",
});
const trials: {
  combined: boolean;
  evidence: string;
  runs: {
    pauseMS: number;
    resumeToHealthyMS: number;
    preserved: boolean;
    afterAnonBytes: number;
  }[];
}[] = [];
console.log(
  JSON.stringify({
    comparison: directory,
    order: ["baseline", "combined", "combined", "baseline"],
  }),
);
for (const [index, combined] of order.entries()) {
  if (
    createHash("sha256")
      .update(await readFile(benchmark))
      .digest("hex") !== source
  )
    throw new Error("Benchmark source changed between comparison trials");
  const child = Bun.spawn([process.execPath, benchmark], {
    cwd: root,
    env: {
      ...process.env,
      FACTORY_BENCHMARK_CYCLES: "10",
      FACTORY_BENCHMARK_MEMORY_MIB: "256",
      FACTORY_BENCHMARK_PROFILE: "0",
      FACTORY_BENCHMARK_READY_PROBE: "0",
      FACTORY_BENCHMARK_BATCH_PREFLIGHT: combined ? "1" : "0",
      FACTORY_BENCHMARK_EXPORT_PAGES: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await save(`trial-${index + 1}.json`, { combined, exitCode, stdout, stderr });
  if (exitCode !== 0) {
    await save("result.json", { passed: false, failedTrial: index + 1, trials });
    throw new Error(
      `Comparison trial ${index + 1} failed; original native evidence remains retained`,
    );
  }
  const receipt = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { evidence: string };
  const evidence = resolve(receipt.evidence);
  if (!evidence.startsWith(`${resolve(root, ".factory/test-results/runtime-benchmark")}/`))
    throw new Error("Comparison benchmark receipt left the owned evidence tree");
  const result = JSON.parse(await readFile(resolve(evidence, "result.json"), "utf8"));
  const configuration = JSON.parse(await readFile(resolve(evidence, "configuration.json"), "utf8"));
  const cleanup = JSON.parse(await readFile(resolve(evidence, "cleanup.json"), "utf8"));
  if (
    configuration.benchmarkScriptSHA256 !== source ||
    configuration.worker.image !== process.env["FACTORY_FACTORYBOX_WORKER_IMAGE"] ||
    configuration.worker.executableSHA256 !== process.env["FACTORY_FACTORYBOX_EXECUTABLE_SHA256"] ||
    configuration.randomMemoryMiB !== 256 ||
    Boolean(configuration.batchPreflight) !== combined ||
    configuration.profiling !== undefined ||
    configuration.readyProbe !== undefined ||
    configuration.snapshotExport !== undefined ||
    cleanup.absenceConfirmed !== true
  )
    throw new Error("Comparison trial changed its inputs, timing mode or confirmed cleanup");
  if (
    !result.passed ||
    result.samples !== 10 ||
    result.successfulRestores !== 10 ||
    !result.anonymousRAMReleased
  )
    throw new Error("Comparison trial did not retain all required state and memory assertions");
  trials.push({ combined, evidence, runs: result.runs });
  await save("progress.json", { completedTrials: trials.length, trials });
  console.log(
    JSON.stringify({
      trial: index + 1,
      combined,
      evidence,
      samples: result.samples,
      pauseMedianMS: result.pause.medianMS,
      resumeMedianMS: result.resumeToHealthy.medianMS,
    }),
  );
}
const summary = (combined: boolean) => {
  const runs = trials.filter((trial) => trial.combined === combined).flatMap((trial) => trial.runs);
  return {
    samples: runs.length,
    pauseMedianMS: percentile(
      runs.map((run) => run.pauseMS),
      0.5,
    ),
    pauseMeanMS: runs.reduce((total, run) => total + run.pauseMS, 0) / runs.length,
    resumeMedianMS: percentile(
      runs.map((run) => run.resumeToHealthyMS),
      0.5,
    ),
    preserved: runs.every((run) => run.preserved && run.afterAnonBytes === 0),
  };
};
await save("result.json", {
  passed: true,
  baseline: summary(false),
  combined: summary(true),
  trials,
  qualification:
    "Local same-shape comparison only; not AKS or release qualification; no stable tail claim",
});
console.log(
  JSON.stringify({
    evidence: directory,
    passed: true,
    baseline: summary(false),
    combined: summary(true),
  }),
);
