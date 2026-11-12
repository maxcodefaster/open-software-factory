// Availability only, in an owned same-shape worker. No host policy changes,
// parent-image chains, lazy pager, runtime protocol or default selection.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { createConformanceRuntime } from "./factorybox-conformance";

const root = resolve(import.meta.dir, "../..");
const owner = crypto.randomUUID();
const directory = resolve(root, ".factory/test-results/advanced-capabilities", owner);
await mkdir(directory, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
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
let measured: unknown;
try {
  await runtime.prepare();
  const target = runtime.target();
  const expected = {
    storeID: target.identity.storeID,
    epoch: target.identity.epoch,
    executableSHA256: target.identity.executableSHA256,
    owner,
  };
  await save("capability-intent.json", {
    ...expected,
    scope: "Local capability observation only; stock AKS prerequisite remains missing",
    hostChanges: false,
  });
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Capability proof exceeded its original workload deadline");
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
      `import ctypes,errno,hashlib,json,os,pathlib,platform,subprocess,sys,time
e=json.loads(sys.argv[1]);status=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert status['store_id']==e['storeID'] and status['epoch']==e['epoch'] and status['supervisor_sha256']==e['executableSHA256']
criu='/opt/factorybox/components/criu'
digest=hashlib.sha256(pathlib.Path(criu).read_bytes()).hexdigest()
assert digest=='dfe97683c091f6326bfd471e8e46036f59a177489efc8912650d56d4bb525496'
output=pathlib.Path('/var/lib/sysbox/fixed-store/data/store')/('fixture-capabilities-'+e['owner']);output.mkdir(mode=0o700)
features=[]
for feature in ['mem_dirty_track','uffd','uffd-noncoop']:
 start=time.monotonic_ns()
 try:
  command=[criu,'check','--feature',feature]
  done=subprocess.run(command,cwd=output,capture_output=True,text=True,timeout=10)
  features.append({'feature':feature,'command':command,'exitCode':done.returncode,'stdout':done.stdout[-16384:],'stderr':done.stderr[-16384:],'elapsedMS':(time.monotonic_ns()-start)/1e6})
 except subprocess.TimeoutExpired:
  features.append({'feature':feature,'timedOut':True,'available':False})
libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long
number={'x86_64':323,'aarch64':282}.get(platform.machine());assert number is not None
calls=[]
for flags in [os.O_CLOEXEC|os.O_NONBLOCK,os.O_CLOEXEC|os.O_NONBLOCK|1]:
 ctypes.set_errno(0);fd=libc.syscall(number,flags);error=ctypes.get_errno()
 calls.append({'flags':flags,'userModeOnly':bool(flags&1),'opened':fd>=0,'errno':error,'errorName':errno.errorcode.get(error)})
 if fd>=0:os.close(fd)
policy=pathlib.Path('/proc/sys/vm/unprivileged_userfaultfd')
print(json.dumps({'criuSHA256':digest,'kernel':platform.release(),'architecture':platform.machine(),'unprivilegedUserfaultfd':policy.read_text().strip() if policy.exists() else None,'workerCapabilityMask':next(line.strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:')),'features':features,'syscalls':calls,'defaultRestore':'eager','stockAKSQualified':False}))`,
      JSON.stringify(expected),
    ]),
    undefined,
    { timeoutMS: Math.min(remaining, 45_000), outputBytes: 128 * 1024 },
  );
  await save("capability-command.json", result);
  if (result.exitCode !== 0)
    throw new Error("Owned capability observation failed; no experiment was enabled");
  measured = JSON.parse(result.stdout);
  await save("capabilities.json", measured);
  await runtime.boundary();
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Capability observation failed",
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed: true,
  capabilities: measured,
  scope:
    "Availability observation, not incremental/lazy correctness, performance or AKS qualification",
  defaultRestoreUnchanged: true,
  hostChanges: false,
});
console.log(JSON.stringify({ evidence: directory, passed: true }));
