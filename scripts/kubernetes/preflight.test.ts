import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pins from "../../deploy/substrate/pins.json";
import { pinnedNativeSandboxSpec } from "../../packages/runtime-kubernetes/src/substrate-profile";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
import {
  formatPreflight,
  type Kubectl,
  preflightExitCode,
  preflightOptionsFromArguments,
  runPreflight,
} from "./preflight";

function clusterFixture() {
  const configuration = nativeInstallationFixture();
  const metadata = (name: string, namespace?: string) => ({
    name,
    uid: crypto.randomUUID(),
    creationTimestamp: new Date().toISOString(),
    labels: {},
    annotations: {},
    ...(namespace ? { namespace } : {}),
  });
  const sandbox = {
    metadata: metadata(configuration.profile),
    spec: pinnedNativeSandboxSpec(),
  };
  const pool = {
    metadata: { ...metadata("native-base", "ate-workers"), labels: configuration.workerSelector },
    spec: {
      replicas: 1,
      workerImage: pins.substrate.workerImage,
      sandboxClasses: [{ name: "gvisor", configRef: { name: configuration.profile } }],
      template: {
        nodeSelector: {
          "kubernetes.io/os": "linux",
          "kubernetes.io/arch": "amd64",
          "kubernetes.io/hostname": "owned-node",
        },
        resources: { requests: { cpu: "4", memory: "8Gi" }, limits: { cpu: "4", memory: "8Gi" } },
      },
    },
    status: { readyReplicas: 1, replicas: 1 },
  };
  const node = {
    metadata: {
      ...metadata("owned-node"),
      labels: {
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": "amd64",
        "kubernetes.io/hostname": "owned-node",
      },
    },
    spec: {},
    status: {
      nodeInfo: { bootID: crypto.randomUUID(), architecture: "amd64", operatingSystem: "linux" },
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const workerLabels: Record<string, string> = { "ate.dev/worker-pool": pool.metadata.name };
  const worker = {
    metadata: { ...metadata("owned-worker", "ate-workers"), labels: workerLabels },
    spec: { nodeName: node.metadata.name, containers: [{ image: pool.spec.workerImage }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  };
  const namespace = {
    metadata: {
      ...metadata("factory"),
      labels: {
        "pod-security.kubernetes.io/enforce": "baseline",
        "ate.dev/api-access": "true",
      } as Record<string, string>,
    },
  };
  const storage = {
    items: [
      {
        metadata: {
          name: "owned-posix",
          annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
        },
        provisioner: "owned.csi.example",
      },
    ],
  };
  const recorded: string[][] = [];
  const run: Kubectl = async (args) => {
    recorded.push([...args]);
    expect(args[0]).toBe("get");
    const resources: Record<string, unknown> = {
      sandboxconfig: sandbox,
      workerpools: { items: [pool] },
      nodes: { items: [node] },
      pods: {
        items: [worker].filter((pod) => {
          const index = args.indexOf("-l");
          if (index < 0) return true;
          return args[index + 1]?.split(",").every((entry) => {
            const [key, value] = entry.split("=");
            return key && pod.metadata.labels[key] === value;
          });
        }),
      },
      namespace,
      storageclasses: storage,
    };
    const value = resources[args[1] ?? ""];
    if (!value) throw new Error("Unexpected preflight resource");
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  return { configuration, sandbox, pool, node, worker, namespace, storage, run, calls: recorded };
}

test("native preflight reads the exact profile, Ready amd64 pool and StorageClass without creating any resources", async () => {
  const f = clusterFixture();
  const checks = await runPreflight(
    { configuration: f.configuration, releaseNamespace: "factory" },
    f.run,
  );
  expect(preflightExitCode(checks)).toBe(0);
  expect(checks.filter((check) => check.status === "PASS")).toHaveLength(4);
  expect(checks.find((check) => check.id === "native.assignment")?.status).toBe("WARN");
  expect(formatPreflight(checks)).toContain("4 passed, 1 warnings, 0 failed");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  expect(f.calls.some((args) => args.includes("secrets") || args.includes("pods/log"))).toBe(false);
});

test("ARM preflight requires its selected ARM pool, node and Ready worker without accepting an amd64 replacement", async () => {
  const f = clusterFixture();
  for (const attribute of f.configuration.runtime.version.attributes)
    if (attribute.key === "architecture") attribute.value = "arm64";
  f.pool.spec.template.nodeSelector["kubernetes.io/arch"] = "arm64";
  f.node.metadata.labels["kubernetes.io/arch"] = "arm64";
  f.node.status.nodeInfo.architecture = "arm64";
  const options = { configuration: f.configuration, releaseNamespace: "factory" };
  expect(preflightExitCode(await runPreflight(options, f.run))).toBe(0);
  f.node.status.nodeInfo.architecture = "amd64";
  expect(preflightExitCode(await runPreflight(options, f.run))).toBe(1);
  f.node.status.nodeInfo.architecture = "arm64";
  f.pool.spec.template.nodeSelector["kubernetes.io/arch"] = "amd64";
  expect(preflightExitCode(await runPreflight(options, f.run))).toBe(1);
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
});

test("a Ready worker from another native pool cannot satisfy the original pool preflight", async () => {
  const f = clusterFixture();
  f.worker.metadata.labels["ate.dev/worker-pool"] = "another-pool";
  const checks = await runPreflight(
    { configuration: f.configuration, releaseNamespace: "factory" },
    f.run,
  );
  expect(checks.find((check) => check.id === "native.capacity")?.status).toBe("FAIL");
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
});

test.each([
  "profile",
  "pool not ready",
  "architecture",
  "worker image",
  "capacity",
  "storage",
  "release policy",
])("native preflight fails closed on %s without a privileged fallback", async (boundary) => {
  const f = clusterFixture();
  if (boundary === "profile") f.sandbox.spec.defaultVersion = "unqualified";
  else if (boundary === "pool not ready") f.pool.status.readyReplicas = 0;
  else if (boundary === "architecture") f.node.status.nodeInfo.architecture = "arm64";
  else if (boundary === "worker image") {
    const worker = f.worker.spec.containers[0];
    if (!worker) throw new Error("Missing owned worker");
    worker.image = `registry.example/foreign@sha256:${"f".repeat(64)}`;
  } else if (boundary === "capacity") f.pool.spec.template.resources.limits.memory = "1Gi";
  else if (boundary === "storage") f.storage.items = [];
  else f.namespace.metadata.labels["pod-security.kubernetes.io/enforce"] = "restricted";
  const checks = await runPreflight(
    { configuration: f.configuration, releaseNamespace: "factory" },
    f.run,
  );
  expect(preflightExitCode(checks)).toBe(1);
  expect(checks.some((check) => check.status === "FAIL")).toBe(true);
  expect(f.calls.every((args) => args[0] === "get")).toBe(true);
});

test("unavailable native API observations are failures, not another runtime or a passing skipped probe", async () => {
  const configuration = nativeInstallationFixture();
  const checks = await runPreflight({ configuration, releaseNamespace: "factory" }, async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "forbidden",
  }));
  expect(preflightExitCode(checks)).toBe(1);
  expect(checks.filter((check) => check.status === "FAIL")).toHaveLength(4);
});

test.each([undefined, "false"])(
  "native preflight rejects missing or disabled official API Namespace admission: %s",
  async (admission) => {
    const f = clusterFixture();
    if (admission === undefined) delete f.namespace.metadata.labels["ate.dev/api-access"];
    else f.namespace.metadata.labels["ate.dev/api-access"] = admission;
    const checks = await runPreflight(
      { configuration: f.configuration, releaseNamespace: "factory" },
      f.run,
    );
    expect(preflightExitCode(checks)).toBe(1);
    expect(checks.find((check) => check.id === "release.namespace")?.status).toBe("FAIL");
    expect(checks.filter((check) => check.status === "PASS")).toHaveLength(3);
    expect(f.calls.every((args) => args[0] === "get")).toBe(true);
  },
);

test("preflight CLI requires the normal native configuration and does not accept obsolete worker/probe switches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-preflight-"));
  const file = join(directory, "configuration.json");
  const env = {
    FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: file,
    FACTORY_PREFLIGHT_NAMESPACE: "factory",
    FACTORY_FORGEJO_PUBLIC_URL: "https://git.example",
    FACTORY_FORGEJO_API_URL: "http://forgejo.factory.svc:3000/api/v1/",
  };
  try {
    await writeFile(file, JSON.stringify(nativeInstallationFixture()));
    expect(preflightOptionsFromArguments(["--json"], env).json).toBe(true);
    expect(
      preflightOptionsFromArguments(
        ["--configuration", file, "--storage-class", "owned-posix"],
        env,
      ).storageClass,
    ).toBe("owned-posix");
    for (const args of [
      ["--read-only"],
      ["--architecture", "arm64"],
      ["--image", "legacy"],
      ["--probe-timeout-seconds", "10"],
    ])
      expect(() => preflightOptionsFromArguments(args, env)).toThrow();
    expect(() => preflightOptionsFromArguments([], {})).toThrow("FACTORY_SUBSTRATE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [true, false],
  [true, true],
  [false, false],
])(
  "preflight CLI preserves operator selection or cleans its projected connection, serviceAccount=%s, observation failure=%s",
  async (serviceAccount, observationFails) => {
    const directory = await mkdtemp(join(tmpdir(), "native-preflight-client-"));
    const configurationFile = join(directory, "configuration.json");
    const operatorFile = join(directory, "operator.json");
    const traceFile = join(directory, "commands.jsonl");
    const operatorConfiguration = '{"operator":"must remain unchanged"}';
    const f = clusterFixture();
    const resources = {
      sandboxconfig: f.sandbox,
      workerpools: { items: [f.pool] },
      nodes: { items: [f.node] },
      pods: { items: [f.worker] },
      namespace: f.namespace,
      storageclasses: f.storage,
    };
    try {
      await writeFile(configurationFile, JSON.stringify(f.configuration));
      await writeFile(operatorFile, operatorConfiguration, { mode: 0o600 });
      await writeFile(
        join(directory, "kubectl"),
        `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const file = process.env.KUBECONFIG;
appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ args, file }) + "\\n");
if (${serviceAccount}) {
assert.notEqual(file, ${JSON.stringify(operatorFile)});
assert.equal(statSync(file).mode & 0o777, 0o600);
assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
const config = JSON.parse(readFileSync(file, "utf8"));
assert.deepEqual(config.clusters, [{ name: "factory", cluster: {
  server: "https://10.43.0.1:443",
  "certificate-authority": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
} }]);
assert.deepEqual(config.users, [{ name: "factory", user: {
  tokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token"
} }]);
assert.deepEqual(config.contexts, [{ name: "factory", context: { cluster: "factory", user: "factory" } }]);
assert.equal(config["current-context"], "factory");
assert.deepEqual(args.slice(0, 4), ["--context", "factory", "--request-timeout=10s", "get"]);
for (const name of ["FACTORY_AUTH_SECRET", "FACTORY_MODEL_API_KEY", "FACTORY_DATABASE_URL"])
  assert.equal(process.env[name], undefined);
} else {
  assert.equal(file, ${JSON.stringify(operatorFile)});
  assert.equal(readFileSync(file, "utf8"), ${JSON.stringify(operatorConfiguration)});
  assert.deepEqual(args.slice(0, 4), ["--context", "operator", "--request-timeout=10s", "get"]);
}
const resources = ${JSON.stringify(resources)};
if (${observationFails} && args[4] === "namespace") process.exit(1);
assert.ok(Object.hasOwn(resources, args[4]));
console.log(JSON.stringify(resources[args[4]]));
`,
        { mode: 0o700 },
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/kubernetes/preflight.ts",
          ...(serviceAccount ? ["--service-account"] : []),
          "--json",
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            KUBECONFIG: operatorFile,
            FACTORY_KUBERNETES_CONTEXT: "operator",
            KUBERNETES_SERVICE_HOST: "10.43.0.1",
            KUBERNETES_SERVICE_PORT: "443",
            FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: configurationFile,
            FACTORY_PREFLIGHT_NAMESPACE: "factory",
            FACTORY_FORGEJO_PUBLIC_URL: "https://git.example",
            FACTORY_FORGEJO_API_URL: "http://forgejo.factory.svc:3000/api/v1/",
            FACTORY_AUTH_SECRET: "must-not-reach-kubectl",
            FACTORY_MODEL_API_KEY: "must-not-reach-kubectl",
            FACTORY_DATABASE_URL: "must-not-reach-kubectl",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      const checks = JSON.parse(stdout) as Array<{ id: string; status: string }>;
      expect(checks.filter((check) => check.status === "PASS")).toHaveLength(
        observationFails ? 3 : 4,
      );
      expect(
        checks.filter((check) => check.status === "FAIL").map(({ id, status }) => ({ id, status })),
      ).toEqual(observationFails ? [{ id: "release.namespace", status: "FAIL" }] : []);
      expect(exitCode).toBe(observationFails ? 1 : 0);
      const commands = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; file: string });
      expect(commands).toHaveLength(6);
      expect(commands.every((command) => command.args[3] === "get")).toBe(true);
      expect(new Set(commands.map((command) => command.file)).size).toBe(1);
      if (serviceAccount)
        for (const command of commands) await expect(access(command.file)).rejects.toThrow();
      expect(await readFile(operatorFile, "utf8")).toBe(operatorConfiguration);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
