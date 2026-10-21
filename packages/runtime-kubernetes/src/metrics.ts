import { z } from "zod";
import { kubernetesCommand, kubernetesConnectionEnvironment } from "./config";

const payload = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string() }),
  timestamp: z.iso.datetime(),
  window: z.string(),
  containers: z
    .array(z.object({ name: z.string(), usage: z.object({ cpu: z.string(), memory: z.string() }) }))
    .max(32),
});
export type CurrentMetrics = {
  status: "available" | "stale" | "unavailable" | "forbidden";
  timestamp: string | null;
  cpuMilli: number | null;
  memoryMiB: number | null;
};
export function parsePodMetrics(
  raw: unknown,
  namespace: string,
  pod: string,
  now = Date.now(),
): CurrentMetrics {
  const parsed = payload.safeParse(raw);
  const missing: CurrentMetrics = {
    status: "unavailable",
    timestamp: null,
    cpuMilli: null,
    memoryMiB: null,
  };
  if (
    !parsed.success ||
    parsed.data.metadata.namespace !== namespace ||
    parsed.data.metadata.name !== pod
  )
    return missing;
  const envbox = parsed.data.containers.find((container) => container.name === "envbox");
  if (!envbox) return missing;
  const cpu = envbox.usage.cpu.match(/^(\d+(?:\.\d+)?)(n|u|m)?$/);
  const memory = envbox.usage.memory.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G)?$/);
  if (!cpu || !memory) return missing;
  const cpuUnits: Record<string, number> = { n: 1e-6, u: 1e-3, m: 1 };
  const cpuMilli = Number(cpu[1]) * (cpuUnits[cpu[2] ?? ""] ?? 1000);
  const units: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1e3,
    M: 1e6,
    G: 1e9,
  };
  const memoryMiB = (Number(memory[1]) * (units[memory[2] ?? ""] ?? 1)) / 1024 ** 2;
  const age = now - Date.parse(parsed.data.timestamp);
  if (!Number.isFinite(cpuMilli) || !Number.isFinite(memoryMiB) || age < -5000) return missing;
  return {
    status: age > 60000 ? "stale" : "available",
    timestamp: parsed.data.timestamp,
    cpuMilli,
    memoryMiB,
  };
}
type Read = (
  namespace: string,
  pod: string,
  uid: string,
) => Promise<{ status: number; body: unknown }>;
async function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return new TextDecoder().decode(Buffer.concat(chunks));
      size += part.value.byteLength;
      if (size > limit) throw new Error("Metrics response is too large");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
}
async function readRaw(path: string) {
  const process = Bun.spawn(kubernetesCommand(["get", "--request-timeout=2s", "--raw", path]), {
    env: kubernetesConnectionEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => process.kill(), 2500);
  try {
    const [output, error, status] = await Promise.all([
      boundedText(process.stdout, 256 * 1024),
      boundedText(process.stderr, 8192),
      process.exited,
    ]);
    if (status !== 0) return { status: error.includes("Forbidden") ? 403 : 503, body: null };
    return { status: 200, body: JSON.parse(output) as unknown };
  } finally {
    clearTimeout(timeout);
    process.kill();
  }
}
const podIdentity = z.object({ metadata: z.object({ uid: z.string() }) });
export async function readCurrentPodMetrics(
  namespace: string,
  pod: string,
  uid: string,
  raw = readRaw,
) {
  const path = `/api/v1/namespaces/${namespace}/pods/${pod}`;
  const before = await raw(path);
  if (before.status !== 200) return before;
  if (podIdentity.safeParse(before.body).data?.metadata.uid !== uid)
    return { status: 503, body: null };
  const metrics = await raw(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${pod}`);
  if (metrics.status !== 200) return metrics;
  const after = await raw(path);
  if (after.status !== 200) return after;
  return podIdentity.safeParse(after.body).data?.metadata.uid === uid
    ? metrics
    : { status: 503, body: null };
}
export function createCurrentMetrics(reader: Read = readCurrentPodMetrics, clock = Date.now) {
  const cache = new Map<string, { until: number; value: CurrentMetrics }>();
  const pending = new Map<string, Promise<CurrentMetrics>>();
  return async (namespace: string, pod: string, uid: string): Promise<CurrentMetrics> => {
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(pod) ||
      !uid ||
      uid.length > 128
    )
      throw new Error("Invalid metrics target");
    const key = `${namespace}/${pod}/${uid}`,
      cached = cache.get(key);
    if (cached && cached.until > clock())
      return {
        ...cached.value,
        status:
          cached.value.timestamp && clock() - Date.parse(cached.value.timestamp) > 60000
            ? "stale"
            : cached.value.status,
      };
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 4)
      return { status: "unavailable", timestamp: null, cpuMilli: null, memoryMiB: null };
    const request = (async () => {
      let value: CurrentMetrics = {
        status: "unavailable",
        timestamp: null,
        cpuMilli: null,
        memoryMiB: null,
      };
      try {
        const result = await reader(namespace, pod, uid);
        value =
          result.status === 403
            ? { ...value, status: "forbidden" }
            : result.status === 200
              ? parsePodMetrics(result.body, namespace, pod, clock())
              : value;
      } catch {
        /* Missing metrics never become zero consumption. */
      }
      if (cache.size >= 128) cache.delete(cache.keys().next().value ?? "");
      cache.set(key, { until: clock() + 5000, value });
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
