import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
    "scripts/kubernetes/restore-rehearsal.ts",
    "scripts/kubernetes/restore-rehearsal-model.ts",
    "scripts/kubernetes/restore-rehearsal-cluster.ts",
  ])
    expect(await Bun.file(path).exists(), path).toBe(false);
  expect(await Bun.file("scripts/kubernetes/restore-check.ts").exists()).toBe(true);
});

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
