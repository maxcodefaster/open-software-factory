// Native lifecycle measurements, not a provider speed ranking. The existing
// conformance adapter owns admission, exact identities, deadlines and cleanup.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { exportBenchmarkPages } from "./benchmark-export";
import { type LifecycleSample, summarizeLifecycle } from "./benchmark-model";
import { combinedBenchmarkPreflight } from "./benchmark-preflight";
import { benchmarkCommandKind, benchmarkMemoryMiB, profiledArguments } from "./benchmark-profile";
import { benchmarkResources } from "./benchmark-resources";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/runtime-benchmark", owner);
const profiling = process.env["FACTORY_BENCHMARK_PROFILE"] === "1";
const readyProbe = process.env["FACTORY_BENCHMARK_READY_PROBE"] === "1";
const batchPreflight = process.env["FACTORY_BENCHMARK_BATCH_PREFLIGHT"] === "1";
const exportPages = process.env["FACTORY_BENCHMARK_EXPORT_PAGES"];
const memoryMiB = benchmarkMemoryMiB(process.env["FACTORY_BENCHMARK_MEMORY_MIB"]);
let phase = "admission";
const commandTimings: {
  phase: string;
  kind: string;
  elapsedMS: number;
  exitCode?: number;
  failed: boolean;
}[] = [];
const timedCommand: typeof runCommand = async (args, body, limits) => {
  if (!profiling) return runCommand(args, body, limits);
  const started = performance.now();
  const observed = { phase, kind: benchmarkCommandKind(args) };
  try {
    const result = await runCommand(profiledArguments(args, true), body, limits);
    commandTimings.push({
      ...observed,
      elapsedMS: performance.now() - started,
      exitCode: result.exitCode,
      failed: result.exitCode !== 0,
    });
    return result;
  } catch (cause) {
    commandTimings.push({ ...observed, elapsedMS: performance.now() - started, failed: true });
    throw cause;
  }
};
const cycles = Number(process.env["FACTORY_BENCHMARK_CYCLES"] ?? 10);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 20)
  throw new Error(
    "FACTORY_BENCHMARK_CYCLES must be 1–20; the native 420-second bound still applies",
  );
const image = (
  process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"] ??
  (await readFile(resolve(root, ".factory/runtime-host-image"), "utf8"))
).trim();
if (!/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Benchmark requires a digest-pinned runtime image");
const profile = configuredFactoryboxRuntimeProfile();
await mkdir(directory, { recursive: true });
const commandRunner: typeof runCommand = combinedBenchmarkPreflight(
  batchPreflight,
  () => phase,
  () => runtime.target().identity,
  timedCommand,
);
const runtime = createConformanceRuntime(
  owner,
  image,
  profile,
  await readRuntimeRegistryCA(),
  directory,
  undefined,
  commandRunner,
);
const samples: LifecycleSample[] = [];
const run = async (args: string[]) => {
  const result = await commandRunner(runtime.execArgs(args), undefined, {
    timeoutMS: 180_000,
    outputBytes: 1 << 20,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Benchmark command failed");
  return result.stdout.trim();
};
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
let containerID = "";
const probe = async (ready = false) =>
  JSON.parse(
    await run([
      "docker",
      "exec",
      containerID,
      "node",
      "-e",
      `fetch('http://localhost:4301/${ready ? "ready" : "state"}').then(r=>{if(!r.ok)throw Error('health');return r.text()}).then(console.log)`,
    ]),
  ) as { pid: number; startedAt: number; marker: string; requests: number; memoryMiB: number };
const waitHealthy = async (ready = false) => {
  const until = performance.now() + 30_000;
  let failure: unknown;
  while (performance.now() < until) {
    try {
      return await probe(ready);
    } catch (cause) {
      failure = cause;
      await Bun.sleep(200);
    }
  }
  throw failure ?? new Error("App did not answer its health check");
};

try {
  const admissionStarted = performance.now();
  await runtime.prepare();
  await run(["docker", "info"]);
  const admissionMS = performance.now() - admissionStarted;
  const fixture = resolve(root, "test/fixtures/runtime-project");
  const workspace = "/home/coder/runtime-project";
  await run(["mkdir", "-p", workspace]);
  await run(["chown", "1000:1000", workspace]);
  const tar = Bun.spawn(["tar", "-C", fixture, "-cf", "-", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const extract = Bun.spawn(
    runtime.execArgs(["tar", "-C", workspace, "-xf", "-"], true, "1000:1000"),
    {
      stdin: tar.stdout,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [tarStatus, extractStatus, tarError, extractError] = await Promise.all([
    tar.exited,
    extract.exited,
    new Response(tar.stderr).text(),
    new Response(extract.stderr).text(),
  ]);
  if (tarStatus || extractStatus)
    throw new Error(`Fixture copy failed: ${tarError} ${extractError}`);
  const appStarted = performance.now();
  phase = "app-setup";
  const output = await run([
    "devcontainer",
    "up",
    "--workspace-folder",
    workspace,
    "--config",
    `${workspace}/.devcontainer/devcontainer.json`,
    "--log-format",
    "json",
  ]);
  const result = output
    .split("\n")
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((line) => line?.outcome === "success");
  if (!/^[a-f0-9]{64}$/.test(result?.containerId ?? ""))
    throw new Error("No primary Dev Container");
  containerID = result.containerId;
  // Random memory prevents a compressible zero buffer from making capture
  // look unrealistically cheap. Requests verify the same process and state.
  await run([
    "docker",
    "exec",
    "-d",
    containerID,
    "node",
    "-e",
    `
    const crypto=require('node:crypto'),http=require('node:http');
    const memory=crypto.randomFillSync(Buffer.alloc(${memoryMiB}*1024*1024));
    const startedAt=Date.now(),marker=crypto.createHash('sha256').update(memory).digest('hex');
    let requests=0;
    http.createServer((req,res)=>{
      if(req.url!='/state'&&req.url!='/ready'){res.writeHead(404);res.end();return;}
      if(req.url==='/state'){
        const actual=crypto.createHash('sha256').update(memory).digest('hex');
        if(actual!==marker){res.writeHead(500);res.end('memory changed');return;}
      }
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({pid:process.pid,startedAt,marker,requests:++requests,memoryMiB:${memoryMiB}}));
    }).listen(4301,'0.0.0.0');
  `,
  ]);
  const initial = await waitHealthy();
  const appStartupMS = performance.now() - appStarted;
  const containerIdentities = await run(["docker", "ps", "--no-trunc", "--format", "{{.ID}}"]);
  await save("configuration.json", {
    sourceCommit: (await runCommand(["git", "-C", root, "rev-parse", "HEAD"])).stdout.trim(),
    benchmarkScriptSHA256: createHash("sha256")
      .update(await readFile(import.meta.path))
      .digest("hex"),
    measuredAt: new Date().toISOString(),
    platform: `linux/${profile.architecture}`,
    nodeArchitecture: arch(),
    kernel: release(),
    worker: profile,
    runtimeImage: image,
    fixture: "test/fixtures/runtime-project",
    cycles,
    randomMemoryMiB: memoryMiB,
    ...(exportPages
      ? {
          snapshotExport:
            "Owned RAM-image export outside timing; diagnostic run, not a speed comparison",
        }
      : {}),
    ...(batchPreflight
      ? { batchPreflight: "Combined read-only worker/capacity preflight before unchanged pause" }
      : {}),
    ...(readyProbe
      ? {
          readyProbe:
            "Separate lightweight App-ready request before full memory integrity probe; compare only matching probe modes",
        }
      : {}),
    ...(profiling ? { profiling: "Opt-in phase traces; attribution run, not a speed claim" } : {}),
    timing:
      "Host monotonic time, including Kubernetes exec transport; resume ends after a successful App state probe",
    cache:
      "One newly admitted worker; repeated pause/resume on the same warmed environment; no host image cache purge",
    admissionMS,
    appStartupMS,
    initial,
  });
  let previous = initial;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    phase = `cycle-${cycle}:sample-before`;
    const resourcesBefore = profiling
      ? await benchmarkResources(runtime.target(), timedCommand)
      : null;
    phase = `cycle-${cycle}:pause`;
    const pauseStarted = performance.now();
    const capture = await runtime.pause();
    const pauseMS = performance.now() - pauseStarted;
    phase = `cycle-${cycle}:sample-paused`;
    const resourcesPaused = profiling
      ? await benchmarkResources(runtime.target(), timedCommand)
      : null;
    if (exportPages && cycle === 1) {
      phase = `cycle-${cycle}:export`;
      await exportBenchmarkPages(runtime.target(), capture.snapshotID, exportPages);
    }
    phase = `cycle-${cycle}:resume`;
    const resumeStarted = performance.now();
    await runtime.resume(runtime.target().input.sandboxID, capture.snapshotID);
    let resumeToReadyMS: number | undefined;
    if (readyProbe) {
      const ready = await waitHealthy(true);
      resumeToReadyMS = performance.now() - resumeStarted;
      if (ready.pid !== initial.pid || ready.startedAt !== initial.startedAt)
        throw new Error("App-ready response belongs to another process");
    }
    const current = await waitHealthy();
    const resumeToHealthyMS = performance.now() - resumeStarted;
    phase = `cycle-${cycle}:sample-after`;
    const resourcesAfter = profiling
      ? await benchmarkResources(runtime.target(), timedCommand)
      : null;
    phase = `cycle-${cycle}:verify`;
    const identities = await run(["docker", "ps", "--no-trunc", "--format", "{{.ID}}"]);
    const preserved =
      identities === containerIdentities &&
      current.pid === initial.pid &&
      current.startedAt === initial.startedAt &&
      current.marker === initial.marker &&
      current.requests > previous.requests;
    const sample = {
      pauseMS,
      resumeToHealthyMS,
      ...(resumeToReadyMS === undefined ? {} : { resumeToReadyMS }),
      beforeAnonBytes: capture.paused.record.pause.before.anon,
      afterAnonBytes: capture.paused.record.pause.after.anon,
      preserved,
    };
    samples.push(sample);
    await save(`cycle-${cycle}.json`, { cycle, ...sample, state: current });
    if (profiling)
      await save(`resources-${cycle}.json`, {
        before: resourcesBefore,
        paused: resourcesPaused,
        after: resourcesAfter,
      });
    console.log(JSON.stringify({ cycle, ...sample }));
    if (!preserved)
      throw new Error("Resume changed the running process, memory, counters or container identity");
    previous = current;
  }
  await run([
    "docker",
    "compose",
    "--project-name",
    "runtime-project_devcontainer",
    "--file",
    `${workspace}/.devcontainer/compose.yaml`,
    "down",
    "--volumes",
    "--remove-orphans",
  ]);
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Benchmark failed",
    samples,
  });
  throw cause;
} finally {
  phase = "cleanup";
  try {
    await runtime.cleanup();
  } finally {
    if (profiling) await save("command-timings.json", commandTimings);
  }
}
await save("result.json", { passed: true, ...summarizeLifecycle(samples), runs: samples });
console.log(JSON.stringify({ evidence: directory, ...summarizeLifecycle(samples) }));
