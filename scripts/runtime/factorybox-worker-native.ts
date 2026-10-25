// Explicit native transport contract proof. Kubernetes observations are fixtures;
// all worker-status/lifecycle commands execute the actual owned Docker worker.
import assert from "node:assert/strict";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import {
  executeFactoryboxOperation,
  factoryboxWorkerRequest,
  inspectFactoryboxWorker,
  renderFactoryboxWorker,
  type FactoryboxOperation,
} from "../../packages/runtime-kubernetes/src/factorybox-worker";

const file = process.argv[2];
if (!file) throw new Error("Native Factorybox transport proof requires its owned fixture file");
const input = await Bun.file(file).json();
const request = factoryboxWorkerRequest.parse(input.request);
const docker = input.docker as string[];
const container = input.containerID as string;
if (!/^[a-f0-9]{64}$/.test(container) || !Array.isArray(docker) || !docker.includes("docker"))
  throw new Error("Native proof requires an exact container ID and explicit Docker command");
const inspected = await runCommand([...docker, "inspect", container]);
assert.equal(inspected.exitCode, 0);
const actual = JSON.parse(inspected.stdout)[0];
assert.equal(actual.Id, container);
assert.equal(actual.Config.Labels["com.factorybox.run"], request.storeID);
assert.equal(actual.HostConfig.Memory, 3 * 1024 ** 3);
assert.equal(actual.HostConfig.NanoCpus, 3_000_000_000);
assert.equal(actual.HostConfig.CgroupnsMode, "private");
const rendered = renderFactoryboxWorker(request);
const metadata = (index: 0 | 1 | 2, uid: string) => ({ ...rendered[index].metadata, uid });
const resources: Record<string, unknown> = {
  namespace: { ...rendered[0], metadata: metadata(0, "native-fixture-namespace") },
  pvc: {
    ...rendered[1],
    metadata: metadata(1, "native-fixture-claim"),
    status: { phase: "Bound" },
  },
  pod: {
    ...rendered[2],
    metadata: metadata(2, container),
    spec: { ...rendered[2].spec, nodeName: request.nodeName },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "worker", restartCount: 0, ready: true }],
    },
  },
  node: {
    metadata: { name: request.nodeName },
    status: {
      nodeInfo: {
        operatingSystem: "linux",
        architecture: "amd64",
        kernelVersion: request.kernel,
        bootID: input.bootID,
      },
    },
  },
};
const calls: string[][] = [];
const transport: typeof runCommand = async (args, stdin, limits) => {
  if (args[0] === "get") {
    const value = resources[args[1] ?? ""];
    assert.ok(value);
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  }
  assert.deepEqual(args.slice(0, 8), [
    "exec",
    request.podName,
    "-n",
    request.namespace,
    "-c",
    "worker",
    "--",
    "/opt/factorybox/factorybox",
  ]);
  calls.push([...args]);
  return runCommand([...docker, "exec", container, ...args.slice(7)], stdin, limits);
};
const identity = await inspectFactoryboxWorker(request, undefined, transport);
const steps: Array<{ operation: FactoryboxOperation; seconds: number; output: unknown }> = [];
async function operate(operation: FactoryboxOperation) {
  const started = performance.now();
  const result = await executeFactoryboxOperation(request, identity, operation, transport);
  assert.equal(result.confirmed, true, result.stderr);
  const output = JSON.parse(result.stdout);
  steps.push({ operation, seconds: (performance.now() - started) / 1000, output });
  return output;
}
async function actor(pid: number, marker?: string) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const script = `import http.client,json,socket,sys,time
path='/proc/'+sys.argv[1]+'/root/workspace/.minimal.sock'
deadline=time.monotonic()+5
while True:
 try:
  connection=http.client.HTTPConnection('localhost',timeout=5)
  connection.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  connection.sock.connect(path)
  break
 except OSError:
  if time.monotonic()>deadline: raise
  time.sleep(.05)
marker=sys.argv[2]
connection.request('POST' if marker else 'GET','/',body=json.dumps({'marker':marker}) if marker else None)
response=connection.getresponse()
assert response.status==200,response.status
print(response.read().decode())
`;
  const result = await runCommand([
    ...docker,
    "exec",
    container,
    "python3",
    "-c",
    script,
    String(pid),
    marker ?? "",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const sandboxID = `owned-${request.storeID.slice(0, 12)}`;
const started = await operate({
  action: "start",
  sandboxID,
  bundle: "/var/lib/sysbox/fixed-store/data/store/input/bundle",
});
const first = await actor(started.runtime.pid);
assert.equal(first.counter, 0);
const changed = await actor(started.runtime.pid, "native-factorybox-adapter");
assert.equal(changed.counter, 1);
assert.notEqual(changed.ram_sha256, first.ram_sha256);
const snapshotID = "8".repeat(32);
const paused = await operate({ action: "pause", sandboxID, snapshotID });
assert.equal(paused.record.pause.after.anon, 0);
assert.equal(paused.record.pause.snapshot.resident_bytes_after, 0);
const resumed = await operate({ action: "resume", sandboxID, snapshotID });
const after = await actor(resumed.runtime.pid);
assert.deepEqual(after, changed);
const replay = await operate({ action: "resume", sandboxID, snapshotID });
assert.equal(replay.runtime.pid, resumed.runtime.pid);
await operate({ action: "delete", sandboxID });
console.log(
  JSON.stringify({
    passed: true,
    kubernetesQualified: false,
    sourceContract: "private-store-only",
    identity,
    first,
    changed,
    after,
    steps,
    calls,
  }),
);
