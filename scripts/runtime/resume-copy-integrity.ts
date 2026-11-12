// Own one request-scoped cp failure and an exact bad destination prefix. This
// does not replace cp, change host PATH or relax any native recovery boundary.
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
const directory = resolve(root, ".factory/test-results/resume-copy-integrity", owner);
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
let passed = false;
try {
  await runtime.prepare();
  const target = runtime.target();
  const pause = await runtime.pause();
  const shim = `/var/lib/sysbox/fixed-store/data/store/fixture-copy-${owner}`;
  const expected = {
    storeID: target.identity.storeID,
    epoch: target.identity.epoch,
    executableSHA256: target.identity.executableSHA256,
    sandboxID: target.input.sandboxID,
    snapshotID: pause.snapshotID,
    shim,
  };
  const limits = (maximum = 15_000) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Copy proof exceeded its original workload deadline");
    return { timeoutMS: Math.min(remaining, maximum), outputBytes: 4 * 1024 ** 2 };
  };
  const run: Parameters<typeof executeFactoryboxOperation>[3] = (args, body, requested) =>
    runCommand(kubernetesCommand(args), body, {
      timeoutMS: limits(requested?.timeoutMS ?? 15_000).timeoutMS,
      outputBytes: requested?.outputBytes ?? 4 * 1024 ** 2,
    });
  const state = async () => {
    const result = await executeFactoryboxOperation(
      factoryboxRuntimeRequest(target.input),
      target.identity,
      { action: "state", sandboxID: target.input.sandboxID },
      run,
      factoryboxRuntimeDeclaration(target.input),
    );
    if (!result.confirmed) throw new Error("Copy fixture native state is unconfirmed");
    return JSON.parse(result.stdout);
  };
  const call = async (program: string, value: unknown) => {
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
        program,
        JSON.stringify(value),
      ]),
      undefined,
      limits(),
    );
    if (result.exitCode !== 0) throw new Error(`Exact owned copy fault failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const guard = `import hashlib,json,os,pathlib,stat,subprocess,sys
e=json.loads(sys.argv[1]);s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert s['store_id']==e['storeID'] and s['epoch']==e['epoch'] and s['supervisor_sha256']==e['executableSHA256']
object=s['lifecycle']['root']+'/objects/'+e['sandboxID']
source=object+'/captures/'+e['snapshotID']+'/images'
destination=object+'/resumes/'+e['snapshotID']+'/images'
`;
  await save("copy-failure-intent.json", expected);
  await call(
    guard +
      `os.mkdir(e['shim'],0o700)
fd=os.open(e['shim']+'/cp',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700)
try:os.write(fd,b'#!/bin/sh\\nexit 74\\n');os.fsync(fd)
finally:os.close(fd)
print(json.dumps({'requestScopedShimCreated':True}))`,
    expected,
  );
  let injected = false;
  const failed = await executeFactoryboxOperation(
    factoryboxRuntimeRequest(target.input),
    target.identity,
    { action: "resume", sandboxID: target.input.sandboxID, snapshotID: pause.snapshotID },
    (args, body, requested) => {
      const separator = args.indexOf("--");
      if (
        separator >= 0 &&
        args[separator + 1] === "/opt/factorybox/factorybox" &&
        args.includes("resume")
      ) {
        if (
          injected ||
          !args.includes(target.input.podName) ||
          !args.includes(target.input.namespace)
        )
          throw new Error("Copy injection left its one owned native request");
        injected = true;
        return run(
          [
            ...args.slice(0, separator + 1),
            "env",
            `PATH=${shim}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
            ...args.slice(separator + 1),
          ],
          body,
          requested,
        );
      }
      return run(args, body, requested);
    },
    factoryboxRuntimeDeclaration(target.input),
  );
  await save("copy-failure.json", failed);
  if (
    !injected ||
    failed.confirmed ||
    !failed.stderr.includes("copy private fork images") ||
    !failed.stderr.includes("exit status 74")
  )
    throw new Error("Copy fault lacked its known pre-restore failure");
  const pending = await state();
  if (
    pending.record.phase !== "resuming" ||
    pending.record.pause.resume.attempted !== false ||
    pending.runtime.status !== "stopped"
  )
    throw new Error("Copy fault changed attempted restore authority");
  await save("unattempted.json", pending);
  const fault = await call(
    guard +
      `names=sorted(n for n in os.listdir(source) if n.startswith('pages-') and n.endswith('.img'))
assert names
name=max(names,key=lambda n:os.stat(source+'/'+n).st_size)
left=os.open(source+'/'+name,os.O_RDONLY|os.O_NOFOLLOW)
right=os.open(destination+'/'+name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
 info=os.fstat(left);assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size>4096
 data=os.pread(left,4096,0);assert len(data)==4096
 os.write(right,data);os.fchown(right,info.st_uid,info.st_gid);os.fchmod(right,stat.S_IMODE(info.st_mode))
 os.pwrite(right,bytes([data[0]^1]),0);os.fsync(right);copied=os.fstat(right)
 assert (copied.st_dev,copied.st_ino)!=(info.st_dev,info.st_ino) and copied.st_nlink==1
 print(json.dumps({'name':name,'device':copied.st_dev,'inode':copied.st_ino,'bytes':copied.st_size,'original':data[0],'sourceBytes':info.st_size}))
finally:os.close(left);os.close(right)`,
    expected,
  );
  await save("bad-prefix.json", fault);
  let refusal = "";
  try {
    await runtime.resume(target.input.sandboxID, pause.snapshotID);
  } catch (cause) {
    refusal = cause instanceof Error ? cause.message : "refused";
  }
  if (!refusal.includes("incomplete Resume copy differs from its original checkpoint prefix"))
    throw new Error("Changed destination prefix lacked its native integrity refusal");
  const refused = await state();
  if (
    refused.record.pause.resume.attempted !== false ||
    refused.runtime.status !== "stopped" ||
    refused.record.pause.resume.requested_at !== pending.record.pause.resume.requested_at
  )
    throw new Error("Destination fault changed the original unattempted request");
  await save("destination-refusal.json", { refusal, state: refused });
  await call(
    guard +
      `fd=os.open(destination+'/'+e['fault']['name'],os.O_RDWR|os.O_NOFOLLOW)
try:
 info=os.fstat(fd);fault=e['fault']
 assert (info.st_dev,info.st_ino,info.st_size)==(fault['device'],fault['inode'],fault['bytes']) and info.st_nlink==1 and os.pread(fd,1,0)[0]==(fault['original']^1)
 os.pwrite(fd,bytes([fault['original']]),0);os.fsync(fd)
 print(json.dumps({'exactKnownFixtureByteRepaired':True}))
finally:os.close(fd)`,
    { ...expected, fault },
  );
  await runtime.resume(target.input.sandboxID, pause.snapshotID);
  const resumed = await state();
  if (
    resumed.runtime.status !== "running" ||
    resumed.record.pause.resume.requested_at !== pending.record.pause.resume.requested_at ||
    resumed.record.runtime_id !== pending.record.runtime_id
  )
    throw new Error("Recovered copy did not continue its original source request");
  const continued = await call(
    guard +
      `left=pathlib.Path(source)/e['fault']['name'];right=pathlib.Path(destination)/e['fault']['name'];info=right.stat();fault=e['fault']
assert (info.st_dev,info.st_ino)==(fault['device'],fault['inode']) and info.st_size==fault['sourceBytes']
assert hashlib.sha256(left.read_bytes()).digest()==hashlib.sha256(right.read_bytes()).digest()
print(json.dumps({'sameDestinationInodeContinued':True,'fullSourceAndDestinationHashEqual':True}))`,
    { ...expected, fault },
  );
  await save("continued.json", { ...continued, sameOriginalRequest: true, resumed });
  passed = true;
  await runtime.passed();
} catch (cause) {
  await save("failure.json", {
    error: cause instanceof Error ? cause.message : "Copy integrity proof failed",
  });
  throw cause;
} finally {
  await runtime.cleanup();
}
await save("result.json", {
  passed,
  changedDestinationRefusedBeforeRestore: true,
  originalRequestRecovered: true,
  sameDestinationInodeAppended: true,
  sourceAndDestinationChecksRetained: true,
  hostChanges: false,
});
console.log(JSON.stringify({ evidence: directory, passed }));
