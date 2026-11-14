// Process and context-pinned Kubernetes commands for the clean-room check.
import { setTimeout as delay } from "node:timers/promises";
import { type RunOptions, run } from "../owned-client-process";

export { type Output, pipe, type RunOptions, run } from "../owned-client-process";

export async function removeCleanRoomContainer(name: string, owner: string, execute = run) {
  const observed = await execute(
    [
      "docker",
      "container",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "factory.clean-room-owner")}}}',
      name,
    ],
    { allowFailure: true },
  );
  if (observed.code !== 0) {
    if (/\bno such (?:container|object)(?::|\s*$)/i.test(observed.stderr)) return;
    throw Error("Owned artifact container cleanup is unconfirmed");
  }
  const identity: unknown = JSON.parse(observed.stdout);
  if (
    !identity ||
    typeof identity !== "object" ||
    !("id" in identity) ||
    typeof identity.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.id) ||
    (/^[a-f0-9]{64}$/.test(name) && identity.id !== name) ||
    !("owner" in identity) ||
    identity.owner !== owner
  )
    throw Error("Artifact container ownership changed; nothing removed");
  await execute(["docker", "rm", "--force", identity.id]);
}

export async function until<T>(
  label: string,
  timeoutMs: number,
  attempt: () => Promise<T | null | undefined | false>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const value = await attempt();
      if (value) return value;
    } catch (cause) {
      signal?.throwIfAborted();
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await delay(2000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

export function cluster(context: string) {
  const withContext = (tool: string, flag: string, args: string[]) => [
    tool,
    ...(context ? [flag, context] : []),
    ...args,
  ];
  const kube = (...args: string[]) => withContext("kubectl", "--context", args);
  const helm = (...args: string[]) => withContext("helm", "--kube-context", args);
  return {
    kube,
    helm,
    kubectl: (args: string[], options?: RunOptions) => run(kube(...args), options),
    json: async (args: string[], options?: RunOptions) =>
      JSON.parse((await run(kube(...args, "-o", "json"), options)).stdout),
    apply: (manifest: unknown) =>
      run(kube("apply", "-f", "-"), { input: JSON.stringify(manifest) }),
    exists: async (args: string[], options?: RunOptions) =>
      (await run(kube("get", ...args), { ...options, allowFailure: true })).code === 0,
  };
}
export type Cluster = ReturnType<typeof cluster>;

/** Every nonzero Helm outcome fails, including capacity and unavailable observations. */
export async function testCleanRoomChart(
  cl: Cluster,
  release: string,
  namespace: string,
  signal?: AbortSignal,
) {
  const result = await run(cl.helm("test", release, "-n", namespace, "--timeout", "25m"), {
    allowFailure: true,
    signal,
  });
  if (result.code === 0) return "helm test passed (the preflight Job succeeded)";
  const logs = await cl.kubectl(["-n", namespace, "logs", `job/${release}-preflight`], {
    allowFailure: true,
    signal,
  });
  const lines = logs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(WARN|FAIL)\b/.test(line));
  throw new Error(
    `helm test failed: ${lines.slice(0, 4).join(" | ") || result.stderr.trim().split("\n").at(-1) || `exit ${result.code}`}`,
  );
}
