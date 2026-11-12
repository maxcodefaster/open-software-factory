// Deliberate fault in an exactly owned fixture image. Native refusal must happen
// before attempted restore; repair only the one known byte and retain the request.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import {
  configuredFactoryboxRuntimeProfile,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
} from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { executeFactoryboxOperation } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/resume-integrity", owner);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const image = process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"];
if (!image) throw new Error("Pinned runtime image is required");
const runtime = createConformanceRuntime(
  owner,
  image,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  directory,
);
let verified = false;
try {
  await runtime.prepare();
  const target = runtime.target();
  const capture = await runtime.pause();
  const script = `import json,os,stat,subprocess,sys
e=json.loads(sys.argv[1]);s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert s['store_id']==e['storeID'] and s['epoch']==e['epoch']
root=s['lifecycle']['root']+'/objects/'+e['sandboxID']+'/captures/'+e['snapshotID']+'/images'
directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 name=e.get('file') or sorted(n for n in os.listdir(directory) if n.startswith('pages-') and n.endswith('.img'))[0]
 fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW,dir_fd=directory)
 try:
  info=os.fstat(fd);assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size>0
  current=os.pread(fd,1,0)[0]
  if e.get('restore'):
   assert info.st_ino==e['inode'] and current==(e['original']^1)
   value=e['original']
  else:value=current^1
  os.pwrite(fd,bytes([value]),0);os.fsync(fd)
  print(json.dumps({'file':name,'inode':info.st_ino,'original':current}))
 finally:os.close(fd)
finally:os.close(directory)`;
  const expected = {
    storeID: target.identity.storeID,
    epoch: target.identity.epoch,
    sandboxID: target.input.sandboxID,
    snapshotID: capture.snapshotID,
  };
  const mutate = async (value: unknown) => {
    const result = await runCommand(
      kubernetesCommand([
        "exec",
        target.input.podName,
        "-n",
        target.input.namespace,
        "-c",
        "worker",
        "--",
        "python3",
        "-c",
        script,
        JSON.stringify(value),
      ]),
      undefined,
      { timeoutMS: 10_000, outputBytes: 16_384 },
    );
    if (result.exitCode !== 0) throw new Error("Owned RAM fault operation failed");
    return JSON.parse(result.stdout);
  };
  await save("fault-intent.json", expected);
  const fault = await mutate(expected);
  await save("fault.json", fault);
  let refusal = "";
  try {
    await runtime.resume(target.input.sandboxID, capture.snapshotID);
  } catch (cause) {
    refusal = cause instanceof Error ? cause.message : "refused";
  }
  if (!refusal.includes("RAM payload changed"))
    throw new Error("Changed RAM did not produce its native integrity refusal");
  const state = await executeFactoryboxOperation(
    factoryboxRuntimeRequest(target.input),
    target.identity,
    { action: "state", sandboxID: target.input.sandboxID },
    undefined,
    factoryboxRuntimeDeclaration(target.input),
  );
  if (!state.confirmed) throw new Error("Faulted restore observation is unconfirmed");
  const observed = JSON.parse(state.stdout);
  if (
    observed.record.pause.resume.attempted !== false ||
    observed.record.pause.snapshot_id !== capture.snapshotID ||
    observed.runtime.status !== "stopped"
  )
    throw new Error("RAM fault changed native restore attempt authority");
  await save("refusal.json", { refusal, state: observed, restoreAttempted: false });
  await mutate({ ...expected, ...fault, restore: true });
  await runtime.resume(target.input.sandboxID, capture.snapshotID);
  verified = true;
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Integrity proof failed",
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed: verified,
  changedRAMRefusedBeforeAttempt: true,
  exactOriginalUnattemptedRequestRecovered: true,
  scope:
    "Owned deliberate integrity fault only; full source and destination hash checks remain selected",
});
console.log(JSON.stringify({ evidence: directory, passed: verified }));
