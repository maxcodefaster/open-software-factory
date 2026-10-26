import { z } from "zod";
import {
  type FactoryboxRuntimeInput,
  factoryboxRuntimeDeclaration,
  factoryboxRuntimeRequest,
} from "./factorybox-runtime";
import {
  executeFactoryboxOperation,
  type FactoryboxWorkerIdentity,
  runFactoryboxKubernetes,
} from "./factorybox-worker";
import type { CurrentMetrics } from "./metrics";

const counter = z.number().int().nonnegative().safe();
const sample = z.object({
  owner: z.string().regex(/^[a-f0-9]{32}$/),
  timestamp: z.iso.datetime(),
  monotonicNS: counter,
  cpuUsec: counter,
  memoryBytes: counter,
});
export type FactoryboxResourceSample = z.infer<typeof sample>;
type Target = { input: FactoryboxRuntimeInput; identity: FactoryboxWorkerIdentity };
type Observation = { status: number; body: unknown };

const sampler = `import datetime,json,os,subprocess,sys,time
request=json.load(sys.stdin)
status=json.loads(subprocess.check_output(['/opt/factorybox/factorybox','worker-status'],timeout=5))
if status['store_id']!=request['storeID'] or status['epoch']!=request['epoch']:
 raise ValueError('Worker changed before Sandbox resource sample')
parent=os.open('/sys/fs/cgroup',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 group=os.open(request['runtimeID'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
finally: os.close(parent)
try:
 info=os.fstat(group)
 mount=[line.split()[1] for line in open('/proc/self/fdinfo/'+str(group)) if line.startswith('mnt_id:')]
 expected=request['cgroup']
 if (info.st_dev,info.st_ino,mount)!=(expected['device'],expected['inode'],[str(expected['mount_id'])]):
  raise ValueError('Sandbox cgroup identity changed')
 def read(name):
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=group)
  with os.fdopen(fd) as stream:
   value=stream.read(16385)
   if len(value)>16384: raise ValueError('Resource counter exceeds bound')
   return value
 cpu=dict(line.split() for line in read('cpu.stat').splitlines())
 print(json.dumps({'owner':request['owner'],'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
  'monotonicNS':time.monotonic_ns(),'cpuUsec':int(cpu['usage_usec']),'memoryBytes':int(read('memory.current'))}))
finally: os.close(group)
`;

export async function readFactoryboxSandboxSample(
  target: Target,
  run = runFactoryboxKubernetes,
): Promise<Observation> {
  const { input, identity } = target;
  const request = factoryboxRuntimeRequest(input);
  const state = await executeFactoryboxOperation(
    request,
    identity,
    { action: "state", sandboxID: input.sandboxID },
    run,
    factoryboxRuntimeDeclaration(input),
  );
  if (!state.confirmed) return { status: 503, body: null };
  const record = z
    .object({
      id: z.literal(input.sandboxID),
      owner: z.string().regex(/^[a-f0-9]{32}$/),
      runtime_id: z.string(),
      phase: z.enum(["running", "paused"]),
      cgroup: z.object({ device: counter, inode: counter, mount_id: counter }),
    })
    .parse(JSON.parse(state.stdout).record);
  if (record.runtime_id !== `fbx-${record.owner}`)
    throw new Error("Sandbox metrics owner differs from its cgroup");
  const result = await run(
    [
      "exec",
      "-i",
      input.podName,
      "-n",
      input.namespace,
      "-c",
      "worker",
      "--",
      "python3",
      "-c",
      sampler,
    ],
    JSON.stringify({
      storeID: identity.storeID,
      epoch: identity.epoch,
      runtimeID: record.runtime_id,
      owner: record.owner,
      cgroup: record.cgroup,
    }),
    { timeoutMS: 5000, outputBytes: 16_384 },
  );
  if (result.exitCode !== 0)
    return { status: /Forbidden/.test(result.stderr) ? 403 : 503, body: null };
  const parsed = sample.parse(JSON.parse(result.stdout));
  if (parsed.owner !== record.owner) throw new Error("Sandbox metrics returned another owner");
  return { status: 200, body: parsed };
}

const unavailable = (): CurrentMetrics => ({
  status: "unavailable",
  timestamp: null,
  cpuMilli: null,
  memoryMiB: null,
});

// CPU is a delta of this exact Sandbox's counters, never a repeated Pod total.
// Samples, deltas and the short observation cache stay ephemeral.
export function createFactoryboxMetrics(
  reader: (target: Target) => Promise<Observation> = readFactoryboxSandboxSample,
  clock = Date.now,
) {
  const values = new Map<
    string,
    { until: number; previous: FactoryboxResourceSample | null; value: CurrentMetrics }
  >();
  const pending = new Map<string, Promise<CurrentMetrics>>();
  return async (target: Target): Promise<CurrentMetrics> => {
    const request = factoryboxRuntimeRequest(target.input);
    if (request.storeID !== target.identity.storeID)
      throw new Error("Metrics target differs from its worker");
    const key = `${target.input.namespace}/${target.identity.podUID}/${target.identity.epoch}/${target.input.sandboxID}`;
    const cached = values.get(key);
    if (cached && cached.until > clock()) return cached.value;
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= 4) return unavailable();
    const work = (async () => {
      let value = unavailable(),
        previous = cached?.previous ?? null;
      try {
        const observed = await reader(target);
        if (observed.status === 403) value = { ...value, status: "forbidden" };
        else if (observed.status === 200) {
          const current = sample.parse(observed.body);
          const age = clock() - Date.parse(current.timestamp);
          if (age < -5000) throw new Error("Sandbox metrics timestamp is in the future");
          const same =
            previous?.owner === current.owner &&
            current.monotonicNS > previous.monotonicNS &&
            current.cpuUsec >= previous.cpuUsec;
          value = {
            status: age > 60_000 ? "stale" : "available",
            timestamp: current.timestamp,
            cpuMilli:
              same && previous
                ? ((current.cpuUsec - previous.cpuUsec) * 1_000_000) /
                  (current.monotonicNS - previous.monotonicNS)
                : null,
            memoryMiB: current.memoryBytes / 1024 ** 2,
          };
          previous = current;
        }
      } catch (cause) {
        previous = null;
        if (cause instanceof Error && /Forbidden/.test(cause.message))
          value = { ...unavailable(), status: "forbidden" };
      }
      // Remove only expired observations, and keep memory bounded even when
      // many short-lived Sandboxes have appeared since the last view.
      for (const [name, entry] of values) if (entry.until < clock() - 60_000) values.delete(name);
      if (values.size >= 128 && !values.has(key)) values.delete(values.keys().next().value!);
      values.set(key, { until: clock() + 5000, previous, value });
      return value;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };
}
