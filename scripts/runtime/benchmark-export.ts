import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import type { FactoryboxRuntimeInput } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "../../packages/runtime-kubernetes/src/factorybox-worker";

// Export only this owned synthetic fixture's RAM images for offline analysis.
// The immutable generation stays untouched. RAM exports are sensitive artifacts,
// never public assets or a general-purpose project export interface.
export async function exportBenchmarkPages(
  target: { input: FactoryboxRuntimeInput; identity: FactoryboxWorkerIdentity },
  snapshotID: string,
  path: string,
) {
  if (!/^[a-f0-9]{32}$/.test(snapshotID)) throw new Error("Invalid export snapshot identity");
  const { input, identity } = target;
  const script = `import json,os,stat,subprocess,sys,tarfile
e=json.loads(sys.argv[1])
s=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
assert s['store_id']==e['storeID'] and s['epoch']==e['epoch'] and s['supervisor_sha256']==e['executableSHA256']
images=s['lifecycle']['root']+'/objects/'+e['sandboxID']+'/captures/'+e['snapshotID']+'/images'
root=os.open(images,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 names=sorted(name for name in os.listdir(root) if name.startswith('pages-') and name.endswith('.img'))
 assert names and len(names)<=65536
 total=0
 with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
  for name in names:
   fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=root)
   with os.fdopen(fd,'rb') as stream:
    info=os.fstat(stream.fileno());assert stat.S_ISREG(info.st_mode) and info.st_nlink==1
    total+=info.st_size;assert total<=2<<30
    entry=tarfile.TarInfo(name);entry.size=info.st_size;entry.mode=0o600
    archive.addfile(entry,stream)
finally:os.close(root)`;
  const child = Bun.spawn(
    kubernetesCommand([
      "exec",
      input.podName,
      "-n",
      input.namespace,
      "-c",
      "worker",
      "--",
      "python3",
      "-c",
      script,
      JSON.stringify({
        storeID: identity.storeID,
        epoch: identity.epoch,
        executableSHA256: identity.executableSHA256,
        sandboxID: input.sandboxID,
        snapshotID,
      }),
    ]),
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [, stderr, status] = await Promise.all([
      pipeline(
        Readable.from(
          (async function* () {
            const reader = child.stdout.getReader();
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) return;
                yield chunk.value;
              }
            } finally {
              reader.releaseLock();
            }
          })(),
        ),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      ),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) throw new Error(`Owned snapshot export failed: ${stderr.slice(-2000)}`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
