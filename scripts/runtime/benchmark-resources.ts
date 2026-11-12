import { z } from "zod";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import type { FactoryboxRuntimeInput } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import type { FactoryboxWorkerIdentity } from "../../packages/runtime-kubernetes/src/factorybox-worker";

const counters = z.record(z.string(), z.number().int().nonnegative().safe());
const group = z.object({
  cpu: counters,
  memoryBytes: z.number().int().nonnegative().safe(),
  memory: counters,
  io: z.record(z.string(), counters).nullable(),
  cpuMax: z.string().max(64),
  memoryMax: z.string().max(64),
});
const resourceSample = z.object({
  owner: z.string(),
  timestamp: z.iso.datetime(),
  monotonicNS: z.number().int().nonnegative().safe(),
  worker: group,
  sandbox: group,
});

const sampler = `import datetime,json,os,stat,subprocess,sys,time
expected=json.loads(sys.argv[1])
worker=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
if any(worker[key]!=expected[value] for key,value in [('store_id','storeID'),('epoch','epoch'),('boot_id','bootID'),('supervisor_sha256','executableSHA256')]):
 raise ValueError('Diagnostic worker identity changed')
path=worker['lifecycle']['root']+'/objects/'+expected['sandboxID']+'/record.json'
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
 info=os.fstat(fd)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_size>4<<20:raise ValueError('Diagnostic record identity changed')
 with os.fdopen(fd,closefd=False) as stream:record=json.load(stream)
finally:os.close(fd)
if record['id']!=expected['sandboxID'] or record['runtime_id']!='fbx-'+record['owner']:raise ValueError('Diagnostic Sandbox identity changed')
def identity(fd):
 info=os.fstat(fd)
 mount=[line.split()[1] for line in open('/proc/self/fdinfo/'+str(fd)) if line.startswith('mnt_id:')]
 if len(mount)!=1:raise ValueError('Diagnostic cgroup mount is absent')
 return {'device':info.st_dev,'inode':info.st_ino,'mount_id':int(mount[0])}
def read(fd,name):
 file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
 with os.fdopen(file) as stream:
  data=stream.read(16385)
  if len(data)>16384:raise ValueError('Diagnostic counter exceeds bound')
  return data
def sample(fd):
 cpu={key:int(value) for key,value in (line.split() for line in read(fd,'cpu.stat').splitlines())}
 memory={key:int(value) for key,value in (line.split() for line in read(fd,'memory.stat').splitlines())}
 try:
  io={}
  for line in read(fd,'io.stat').splitlines():
   fields=line.split();io[fields[0]]={key:int(value) for key,value in (field.split('=',1) for field in fields[1:])}
 except FileNotFoundError:io=None
 return {'cpu':cpu,'memoryBytes':int(read(fd,'memory.current')),'memory':memory,'io':io,
  'cpuMax':read(fd,'cpu.max').strip(),'memoryMax':read(fd,'memory.max').strip()}
parent=os.open('/sys/fs/cgroup',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 if identity(parent)!=record['cgroup_parent']:raise ValueError('Diagnostic worker cgroup changed')
 child=os.open(record['runtime_id'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  if identity(child)!=record['cgroup']:raise ValueError('Diagnostic Sandbox cgroup changed')
  result={'owner':record['owner'],'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
   'monotonicNS':time.monotonic_ns(),'worker':sample(parent),'sandbox':sample(child)}
 finally:os.close(child)
finally:os.close(parent)
print(json.dumps(result))`;

export function readBenchmarkResources(value: unknown) {
  return resourceSample.parse(value);
}

// Attribution only, outside timed operations. Never inspect the host's cgroup
// tree, mutate counters, or use diagnostic availability as lifecycle authority.
export async function benchmarkResources(
  target: { input: FactoryboxRuntimeInput; identity: FactoryboxWorkerIdentity },
  command: typeof runCommand = runCommand,
) {
  const { input, identity } = target;
  try {
    const result = await command(
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
        sampler,
        JSON.stringify({
          storeID: identity.storeID,
          epoch: identity.epoch,
          bootID: identity.bootID,
          executableSHA256: identity.executableSHA256,
          sandboxID: input.sandboxID,
        }),
      ]),
      undefined,
      { timeoutMS: 10_000, outputBytes: 32_768 },
    );
    if (result.exitCode !== 0) return { status: "unavailable" as const };
    return {
      status: "available" as const,
      sample: readBenchmarkResources(JSON.parse(result.stdout)),
    };
  } catch {
    return { status: "unavailable" as const };
  }
}
