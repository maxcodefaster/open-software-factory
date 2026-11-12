// Pinned public repository in the maintained Dev Container. No provider ranking,
// personal configuration, model calls or production template promotion.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand, runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { loggedBenchmarkCommand } from "./benchmark-command";
import { createConformanceRuntime } from "./factorybox-conformance";
import { projectStateProbeArguments } from "./project-probe";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/project-benchmark", owner);
await mkdir(directory, { recursive: true });
const home = resolve(directory, "empty-home");
await mkdir(home, { mode: 0o700 });
const commit = "f15d4eaba03d86786bec2de7aed1236718c813f9";
const dnsOrder = process.env["FACTORY_PROJECT_BENCHMARK_DNS_ORDER"];
if (dnsOrder !== undefined && dnsOrder !== "ipv4first")
  throw new Error(
    "Project DNS experiment accepts only explicit ipv4first or the unchanged default",
  );
const nodeEnvironment = dnsOrder ? ["--env", "NODE_OPTIONS=--dns-result-order=ipv4first"] : [];
const source = resolve(directory, "fastify");
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const deadline = performance.now() + 420_000;
const limits = () => ({
  timeoutMS: Math.max(1, Math.min(180_000, deadline - performance.now())),
  outputBytes: 4 * 1024 ** 2,
});
await save("project-intent.json", {
  repository: "https://github.com/fastify/fastify.git",
  commit,
  tag: "v5.6.2",
  resourceShape: "3 CPU / 3 GiB",
  fixture: "test/fixtures/runtime-project",
  personalConfiguration: false,
  dnsOrder: dnsOrder ?? "default",
  modelCalls: false,
});
const cloneStarted = performance.now();
const gitEnvironment = {
  PATH: process.env["PATH"],
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const cloned = await runEnvironmentCommand(
  [
    "git",
    "clone",
    "--depth=1",
    "--branch=v5.6.2",
    "--single-branch",
    "--",
    "https://github.com/fastify/fastify.git",
    source,
  ],
  gitEnvironment,
  limits(),
);
await save("clone.json", { ...cloned, elapsedMS: performance.now() - cloneStarted });
if (cloned.exitCode !== 0) throw new Error("Pinned public clone failed");
const revision = await runEnvironmentCommand(
  ["git", "-C", source, "rev-parse", "HEAD"],
  gitEnvironment,
  limits(),
);
if (revision.stdout.trim() !== commit)
  throw new Error("Public project tag moved from its pinned commit");
const image = process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"];
if (!image) throw new Error("Pinned runtime image is required");
const runtime = createConformanceRuntime(
  owner,
  image,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  directory,
);
let containerID = "";
const stages: { name: string; elapsedMS: number }[] = [];
const run = async (args: string[]) => {
  if (performance.now() >= deadline)
    throw new Error("Project workload exceeded its original 420-second deadline");
  const result = await runCommand(runtime.execArgs(args), undefined, limits());
  if (result.exitCode !== 0) throw new Error(result.stderr || "Project command failed");
  return result.stdout.trim();
};
const copy = async (from: string, to: string) => {
  await run(["mkdir", "-p", to]);
  await run(["chown", "1000:1000", to]);
  const tar = Bun.spawn(["tar", "-C", from, "-cf", "-", "."], { stdout: "pipe", stderr: "pipe" });
  const extract = Bun.spawn(runtime.execArgs(["tar", "-C", to, "-xf", "-"], true, "1000:1000"), {
    stdin: tar.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [left, right, leftError, rightError] = await Promise.all([
    tar.exited,
    extract.exited,
    new Response(tar.stderr).text(),
    new Response(extract.stderr).text(),
  ]);
  if (left || right) throw new Error(`Owned fixture copy failed: ${leftError} ${rightError}`);
};
const projectCommand = async (name: string, command: string[]) => {
  const started = performance.now();
  await save(`${name}-intent.json`, { command, originalDeadline: "420-second project workload" });
  const result = await loggedBenchmarkCommand(
    runtime.execArgs([
      "docker",
      "exec",
      "--user",
      "1000:1000",
      ...nodeEnvironment,
      "--workdir",
      "/workspace/project/fastify",
      containerID,
      ...command,
    ]),
    directory,
    name,
    { timeoutMS: Math.max(1, deadline - performance.now()), outputBytes: 4 * 1024 ** 2 },
  );
  const elapsedMS = performance.now() - started;
  await save(`${name}.json`, { command, ...result, elapsedMS });
  if (result.exitCode !== 0)
    throw new Error(`Public project ${name} failed; original output retained`);
  stages.push({ name, elapsedMS });
  return result.stdout.trim();
};
const probeArgs = () => projectStateProbeArguments(containerID, nodeEnvironment);
try {
  const admitted = performance.now();
  await runtime.prepare();
  stages.push({ name: "worker-admission", elapsedMS: performance.now() - admitted });
  const workspace = "/home/coder/runtime-project";
  await copy(resolve(root, "test/fixtures/runtime-project"), workspace);
  await copy(source, `${workspace}/fastify`);
  const setup = performance.now();
  const cli = await run([
    "devcontainer",
    "up",
    "--workspace-folder",
    workspace,
    "--config",
    `${workspace}/.devcontainer/devcontainer.json`,
    "--log-format",
    "json",
  ]);
  const result = cli
    .split("\n")
    .reverse()
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .find((value) => value.outcome === "success");
  if (!/^[a-f0-9]{64}$/.test(result?.containerId ?? ""))
    throw new Error("No approved primary Dev Container");
  containerID = result.containerId;
  stages.push({ name: "devcontainer-up", elapsedMS: performance.now() - setup });
  await projectCommand("node-version", ["node", "--version"]);
  await projectCommand("npm-version", ["npm", "--version"]);
  await projectCommand("dependencies", [
    "npm",
    "install",
    "--package-lock=true",
    "--no-audit",
    "--no-fund",
  ]);
  const lockSHA256 = await projectCommand("dependency-lock", [
    "node",
    "-e",
    "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('package-lock.json')).digest('hex'))",
  ]);
  await projectCommand("lint", ["npm", "run", "lint"]);
  await projectCommand("unit", ["npm", "run", "unit"]);
  await projectCommand("types", ["npm", "run", "test:typescript"]);
  await projectCommand("build", ["npm", "run", "build:validation"]);
  await run([
    "docker",
    "exec",
    ...nodeEnvironment,
    "--workdir",
    "/workspace/project/fastify",
    "-d",
    containerID,
    "node",
    "-e",
    `
const crypto=require('node:crypto'),app=require('./')();
const memory=crypto.randomBytes(64*1024*1024),startedAt=Date.now(),marker=crypto.createHash('sha256').update(memory).digest('hex');let requests=0;
app.get('/state',async()=>{if(crypto.createHash('sha256').update(memory).digest('hex')!==marker)throw Error('memory');return {pid:process.pid,startedAt,marker,requests:++requests};});
app.listen({port:4321,host:'0.0.0.0'}).catch(e=>{console.error(e);process.exit(1)});`,
  ]);
  let initial: { pid: number; startedAt: number; marker: string; requests: number } | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      initial = JSON.parse(await run(probeArgs()));
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!initial) throw new Error("Public Fastify App did not answer its full state probe");
  const coldProjectReadyMS = performance.now() - setup;
  await save("configuration.json", {
    repositoryCommit: commit,
    dnsOrder: dnsOrder ?? "default",
    lockSHA256,
    worker: configuredFactoryboxRuntimeProfile(),
    runtimeImage: image,
    stages,
    coldProjectReadyMS,
    firstState: initial,
    scope:
      "Public Fastify library workload, not an enterprise or provider suite; no database in this fixture",
  });
  const capture = await runtime.pause();
  const forkStarted = performance.now();
  const fork = await runtime.fork(crypto.randomUUID(), capture.snapshotID);
  const childArgs = (args: string[]) =>
    runtime.execArgs(args, false, undefined, fork.input.sandboxID);
  const forkProbe = await runCommand(childArgs(probeArgs()), undefined, limits());
  if (forkProbe.exitCode !== 0) throw new Error("Prepared public-project fork did not answer");
  const continued = JSON.parse(forkProbe.stdout);
  const preparedForkToReadyMS = performance.now() - forkStarted;
  if (
    continued.pid !== initial.pid ||
    continued.startedAt !== initial.startedAt ||
    continued.marker !== initial.marker ||
    continued.requests <= initial.requests
  )
    throw new Error("Prepared public-project fork changed its preserved process or memory");
  await save("prepared-activation.json", {
    passed: true,
    coldProjectReadyMS,
    preparedForkToReadyMS,
    processAndMemoryPreserved: true,
    scope: "Activation substep only; independent write and full cleanup still required",
  });
  const marker = await runCommand(
    childArgs([
      "docker",
      "exec",
      "--user",
      "1000:1000",
      containerID,
      "node",
      "-e",
      "require('node:fs').writeFileSync('/workspace/project/fork-only-marker','owned fork')",
    ]),
    undefined,
    limits(),
  );
  await save("fork-private-write.json", marker);
  if (marker.exitCode !== 0) throw new Error("Fork's private write failed");
  await runtime.pause(fork.input.sandboxID);
  await runtime.resume(runtime.target().input.sandboxID, capture.snapshotID);
  await run([
    "docker",
    "exec",
    containerID,
    "node",
    "-e",
    "if(require('node:fs').existsSync('/workspace/project/fork-only-marker'))process.exit(1)",
  ]);
  const resumed = JSON.parse(await run(probeArgs()));
  if (resumed.marker !== initial.marker || resumed.startedAt !== initial.startedAt)
    throw new Error("Source App changed after independent fork");
  await save("project-result.json", {
    passed: true,
    coldProjectReadyMS,
    preparedForkToReadyMS,
    stages,
    statePreserved: true,
    sourceAndForkIndependent: true,
    noAgentRAM: true,
    scope:
      "One prepared activation proof, not a latency distribution; no product template automatically promoted",
  });
  await runtime.passed();
} catch (cause) {
  await save("project-failure.json", {
    error: cause instanceof Error ? cause.message : "Public project proof failed",
    stages,
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed: true,
  scope:
    "Pinned public project checks, independent prepared fork and confirmed owned cleanup; not AKS qualification",
});
console.log(JSON.stringify({ evidence: directory, passed: true }));
