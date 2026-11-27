import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Fixture, images, requiredTables, type Witnesses } from "./restore-rehearsal";
import {
  matchesRestoreSourceContract,
  restoreContractDigest,
  reviewedRestoreContract,
  reviewedRestoreContracts,
} from "./restore-source-contract";

const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

async function fixtureRevision() {
  const source = resolve(import.meta.dir, "../..");
  for (const reviewed of reviewedRestoreContracts) {
    try {
      if ((await localGit(source, ["cat-file", "-t", reviewed.revision])) === "commit")
        return { revision: reviewed.revision, reviewed };
    } catch {
      // The exact reviewed commit can be absent in a shallow checkout.
    }
  }
  const current = await localGit(source, ["rev-parse", "--verify", "HEAD"]);
  if (!(await matchesRestoreSourceContract(source, current, current)))
    throw Error("Restore tests need a reviewed baseline or a content-equivalent local commit");
  const chart = await restoreContractDigest(source, current, "chart");
  const application = await restoreContractDigest(source, current, "application");
  const reviewed = reviewedRestoreContracts.find(
    (entry) => entry.chart === chart && entry.application === application,
  );
  if (!reviewed) throw Error("The shallow fixture has no matching reviewed content pair");
  return { revision: current, reviewed };
}

const { revision: baseline, reviewed: baselineContract } = await fixtureRevision();

async function localGit(repository: string, args: string[], input?: string) {
  const child = Bun.spawn(
    ["git", "--no-replace-objects", "-c", "protocol.allow=never", "-C", repository, ...args],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_AUTHOR_NAME: "Offline restore test",
        GIT_AUTHOR_EMAIL: "restore-test@example.invalid",
        GIT_COMMITTER_NAME: "Offline restore test",
        GIT_COMMITTER_EMAIL: "restore-test@example.invalid",
        GIT_AUTHOR_DATE: "2026-11-19T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-11-19T00:00:00Z",
      },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`Local test Git failed: ${stderr}`);
  return stdout.trim();
}

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "factory-restore-contract-test-")));
  try {
    // Reuse only read-only committed objects, not a checkout or private restore fixtures.
    // This test deliberately requires the reviewed baseline object to be available locally.
    const objects = await localGit(resolve(import.meta.dir, "../.."), [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    await localGit(root, ["init", "--template=", "--initial-branch=offline-test"]);
    await writeFile(join(root, ".git/objects/info/alternates"), `${objects}\n`);
    const commit = async (
      changes: { path: string; value?: string; mode?: string; oid?: string }[],
      parent = baseline,
    ) => {
      await localGit(root, ["read-tree", parent]);
      for (const change of changes) {
        if (change.value === undefined && change.oid === undefined) {
          await localGit(root, ["update-index", "--force-remove", "--", change.path]);
          continue;
        }
        const oid =
          change.oid ??
          (await localGit(root, ["hash-object", "-w", "--stdin"], change.value ?? ""));
        await localGit(root, [
          "update-index",
          "--add",
          "--cacheinfo",
          `${change.mode ?? "100644"},${oid},${change.path}`,
        ]);
      }
      const tree = await localGit(root, ["write-tree", "--missing-ok"]);
      return localGit(root, ["commit-tree", tree, "-p", parent], "offline source contract test\n");
    };
    const admitted = await commit([
      { path: "README.md", value: "Only human docs changed\n" },
      { path: "deploy/helm/factory/README.md", value: "Only chart docs changed\n" },
      { path: "scripts/kubernetes/restore-rehearsal.ts", value: "// verifier-only successor\n" },
      { path: "scripts/kubernetes/restore-source-contract.ts", value: "// new verifier only\n" },
      { path: "scripts/kubernetes/restore-source-contract.test.ts", value: "// test only\n" },
      { path: "scripts/kubernetes/restore-zero-projects.ts", value: "// restore reader only\n" },
      { path: "scripts/kubernetes/restore-zero-projects.test.ts", value: "// reader test only\n" },
    ]);
    return {
      root,
      commit,
      admitted,
      matches: (chart = admitted, application = admitted) =>
        matchesRestoreSourceContract(root, chart, application),
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("real local committed objects reproduce both static baseline SHA-256 contracts", async () => {
  const repo = await repository();
  try {
    for (const contract of ["chart", "application"] as const)
      expect(await restoreContractDigest(repo.root, baseline, contract)).toBe(
        baselineContract[contract],
      );
    expect(await repo.matches(baseline, baseline)).toBe(true);
    expect(await repo.matches()).toBe(true);
    // Different source SHAs must still match the same reviewed content pair.
    expect(await repo.matches(baseline, repo.admitted)).toBe(true);
    expect(await repo.matches(repo.admitted, baseline)).toBe(true);
  } finally {
    await repo.close();
  }
});

test.each([
  "apps/factory/src/restore-contract-new-code.ts",
  "apps/factory/src/agent/opencode-terminal.ts",
  "apps/factory/src/agent/terminal-outcome.ts",
  "apps/factory/src/models/relay.ts",
  "packages/db/migrations/0001_baseline.sql",
  "apps/factory/src/delivery/controller.ts",
  "apps/factory/src/desktop/ticket-commands.ts",
  "test/integration/terminal-checkpoint-restore.test.ts",
  "test/integration/delivery-recovery.test.ts",
  "test/fixtures/change-agent-turns.ts",
  "apps/factory/src/desktop/ticket-commands.test.ts",
  "test/fixtures/promotion-retry.ts",
  "test/browser/implementation-journey.spec.ts",
  "scripts/kubernetes/backup.test.ts",
  "test/integration/backup-runner.native.test.ts",
  "packages/restore-contract-new-package.ts",
  "services/restore-contract-new-service.go",
  "deploy/opencode-server/config/AGENTS.md",
  "scripts/owned-client-process.ts",
  "scripts/kubernetes/start.ts",
  "package.json",
  "bun.lock",
  "upstream.json",
  "mise.toml",
  ".mise.toml",
  "tsconfig.base.json",
  ".dockerignore",
  "templates/starter-app/package.json",
  "scripts/factory/framework-image-proof.ts",
  "apps/factory/public/art/README.md",
  "scripts/kubernetes/unknown-restore.test.ts",
  "scripts/kubernetes/restore-source-contract-new.ts",
  "unknown-production-root.sh",
] as const)("real committed application change in %s refuses", async (path) => {
  const repo = await repository();
  try {
    const changed = await repo.commit([{ path, value: "changed committed production bytes\n" }]);
    expect(await repo.matches(repo.admitted, changed)).toBe(false);
  } finally {
    await repo.close();
  }
});

test.each([
  "deploy/helm/factory/Chart.yaml",
  "deploy/helm/factory/values.yaml",
  "deploy/helm/factory/values.local.yaml",
  "deploy/helm/factory/templates/factory.yaml",
  "deploy/helm/factory/templates/preflight.yaml",
  "deploy/helm/factory/files/backup/forgejo.sh",
  "deploy/helm/factory/files/backup/common.sh",
  "deploy/helm/factory/files/backup/foreign-keys.sql",
  "deploy/helm/factory/templates/new-test-only.yaml",
] as const)("real committed chart change in %s refuses", async (path) => {
  const repo = await repository();
  try {
    const changed = await repo.commit([{ path, value: "changed committed chart bytes\n" }]);
    expect(await repo.matches(changed, repo.admitted)).toBe(false);
    // The independently selected application contract deliberately excludes chart files.
    expect(await repo.matches(repo.admitted, changed)).toBe(true);
  } finally {
    await repo.close();
  }
});

test("additional content profiles retain the historical fingerprint", () => {
  expect(reviewedRestoreContracts[0]).toBe(reviewedRestoreContract);
  expect(reviewedRestoreContract).toEqual({
    revision: "509a72684ef9961f22ad3cd857e0ac5c3062a4fa",
    chart: "66ee75748e01f963fa94bb73dc470cd2149a29a5b2d2af42576a0c4f99abfc18",
    application: "48f400353073eb34ba67cd50ba2e81a55adce3d87bacd996a93acd66533522a6",
  });
  expect(Object.isFrozen(reviewedRestoreContracts)).toBe(true);
  expect(reviewedRestoreContracts.every(Object.isFrozen)).toBe(true);
});

test("every available reviewed source and the selected shallow fixture retain admission", async () => {
  const source = resolve(import.meta.dir, "../..");
  const revisions = new Set([baseline, ...reviewedRestoreContracts.map((entry) => entry.revision)]);
  let observed = 0;
  for (const revision of revisions) {
    try {
      await localGit(source, ["cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      // Missing historical objects are not positive results; baseline must exist.
      continue;
    }
    expect(await matchesRestoreSourceContract(source, revision, revision)).toBe(true);
    observed++;
  }
  expect(observed).toBeGreaterThan(0);
});

test("chart and application digests cannot be borrowed from different reviewed pairs", async () => {
  const source = resolve(import.meta.dir, "../..");
  const available = new Map([[baseline, { ...baselineContract, revision: baseline }]]);
  for (const reviewed of reviewedRestoreContracts) {
    try {
      await localGit(source, ["cat-file", "-e", `${reviewed.revision}^{commit}`]);
      available.set(reviewed.revision, reviewed);
    } catch {
      // Missing historical objects do not count as a checked pair.
    }
  }
  let observed = 0;
  for (const chart of available.values()) {
    for (const application of available.values()) {
      const expected = reviewedRestoreContracts.some(
        (reviewed) =>
          reviewed.chart === chart.chart && reviewed.application === application.application,
      );
      expect(await matchesRestoreSourceContract(source, chart.revision, application.revision)).toBe(
        expected,
      );
      observed++;
    }
  }
  expect(observed).toBeGreaterThan(0);
});

test("committed deletions, executable modes, symlinks, submodules and excluded-path mode changes refuse", async () => {
  const repo = await repository();
  try {
    const packageOID = await localGit(repo.root, ["rev-parse", `${baseline}:package.json`]);
    for (const change of [
      { path: "package.json" },
      { path: "package.json", oid: packageOID, mode: "100755" },
      { path: "package.json", value: "another-file", mode: "120000" },
      { path: "README.md", value: "another-file", mode: "120000" },
      { path: "scripts/kubernetes/restore-rehearsal.ts", value: "executable", mode: "100755" },
      { path: "unknown-submodule", oid: baseline, mode: "160000" },
    ])
      expect(await repo.matches(repo.admitted, await repo.commit([change]))).toBe(false);
    const noChart = await repo.commit([{ path: "deploy/helm/factory/Chart.yaml" }]);
    expect(await repo.matches(noChart, repo.admitted)).toBe(false);
    const missingBlob = await repo.commit([{ path: "package.json", oid: "e".repeat(40) }]);
    expect(await repo.matches(repo.admitted, missingBlob)).toBe(false);
    const linkedChartDoc = await repo.commit([
      { path: "deploy/helm/factory/README.md", value: "values.yaml", mode: "120000" },
    ]);
    expect(await repo.matches(linkedChartDoc, repo.admitted)).toBe(false);
  } finally {
    await repo.close();
  }
});

test("only exact local commit SHA objects qualify, never names, rev expressions or missing objects", async () => {
  const repo = await repository();
  try {
    const tree = await localGit(repo.root, ["rev-parse", `${baseline}^{tree}`]);
    const blob = await localGit(repo.root, ["rev-parse", `${baseline}:package.json`]);
    const tag = await localGit(
      repo.root,
      ["mktag"],
      `object ${baseline}\ntype commit\ntag offline-tag\ntagger Test <test@example.invalid> 1795046400 +0000\n\nlocal tag\n`,
    );
    await localGit(repo.root, ["update-ref", "refs/heads/equivalent", repo.admitted]);
    for (const invalid of [
      "HEAD",
      "equivalent",
      "refs/heads/equivalent",
      repo.admitted.slice(0, 12),
      repo.admitted.toUpperCase(),
      `${repo.admitted}^{commit}`,
      `${repo.admitted}~0`,
      ` ${repo.admitted}`,
      "--all",
      "",
      "f".repeat(40),
      tree,
      blob,
      tag,
    ]) {
      expect(await repo.matches(invalid, repo.admitted)).toBe(false);
      expect(await repo.matches(repo.admitted, invalid)).toBe(false);
    }
    // With no baseline objects available, matching names or a working copy cannot help.
    await rm(join(repo.root, ".git/objects/info/alternates"));
    expect(await repo.matches()).toBe(false);
  } finally {
    await repo.close();
  }
});

test("HEAD, the index, dirty working files, replacement refs and inherited Git overrides do not authorize a source", async () => {
  const repo = await repository();
  try {
    const changed = await repo.commit([{ path: "package.json", value: "unreviewed\n" }]);
    await localGit(repo.root, ["update-ref", "HEAD", changed]);
    await localGit(repo.root, ["replace", changed, repo.admitted]);
    await writeFile(join(repo.root, "package.json"), "dirty working copy\n");
    const before = await readFile(join(repo.root, ".git/index"));
    expect(await repo.matches()).toBe(true);
    expect(await repo.matches(repo.admitted, changed)).toBe(false);
    expect(await readFile(join(repo.root, ".git/index"))).toEqual(before);
    const inherited = {
      GIT_DIR: process.env["GIT_DIR"],
      GIT_OBJECT_DIRECTORY: process.env["GIT_OBJECT_DIRECTORY"],
      GIT_CONFIG_COUNT: process.env["GIT_CONFIG_COUNT"],
      GIT_CONFIG_KEY_0: process.env["GIT_CONFIG_KEY_0"],
      GIT_CONFIG_VALUE_0: process.env["GIT_CONFIG_VALUE_0"],
    };
    try {
      process.env["GIT_DIR"] = join(repo.root, "does-not-exist");
      process.env["GIT_OBJECT_DIRECTORY"] = join(repo.root, "does-not-exist");
      process.env["GIT_CONFIG_COUNT"] = "1";
      process.env["GIT_CONFIG_KEY_0"] = "core.repositoryformatversion";
      process.env["GIT_CONFIG_VALUE_0"] = "9999";
      expect(await repo.matches()).toBe(true);
      expect(await repo.matches(repo.admitted, changed)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    await repo.close();
  }
});

async function contentFixture(repo: Awaited<ReturnType<typeof repository>>) {
  // Load the real candidate helper from this temporary repository so its fixed repository
  // selection is exercised without adding a repository/fingerprint input to fixture.json.
  await mkdir(join(repo.root, "scripts/kubernetes"), { recursive: true });
  for (const name of ["restore-rehearsal.ts", "restore-source-contract.ts"])
    await writeFile(
      join(repo.root, "scripts/kubernetes", name),
      await readFile(join(import.meta.dir, name)),
    );
  await writeFile(
    join(repo.root, "upstream.json"),
    await readFile(resolve(import.meta.dir, "../../upstream.json")),
  );
  await mkdir(join(repo.root, "deploy/helm/factory"), { recursive: true });
  await writeFile(
    join(repo.root, "deploy/helm/factory/image-pins.json"),
    await readFile(resolve(import.meta.dir, "../../deploy/helm/factory/image-pins.json")),
  );
  const { loadFixture } = await import(join(repo.root, "scripts/kubernetes/restore-rehearsal.ts"));
  const privateRoot = join(repo.root, "private");
  const owner = "a".repeat(32);
  const set = "20261117T100209Z";
  for (const directory of [
    privateRoot,
    join(privateRoot, set),
    join(privateRoot, "objects"),
    join(privateRoot, "tls"),
  ])
    await mkdir(directory, { mode: 0o700 });
  const parts: Record<string, string> = {};
  for (const name of ["postgres.dump", "forgejo.tar.gz", "state.tar.gz", "openbao.snap"]) {
    await writeFile(join(privateRoot, set, name), "synthetic bytes", { mode: 0o600 });
    parts[name] = hash("synthetic bytes");
  }
  await writeFile(join(privateRoot, set, "COMPLETE"), "", { mode: 0o600 });
  for (const name of ["ca.crt", "tls.crt", "tls.key"])
    await writeFile(join(privateRoot, "tls", name), "synthetic unused TLS bytes", { mode: 0o600 });
  const source = {
    chartRevision: baseline,
    applicationRevision: repo.admitted,
    namespace: "retained-factory",
    namespaceUID: "c4262638-6225-4915-b1bb-eff6ad2aaed2",
    release: "factory",
    factoryOrigin: "https://factory.example.invalid",
    forgejoOrigin: "https://git.example.invalid",
    storageClass: "retained",
  };
  const value: Fixture = {
    schema: 1,
    owner,
    source: { ...source },
    set,
    privateRoot,
    evidenceDirectory: join(repo.root, "evidence"),
    docker: {
      host: "unix:///unused/docker.sock",
      daemonID: "unused-daemon",
      platform: "linux/arm64",
    },
    retained: { paths: [join(repo.root, "retained")], containers: [], volumes: [], networks: [] },
    images: { ...images },
    limits: {
      memoryMiB: 512,
      cpus: 1,
      pids: 128,
      tmpfsMiB: 64,
      commandTimeoutSeconds: 30,
      requiredDiskBytes: 1024 ** 3,
      availableDiskBytes: 2 * 1024 ** 3,
    },
  };
  const witness: Witnesses = {
    schema: 1,
    owner,
    source: { ...source },
    set,
    provenance: "independent-source-observation",
    parts,
    postgres: Object.fromEntries(
      requiredTables.map((table) => [table, { rows: 0, sha256: hash("") }]),
    ),
    forgejo: {
      tables: { repository: { rows: 0, sha256: hash("") } },
      files: ["forgejo.sqlite3", "forgejo-db.sql", "app.ini"].map((path) => ({
        path,
        bytes: 1,
        sha256: hash("x"),
      })),
      repositories: [],
    },
    state: {
      files: [
        "kubernetes-installation.json",
        "openbao/bootstrap.json",
        "openbao/factory-login.json",
        "ingress-tls/identity.json",
      ].map((path) => ({ path, bytes: 1, sha256: hash("x") })),
      excludedProvisionerPaths: [],
      credentialReview: "no-native-provisioner-material-in-included-files",
    },
    objects: [],
    openbao: [{ path: "factory/data/models/synthetic", sha256: hash("synthetic") }],
  };
  const path = join(privateRoot, "fixture.json");
  const witnessesPath = join(privateRoot, "witnesses.json");
  const save = async () => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await writeFile(witnessesPath, JSON.stringify(witness), { mode: 0o600 });
  };
  await save();
  return {
    value,
    witness,
    path,
    witnessesPath,
    save,
    load: (mode = "run") => loadFixture(path, owner, mode),
  };
}

test("content-profile loader keeps exact independent source revisions and input bytes without creating evidence", async () => {
  const repo = await repository();
  try {
    const f = await contentFixture(repo);
    const fixtureBefore = await readFile(f.path);
    const witnessBefore = await readFile(f.witnessesPath);
    const loaded = await f.load();
    expect(loaded.source).toEqual(f.value.source);
    expect(loaded.witnesses.source).toEqual(f.witness.source);
    expect(loaded.source.chartRevision).not.toBe(loaded.source.applicationRevision);
    expect(loaded.witnessDigest).toBe(hash(JSON.stringify(f.witness)));
    expect(await readFile(f.path)).toEqual(fixtureBefore);
    expect(await readFile(f.witnessesPath)).toEqual(witnessBefore);
    expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
    await mkdir(f.value.evidenceDirectory, { mode: 0o700 });
    await writeFile(join(f.value.evidenceDirectory, "result.json"), "existing receipt", {
      mode: 0o600,
    });
    expect((await f.load("inspect")).source).toEqual(f.value.source);
    expect(await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8")).toBe(
      "existing receipt",
    );
    await expect(f.load()).rejects.toThrow("Evidence destination already exists");
  } finally {
    await repo.close();
  }
});

test.each([
  "witness chart",
  "witness application",
  "witness namespace",
  "witness owner",
  "witness set",
  "destination provenance",
  "missing native witness",
  "missing writer witness",
  "missing CA",
  "empty CA",
  "symlink CA",
  "excluded CA",
  "native credential",
  "changed part",
  "image pin",
  "caller digest",
  "production application",
  "production chart",
] as const)("content-profile loader still refuses %s", async (boundary) => {
  const repo = await repository();
  try {
    const f = await contentFixture(repo);
    if (boundary === "witness chart") f.witness.source.chartRevision = repo.admitted;
    if (boundary === "witness application") f.witness.source.applicationRevision = baseline;
    if (boundary === "witness namespace")
      f.witness.source.namespaceUID = "365f92d0-2e7c-4f76-8728-6e7295cfc84b";
    if (boundary === "witness owner") f.witness.owner = "b".repeat(32);
    if (boundary === "witness set") f.witness.set = "20261118T100209Z";
    if (boundary === "destination provenance")
      Object.assign(f.witness, { provenance: "restored-destination" });
    if (boundary === "missing native witness") delete f.witness.postgres["factory.runtime_attempt"];
    if (boundary === "missing writer witness") delete f.witness.postgres["factory.change_writer"];
    const ca = f.witness.state.files.at(-1);
    if (!ca) throw Error("Synthetic CA witness missing");
    if (boundary === "missing CA") f.witness.state.files.pop();
    if (boundary === "empty CA") ca.bytes = 0;
    if (boundary === "symlink CA") ca.link = "../another";
    if (boundary === "excluded CA") f.witness.state.excludedProvisionerPaths.push(ca.path);
    if (boundary === "native credential")
      f.witness.state.files.push({ path: "native/provisioner-token", bytes: 1, sha256: hash("x") });
    if (boundary === "changed part") f.witness.parts["state.tar.gz"] = "0".repeat(64);
    if (boundary === "image pin") f.value.images["postgres"] = "postgres:16";
    if (boundary === "caller digest")
      Object.assign(f.value.source, { contractSHA256: reviewedRestoreContract.application });
    if (boundary === "production application")
      f.value.source.applicationRevision = f.witness.source.applicationRevision = await repo.commit(
        [{ path: "package.json", value: "changed\n" }],
      );
    if (boundary === "production chart")
      f.value.source.chartRevision = f.witness.source.chartRevision = await repo.commit([
        { path: "deploy/helm/factory/values.yaml", value: "changed\n" },
      ]);
    await f.save();
    const fixtureBefore = await readFile(f.path);
    const witnessBefore = await readFile(f.witnessesPath);
    const expected =
      boundary.startsWith("witness ") || boundary === "destination provenance"
        ? "Witnesses must bind independent source observations"
        : boundary.includes("native witness") || boundary.includes("writer witness")
          ? "Product, Source/Writer and native-binding table witnesses"
          : boundary.endsWith("CA")
            ? "Supported source requires its original witnessed retained state"
            : boundary === "native credential"
              ? "Native provisioner material must never enter destination state"
              : boundary === "changed part"
                ? "Backup part does not match its witness"
                : boundary === "image pin"
                  ? "Only this source's exact pinned data-service/tool images"
                  : boundary === "caller digest"
                    ? "Unexpected private fixture schema"
                    : "Source identity is incomplete or from a different chart";
    await expect(f.load()).rejects.toThrow(expected);
    expect(await readFile(f.path)).toEqual(fixtureBefore);
    expect(await readFile(f.witnessesPath)).toEqual(witnessBefore);
    expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
  } finally {
    await repo.close();
  }
});
