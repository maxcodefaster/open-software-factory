import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectArguments, localAccessConfiguration } from "./connect";

const options = connectArguments(["--namespace", "owned-proof", "--release", "proof"]);

function configuration(ports = [58000, 58001, 58002]) {
  return {
    metadata: {
      name: "proof-config",
      namespace: options.namespace,
      uid: "owned-config-identity",
      labels: {
        "app.kubernetes.io/name": "factory",
        "app.kubernetes.io/instance": "proof",
        "app.kubernetes.io/managed-by": "Helm",
      },
    },
    data: {
      NODE_ENV: "development",
      FACTORY_HELM_RELEASE: "proof",
      FACTORY_BASE_URL: `http://127.0.0.1:${ports[0]}`,
      FACTORY_FORGEJO_PUBLIC_URL: `http://127.0.0.1:${ports[1]}`,
      FACTORY_ZERO_CACHE_PUBLIC_URL: `http://127.0.0.1:${ports[2]}/zero`,
    },
  };
}

test("local access has one command with explicit optional installation selection", () => {
  expect(connectArguments([])).toEqual({ namespace: "factory", release: "factory", context: "" });
  expect(connectArguments(["-n", "owned-proof", "-r", "proof", "--context", "selected"])).toEqual({
    namespace: "owned-proof",
    release: "proof",
    context: "selected",
  });
  for (const args of [
    ["--other", "value"],
    ["--namespace"],
    ["--namespace", "--release"],
    ["-n", "one", "--namespace", "two"],
    ["--namespace", "other/namespace"],
    ["--release", "x".repeat(54)],
    ["--release", "-unsafe"],
    ["--context", "line\nbreak"],
    ["constructor", "value"],
  ])
    expect(() => connectArguments(args)).toThrow();
});

test("local access discovers only the three installed public transports, never secrets or storage", () => {
  const value = configuration();
  const result = localAccessConfiguration(value, options);
  expect(result.uid).toBe(value.metadata.uid);
  expect(
    result.targets.map(({ service, port, remotePort, address }) => ({
      service,
      port,
      remotePort,
      address,
    })),
  ).toEqual([
    { service: "proof-factory", port: 58000, remotePort: 3000, address: "127.0.0.1" },
    { service: "proof-forgejo", port: 58001, remotePort: 3000, address: "127.0.0.1" },
    { service: "proof-zero", port: 58002, remotePort: 4848, address: "127.0.0.1" },
  ]);
  expect(result.targets[2]?.url).toBe(`${value.data.FACTORY_ZERO_CACHE_PUBLIC_URL}`);
});

test("the selected Helm identity and development mode are required before opening ports", () => {
  for (const mutate of [
    (value: ReturnType<typeof configuration>) => {
      value.metadata.uid = "";
    },
    (value: ReturnType<typeof configuration>) => {
      value.metadata.name = "other-config";
    },
    (value: ReturnType<typeof configuration>) => {
      value.metadata.namespace = "other";
    },
    (value: ReturnType<typeof configuration>) => {
      value.metadata.labels["app.kubernetes.io/instance"] = "other";
    },
    (value: ReturnType<typeof configuration>) => {
      value.metadata.labels["app.kubernetes.io/name"] = "other";
    },
    (value: ReturnType<typeof configuration>) => {
      value.metadata.labels["app.kubernetes.io/managed-by"] = "other";
    },
    (value: ReturnType<typeof configuration>) => {
      value.data.FACTORY_HELM_RELEASE = "other";
    },
    (value: ReturnType<typeof configuration>) => {
      value.data.NODE_ENV = "production";
    },
  ]) {
    const value = configuration();
    mutate(value);
    expect(() => localAccessConfiguration(value, options)).toThrow();
  }
});

test("local access refuses external hosts, TLS endpoints, paths, credentials and overlapping ports", () => {
  for (const url of [
    "http://example.com:58000",
    "http://127.0.0.2:58000",
    "https://127.0.0.1:58000",
    "http://user:password@127.0.0.1:58000",
    "http://127.0.0.1:58000/other",
    "http://127.0.0.1:58000/?other",
    "http://127.0.0.1:58000/#other",
  ]) {
    const value = configuration();
    value.data.FACTORY_BASE_URL = url;
    expect(() => localAccessConfiguration(value, options)).toThrow();
  }
  const mismatch = configuration();
  mismatch.data.FACTORY_ZERO_CACHE_PUBLIC_URL = "http://localhost:58002/zero";
  expect(() => localAccessConfiguration(mismatch, options)).toThrow("same cookie hostname");
  expect(() => localAccessConfiguration(configuration([58000, 58000, 58002]), options)).toThrow(
    "distinct ports",
  );
  const wrongPath = configuration();
  wrongPath.data.FACTORY_ZERO_CACHE_PUBLIC_URL += "/other";
  expect(() => localAccessConfiguration(wrongPath, options)).toThrow();
});

test("localhost and IPv6 remain loopback-only, and long Helm names use the actual chart name", () => {
  const value = configuration();
  for (const host of ["localhost", "[::1]"]) {
    for (const key of [
      "FACTORY_BASE_URL",
      "FACTORY_FORGEJO_PUBLIC_URL",
      "FACTORY_ZERO_CACHE_PUBLIC_URL",
    ] as const)
      value.data[key] = value.data[key].replace(/127\.0\.0\.1|localhost|\[::1\]/, host);
    expect(localAccessConfiguration(value, options).targets[0]?.address).toBe(
      host === "[::1]" ? "::1" : "127.0.0.1",
    );
  }
  const release = `${"a".repeat(39)}-suffix`;
  value.metadata.name = `${"a".repeat(39)}-config`;
  value.metadata.labels["app.kubernetes.io/instance"] = release;
  value.data.FACTORY_HELM_RELEASE = release;
  expect(localAccessConfiguration(value, { ...options, release }).targets[0]?.service).toBe(
    `${"a".repeat(39)}-factory`,
  );
  const repeatedDash = `${"a".repeat(38)}--suffix`;
  value.metadata.name = `${"a".repeat(38)}--config`;
  value.metadata.labels["app.kubernetes.io/instance"] = repeatedDash;
  value.data.FACTORY_HELM_RELEASE = repeatedDash;
  expect(
    localAccessConfiguration(value, { ...options, release: repeatedDash }).targets[0]?.service,
  ).toBe(`${"a".repeat(38)}--factory`);
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  detail: string,
  timeoutMS = 5_000,
) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Did not observe ${detail}`);
}

// Exercise the real CLI and subprocess lifecycle. The fake kubectl owns real
// loopback listeners, but has no access to Kubernetes or any retained installation.
async function fixture(extraEnvironment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "factory-connect-"));
  const configPath = join(directory, "config.json");
  const tracePath = join(directory, "trace.jsonl");
  const hangPath = join(directory, "hung-forward");
  const reservations = Array.from({ length: 3 }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }),
  );
  const value = configuration(
    reservations.map((server) => {
      if (server.port === undefined) throw new Error("Owned TCP listener has no port");
      return server.port;
    }),
  );
  for (const server of reservations) await server.stop(true);
  await writeFile(configPath, JSON.stringify(value));
  await writeFile(tracePath, "");
  await writeFile(
    join(directory, "kubectl"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ args, pid: process.pid }) + "\\n");
if (args.includes("current-context")) {
  console.log("owned-context");
} else if (args.includes("get") && args.includes("configmap")) {
  console.log(readFileSync(process.env.FAKE_CONFIG, "utf8"));
} else if (args.includes("port-forward")) {
  if (process.env.FAKE_FAIL_SERVICE && args.includes("service/" + process.env.FAKE_FAIL_SERVICE)) {
    console.error("error: test-owned connection failure");
    process.exit(1);
  }
  const mapping = args.at(-1).split(":");
  let server;
  try {
    server = Bun.serve({
      hostname: args[args.indexOf("--address") + 1],
      port: Number(mapping[0]),
      fetch: () => {
        if (existsSync(process.env.FAKE_HANG) &&
            readFileSync(process.env.FAKE_HANG, "utf8") === String(process.pid))
          return new Promise(() => {});
        return new Response("owned forward", { status: Number(process.env.FAKE_HTTP_STATUS ?? 200) });
      },
    });
  } catch {
    console.error("error: unable to listen on any of the requested ports");
    process.exit(1);
  }
  const stop = async () => { await server.stop(true); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (!process.env.FAKE_SILENT_SERVICE || !args.includes("service/" + process.env.FAKE_SILENT_SERVICE))
    console.log("Forwarding from 127.0.0.1:" + mapping[0] + " -> " + mapping[1]);
} else {
  process.exit(2);
}
`,
    { mode: 0o700 },
  );
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = "";
  let error = "";
  let settled: Promise<number> | undefined;
  async function capture(stream: ReadableStream<Uint8Array>, append: (text: string) => void) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        append(decoder.decode(chunk.value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  }
  const trace = async () =>
    (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; pid: number });
  return {
    value,
    trace,
    output: () => output,
    error: () => error,
    update: async () => {
      await writeFile(configPath, JSON.stringify(value));
    },
    hang: async (pid: number) => {
      await writeFile(hangPath, String(pid));
    },
    start(args: string[] = ["--namespace", options.namespace, "--release", options.release]) {
      child = Bun.spawn(
        [process.execPath, "--no-env-file", resolve(import.meta.dir, "connect.ts"), ...args],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"]}`,
            FAKE_CONFIG: configPath,
            FAKE_TRACE: tracePath,
            FAKE_HANG: hangPath,
            ...extraEnvironment,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      settled = Promise.all([
        child.exited,
        capture(child.stdout as ReadableStream<Uint8Array>, (text) => {
          output += text;
        }),
        capture(child.stderr as ReadableStream<Uint8Array>, (text) => {
          error += text;
        }),
      ]).then(([code]) => code);
      return { exited: settled, process: child };
    },
    async cleanup() {
      if (child?.exitCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child?.exitCode === null && child.kill("SIGKILL"), 1_000);
      try {
        await settled;
      } finally {
        clearTimeout(timer);
        const forwards = (await trace()).filter((entry) => entry.args.includes("port-forward"));
        const leaked: number[] = [];
        for (const entry of forwards) {
          let alive = false;
          try {
            process.kill(entry.pid, 0);
            alive = true;
          } catch {}
          // Never leave a test-owned process behind even when an assertion fails.
          if (alive) {
            leaked.push(entry.pid);
            process.kill(entry.pid, "SIGKILL");
          }
        }
        await rm(directory, { recursive: true, force: true });
        expect(leaked, "all owned forwards should have been reaped by the command").toEqual([]);
      }
    },
  };
}

test("one CLI opens all public connections, pins current context and disconnects only its children", async () => {
  const proof = await fixture();
  const unrelated = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unrelated"),
  });
  try {
    const command = proof.start();
    await waitFor(
      () => proof.output().includes("Local access connected."),
      "all local connections",
    );
    const calls = await proof.trace();
    const forwards = calls.filter((call) => call.args.includes("port-forward"));
    expect(forwards).toHaveLength(3);
    for (const call of forwards) {
      expect(call.args.slice(0, 4)).toEqual([
        "--context",
        "owned-context",
        "-n",
        options.namespace,
      ]);
      expect(call.args).toContain("--address");
      expect(call.args).toContain("127.0.0.1");
      expect(call.args).not.toContain("secrets");
    }
    command.process.kill("SIGINT");
    expect(await command.exited).toBe(0);
    expect(await (await fetch(unrelated.url)).text()).toBe("unrelated");
  } finally {
    await proof.cleanup();
    await unrelated.stop(true);
  }
});

test("an interrupted forward reconnects automatically without replacing the other connections", async () => {
  const proof = await fixture();
  try {
    proof.start(["-n", options.namespace, "-r", options.release, "--context", "explicit-context"]);
    await waitFor(() => proof.output().includes("Local access connected."), "initial connections");
    const initial = (await proof.trace()).filter((call) => call.args.includes("port-forward"));
    const factory = initial.find((call) => call.args.includes("service/proof-factory"));
    if (!factory) throw new Error("Owned Factory forward is missing");
    process.kill(factory.pid, "SIGTERM");
    await waitFor(() => proof.output().includes("Local access restored."), "restored connection");
    const calls = await proof.trace();
    const forwards = calls.filter((call) => call.args.includes("port-forward"));
    expect(forwards).toHaveLength(4);
    expect(forwards.filter((call) => call.args.includes("service/proof-factory"))).toHaveLength(2);
    expect(forwards.filter((call) => call.args.includes("service/proof-zero"))).toHaveLength(1);
    expect(forwards.filter((call) => call.args.includes("service/proof-forgejo"))).toHaveLength(1);
    expect(calls.every((call) => call.args.includes("explicit-context"))).toBe(true);
    expect(
      calls.every(
        (call) => !call.args.some((arg) => ["apply", "delete", "exec", "rollout"].includes(arg)),
      ),
    ).toBe(true);
  } finally {
    await proof.cleanup();
  }
});

test("a half-open forward heals before a browser request, even when kubectl never exits", async () => {
  const proof = await fixture();
  try {
    proof.start();
    await waitFor(() => proof.output().includes("Local access connected."), "initial connections");
    const factory = (await proof.trace()).find((call) =>
      call.args.includes("service/proof-factory"),
    );
    if (!factory) throw new Error("Owned Factory forward is missing");
    await proof.hang(factory.pid);
    await waitFor(
      () => proof.output().includes("Local access restored."),
      "healed transport",
      25_000,
    );
    const forwards = (await proof.trace()).filter((call) => call.args.includes("port-forward"));
    expect(forwards).toHaveLength(4);
    const response = await fetch(proof.value.data.FACTORY_BASE_URL);
    expect(await response.text()).toBe("owned forward");
  } finally {
    await proof.cleanup();
  }
}, 30_000);

test("an HTTP bootstrap failure is live transport, not permission to churn connections", async () => {
  const proof = await fixture({ FAKE_HTTP_STATUS: "503" });
  try {
    proof.start();
    await waitFor(() => proof.output().includes("Local access connected."), "live HTTP transport");
    expect((await proof.trace()).filter((call) => call.args.includes("port-forward"))).toHaveLength(
      3,
    );
    expect(proof.output()).not.toContain("Factory ready");
  } finally {
    await proof.cleanup();
  }
});

test("reconnection refuses an installation replaced under the same name", async () => {
  const proof = await fixture();
  try {
    const command = proof.start();
    await waitFor(() => proof.output().includes("Local access connected."), "initial connections");
    proof.value.metadata.uid = "another-installation";
    await proof.update();
    const forward = (await proof.trace()).find((call) => call.args.includes("port-forward"));
    if (!forward) throw new Error("Owned forward is missing");
    process.kill(forward.pid, "SIGTERM");
    expect(await command.exited).toBe(1);
    expect(proof.error()).toContain("installation identity or addresses changed");
    expect((await proof.trace()).filter((call) => call.args.includes("port-forward"))).toHaveLength(
      3,
    );
  } finally {
    await proof.cleanup();
  }
});

test("reconnection cannot silently change retained browser identities on the same installation", async () => {
  const proof = await fixture();
  try {
    const command = proof.start();
    await waitFor(() => proof.output().includes("Local access connected."), "initial connections");
    proof.value.data.FACTORY_BASE_URL = proof.value.data.FACTORY_BASE_URL.replace(
      "127.0.0.1",
      "localhost",
    );
    proof.value.data.FACTORY_ZERO_CACHE_PUBLIC_URL =
      proof.value.data.FACTORY_ZERO_CACHE_PUBLIC_URL.replace("127.0.0.1", "localhost");
    await proof.update();
    const forward = (await proof.trace()).find((call) => call.args.includes("port-forward"));
    if (!forward) throw new Error("Owned forward is missing");
    process.kill(forward.pid, "SIGTERM");
    expect(await command.exited).toBe(1);
    expect(proof.error()).toContain("installation identity or addresses changed");
    expect((await proof.trace()).filter((call) => call.args.includes("port-forward"))).toHaveLength(
      3,
    );
  } finally {
    await proof.cleanup();
  }
});

test("startup failure closes the other forwards instead of reporting partial readiness", async () => {
  const proof = await fixture({ FAKE_FAIL_SERVICE: "proof-forgejo" });
  try {
    const command = proof.start();
    expect(await command.exited).toBe(1);
    expect(proof.error()).toContain("Forgejo connection failed");
    expect(proof.output()).not.toContain("Local access connected.");
  } finally {
    await proof.cleanup();
  }
});

test("an occupied port is reported without killing its owner or changing public addresses", async () => {
  const proof = await fixture();
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: new URL(proof.value.data.FACTORY_BASE_URL).port,
    fetch: () => new Response("not Factory"),
  });
  try {
    const command = proof.start();
    expect(await command.exited).toBe(1);
    expect(proof.error()).toContain("already in use");
    expect(await (await fetch(occupied.url)).text()).toBe("not Factory");
    expect(proof.output()).not.toContain("Local access connected.");
  } finally {
    await proof.cleanup();
    await occupied.stop(true);
  }
});

test("a silent half-prepared forward does not count as connected and Stop reaps it", async () => {
  const proof = await fixture({ FAKE_SILENT_SERVICE: "proof-zero" });
  try {
    const command = proof.start();
    await waitFor(
      async () =>
        (await proof.trace()).filter((call) => call.args.includes("port-forward")).length === 3,
      "forward subprocesses",
    );
    expect(proof.output()).not.toContain("Local access connected.");
    command.process.kill("SIGTERM");
    expect(await command.exited).toBe(0);
  } finally {
    await proof.cleanup();
  }
});

test("help requires no cluster, and invalid arguments fail before opening connections", async () => {
  const proof = await fixture();
  try {
    const command = proof.start(["--help"]);
    expect(await command.exited).toBe(0);
    expect(proof.output()).toContain("Ctrl+C");
    expect(await proof.trace()).toEqual([]);
  } finally {
    await proof.cleanup();
  }
  const invalid = await fixture();
  try {
    const command = invalid.start(["--namespace", "invalid/name"]);
    expect(await command.exited).toBe(1);
    expect(await invalid.trace()).toEqual([]);
  } finally {
    await invalid.cleanup();
  }
});
