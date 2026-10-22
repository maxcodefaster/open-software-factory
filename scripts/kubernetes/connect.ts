import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

const help = `Connect to a local Helm-installed Factory:

  mise exec -- bun run factory:connect [--namespace factory] [--release factory] [--context NAME]

Reads the installed browser addresses and keeps all three loopback connections open.
Reconnecting never restarts Factory, changes its addresses or repeats model work.
Keep this command running. Ctrl+C disconnects without stopping the installation.`;

export function connectArguments(args: string[]) {
  const options = { namespace: "factory", release: "factory", context: "" };
  const flags = new Map<string, keyof typeof options>([
    ["--namespace", "namespace"],
    ["-n", "namespace"],
    ["--release", "release"],
    ["-r", "release"],
    ["--context", "context"],
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = flags.get(args[index] ?? "");
    const value = args[index + 1];
    if (!key || !value || value.startsWith("-") || seen.has(key) || /[\0\r\n]/.test(value))
      throw new Error("Use --namespace NAME, --release NAME and optionally --context NAME.");
    seen.add(key);
    options[key] = value;
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.namespace) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(options.release)
  )
    throw new Error("Use a valid Kubernetes namespace and Helm release name.");
  return options;
}
type Options = ReturnType<typeof connectArguments>;

const configSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    uid: z.string().min(1),
    labels: z.record(z.string(), z.string()),
  }),
  data: z.record(z.string(), z.string()),
});

function loopbackURL(value: string | undefined, path: string) {
  const url = new URL(value ?? "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== path
  )
    throw new Error("Local access requires HTTP loopback browser addresses from the local values.");
  return url;
}

export function localAccessConfiguration(value: unknown, options: Options) {
  const config = configSchema.parse(value);
  const name = options.release.slice(0, 40).replace(/-$/, "");
  if (
    config.metadata.name !== `${name}-config` ||
    config.metadata.namespace !== options.namespace ||
    config.metadata.labels["app.kubernetes.io/name"] !== "factory" ||
    config.metadata.labels["app.kubernetes.io/instance"] !== options.release ||
    config.metadata.labels["app.kubernetes.io/managed-by"] !== "Helm" ||
    config.data["FACTORY_HELM_RELEASE"] !== options.release ||
    config.data["NODE_ENV"] !== "development"
  )
    throw new Error(
      "Select the exact Factory development Helm release, not an Ingress installation.",
    );
  const factory = loopbackURL(config.data["FACTORY_BASE_URL"], "/");
  const forgejo = loopbackURL(config.data["FACTORY_FORGEJO_PUBLIC_URL"], "/");
  const zero = loopbackURL(config.data["FACTORY_ZERO_CACHE_PUBLIC_URL"], "/zero");
  if (zero.hostname !== factory.hostname)
    throw new Error("Factory and the planning cache must use the same cookie hostname.");
  const targets = [
    { role: "Factory", component: "factory", remotePort: 3000, url: factory },
    { role: "Forgejo", component: "forgejo", remotePort: 3000, url: forgejo },
    { role: "Planning", component: "zero", remotePort: 4848, url: zero },
  ].map((target) => ({
    ...target,
    url: target.url.href,
    port: Number(target.url.port || "80"),
    address: target.url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    service: `${name}-${target.component}`,
  }));
  if (new Set(targets.map((target) => target.port)).size !== targets.length)
    throw new Error("Local Factory, Forgejo and planning access require three distinct ports.");
  return { uid: config.metadata.uid, targets };
}
type Target = ReturnType<typeof localAccessConfiguration>["targets"][number];

async function kubectl(options: Options, args: string[]) {
  const result = await runCommand(
    [
      "kubectl",
      ...(options.context ? ["--context", options.context] : []),
      "--request-timeout=10s",
      ...args,
    ],
    undefined,
    { timeoutMS: 12_000, outputBytes: 512 * 1024 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      "Cannot read the selected Kubernetes context or Factory release. Check access.",
    );
  return result.stdout.trim();
}

async function configuration(options: Options) {
  const name = options.release.slice(0, 40).replace(/-$/, "");
  return JSON.parse(
    await kubectl(options, [
      "-n",
      options.namespace,
      "get",
      "configmap",
      `${name}-config`,
      "-o",
      "json",
    ]),
  ) as unknown;
}

async function forward(
  options: Options,
  target: Target,
  signal: AbortSignal,
  connected: () => void,
) {
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      "kubectl",
      "--context",
      options.context,
      "-n",
      options.namespace,
      "port-forward",
      "--address",
      target.address,
      "--pod-running-timeout=60s",
      `service/${target.service}`,
      `${target.port}:${target.remotePort}`,
    ],
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const lifetime = new AbortController();
  const handshake = Promise.withResolvers<void>();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    lifetime.abort();
    handshake.resolve();
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1_000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let listening = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 65_000);
  void child.exited.then(() => {
    lifetime.abort();
    handshake.resolve();
  });
  async function checkTransport() {
    await handshake.promise;
    let failures = 0;
    let confirmed = false;
    const path =
      target.component === "factory"
        ? "/api/session"
        : target.component === "forgejo"
          ? "/api/healthz"
          : "/keepalive";
    while (!lifetime.signal.aborted) {
      const response = await fetch(new URL(path, target.url), {
        redirect: "manual",
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2_000)]),
      }).catch(() => null);
      await response?.body?.cancel().catch(() => {});
      if (lifetime.signal.aborted) return;
      // Any HTTP response proves transport. A bootstrapping application's 503
      // must not cause a reconnect loop or be advertised as application readiness.
      if (response) {
        failures = 0;
        if (!confirmed) {
          confirmed = true;
          clearTimeout(timer);
          connected();
        }
      } else if (++failures >= 2) {
        // An idle kubectl can keep its local listener after its Pod has gone.
        // Detect that without requiring a real browser request to trigger recovery.
        stop();
        return;
      }
      await delay(5_000, undefined, { signal: lifetime.signal }).catch(() => {});
    }
  }
  async function read(stream: ReadableStream<Uint8Array>, observe: boolean) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return tail;
        // Keep only compact diagnostics, never an unbounded command transcript.
        tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-4_096);
        const host = target.address === "::1" ? "[::1]" : target.address;
        if (
          observe &&
          !listening &&
          !signal.aborted &&
          tail.includes(`Forwarding from ${host}:${target.port} -> ${target.remotePort}`)
        ) {
          listening = true;
          handshake.resolve();
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const [, diagnostic] = await Promise.all([
      read(child.stdout, true),
      read(child.stderr, false),
      child.exited,
      checkTransport(),
    ]);
    return {
      portUnavailable: /address already in use|unable to listen on any/i.test(diagnostic),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    stop();
    await child.exited;
    clearTimeout(killTimer);
  }
}

export async function connectLocalFactory(
  input: Options,
  signal: AbortSignal,
  report: (message: string) => void = console.log,
) {
  const options = {
    ...input,
    context: input.context || (await kubectl(input, ["config", "current-context"])),
  };
  const original = localAccessConfiguration(await configuration(options), options);
  signal.throwIfAborted();
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const active = new Set<string>();
  let announced = false;
  report(`Connecting to ${options.release} in ${options.namespace} on ${options.context}.`);
  const workers = original.targets.map(async (target) => {
    let attempted = false;
    let previouslyConnected = false;
    let reconnecting = false;
    let backoff = 1_000;
    while (!controller.signal.aborted) {
      if (attempted) {
        let observed: unknown;
        try {
          observed = await configuration(options);
        } catch {
          if (controller.signal.aborted) return;
          await delay(backoff, undefined, { signal: controller.signal });
          backoff = Math.min(backoff * 2, 10_000);
          continue;
        }
        if (
          JSON.stringify(localAccessConfiguration(observed, options)) !== JSON.stringify(original)
        )
          throw new Error(
            "Factory installation identity or addresses changed. Reconnect explicitly.",
          );
      }
      attempted = true;
      const result = await forward(options, target, controller.signal, () => {
        previouslyConnected = true;
        reconnecting = false;
        backoff = 1_000;
        active.add(target.role);
        if (active.size === original.targets.length) {
          report(announced ? "Local access restored." : "Local access connected.");
          if (!announced) {
            for (const entry of original.targets) report(`  ${entry.role}: ${entry.url}`);
            report("Keep this command running. Ctrl+C disconnects without stopping Factory.");
            announced = true;
          }
        }
      });
      active.delete(target.role);
      if (controller.signal.aborted) return;
      if (result.portUnavailable)
        throw new Error(
          `${target.role} port ${target.port} is already in use. Close the other local connection first; it was not stopped.`,
        );
      if (!previouslyConnected)
        throw new Error(
          `${target.role} connection ${result.timedOut ? "timed out" : "failed"}. Check that this Helm installation is running and accessible.`,
        );
      if (!reconnecting)
        report(`${target.role} connection lost. Reconnecting to the same installation.`);
      reconnecting = true;
      await delay(backoff, undefined, { signal: controller.signal });
      backoff = Math.min(backoff * 2, 10_000);
    }
  });
  try {
    await Promise.all(workers);
  } catch (cause) {
    if (!signal.aborted) throw cause;
  } finally {
    controller.abort();
    await Promise.allSettled(workers);
    signal.removeEventListener("abort", stop);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) console.log(help);
  else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await connectLocalFactory(connectArguments(args), controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        console.error(cause instanceof Error ? cause.message : "Local access failed.");
        process.exitCode = 1;
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
