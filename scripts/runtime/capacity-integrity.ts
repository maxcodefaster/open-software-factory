// Deliberate bounded-store pressure in one owned fixture; never host/global pressure.
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
const directory = resolve(root, ".factory/test-results/capacity-integrity", owner);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const image = process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"];
if (!image) throw new Error("Pinned runtime image is required");
const deadline = performance.now() + 420_000;
const runtime = createConformanceRuntime(
  owner,
  image,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  directory,
);
let passed = false;
try {
  await runtime.prepare();
  const target = runtime.target();
  const pressure = `/var/lib/sysbox/fixed-store/data/store/fixture-pressure-${owner}`;
  const call = async (script: string, value: unknown) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error("Capacity proof exceeded its original 420-second workload deadline");
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
      { timeoutMS: Math.min(remaining, 120_000), outputBytes: 16_384 },
    );
    if (result.exitCode !== 0) throw new Error(`Owned capacity fault failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const state = async () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error("Capacity proof exceeded its original 420-second workload deadline");
    const result = await executeFactoryboxOperation(
      factoryboxRuntimeRequest(target.input),
      target.identity,
      { action: "state", sandboxID: target.input.sandboxID },
      (args, body, limits) =>
        runCommand(kubernetesCommand(args), body, {
          timeoutMS: Math.min(remaining, limits?.timeoutMS ?? 15_000),
          outputBytes: limits?.outputBytes ?? 4 * 1024 ** 2,
        }),
      factoryboxRuntimeDeclaration(target.input),
    );
    if (!result.confirmed) throw new Error("Original source state under pressure is unconfirmed");
    return JSON.parse(result.stdout);
  };
  const original = await state();
  const expected = {
    path: pressure,
    storeID: target.identity.storeID,
    epoch: target.identity.epoch,
    executableSHA256: target.identity.executableSHA256,
  };
  await save("pressure-intent.json", expected);
  const owned = await call(
    `import ctypes,json,os,subprocess,sys
e=json.loads(sys.argv[1]);s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert s['store_id']==e['storeID'] and s['epoch']==e['epoch'] and s['supervisor_sha256']==e['executableSHA256']
assert os.path.realpath(e['path'])==e['path']
fd=os.open(e['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
 fs=os.fstatvfs(fd);available=fs.f_bavail*fs.f_frsize;target=96<<20
 info=os.fstat(fd);assert info.st_dev==os.stat('/var/lib/sysbox/fixed-store/data').st_dev and info.st_dev!=os.stat('/var/lib/sysbox').st_dev
 assert 0<fs.f_blocks*fs.f_frsize<=64<<30
 allocation=available-target;assert 0<allocation<64<<30
 os.posix_fallocate(fd,0,allocation);os.fsync(fd)
 libc=ctypes.CDLL(None,use_errno=True);assert libc.syncfs(fd)==0
 fs=os.fstatvfs(fd);info=os.fstat(fd);remaining=fs.f_bavail*fs.f_frsize
 assert remaining<192<<20
 print(json.dumps({'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'availableBytes':remaining}))
finally:os.close(fd)`,
    expected,
  );
  await save("pressure.json", owned);
  let refusal = "";
  try {
    await runtime.pause();
  } catch (cause) {
    refusal = cause instanceof Error ? cause.message : "refused";
  }
  if (!refusal.includes("capacity refused Pause before dispatch"))
    throw new Error("Owned disk pressure did not refuse pause before mutation");
  const observed = await state();
  if (
    observed.record.phase !== "running" ||
    observed.record.pause != null ||
    observed.runtime.status !== "running" ||
    observed.runtime.pid !== original.runtime.pid
  )
    throw new Error("Known write refusal changed the original source or transition intent");
  await save("refusal.json", { refusal, observed, nativePauseDispatched: false });
  const released = await call(
    `import ctypes,json,os,stat,subprocess,sys
e=json.loads(sys.argv[1]);s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert s['store_id']==e['storeID'] and s['epoch']==e['epoch'] and s['supervisor_sha256']==e['executableSHA256']
e=json.loads(sys.argv[1]);info=os.lstat(e['path']);o=e['owned']
assert stat.S_ISREG(info.st_mode) and (info.st_dev,info.st_ino,info.st_size)==(o['device'],o['inode'],o['bytes']) and info.st_nlink==1 and info.st_uid==0
os.unlink(e['path']);fd=os.open(os.path.dirname(e['path']),os.O_RDONLY|os.O_DIRECTORY)
try:assert ctypes.CDLL(None,use_errno=True).syncfs(fd)==0
finally:os.close(fd)
print(json.dumps({'exactOwnedPressureReleased':True}))`,
    { ...expected, owned },
  );
  await save("pressure-release.json", released);
  const pause = await runtime.pause();
  await runtime.resume(target.input.sandboxID, pause.snapshotID);
  passed = true;
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Capacity integrity proof failed",
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed,
  knownPressureRefusedBeforePauseDispatch: true,
  originalSourceRetained: true,
  exactOwnedPressureRemoved: true,
  pauseResumeAfterPressurePassed: true,
});
console.log(JSON.stringify({ evidence: directory, passed }));
