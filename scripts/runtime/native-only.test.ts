import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type Execute,
  images,
  type LoadedFixture,
  rehearse,
  requiredTables,
  resourcePlan,
} from "../kubernetes/restore-rehearsal";

test("runtime conformance runs only the explicit official Substrate proofs and exposes no legacy cleanup command", async () => {
  const manifest = await Bun.file("package.json").json();
  expect(manifest.scripts["runtime:conformance"]).toBe(
    "bun run test:native substrate-adapter.native substrate-workspaces.native",
  );
  expect(manifest.scripts["runtime:smoke:down"]).toBeUndefined();
  for (const path of [
    "deploy/factorybox/release.json",
    "deploy/factorybox/release-amd64.json",
    "scripts/runtime/conformance.ts",
    "scripts/runtime/conformance-resources.ts",
    "scripts/runtime/factorybox-conformance.ts",
    "scripts/runtime/factorybox-build.ts",
    "scripts/runtime/factorybox-publish.ts",
    "scripts/runtime/factorybox-worker.ts",
    "scripts/runtime/benchmark.ts",
    "packages/runtime-kubernetes/src/manifest.ts",
    "packages/runtime-kubernetes/src/reserve.ts",
    "packages/runtime-kubernetes/src/source-forward.ts",
    "packages/runtime-domain/src/reserve.ts",
    "test/fixtures/verification-pool-cluster.ts",
    "test/fixtures/verification-pool-registry.ts",
    "test/fixtures/factorybox-runtime.ts",
    "test/fixtures/factorybox-cleanup.ts",
  ])
    expect(await Bun.file(path).exists(), path).toBe(false);
});

test("live native proofs have no private-kernel exec or legacy worker database path", async () => {
  for (const path of [
    "test/browser/workspace-startup.live.spec.ts",
    "test/integration/project-environments.live.test.ts",
    "test/integration/external-factory-mcp.live.test.ts",
    "test/fixtures/publication-runtime.ts",
    "test/integration/native-publication.live.test.ts",
  ]) {
    const source = await readFile(path, "utf8");
    expect(
      /factorybox_|factorybox-runtime|sysbox-runc|runtime_artifact_intent|kubernetes_namespace/.test(
        source,
      ),
      path,
    ).toBe(false);
  }
  const paths: string[] = [];
  for (const pattern of ["factorybox*.ts", "factorybox/**/*"])
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: "packages/runtime-kubernetes/src",
      onlyFiles: true,
    }))
      paths.push(path);
  expect(paths.filter((path) => !path.includes("/__pycache__/"))).toEqual([]);
});

test("native startup has no cluster metrics-server installation dependency", async () => {
  const [launcher, upstream] = await Promise.all([
    readFile("scripts/factory/index.ts", "utf8"),
    Bun.file("upstream.json").json(),
  ]);
  expect(launcher.includes("ensureLocalMetricsServer")).toBe(false);
  expect(upstream.metricsServer).toBeUndefined();
  expect(await Bun.file("scripts/factory/metrics-server.ts").exists()).toBe(false);
  expect(await Bun.file("deploy/metrics-server/components.yaml").exists()).toBe(false);
});

test("Greenfield Source exposes no operator rescue for failed disposable fixtures", async () => {
  for (const path of [
    "apps/factory/src/workspace/substrate-source-preservation.ts",
    "services/runtime-connector/connector/native_source_preserve_linux.go",
    "services/runtime-connector/connector/native_source_preserve_linux_test.go",
    "services/runtime-connector/workspacefiles/retained_lockfile_linux_test.go",
    "test/integration/substrate-source-preservation.test.ts",
  ])
    expect(await Bun.file(path).exists(), path).toBe(false);
  for (const path of [
    "apps/factory/src/workspace/substrate-source.ts",
    "apps/factory/src/workspace/source-controller.ts",
    "apps/factory/src/server/protocols/internal.ts",
    "services/runtime-connector/cmd/factory-runtime-connector/main.go",
    "services/runtime-connector/connector/native_parent_other.go",
    "services/runtime-connector/workspacefiles/bundle_linux.go",
  ])
    expect(await readFile(path, "utf8"), path).not.toMatch(
      /nativePreservation|preservationEndpoint|RunSubstrateSourcePreserve|ExportRetainedLockfileBundle|MaterializeRetainedLockfileBundle|retainedRootLockfile/,
    );
});

test("release tooling exposes no Factorybox upgrade, soak or identity-rewriting restore programme", async () => {
  const manifest = await Bun.file("package.json").json();
  for (const name of ["release:upgrade-test", "release:soak", "restore:rehearsal"])
    expect(manifest.scripts[name], name).toBeUndefined();
  for (const path of [
    "scripts/release/upgrade-test.ts",
    "scripts/release/upgrade-test-model.ts",
    "scripts/release/upgrade-test-browser.ts",
    "scripts/release/soak.ts",
    "scripts/release/soak-ui-cycle.ts",
    "scripts/release/soak-wiki.ts",
    "scripts/release/soak-journey.ts",
    "scripts/kubernetes/restore-rehearsal-model.ts",
    "scripts/kubernetes/restore-rehearsal-cluster.ts",
  ])
    expect(await Bun.file(path).exists(), path).toBe(false);
  expect(await Bun.file("scripts/kubernetes/restore-check.ts").exists()).toBe(true);
});

// Exercise the real orchestration with a command recorder, not a daemon or a private backup.
// Only its evidence journal is written locally. All restore/service commands are mocked.
async function observeIsolatedRehearsal(changedTable?: string) {
  const root = await mkdtemp(join(tmpdir(), "factory-native-restore-guard-"));
  const source = Object.freeze({
    chartRevision: "39d7969bb3acd93d0bc497a5748cce08ae435091",
    applicationRevision: "089ca64dbc9ab48f3b452151a2d694d7aabe3a10",
    namespace: "retained-factory",
    namespaceUID: "c4262638-6225-4915-b1bb-eff6ad2aaed2",
    release: "factory",
    factoryOrigin: "https://factory.example.invalid",
    forgejoOrigin: "https://git.example.invalid",
    storageClass: "retained",
  });
  const postgres = Object.freeze(
    Object.fromEntries(
      requiredTables.map((table) => [table, Object.freeze({ rows: 1, sha256: "1".repeat(64) })]),
    ),
  );
  const fixture: LoadedFixture = {
    schema: 1,
    owner: "a".repeat(32),
    source,
    set: "20261117T100209Z",
    privateRoot: join(root, "mock-input"),
    evidenceDirectory: join(root, "evidence"),
    docker: {
      host: "unix:///mock-only/docker.sock",
      daemonID: "mock-owned-daemon",
      platform: "linux/arm64",
    },
    retained: { paths: [], containers: [], volumes: [], networks: [] },
    images,
    limits: {
      memoryMiB: 512,
      cpus: 1,
      pids: 128,
      tmpfsMiB: 64,
      commandTimeoutSeconds: 3600,
      requiredDiskBytes: 1,
      availableDiskBytes: 1024,
    },
    witnessDigest: "2".repeat(64),
    witnesses: Object.freeze({
      schema: 1,
      owner: "a".repeat(32),
      source,
      set: "20261117T100209Z",
      provenance: "independent-source-observation",
      parts: {},
      postgres,
      forgejo: { tables: {}, files: [], repositories: ["repos/owned/project.git"] },
      state: {
        files: [],
        excludedProvisionerPaths: [],
        credentialReview: "no-native-provisioner-material-in-included-files" as const,
      },
      objects: [],
      openbao: [],
    }),
  };
  Object.freeze(fixture);
  const original = JSON.stringify({ source, postgres });
  const observed: LoadedFixture["witnesses"]["postgres"] = structuredClone(postgres);
  if (changedTable) observed[changedTable] = { rows: 1, sha256: "3".repeat(64) };
  const calls: { command: string[]; input: unknown }[] = [];
  type Resource = {
    id: string;
    name: string;
    created: string;
    labels: Record<string, string>;
    internal: boolean;
  };
  const resources = new Map<string, Resource>();
  const ids = new Map<string, string>();
  const execute: Execute = async (command, options) => {
    calls.push({ command, input: options?.input });
    const args = command.slice(5);
    const [kind, operation] = args;
    let stdout = "";
    if (kind === "info")
      stdout = JSON.stringify({ id: fixture.docker.daemonID, cpus: 8, memory: 8 * 1024 ** 3 });
    else if (kind === "image") stdout = fixture.docker.platform;
    else if (operation === "inspect") {
      const target = args.at(-1);
      const found = [...resources.values()].find((r) => r.name === target || r.id === target);
      if (!found) return { code: 1, stdout: "", stderr: `Error: No such ${kind}: ${target}` };
      stdout = JSON.stringify(found);
    } else if (operation === "create") {
      const name =
        kind === "container" ? (args[args.indexOf("--name") + 1] ?? "") : (args.at(-1) ?? "");
      const labels: Record<string, string> = {};
      args.forEach((value, i) => {
        if (value !== "--label") return;
        const label = args[i + 1] ?? "";
        const equals = label.indexOf("=");
        labels[label.slice(0, equals)] = label.slice(equals + 1);
      });
      const id = kind === "volume" ? name : (resources.size + 1).toString(16).padStart(64, "0");
      resources.set(name, {
        id,
        name,
        created: "mock-original",
        labels,
        internal: args.includes("--internal"),
      });
      ids.set(name, id);
      stdout = id;
    } else if (operation === "rm") {
      for (const [name, resource] of resources)
        if (resource.id === args.at(-1)) resources.delete(name);
    } else if (
      kind === "exec" &&
      typeof options?.input === "string" &&
      options.input.includes("PG_WITNESS")
    )
      stdout = JSON.stringify(observed);
    return { code: 0, stdout, stderr: "" };
  };
  try {
    const receipt = await rehearse(fixture, execute);
    expect(JSON.stringify({ source, postgres })).toBe(original);
    expect(receipt.source).toEqual(source);
    expect(receipt.nativeActivation).toBe("not-run-not-qualified");
    expect(receipt.cleanup).toBe("confirmed");
    expect(resources.size).toBe(0);
    return { fixture, receipt, calls, ids };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("isolated restore launches only quarantined data services and offline clients, never Factory reconcilers", async () => {
  const { fixture, receipt, calls, ids } = await observeIsolatedRehearsal();
  expect(receipt.status).toBe("data-services-passed");
  expect(Object.values(receipt.components)).toEqual(Array(5).fill("passed"));
  const upstream = await Bun.file("upstream.json").json();
  const expected: Record<string, string[]> = {
    tools: ["node", upstream.node.image, "-e", "setInterval(()=>{},2147483647)"],
    postgres: [
      "docker-entrypoint.sh",
      images.postgres ?? "",
      "postgres",
      "-c",
      "listen_addresses=",
      "-c",
      "wal_level=logical",
    ],
    forgejo: ["sh", images.forgejo ?? "", "-c", "while :; do sleep 3600; done"],
    garage: [
      "/garage",
      upstream.garage.image,
      "-c",
      "/control/garage.toml",
      "server",
      "--single-node",
      "--default-bucket",
    ],
    rclone: ["sh", upstream.rclone.image, "-c", "while :; do sleep 3600; done"],
    openbao: ["/usr/bin/bao", upstream.openbao.image, "server", "-config=/control/bao.json"],
    "bao-client": ["node", upstream.node.image, "-e", "setInterval(()=>{},2147483647)"],
  };
  for (const role of ["postgres", "forgejo"])
    expect(await readFile(`deploy/helm/factory/templates/${role}.yaml`, "utf8")).toContain(
      images[role] ?? "",
    );
  const plan = resourcePlan(fixture);
  const byName = new Map(plan.map((r) => [r.name, r]));
  const byID = new Map(plan.map((r) => [ids.get(r.name), r]));
  const volumeNames = new Set(plan.filter((r) => r.kind === "volume").map((r) => r.name));
  const operations = new Set([
    "info",
    "image inspect",
    ...["network", "volume", "container"].flatMap((kind) =>
      ["inspect", "create", "rm", ...(kind === "container" ? ["start", "stop"] : [])].map(
        (operation) => `${kind} ${operation}`,
      ),
    ),
    "exec",
  ]);
  const launched: string[] = [];
  for (const { command, input } of calls) {
    expect(command.slice(0, 5)).toEqual([
      "docker",
      "--config",
      fixture.privateRoot,
      "--host",
      fixture.docker.host,
    ]);
    const args = command.slice(5);
    const operation =
      args[0] === "info" || args[0] === "exec" ? args[0] : args.slice(0, 2).join(" ");
    expect(operations.has(operation), operation).toBe(true);
    if (args[0] === "image") expect(Object.values(images)).toContain(args.at(-1) ?? "");
    const kind = args[0];
    if (kind === "network" || kind === "volume" || kind === "container") {
      const target = args.at(-1) ?? "";
      if (args[1] !== "create")
        expect((byID.get(target) ?? byName.get(target))?.kind, target).toBe(kind);
      else if (kind !== "container") expect(byName.get(target)?.kind, target).toBe(kind);
    }
    if (args[0] === "container" && args[1] === "create") {
      const role = byName.get(args[args.indexOf("--name") + 1] ?? "")?.key ?? "";
      launched.push(role);
      expect(args.slice(args.indexOf("--entrypoint") + 1), role).toEqual(expected[role] ?? []);
      expect(args[args.indexOf("--entrypoint") + 2]).toMatch(/@sha256:[a-f0-9]{64}$/);
      const network = args[args.indexOf("--network") + 1];
      expect(network, role).toBe(
        role === "garage" || role === "rclone"
          ? plan.find((r) => r.key === "network")?.name
          : role === "bao-client"
            ? `container:${ids.get(plan.find((r) => r.key === "openbao")?.name ?? "")}`
            : "none",
      );
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop=ALL");
      expect(args[args.indexOf("--pull") + 1]).toBe("never");
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--mount") continue;
        const mount = args[i + 1] ?? "";
        if (mount.startsWith("type=bind,")) {
          expect(role).toBe("tools");
          expect(mount).toBe(`type=bind,src=${fixture.privateRoot},dst=/input,readonly`);
        } else {
          expect(mount.split(",")[0]).toBe("type=volume");
          expect(volumeNames.has(mount.split(",")[1]?.slice(4) ?? ""), mount).toBe(true);
        }
      }
      for (const arg of args)
        expect(arg).not.toMatch(
          /^--(?:publish(?:-all)?|privileged|pid|ipc|device|volumes-from|volume)(?:=|$)|^--mount=|^-[pPv]$/,
        );
    }
    if (args[0] === "exec") {
      const target = byID.get(args[2]);
      expect(target?.kind).toBe("container");
      const role = target?.key ?? "";
      expect(args.slice(3), role).toEqual(
        role === "tools" || role === "bao-client"
          ? ["node", "--input-type=module"]
          : [role === "postgres" ? "bash" : "sh", "-s"],
      );
      expect(typeof input).toBe("string");
      if (role === "forgejo")
        expect(input).toBe(`set -eu
export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
git --git-dir='/var/lib/gitea/git/repositories/owned/project.git' fsck --full --strict >/dev/null 2>&1
`);
    }
  }
  expect(launched.sort()).toEqual(Object.keys(expected).sort());
  // Check real runtime imports, including embedded clients' dynamic imports, not source keywords.
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(
    await readFile("scripts/kubernetes/restore-rehearsal.ts", "utf8"),
  );
  const allowed = new Set([
    "../../upstream.json",
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:zlib",
    "node:sqlite",
    "node:https",
  ]);
  for (const entry of imports) expect(allowed.has(entry.path), entry.path).toBe(true);
});

test.each([
  "factory.substrate_binding",
  "factory.substrate_source",
  "factory.substrate_capacity_installation",
  "factory.change_writer",
])(
  "isolated restore rejects a changed %s digest instead of rebinding native identity",
  async (table) => {
    const { fixture, receipt } = await observeIsolatedRehearsal(table);
    expect(fixture.witnesses.postgres[table]?.rows).toBe(1);
    expect(receipt.status).toBe("incomplete");
    expect(receipt.components.postgres).toBe("failed");
    expect(receipt.components.state).toBe("passed");
    expect(receipt.components.openbao).toBe("passed");
  },
);

test("remaining release implementations do not query retired runtime tables or inspect Factorybox workers", async () => {
  const scanner = new Bun.Transpiler({ loader: "ts" });
  for await (const path of new Bun.Glob("*.ts").scan("scripts/release")) {
    if (path.endsWith(".test.ts")) continue;
    const source = await readFile(`scripts/release/${path}`, "utf8");
    expect(
      /factory\.(factorybox_worker|workspace_source)|factory\.dev\/factorybox-worker/.test(source),
      path,
    ).toBe(false);
    for (const entry of scanner.scanImports(source))
      expect(entry.path, path).not.toMatch(/restore-rehearsal|upgrade-test|\/soak/);
  }
});

test("the Factory application import graph has no legacy execution or Source Pod adapter", async () => {
  const root = resolve(".");
  const pending = [resolve("apps/factory/src/server/application.ts")];
  const visited = new Set<string>();
  const scanners = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  while (pending.length) {
    const path = pending.pop();
    if (!path || visited.has(path) || path.endsWith(".json")) continue;
    visited.add(path);
    expect(path).not.toMatch(
      /\/packages\/(?:runtime-kubernetes|runtime-domain)\/src\/(?:factorybox[^/]*|manifest|reserve|source-manifest|source-forward|metrics)\.ts$/,
    );
    const scanner = path.endsWith(".tsx") ? scanners.tsx : scanners.ts;
    for (const entry of scanner.scanImports(await readFile(path, "utf8"))) {
      if (!entry.path.startsWith(".")) continue;
      const base = resolve(dirname(path), entry.path);
      if (!base.startsWith(`${root}/`)) throw Error("Application import left its repository");
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, `${base}/index.ts`];
      let found: string | undefined;
      for (const candidate of candidates)
        if (await Bun.file(candidate).exists()) {
          found = candidate;
          break;
        }
      if (!found) throw Error(`Unresolved application import ${entry.path} in ${path}`);
      pending.push(found);
    }
  }
  expect(visited.has(resolve("apps/factory/src/runtime/substrate.ts"))).toBe(true);
  expect(visited.has(resolve("packages/runtime-kubernetes/src/developer-ide.ts"))).toBe(true);
});
