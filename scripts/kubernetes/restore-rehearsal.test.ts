import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Execute,
  forgejoWitnessProgram,
  images,
  invocation,
  loadFixture,
  openBaoRequest,
  postgresWitnessProgram,
  rehearse,
  requiredTables,
  resourcePlan,
  restoreFiles,
  validateForgejoDatabase,
  type Witnesses,
} from "./restore-rehearsal";

const hash = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const owner = "a".repeat(32);
const daemonID = "owned-disposable-docker";
const source = {
  chartRevision: "39d7969bb3acd93d0bc497a5748cce08ae435091",
  applicationRevision: "089ca64dbc9ab48f3b452151a2d694d7aabe3a10",
  namespace: "retained-factory",
  namespaceUID: "c4262638-6225-4915-b1bb-eff6ad2aaed2",
  release: "factory",
  factoryOrigin: "https://factory.example.invalid",
  forgejoOrigin: "https://git.example.invalid",
  storageClass: "retained",
};
const managedSource = {
  ...source,
  chartRevision: "4438e7580db77df3d861e0bcbd5b1f77c914c365",
  applicationRevision: "4438e7580db77df3d861e0bcbd5b1f77c914c365",
};
const upgradedChartSource = {
  ...managedSource,
  chartRevision: "5609f4cd76bd5203c6ad17ae33a330e65614bb9f",
};
const humanSubmissionSource = {
  ...managedSource,
  chartRevision: "62288627d2a5b69d5de7b6c2478199d290a5792b",
  applicationRevision: "62288627d2a5b69d5de7b6c2478199d290a5792b",
};
const startupDispatchSource = {
  ...managedSource,
  chartRevision: "701ceb9258a1afd298080b0a7075c77ebe906e36",
  applicationRevision: "701ceb9258a1afd298080b0a7075c77ebe906e36",
};
const wikiFeedbackSource = {
  ...managedSource,
  chartRevision: "37db8559833c59925bca477fb1a4d1b29feb15d1",
  applicationRevision: "37db8559833c59925bca477fb1a4d1b29feb15d1",
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "factory-restore-test-")));
  const privateRoot = join(root, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  const set = "20261117T100209Z";
  await mkdir(join(privateRoot, set), { mode: 0o700 });
  await mkdir(join(privateRoot, "objects"), { mode: 0o700 });
  await mkdir(join(privateRoot, "tls"), { mode: 0o700 });
  const parts: Record<string, string> = {};
  for (const name of ["postgres.dump", "forgejo.tar.gz", "state.tar.gz", "openbao.snap"]) {
    const bytes = `synthetic unit fixture ${name}`;
    await writeFile(join(privateRoot, set, name), bytes, { mode: 0o600 });
    parts[name] = hash(bytes);
  }
  await writeFile(join(privateRoot, set, "COMPLETE"), "", { mode: 0o600 });
  for (const name of ["ca.crt", "tls.crt", "tls.key"])
    await writeFile(join(privateRoot, "tls", name), "synthetic, never used for TLS", {
      mode: 0o600,
    });
  const witness: Witnesses = {
    schema: 1,
    owner,
    source,
    set,
    provenance: "independent-source-observation",
    parts,
    postgres: Object.fromEntries(
      requiredTables.map((table) => [table, { rows: 0, sha256: hash("") }]),
    ),
    forgejo: {
      tables: { repository: { rows: 0, sha256: hash("") } },
      files: [
        { path: "forgejo.sqlite3", bytes: 8, sha256: hash("snapshot") },
        { path: "forgejo-db.sql", bytes: 3, sha256: hash("sql") },
        { path: "app.ini", bytes: 3, sha256: hash("ini") },
        { path: "repos/owned/project.git/HEAD", bytes: 4, sha256: hash("HEAD") },
      ],
      repositories: ["repos/owned/project.git"],
    },
    state: {
      files: [
        { path: "openbao/bootstrap.json", sha256: hash("bootstrap"), bytes: 9 },
        { path: "openbao/factory-login.json", sha256: hash("login"), bytes: 5 },
        { path: "kubernetes-installation.json", sha256: hash("identity"), bytes: 8 },
      ],
      excludedProvisionerPaths: [],
      credentialReview: "no-native-provisioner-material-in-included-files",
    },
    objects: [],
    openbao: [{ path: "factory/data/models/owned-witness", sha256: hash("private-witness") }],
  };
  const value = {
    schema: 1,
    owner,
    source,
    set,
    privateRoot,
    evidenceDirectory: join(root, "evidence"),
    docker: { host: "unix:///owned/test/docker.sock", daemonID, platform: "linux/arm64" },
    retained: {
      paths: [join(root, "retained")],
      containers: ["retained-postgres"],
      networks: ["retained-network"],
      volumes: ["retained-state"],
    },
    images: { ...images },
    limits: {
      memoryMiB: 512,
      cpus: 1,
      pids: 128,
      tmpfsMiB: 64,
      commandTimeoutSeconds: 3600,
      requiredDiskBytes: 1024 ** 3,
      availableDiskBytes: 2 * 1024 ** 3,
    },
  };
  const path = join(privateRoot, "fixture.json");
  const save = async () => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await writeFile(join(privateRoot, "witnesses.json"), JSON.stringify(witness), { mode: 0o600 });
  };
  await save();
  return {
    root,
    path,
    value,
    witness,
    save,
    load: () => loadFixture(path, owner),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function fakeDocker(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: { command: string[]; input?: string | Uint8Array | Blob; aborted: boolean }[] = [];
  const resources = new Map<string, Record<string, unknown>>();
  let hook: ((command: string[], input: unknown) => void) | undefined;
  const execute: Execute = async (command, options = {}) => {
    calls.push({
      command,
      ...(options.input === undefined ? {} : { input: options.input }),
      aborted: options.signal?.aborted ?? false,
    });
    hook?.(command, options.input);
    const args = command.slice(5);
    const [kind, operation] = args;
    if (kind === "info")
      return {
        code: 0,
        stdout: JSON.stringify({ id: daemonID, cpus: 8, memory: 8 * 1024 ** 3 }),
        stderr: "",
      };
    if (kind === "image") return { code: 0, stdout: f.value.docker.platform, stderr: "" };
    if (operation === "inspect") {
      const observed = resources.get(args.at(-1) ?? "");
      return observed
        ? { code: 0, stdout: JSON.stringify(observed), stderr: "" }
        : { code: 1, stdout: "", stderr: `Error: No such ${kind}: ${args.at(-1)}` };
    }
    if (operation === "create") {
      const labels: Record<string, string> = {};
      args.forEach((value, i) => {
        if (value === "--label") {
          const label = args[i + 1] ?? "";
          const equals = label.indexOf("=");
          labels[label.slice(0, equals)] = label.slice(equals + 1);
        }
      });
      const name =
        kind === "container" ? (args[args.indexOf("--name") + 1] ?? "") : (args.at(-1) ?? "");
      const id = kind === "volume" ? name : randomBytes(32).toString("hex");
      const observed = { id, name, created: "unit-original-created", labels, internal: true };
      resources.set(name, observed);
      resources.set(id, observed);
      return { code: 0, stdout: id, stderr: "" };
    }
    if (operation === "rm") {
      const observed = resources.get(args.at(-1) ?? "");
      if (observed) {
        resources.delete(String(observed["name"]));
        resources.delete(String(observed["id"]));
      }
    }
    if (
      kind === "exec" &&
      typeof options.input === "string" &&
      options.input.includes("PG_WITNESS")
    )
      return { code: 0, stdout: JSON.stringify(f.witness.postgres), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    resources,
    execute,
    hook: (next: typeof hook) => {
      hook = next;
    },
  };
}

test("private inputs, pins, scope and witnesses are checked without writes or commands", async () => {
  const f = await fixture();
  try {
    const loaded = await f.load();
    expect(loaded.owner).toBe(owner);
    expect(
      resourcePlan(loaded).every((entry) => entry.name.startsWith(`factory-restore-${owner}-`)),
    ).toBe(true);
    expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("read-only inspection validates complete witnesses with existing evidence without changing inputs or receipts", async () => {
  const f = await fixture();
  try {
    await mkdir(f.value.evidenceDirectory, { mode: 0o700 });
    const receipt = join(f.value.evidenceDirectory, "result.json");
    const retainedReceipt = '{"synthetic":"completed-receipt-must-not-be-rewritten"}\n';
    await writeFile(receipt, retainedReceipt, { mode: 0o600 });
    const fixtureBefore = await readFile(f.path);
    const witnessBefore = await readFile(join(f.value.privateRoot, "witnesses.json"));
    const partsBefore = await Promise.all(
      Object.keys(f.witness.parts).map((name) =>
        readFile(join(f.value.privateRoot, f.value.set, name)),
      ),
    );
    const inspected = await loadFixture(f.path, owner, "inspect");
    expect(inspected.witnesses).toEqual(f.witness);
    expect(inspected.witnessDigest).toBe(hash(JSON.stringify(f.witness)));
    expect(inspected.source).toEqual(f.value.source);
    expect(await readFile(f.path)).toEqual(fixtureBefore);
    expect(await readFile(join(f.value.privateRoot, "witnesses.json"))).toEqual(witnessBefore);
    expect(
      await Promise.all(
        Object.keys(f.witness.parts).map((name) =>
          readFile(join(f.value.privateRoot, f.value.set, name)),
        ),
      ),
    ).toEqual(partsBefore);
    expect(await readFile(receipt, "utf8")).toBe(retainedReceipt);
    await expect(f.load()).rejects.toThrow("Evidence destination already exists");
  } finally {
    await f.close();
  }
});

test("inspection CLI is read-only and default plan/run still refuse an existing evidence directory", async () => {
  const f = await fixture();
  try {
    await mkdir(f.value.evidenceDirectory, { mode: 0o700 });
    const receipt = join(f.value.evidenceDirectory, "result.json");
    await writeFile(receipt, '{"synthetic":"unchanged"}', { mode: 0o600 });
    for (const mode of ["--inspect", "--plan", "--run"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dirname, "restore-rehearsal.ts"),
          mode,
          "--fixture",
          f.path,
          "--owner",
          owner,
        ],
        { env: { PATH: "" }, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(mode === "--inspect" ? 0 : 1);
      if (mode === "--inspect") {
        expect(JSON.parse(stdout).kind).toBe("isolated-data-service-restore-inspection");
        expect(JSON.parse(stdout).witnessDigest).toBe(hash(JSON.stringify(f.witness)));
        expect(stderr).toBe("");
      } else {
        expect(stdout).toBe("");
        expect(stderr).toContain("Restore rehearsal refused or incomplete");
      }
      expect(await readFile(receipt, "utf8")).toBe('{"synthetic":"unchanged"}');
      expect(await Bun.file(join(f.value.evidenceDirectory, "ownership.json")).exists()).toBe(
        false,
      );
    }
  } finally {
    await f.close();
  }
});

test("cleanup loads metadata after missing inputs without fabricating a validated witness", async () => {
  const f = await fixture();
  try {
    await rm(join(f.value.privateRoot, "witnesses.json"));
    const metadata = await loadFixture(f.path, owner, "cleanup");
    expect(metadata.owner).toBe(owner);
    expect(Object.hasOwn(metadata, "witnesses")).toBe(false);
    expect(Object.hasOwn(metadata, "witnessDigest")).toBe(false);
    await expect(loadFixture(f.path, owner, "inspect")).rejects.toThrow(
      "Private fixture inputs are incomplete",
    );
  } finally {
    await f.close();
  }
});

test.each([
  "missing witnesses",
  "missing part",
  "changed part",
  "missing COMPLETE",
  "skipped component",
  "witness owner",
  "witness source",
  "witness set",
  "destination witness",
  "native table",
  "writer table",
  "missing Forgejo snapshot witness",
  "linked Forgejo snapshot witness",
  "credential exclusion",
  "object inventory",
  "managed CA",
  "unknown input",
  "public evidence",
  "evidence symlink",
  "unknown mode",
] as const)("read-only inspection refuses %s even with existing evidence", async (boundary) => {
  const f = await fixture();
  try {
    f.value.source = { ...wikiFeedbackSource };
    f.witness.source = { ...wikiFeedbackSource };
    f.witness.state.files.push({
      path: "ingress-tls/identity.json",
      bytes: 19,
      sha256: hash("original CA"),
    });
    await mkdir(f.value.evidenceDirectory, { mode: 0o700 });
    if (boundary === "witness owner") f.witness.owner = "b".repeat(32);
    if (boundary === "witness source")
      f.witness.source.namespaceUID = "d4262638-6225-4915-b1bb-eff6ad2aaed2";
    if (boundary === "witness set") f.witness.set = "20261118T100209Z";
    if (boundary === "destination witness")
      (f.witness as { provenance: string }).provenance = "restored-destination";
    if (boundary === "native table") delete f.witness.postgres["factory.substrate_binding"];
    if (boundary === "writer table") delete f.witness.postgres["factory.change_writer"];
    if (boundary === "missing Forgejo snapshot witness")
      f.witness.forgejo.files = f.witness.forgejo.files.filter(
        (entry) => entry.path !== "forgejo.sqlite3",
      );
    if (boundary === "linked Forgejo snapshot witness")
      f.witness.forgejo.files[0] = {
        path: "forgejo.sqlite3",
        bytes: 0,
        sha256: hash("data/data/forgejo.db"),
        link: "data/data/forgejo.db",
      };
    if (boundary === "managed CA") f.witness.state.files.pop();
    if (boundary === "credential exclusion")
      f.witness.state.files.push({
        path: "native/provisioner-token",
        bytes: 3,
        sha256: hash("not-copied"),
      });
    await f.save();
    if (boundary === "missing witnesses") await rm(join(f.value.privateRoot, "witnesses.json"));
    if (boundary === "missing part")
      await rm(join(f.value.privateRoot, f.value.set, "postgres.dump"));
    if (boundary === "changed part")
      await writeFile(join(f.value.privateRoot, f.value.set, "state.tar.gz"), "changed");
    if (boundary === "missing COMPLETE")
      await rm(join(f.value.privateRoot, f.value.set, "COMPLETE"));
    if (boundary === "skipped component")
      await writeFile(join(f.value.privateRoot, f.value.set, "openbao.skipped"), "");
    if (boundary === "object inventory")
      await writeFile(join(f.value.privateRoot, "objects", "unlisted"), "", { mode: 0o600 });
    if (boundary === "unknown input")
      await writeFile(join(f.value.privateRoot, "unclassified"), "", { mode: 0o600 });
    if (boundary === "public evidence") await chmod(f.value.evidenceDirectory, 0o755);
    if (boundary === "evidence symlink") {
      await rm(f.value.evidenceDirectory, { recursive: true });
      await symlink(f.value.privateRoot, f.value.evidenceDirectory);
    }
    await expect(
      loadFixture(f.path, owner, (boundary === "unknown mode" ? "arbitrary" : "inspect") as never),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("the loader admits the independently witnessed managed-TLS source without relabeling identities", async () => {
  const f = await fixture();
  try {
    f.value.source = { ...managedSource };
    f.witness.source = { ...managedSource };
    f.witness.state.files.push({
      path: "ingress-tls/identity.json",
      bytes: 19,
      sha256: hash("managed CA identity"),
    });
    await f.save();
    const loaded = await f.load();
    expect(loaded.source).toEqual(managedSource);
    expect(loaded.witnesses.source).toEqual(managedSource);
    expect(loaded.witnessDigest).toBe(hash(JSON.stringify(f.witness)));
    expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("the loader admits an independently witnessed upgraded chart without relabeling its application", async () => {
  const f = await fixture();
  try {
    f.value.source = { ...upgradedChartSource };
    f.witness.source = { ...upgradedChartSource };
    f.witness.state.files.push({
      path: "ingress-tls/identity.json",
      bytes: 19,
      sha256: hash("managed CA identity"),
    });
    await f.save();
    const fixtureBefore = await readFile(f.path, "utf8");
    const witnessBefore = await readFile(join(f.value.privateRoot, "witnesses.json"), "utf8");
    const loaded = await f.load();
    expect(loaded.source).toEqual(upgradedChartSource);
    expect(loaded.source.chartRevision).not.toBe(loaded.source.applicationRevision);
    expect(loaded.witnesses.source).toEqual(upgradedChartSource);
    expect(loaded.witnessDigest).toBe(hash(JSON.stringify(f.witness)));
    expect(await readFile(f.path, "utf8")).toBe(fixtureBefore);
    expect(await readFile(join(f.value.privateRoot, "witnesses.json"), "utf8")).toBe(witnessBefore);
    expect(await lstat(f.value.evidenceDirectory).catch(() => null)).toBeNull();
  } finally {
    await f.close();
  }
});

test.each([
  ["62288627", humanSubmissionSource],
  ["701ceb92", startupDispatchSource],
  ["37db8559", wikiFeedbackSource],
] as const)(
  "the loader admits the independently witnessed %s chart and application without relabeling backups",
  async (_revision, observed) => {
    const f = await fixture();
    try {
      f.value.source = { ...observed };
      f.witness.source = { ...observed };
      f.witness.state.files.push({
        path: "ingress-tls/identity.json",
        bytes: 19,
        sha256: hash("managed CA identity"),
      });
      await f.save();
      const fixtureBefore = await readFile(f.path, "utf8");
      const witnessPath = join(f.value.privateRoot, "witnesses.json");
      const witnessBefore = await readFile(witnessPath, "utf8");
      const partsBefore = await Promise.all(
        Object.keys(f.witness.parts).map((name) =>
          readFile(join(f.value.privateRoot, f.value.set, name)),
        ),
      );
      const loaded = await f.load();
      expect(loaded.source).toEqual(observed);
      expect(loaded.witnesses.source).toEqual(observed);
      expect(loaded.witnessDigest).toBe(hash(JSON.stringify(f.witness)));
      expect(await readFile(f.path, "utf8")).toBe(fixtureBefore);
      expect(await readFile(witnessPath, "utf8")).toBe(witnessBefore);
      expect(
        await Promise.all(
          Object.keys(f.witness.parts).map((name) =>
            readFile(join(f.value.privateRoot, f.value.set, name)),
          ),
        ),
      ).toEqual(partsBefore);
      expect(await lstat(f.value.evidenceDirectory).catch(() => null)).toBeNull();
    } finally {
      await f.close();
    }
  },
);

for (const [revision, observed] of [
  ["62288627", humanSubmissionSource],
  ["701ceb92", startupDispatchSource],
  ["37db8559", wikiFeedbackSource],
] as const)
  test.each([
    "new chart old application",
    "old chart new application",
    "unreviewed chart",
    "unreviewed application",
    "relabeled old witness",
    "changed namespace identity",
    "changed witness owner",
    "changed backup set",
    "destination provenance",
    "missing CA",
    "empty CA",
    "symlink CA",
    "excluded CA",
    "changed part",
    "new chart previous application",
    "previous chart new application",
    "missing native witness",
    "missing writer witness",
  ] as const)(`the ${revision} source profile refuses %s`, async (boundary) => {
    const f = await fixture();
    try {
      f.value.source = { ...observed };
      f.witness.source = { ...observed };
      const ca: Witnesses["state"]["files"][number] = {
        path: "ingress-tls/identity.json",
        bytes: 19,
        sha256: hash("managed CA identity"),
      };
      if (boundary !== "missing CA") f.witness.state.files.push(ca);
      if (boundary === "new chart old application")
        f.value.source.applicationRevision = f.witness.source.applicationRevision =
          managedSource.applicationRevision;
      if (boundary === "old chart new application")
        f.value.source.chartRevision = f.witness.source.chartRevision =
          upgradedChartSource.chartRevision;
      if (boundary === "new chart previous application")
        f.value.source.applicationRevision = f.witness.source.applicationRevision =
          revision === "701ceb92"
            ? humanSubmissionSource.applicationRevision
            : startupDispatchSource.applicationRevision;
      if (boundary === "previous chart new application")
        f.value.source.chartRevision = f.witness.source.chartRevision =
          revision === "701ceb92"
            ? humanSubmissionSource.chartRevision
            : startupDispatchSource.chartRevision;
      if (boundary === "unreviewed chart")
        f.value.source.chartRevision = f.witness.source.chartRevision = "f".repeat(40);
      if (boundary === "unreviewed application")
        f.value.source.applicationRevision = f.witness.source.applicationRevision = "f".repeat(40);
      if (boundary === "relabeled old witness")
        f.witness.source = {
          ...(revision === "37db8559" ? startupDispatchSource : upgradedChartSource),
        };
      if (boundary === "changed namespace identity")
        f.witness.source.namespaceUID = "365f92d0-2e7c-4f76-8728-6e7295cfc84b";
      if (boundary === "changed witness owner") f.witness.owner = "b".repeat(32);
      if (boundary === "changed backup set") f.witness.set = "20261117T100210Z";
      if (boundary === "destination provenance")
        Object.assign(f.witness, { provenance: "destination-observation" });
      if (boundary === "empty CA") ca.bytes = 0;
      if (boundary === "symlink CA") ca.link = "../another-identity.json";
      if (boundary === "excluded CA") f.witness.state.excludedProvisionerPaths.push(ca.path);
      if (boundary === "changed part") f.witness.parts["state.tar.gz"] = "0".repeat(64);
      if (boundary === "missing native witness")
        delete f.witness.postgres["factory.substrate_binding"];
      if (boundary === "missing writer witness") delete f.witness.postgres["factory.change_writer"];
      await f.save();
      await expect(f.load()).rejects.toThrow();
      expect(await lstat(f.value.evidenceDirectory).catch(() => null)).toBeNull();
    } finally {
      await f.close();
    }
  });

test.each([
  "unknown chart",
  "unknown application",
  "old chart new application",
  "new chart old application",
  "caller allowlist",
  "witness chart",
  "witness application",
  "witness namespace",
  "witness owner",
  "witness set",
  "destination provenance",
  "missing CA",
  "excluded CA",
  "symlink CA",
  "empty CA",
  "image pin",
  "part digest",
  "chart commit as application",
  "reversed upgraded pair",
  "relabeled upgraded witness",
  "upgraded chart missing CA",
] as const)(
  "the supported source manifest refuses %s before any evidence or destination",
  async (boundary) => {
    const f = await fixture();
    try {
      f.value.source = { ...managedSource };
      f.witness.source = { ...managedSource };
      const ca: Witnesses["state"]["files"][number] = {
        path: "ingress-tls/identity.json",
        bytes: 19,
        sha256: hash("managed CA identity"),
      };
      if (boundary !== "missing CA") f.witness.state.files.push(ca);
      if (boundary === "unknown chart" || boundary === "caller allowlist")
        f.value.source.chartRevision = f.witness.source.chartRevision = "f".repeat(40);
      if (boundary === "unknown application")
        f.value.source.applicationRevision = f.witness.source.applicationRevision = "e".repeat(40);
      if (boundary === "old chart new application")
        f.value.source.chartRevision = f.witness.source.chartRevision = source.chartRevision;
      if (boundary === "new chart old application")
        f.value.source.applicationRevision = f.witness.source.applicationRevision =
          source.applicationRevision;
      if (boundary === "caller allowlist")
        Object.assign(f.value.source, { supportedChartRevisions: ["f".repeat(40)] });
      if (boundary === "witness chart") f.witness.source.chartRevision = source.chartRevision;
      if (boundary === "witness application")
        f.witness.source.applicationRevision = source.applicationRevision;
      if (boundary === "witness namespace")
        f.witness.source.namespaceUID = "365f92d0-2e7c-4f76-8728-6e7295cfc84b";
      if (boundary === "witness owner") f.witness.owner = "b".repeat(32);
      if (boundary === "witness set") f.witness.set = "20261117T100210Z";
      if (boundary === "destination provenance")
        Object.assign(f.witness, { provenance: "destination-observation" });
      if (boundary === "excluded CA") f.witness.state.excludedProvisionerPaths.push(ca.path);
      if (boundary === "symlink CA") ca.link = "../another-identity.json";
      if (boundary === "empty CA") ca.bytes = 0;
      if (boundary === "image pin") f.value.images["postgres"] = "postgres:16";
      if (boundary === "part digest") f.witness.parts["state.tar.gz"] = "0".repeat(64);
      if (boundary === "chart commit as application") {
        f.value.source = {
          ...upgradedChartSource,
          applicationRevision: upgradedChartSource.chartRevision,
        };
        f.witness.source = { ...f.value.source };
      }
      if (boundary === "reversed upgraded pair") {
        f.value.source = {
          ...managedSource,
          applicationRevision: upgradedChartSource.chartRevision,
        };
        f.witness.source = { ...f.value.source };
      }
      if (boundary === "relabeled upgraded witness") {
        f.value.source = { ...upgradedChartSource };
        f.witness.source = { ...managedSource };
      }
      if (boundary === "upgraded chart missing CA") {
        f.value.source = { ...upgradedChartSource };
        f.witness.source = { ...upgradedChartSource };
        f.witness.state.files = f.witness.state.files.filter((v) => v.path !== ca.path);
      }
      await f.save();
      await expect(f.load()).rejects.toThrow();
      expect(await lstat(f.value.evidenceDirectory).catch(() => null)).toBeNull();
    } finally {
      await f.close();
    }
  },
);

test("the data-service pins match the chart and never include a Factory application image", async () => {
  for (const [component, path] of [
    ["postgres", "postgres.yaml"],
    ["forgejo", "forgejo.yaml"],
    ["garage", "objects.yaml"],
    ["openbao", "openbao.yaml"],
    ["rclone", "backup.yaml"],
  ] as const)
    expect(await readFile(`deploy/helm/factory/templates/${path}`, "utf8")).toContain(
      images[component] ?? "",
    );
  expect(Object.keys(images).sort()).toEqual([
    "forgejo",
    "garage",
    "openbao",
    "postgres",
    "rclone",
    "tools",
  ]);
});

test.each(["daemon", "image", "occupied name", "unknown absence"] as const)(
  "refuses %s observations before any evidence or resource create",
  async (boundary) => {
    const f = await fixture();
    try {
      const docker = fakeDocker(f);
      let creates = 0;
      const execute: Execute = async (command, options) => {
        if (command.includes("create")) creates++;
        if (boundary === "daemon" && command[5] === "info")
          return {
            code: 0,
            stdout: JSON.stringify({ id: "another-daemon", cpus: 99, memory: 2 ** 40 }),
            stderr: "",
          };
        if (boundary === "image" && command[5] === "image")
          return { code: 1, stdout: "", stderr: "Pinned image not loaded" };
        if (
          ["occupied name", "unknown absence"].includes(boundary) &&
          command[5] === "network" &&
          command[6] === "inspect"
        )
          return {
            code: boundary === "occupied name" ? 0 : 1,
            stdout: "occupied",
            stderr: "Daemon observation unavailable",
          };
        return docker.execute(command, options);
      };
      await expect(rehearse(await f.load(), execute)).rejects.toThrow();
      expect(creates).toBe(0);
      expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

type TarEntry = { name: string; content?: string | Uint8Array; type?: string; link?: string };
function archiveBytes(entries: TarEntry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (value: string, start: number, length: number) =>
      header.write(value, start, length, "utf8");
    const octal = (value: number, start: number, length: number) =>
      field(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
    field(entry.name, 0, 100);
    octal(0o600, 100, 8);
    octal(process.getuid?.() ?? 1000, 108, 8);
    octal(process.getgid?.() ?? 1000, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    field("        ", 148, 8);
    field(entry.type ?? "0", 156, 1);
    field(entry.link ?? "", 157, 100);
    field("ustar\0", 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Bun.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test.each([
  "valid",
  "managed CA",
  "managed CA upgraded chart",
  "managed CA human submission",
  "managed CA human submission omitted",
  "managed CA human submission mismatch",
  "managed CA startup dispatch",
  "managed CA startup dispatch omitted",
  "managed CA startup dispatch mismatch",
  "managed CA wiki feedback",
  "managed CA wiki feedback omitted",
  "managed CA wiki feedback mismatch",
  "managed CA omitted",
  "managed CA mismatch",
  "traversal",
  "absolute symlink",
  "confined symlink chain",
  "escaping symlink chain",
  "cyclic symlink",
  "40-link chain",
  "41-link chain",
  "hash",
  "snapshot",
  "missing Forgejo snapshot",
  "unwitnessed Forgejo snapshot",
  "changed Forgejo snapshot",
  "Forgejo snapshot WAL sidecar",
  "extra member",
  "truncated",
] as const)(
  "the real streaming verifier handles %s without extracting a single raw file",
  async (boundary) => {
    const f = await fixture();
    try {
      const stateEntries: TarEntry[] = [
        { name: "./kubernetes-installation.json", content: "identity" },
        { name: "./openbao/bootstrap.json", content: "bootstrap" },
        { name: "./openbao/factory-login.json", content: "login" },
      ];
      if (boundary.startsWith("managed CA")) {
        const observed = boundary.includes("wiki feedback")
          ? wikiFeedbackSource
          : boundary.includes("startup dispatch")
            ? startupDispatchSource
            : boundary.includes("human submission")
              ? humanSubmissionSource
              : boundary === "managed CA upgraded chart"
                ? upgradedChartSource
                : managedSource;
        f.value.source = { ...observed };
        f.witness.source = { ...observed };
        const content = "synthetic managed CA state";
        f.witness.state.files.push({
          path: "ingress-tls/identity.json",
          bytes: Buffer.byteLength(content),
          sha256: hash(content),
        });
        if (!boundary.endsWith("omitted"))
          stateEntries.push({
            name: "./ingress-tls/identity.json",
            content: boundary.endsWith("mismatch") ? "changed retained CA state" : content,
          });
      }
      if (boundary === "traversal") stateEntries[0] = { name: "../escape", content: "identity" };
      if (boundary === "absolute symlink") {
        stateEntries.push({ name: "source-link", type: "2", link: "/original/native" });
        f.witness.state.files.push({
          path: "source-link",
          bytes: 0,
          sha256: hash("/original/native"),
          link: "/original/native",
        });
      }
      if (
        boundary === "confined symlink chain" ||
        boundary === "escaping symlink chain" ||
        boundary === "cyclic symlink" ||
        boundary === "40-link chain" ||
        boundary === "41-link chain"
      ) {
        const count = boundary === "40-link chain" ? 40 : 41;
        const links =
          boundary === "40-link chain" || boundary === "41-link chain"
            ? Array.from({ length: count }, (_, i) => [
                `link-${i}`,
                i === count - 1 ? "kubernetes-installation.json" : `link-${i + 1}`,
              ])
            : boundary === "confined symlink chain"
              ? [
                  ["nested/second", "first"],
                  ["nested/first", "../kubernetes-installation.json"],
                ]
              : boundary === "escaping symlink chain"
                ? [
                    ["second", "first/../outside"],
                    ["first", "."],
                  ]
                : [
                    ["second", "first"],
                    ["first", "second"],
                  ];
        for (const [name, link] of links) {
          if (!name || !link) throw Error("Missing synthetic link");
          stateEntries.push({ name, type: "2", link });
          f.witness.state.files.push({ path: name, bytes: 0, sha256: hash(link), link });
        }
      }
      if (boundary === "hash")
        stateEntries[0] = { name: "./kubernetes-installation.json", content: "modified" };
      if (boundary === "extra member")
        stateEntries.push({ name: "unknown", content: "not independently witnessed" });
      const forgejoEntries: TarEntry[] = [
        { name: "forgejo.sqlite3", content: "snapshot" },
        { name: "forgejo-db.sql", content: "sql" },
        { name: "app.ini", content: "ini" },
        { name: "repos/owned/project.git/HEAD", content: "HEAD" },
      ];
      if (boundary === "missing Forgejo snapshot") forgejoEntries.shift();
      if (boundary === "unwitnessed Forgejo snapshot")
        f.witness.forgejo.files = f.witness.forgejo.files.filter(
          (entry) => entry.path !== "forgejo.sqlite3",
        );
      if (boundary === "changed Forgejo snapshot")
        forgejoEntries[0] = { name: "forgejo.sqlite3", content: "modified" };
      if (boundary === "Forgejo snapshot WAL sidecar") {
        forgejoEntries.push({ name: "forgejo.sqlite3-wal", content: "wal" });
        f.witness.forgejo.files.push({
          path: "forgejo.sqlite3-wal",
          bytes: 3,
          sha256: hash("wal"),
        });
      }
      const snapshotEntries: TarEntry[] = [
        { name: "meta.json", content: "metadata" },
        { name: "state.bin", content: "private-state" },
        {
          name: "SHA256SUMS",
          content: `${hash("metadata")}  meta.json\n${hash(boundary === "snapshot" ? "wrong" : "private-state")}  state.bin\n`,
        },
        { name: "SHA256SUMS.sealed", content: "sealed native metadata" },
      ];
      const data: Record<string, Uint8Array> = {
        "state.tar.gz": archiveBytes(stateEntries),
        "forgejo.tar.gz": archiveBytes(forgejoEntries),
        "openbao.snap": archiveBytes(snapshotEntries),
      };
      if (boundary === "truncated")
        data["state.tar.gz"] = (data["state.tar.gz"] ?? new Uint8Array()).slice(0, -8);
      for (const [name, bytes] of Object.entries(data)) {
        await writeFile(join(f.value.privateRoot, f.value.set, name), bytes, { mode: 0o600 });
        f.witness.parts[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      }
      await f.save();
      if (boundary === "unwitnessed Forgejo snapshot") {
        await expect(f.load()).rejects.toThrow();
        return;
      }
      const loaded = await f.load();
      const root = join(f.root, "container");
      await mkdir(root, { mode: 0o700 });
      // The exact verifier only reads synthetic inputs here. The symlink represents a Docker mount.
      await symlink(f.value.privateRoot, join(root, "input"));
      for (const directory of [
        "control",
        "state",
        "forgejo",
        "forgejo-config",
        "bao-data",
        "pg-data",
        "objects-data",
        "objects-input",
      ])
        await mkdir(join(root, directory), { mode: 0o700 });
      const checked = restoreFiles({
        root,
        set: f.value.set,
        source: loaded.source,
        diskBytes: 1,
        verifyOnly: true,
      });
      if (
        boundary === "valid" ||
        boundary === "managed CA" ||
        boundary === "managed CA upgraded chart" ||
        boundary === "managed CA human submission" ||
        boundary === "managed CA startup dispatch" ||
        boundary === "managed CA wiki feedback" ||
        boundary === "confined symlink chain" ||
        boundary === "40-link chain"
      )
        await checked;
      else await expect(checked).rejects.toThrow();
      for (const directory of ["control", "state", "forgejo", "forgejo-config"])
        expect(await Array.fromAsync(new Bun.Glob("**/*").scan(join(root, directory)))).toEqual([]);
      expect(await Bun.file(join(f.root, "escape")).exists()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each(["valid", "fsck override", "included fsck override", "invalid config"] as const)(
  "the exact Forgejo Git validator handles %s without trusting restored fsck policy",
  async (boundary) => {
    const f = await fixture();
    try {
      const repo = join(f.root, "repository.git");
      const env = {
        PATH: process.env["PATH"] ?? "",
        HOME: f.root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      };
      const git = async (args: string[], input = "") => {
        const child = Bun.spawn(["git", ...args], {
          env,
          stdin: new Blob([input]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        return stdout.trim();
      };
      await git(["init", "--bare", repo]);
      const prefix = [`--git-dir=${repo}`];
      const tree = await git([...prefix, "mktree"]);
      if (boundary === "fsck override" || boundary === "included fsck override") {
        const commit = await git(
          [...prefix, "hash-object", "-w", "--literally", "-t", "commit", "--stdin"],
          `tree ${tree}\nauthor MissingEmail 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nsynthetic malformed commit\n`,
        );
        await git([...prefix, "update-ref", "refs/heads/main", commit]);
        const config = "[fsck]\nmissingEmail = ignore\n";
        if (boundary === "fsck override") {
          await git([...prefix, "config", "fsck.missingEmail", "ignore"]);
        } else {
          const included = join(f.root, "included-config");
          await writeFile(included, config);
          await git([...prefix, "config", "include.path", included]);
        }
        // The old command accepts this damaged repository because its restored policy wins.
        await git([...prefix, "fsck", "--full", "--strict"]);
      }
      if (boundary === "invalid config") await writeFile(join(repo, "config"), "[invalid");
      const child = Bun.spawn(["sh", "-s"], {
        env,
        stdin: new Blob([forgejoWitnessProgram([repo])]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code === 0, stderr).toBe(boundary === "valid");
      expect(stdout).toBe("");
    } finally {
      await f.close();
    }
  },
);

test("embedded programs are valid module JavaScript and PostgreSQL witnesses contain no repair SQL", async () => {
  const f = await fixture();
  try {
    // Syntax-only local Node checks, never Docker, Kubernetes or a data service.
    for (const code of [
      invocation(restoreFiles, { root: "", set: f.value.set, source, diskBytes: 1 }),
      invocation(validateForgejoDatabase, { root: "" }),
      invocation(openBaoRequest, { action: "validate" }),
    ]) {
      const child = Bun.spawn(["node", "--check", "--input-type=module"], {
        stdin: new Blob([code]),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    }
    const sql = postgresWitnessProgram(f.witness.postgres, "-- real query supplied by source");
    expect(sql).toContain("default_transaction_read_only=on");
    expect(sql).toContain("COPY (SELECT row_to_json(t)::text");
    expect(sql).toContain("NOT c.convalidated");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DISABLE TRIGGER)\b/);
  } finally {
    await f.close();
  }
});

test("PostgreSQL witnesses preserve quoted authentication table names and reject SQL text", async () => {
  const f = await fixture();
  try {
    f.witness.postgres["auth.oauthClient"] = { rows: 0, sha256: hash("") };
    await f.save();
    expect((await f.load()).witnesses.postgres["auth.oauthClient"]).toEqual({
      rows: 0,
      sha256: hash(""),
    });
    const program = postgresWitnessProgram(f.witness.postgres, "-- supplied read-only query");
    expect(program).toContain('SELECT count(*) FROM "auth"."oauthClient"');
    expect(program).toContain('FROM "auth"."oauthClient" t ORDER BY');
    expect(() =>
      postgresWitnessProgram(
        {
          "auth.client;DROP TABLE factory.project": {
            rows: 0,
            sha256: hash(""),
          },
        },
        "",
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});

async function forgejoSnapshot(directory: string, orphan = false, missingMetadata = false) {
  const file = join(directory, "snapshot.sqlite3");
  const child = Bun.spawn(["node", "--input-type=module"], {
    stdin: new Blob([
      `
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
const sourcePath = ${JSON.stringify(join(directory, "source.sqlite3"))};
const source = new DatabaseSync(sourcePath, {enableForeignKeyConstraints:false});
source.exec(\`
 PRAGMA journal_mode=WAL;
 PRAGMA wal_autocheckpoint=0;
 CREATE TABLE access(id INTEGER PRIMARY KEY,repo_id INTEGER REFERENCES repository(id));
 CREATE TABLE repository(id INTEGER PRIMARY KEY,name TEXT);
 INSERT INTO repository VALUES(1,'owned');
 INSERT INTO access VALUES(1,${orphan ? 999 : 1});
 CREATE TABLE forgejo_version(id INTEGER PRIMARY KEY,version INTEGER);
 INSERT INTO forgejo_version VALUES(1,44);
 CREATE TABLE forgejo_migration(id TEXT PRIMARY KEY,created_unix INTEGER);
 INSERT INTO forgejo_migration VALUES('v17a_original',1794901234);
 CREATE TABLE wal_sentinel(id INTEGER PRIMARY KEY,payload BLOB,large INTEGER,optional TEXT,note TEXT);
 PRAGMA wal_checkpoint(TRUNCATE);
 INSERT INTO wal_sentinel VALUES(1,X'0001ff',9223372036854775807,NULL,'committed-only-in-WAL');
\`);
assert.ok((await stat(sourcePath+"-wal")).size > 0);
${missingMetadata ? 'source.exec("DROP TABLE forgejo_migration");' : ""}
const observer = new DatabaseSync(sourcePath, {readOnly:true,allowExtension:false});
await backup(observer, ${JSON.stringify(file)});
observer.close();
const snapshot = new DatabaseSync(${JSON.stringify(file)});
assert.equal(snapshot.prepare("PRAGMA journal_mode=DELETE").get().journal_mode,"delete");
assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
snapshot.close();
assert.equal(source.prepare("PRAGMA journal_mode").get().journal_mode,"wal");
source.close();
`,
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  return readFile(file);
}

function forgejoTableWitnesses(orphan = false): Witnesses["forgejo"]["tables"] {
  // Independent, predeclared original values, never computed from the restored snapshot.
  return {
    access: {
      rows: 1,
      sha256: hash(`[{"integer":"1"},{"integer":"${orphan ? 999 : 1}"}]\n`),
    },
    repository: { rows: 1, sha256: hash('[{"integer":"1"},"owned"]\n') },
    forgejo_version: { rows: 1, sha256: hash('[{"integer":"1"},{"integer":"44"}]\n') },
    forgejo_migration: {
      rows: 1,
      sha256: hash('["v17a_original",{"integer":"1794901234"}]\n'),
    },
    wal_sentinel: {
      rows: 1,
      sha256: hash(
        '[{"integer":"1"},{"hex":"0001ff"},{"integer":"9223372036854775807"},null,"committed-only-in-WAL"]\n',
      ),
    },
  };
}

test("the actual archive extraction and Node validator roundtrip the witnessed standalone WAL backup without executing SQL or using raw main.db", async () => {
  const f = await fixture();
  try {
    const snapshot = await forgejoSnapshot(f.root);
    const forgejoEntries: TarEntry[] = [
      { name: "forgejo.sqlite3", content: snapshot },
      { name: "forgejo-db.sql", content: "INVALID SQL MUST NEVER EXECUTE" },
      { name: "app.ini", content: "original-configuration" },
      { name: "data/data/forgejo.db", content: "untrusted raw live main.db" },
      { name: "data/data/forgejo.db-wal", content: "untrusted raw live WAL" },
      { name: "data/data/forgejo.db-shm", content: "untrusted raw shared memory" },
      { name: "data/data/forgejo.db-journal", content: "untrusted raw journal" },
    ];
    const stateEntries: TarEntry[] = [
      {
        name: "kubernetes-installation.json",
        content: JSON.stringify({
          runtime: "substrate",
          namespace: source.namespace,
          release: source.release,
          factoryURL: source.factoryOrigin,
          forgeURL: source.forgejoOrigin,
          storageClass: source.storageClass,
        }),
      },
      { name: "openbao/bootstrap.json", content: "original-bootstrap" },
      { name: "openbao/factory-login.json", content: "original-login" },
    ];
    const inventory = (entries: TarEntry[]) =>
      entries.map((entry) => ({
        path: entry.name,
        bytes: Buffer.byteLength(entry.content ?? ""),
        sha256: hash(entry.content ?? ""),
      }));
    f.witness.forgejo = {
      files: inventory(forgejoEntries),
      repositories: [],
      tables: forgejoTableWitnesses(),
    };
    f.witness.state.files = inventory(stateEntries);
    for (const [name, bytes] of Object.entries({
      "forgejo.tar.gz": archiveBytes(forgejoEntries),
      "state.tar.gz": archiveBytes(stateEntries),
      "openbao.snap": archiveBytes([
        { name: "meta.json", content: "metadata" },
        { name: "state.bin", content: "state" },
        {
          name: "SHA256SUMS",
          content: `${hash("metadata")}  meta.json\n${hash("state")}  state.bin\n`,
        },
      ]),
    })) {
      await writeFile(join(f.value.privateRoot, f.value.set, name), bytes, { mode: 0o600 });
      f.witness.parts[name] = hash(bytes);
    }
    await f.save();
    const loaded = await f.load();
    const root = join(f.root, "container");
    await mkdir(root, { mode: 0o700 });
    await symlink(f.value.privateRoot, join(root, "input"));
    for (const directory of [
      "control",
      "state",
      "forgejo",
      "forgejo-config",
      "bao-data",
      "pg-data",
      "objects-data",
      "objects-input",
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const code = `
import vm from "node:vm";
import * as actualFS from "node:fs/promises";
// Only privileged ownership changes are substituted on the local host.
// Archive reads, exclusive extraction, permissions, hashes and SQLite are real.
const fs = {...actualFS, chown:async()=>{}, lchown:async()=>{},
 open:async(...args)=>{const handle=await actualFS.open(...args);handle.chown=async()=>{};return handle;}};
const context=vm.createContext({Buffer});
const program=new vm.SourceTextModule(${JSON.stringify(
      invocation(restoreFiles, {
        root,
        set: f.value.set,
        source: loaded.source,
        diskBytes: 1,
        witnessDigest: loaded.witnessDigest,
      }),
    )},{
 context, importModuleDynamically:async name=>{
  const values=name==="node:fs/promises"?fs:await import(name);
  const m=new vm.SyntheticModule(Object.keys(values),function(){
   for(const key of Object.keys(values))this.setExport(key,values[key]);
  },{context});
  await m.link(()=>{});await m.evaluate();return m;
 }
});
await program.link(()=>{throw Error("unexpected static import")});
await program.evaluate();
${invocation(validateForgejoDatabase, { root })}
`;
    const child = Bun.spawn(["node", "--experimental-vm-modules", "--input-type=module"], {
      stdin: new Blob([code]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(await readFile(join(root, "forgejo/data/forgejo.db"))).toEqual(snapshot);
    expect(await Bun.file(join(root, "control/forgejo.sql")).exists()).toBe(false);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(await Bun.file(join(root, `forgejo/data/forgejo.db${suffix}`)).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test.each([
  "valid",
  "row digest",
  "migration timestamp",
  "missing metadata table",
  "foreign key",
  "corrupt",
  "changed snapshot hash",
  "missing",
  "unwitnessed",
  "WAL header",
  "WAL sidecar",
  "SHM sidecar",
  "journal sidecar",
] as const)(
  "the exact read-only Forgejo database validator checks %s using a real Node Online Backup snapshot",
  async (boundary) => {
    const f = await fixture();
    try {
      const root = join(f.root, "sqlite");
      for (const dir of ["control", "forgejo/data", "forgejo-config"])
        await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
      f.witness.forgejo.repositories = [];
      f.witness.forgejo.tables = forgejoTableWitnesses(boundary === "foreign key");
      if (boundary === "row digest")
        f.witness.forgejo.tables["repository"] = { rows: 1, sha256: hash("wrong") };
      if (boundary === "migration timestamp")
        f.witness.forgejo.tables["forgejo_migration"] = {
          rows: 1,
          sha256: hash('["v17a_original",{"integer":"1794901235"}]\n'),
        };
      const bytes = await forgejoSnapshot(
        root,
        boundary === "foreign key",
        boundary === "missing metadata table",
      );
      if (boundary === "corrupt") bytes[100] = 0xff; // invalid first b-tree page type
      if (boundary === "WAL header") {
        bytes[18] = 2;
        bytes[19] = 2;
      }
      const file = join(root, "forgejo/data/forgejo.db");
      if (boundary !== "missing") await writeFile(file, bytes);
      f.witness.forgejo.files = [
        ...(boundary === "unwitnessed"
          ? []
          : [
              {
                path: "forgejo.sqlite3",
                bytes: bytes.length,
                sha256: hash(boundary === "changed snapshot hash" ? "wrong" : bytes),
              },
            ]),
      ];
      const suffix =
        boundary === "WAL sidecar"
          ? "-wal"
          : boundary === "SHM sidecar"
            ? "-shm"
            : boundary === "journal sidecar"
              ? "-journal"
              : "";
      if (suffix) await writeFile(`${file}${suffix}`, "");
      // An old SQL dump is never a fallback or executable input, even when present.
      await writeFile(join(root, "control/forgejo.sql"), "THIS MUST NEVER EXECUTE");
      await writeFile(join(root, "control/witnesses.json"), JSON.stringify(f.witness));
      await writeFile(join(root, "forgejo-config/app.ini"), "original-config-unit-fixture");
      const child = Bun.spawn(["node", "--input-type=module"], {
        stdin: new Blob([invocation(validateForgejoDatabase, { root })]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(code === 0, stderr).toBe(boundary === "valid");
      if (boundary !== "missing") expect(await readFile(file)).toEqual(bytes);
      if (boundary === "valid")
        for (const sidecar of ["-wal", "-shm", "-journal"])
          expect(await Bun.file(`${file}${sidecar}`).exists()).toBe(false);
    } finally {
      await f.close();
    }
  },
);

test.each(["valid", "wrong original unseal", "AppRole denied", "secret mismatch"] as const)(
  "the exact OpenBao client validates %s using mocked TLS/HTTP only",
  async (boundary) => {
    const f = await fixture();
    try {
      // Node VM imports are in-memory substitutes. No listener, socket, API or original file is used.
      const code = `
import vm from "node:vm";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
const calls = [];
let unsealed = false;
const files = {
 "/control/tls/ca.crt": "synthetic-ca",
 "/state/openbao/bootstrap.json": JSON.stringify({keys_base64:["synthetic-original-key"]}),
 "/state/openbao/factory-login.json": JSON.stringify({role_id:"synthetic-role",secret_id:"synthetic-secret"}),
 "/control/witnesses.json": JSON.stringify({openbao:[{path:"factory/data/models/owned-witness",sha256:${JSON.stringify(hash('{"value":"original"}'))}}]})
};
const fs = { readFile: async path => { if (!(path in files)) throw Error("unexpected file"); return files[path]; },
 unlink: async path => { if (path !== "/control/temporary-root-token") throw Error("unexpected unlink"); } };
const https = { request(options, receive) {
 if (options.hostname !== "127.0.0.1" || options.port !== 8200 || options.ca !== "synthetic-ca" || options.rejectUnauthorized === false)
   throw Error("TLS or destination changed");
 const req = new EventEmitter();
 req.end = data => {
  const body = data ? JSON.parse(data) : null;
  calls.push({path:options.path, body, token:options.headers["X-Vault-Token"]});
  let code=200, result;
  if (options.path === "/v1/sys/health") { code=unsealed?200:503; result={initialized:true,sealed:!unsealed}; }
  else if (options.path === "/v1/sys/unseal") {
   if (body.key !== "synthetic-original-key") throw Error("wrong key source");
   result={sealed:${boundary === "wrong original unseal"}};
   unsealed = !result.sealed;
  } else if (options.path === "/v1/auth/approle/login") {
   if (body.role_id !== "synthetic-role" || body.secret_id !== "synthetic-secret") throw Error("wrong login source");
   code=${boundary === "AppRole denied" ? 403 : 200}; result={auth:{client_token:"synthetic-issued-token"}};
  } else if (options.path === "/v1/factory/data/models/owned-witness") {
   if (options.headers["X-Vault-Token"] !== "synthetic-issued-token") throw Error("wrong token");
   result={data:{data:{value:${JSON.stringify(boundary === "secret mismatch" ? "changed" : "original")}}}};
  } else throw Error("unexpected endpoint");
  queueMicrotask(() => {
   const response=new EventEmitter(); response.statusCode=code; receive(response);
   response.emit("data",Buffer.from(JSON.stringify(result))); response.emit("end");
  });
 };
 req.destroy = error => req.emit("error",error);
 return req;
}};
const context=vm.createContext({Buffer,setTimeout});
const modules={ "node:fs/promises":fs, "node:https":https, "node:crypto":crypto };
const program=new vm.SourceTextModule(${JSON.stringify(invocation(openBaoRequest, { action: "validate" }))},{
 context, importModuleDynamically:async name => {
  if (!(name in modules)) throw Error("unexpected import");
  const values=modules[name];
  const m=new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
  await m.link(()=>{}); await m.evaluate(); return m;
 }
});
await program.link(()=>{throw Error("unexpected static import")});
let passed=false;
try { await program.evaluate(); passed=true; } catch {}
process.stdout.write(JSON.stringify({passed,paths:calls.map(v=>v.path)}));
`;
      const child = Bun.spawn(["node", "--experimental-vm-modules", "--input-type=module"], {
        stdin: new Blob([code]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.passed).toBe(boundary === "valid");
      expect(stdout).not.toContain("synthetic-original-key");
      expect(result.paths[0]).toBe("/v1/sys/health");
    } finally {
      await f.close();
    }
  },
);

test("a lost create acknowledgement reconciles only the journaled nonce before removing original IDs", async () => {
  const f = await fixture();
  try {
    const docker = fakeDocker(f);
    let lost = false;
    const execute: Execute = async (command, options) => {
      if (command.includes("create")) {
        const journal = JSON.parse(
          await readFile(join(f.value.evidenceDirectory, "ownership.json"), "utf8"),
        );
        expect(journal.resources.at(-1).state).toBe("planned");
      }
      const result = await docker.execute(command, options);
      if (!lost && command.includes("create") && command.includes("--name")) {
        lost = true;
        throw Error("daemon created container; acknowledgement lost");
      }
      return result;
    };
    const result = await rehearse(await f.load(), execute);
    expect(lost).toBe(true);
    expect(result.status).toBe("incomplete");
    expect(result.cleanup).toBe("confirmed");
    expect(docker.resources.size).toBe(0);
    const removed = docker.calls.filter(
      (call) => call.command.includes("rm") && call.command.includes("container"),
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]?.command.at(-1)).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await f.close();
  }
});

test("the operator deadline fails even when the exec client returns zero on cancellation, then joins its owned container", async () => {
  const f = await fixture();
  try {
    f.value.limits.commandTimeoutSeconds = 1;
    await f.save();
    const docker = fakeDocker(f);
    let cancelled = false;
    const execute: Execute = async (command, options) => {
      if (
        typeof options?.input === "string" &&
        options.input.includes("pg_restore --exit-on-error")
      ) {
        await new Promise<void>((accept) =>
          options.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              accept();
            },
            { once: true },
          ),
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return docker.execute(command, options);
    };
    const result = await rehearse(await f.load(), execute);
    expect(cancelled).toBe(true);
    expect(result.status).toBe("incomplete");
    expect(result.components.postgres).toBe("failed");
    expect(result.components.objects).toBe("not-run");
    expect(result.cleanup).toBe("confirmed");
    expect(docker.resources.size).toBe(0);
    expect(
      docker.calls.some(
        (call) => call.command.includes("container") && call.command.includes("rm"),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test.each([
  "pin",
  "owner",
  "overlap",
  "witness",
  "partial",
  "symlink",
  "public",
  "credential",
] as const)("refuses %s before creating any evidence or destination", async (boundary) => {
  const f = await fixture();
  try {
    if (boundary === "pin") f.value.images["postgres"] = "postgres:16";
    if (boundary === "owner") f.value.owner = "b".repeat(32);
    if (boundary === "overlap") f.value.retained.paths.push(f.value.evidenceDirectory);
    if (boundary === "witness") delete f.witness.postgres["factory.substrate_binding"];
    if (boundary === "partial") await rm(join(f.value.privateRoot, f.value.set, "COMPLETE"));
    if (boundary === "credential")
      f.witness.state.files.push({
        path: "native/provisioner-token",
        sha256: hash("no"),
        bytes: 2,
      });
    await f.save();
    if (boundary === "public") await chmod(f.path, 0o644);
    if (boundary === "symlink") {
      await rm(join(f.value.privateRoot, "objects"), { recursive: true });
      await symlink(f.value.retained.paths[0] ?? "/", join(f.value.privateRoot, "objects"));
    }
    await expect(f.load()).rejects.toThrow();
    expect(await Bun.file(join(f.value.evidenceDirectory, "result.json")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test.each([
  ["original", source],
  ["37db8559", wikiFeedbackSource],
] as const)(
  "all five components use only pinned quarantined clients for %s; no Factory/native activation",
  async (_revision, observed) => {
    const f = await fixture();
    try {
      f.value.source = { ...observed };
      f.witness.source = { ...observed };
      if (observed === wikiFeedbackSource)
        f.witness.state.files.push({
          path: "ingress-tls/identity.json",
          bytes: 19,
          sha256: hash("managed CA identity"),
        });
      await f.save();
      const docker = fakeDocker(f);
      const result = await rehearse(await f.load(), docker.execute);
      expect(result.status).toBe("data-services-passed");
      expect(result.nativeActivation).toBe("not-run-not-qualified");
      expect(Object.values(result.components)).toEqual(Array(5).fill("passed"));
      expect(result.cleanup).toBe("confirmed");
      const commands = docker.calls.map((call) => call.command.join(" ")).join("\n");
      expect(commands).toContain("--internal");
      expect(commands).toContain("--network none");
      expect(commands).toContain("--network container:");
      expect(commands).toContain("--pull never");
      expect(commands).not.toMatch(
        /kubectl|prune|--privileged|--publish|--network host|docker\.sock:/,
      );
      const inputs = docker.calls.map((call) => String(call.input ?? "")).join("\n");
      expect(inputs).toContain("pg_restore --exit-on-error --single-transaction --no-owner");
      expect(inputs).toContain("PG_WITNESS");
      expect(inputs).toContain("PRAGMA integrity_check");
      expect(inputs).toContain("snapshot restore -force");
      expect(inputs).toContain("auth/approle/login");
      expect(inputs).toContain("--download");
      expect(inputs).toContain("fsck --full --strict");
      expect(docker.resources.size).toBe(0);
      expect(await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8")).not.toContain(
        "private-witness",
      );
    } finally {
      await f.close();
    }
  },
);

test.each([
  "restore failure",
  "cancelled",
  "lost create acknowledgement",
  "foreign replacement",
] as const)(
  "owned cleanup after %s never claims a full pass or removes a replacement",
  async (boundary) => {
    const f = await fixture();
    try {
      const docker = fakeDocker(f);
      const controller = new AbortController();
      let tripped = false;
      docker.hook((command, input) => {
        if (!tripped && typeof input === "string" && input.includes("pg_restore --exit-on-error")) {
          tripped = true;
          if (boundary === "cancelled") controller.abort();
          if (boundary === "foreign replacement") {
            for (const resource of docker.resources.values())
              if (String(resource["name"]).endsWith("-postgres"))
                resource["labels"] = { "factory.restore-rehearsal.owner": "foreign" };
          }
          throw Error("sensitive raw output must never reach result evidence");
        }
        if (boundary === "lost create acknowledgement" && !tripped && command.includes("start")) {
          tripped = true;
          throw Error("response lost");
        }
      });
      const result = await rehearse(await f.load(), docker.execute, controller.signal);
      expect(result.status).not.toBe("data-services-passed");
      expect(result.nativeActivation).toBe("not-run-not-qualified");
      if (boundary === "restore failure")
        expect(result.components).toEqual({
          postgres: "failed",
          forgejo: "passed",
          objects: "passed",
          openbao: "passed",
          state: "passed",
        });
      const receipt = await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8");
      expect(receipt).not.toContain("sensitive raw output");
      if (boundary === "foreign replacement") {
        expect(result.cleanup).toBe("unconfirmed");
        expect(docker.resources.size).toBeGreaterThan(0);
      } else {
        expect(result.cleanup).toBe("confirmed");
        expect(docker.resources.size).toBe(0);
      }
      expect(
        docker.calls.filter((call) => call.command.includes("rm")).every((call) => !call.aborted),
      ).toBe(true);
    } finally {
      await f.close();
    }
  },
);
