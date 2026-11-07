// Native lifecycle measurements, not a provider speed ranking. The existing
// conformance adapter owns admission, exact identities, deadlines and cleanup.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, release } from "node:os";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { type LifecycleSample, summarizeLifecycle } from "./benchmark-model";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/runtime-benchmark", owner);
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
const runtime = createConformanceRuntime(
  owner,
  image,
  profile,
  await readRuntimeRegistryCA(),
  directory,
);
const samples: LifecycleSample[] = [];
const run = async (args: string[]) => {
  const result = await runCommand(runtime.execArgs(args), undefined, {
    timeoutMS: 180_000,
    outputBytes: 1 << 20,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || "Benchmark command failed");
  return result.stdout.trim();
};
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
let containerID = "";
const probe = async () =>
  JSON.parse(
    await run([
      "docker",
      "exec",
      containerID,
      "node",
      "-e",
      "fetch('http://localhost:4301/state').then(r=>{if(!r.ok)throw Error('health');return r.text()}).then(console.log)",
    ]),
  ) as { pid: number; startedAt: number; marker: string; requests: number; memoryMiB: number };
const waitHealthy = async () => {
  const until = performance.now() + 30_000;
  let failure: unknown;
  while (performance.now() < until) {
    try {
      return await probe();
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
    const memory=crypto.randomFillSync(Buffer.alloc(256*1024*1024));
    const startedAt=Date.now(),marker=crypto.createHash('sha256').update(memory).digest('hex');
    let requests=0;
    http.createServer((req,res)=>{
      if(req.url!='/state'){res.writeHead(404);res.end();return;}
      const actual=crypto.createHash('sha256').update(memory).digest('hex');
      if(actual!==marker){res.writeHead(500);res.end('memory changed');return;}
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({pid:process.pid,startedAt,marker,requests:++requests,memoryMiB:256}));
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
    randomMemoryMiB: 256,
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
    const pauseStarted = performance.now();
    const capture = await runtime.pause();
    const pauseMS = performance.now() - pauseStarted;
    const resumeStarted = performance.now();
    await runtime.resume(runtime.target().input.sandboxID, capture.snapshotID);
    const current = await waitHealthy();
    const resumeToHealthyMS = performance.now() - resumeStarted;
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
      beforeAnonBytes: capture.paused.record.pause.before.anon,
      afterAnonBytes: capture.paused.record.pause.after.anon,
      preserved,
    };
    samples.push(sample);
    await save(`cycle-${cycle}.json`, { cycle, ...sample, state: current });
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
  await runtime.cleanup();
}
await save("result.json", { passed: true, ...summarizeLifecycle(samples), runs: samples });
console.log(JSON.stringify({ evidence: directory, ...summarizeLifecycle(samples) }));
