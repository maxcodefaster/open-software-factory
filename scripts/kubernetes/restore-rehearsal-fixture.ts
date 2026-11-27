// Private fixture, source profile, backup part and independent witness validation.
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  absolute,
  images,
  keys,
  managedTLSState,
  memberPath,
  overlaps,
  ownedPath,
  privateJSON,
  requiredTables,
  requireThat,
  resourcePlan,
  same,
  sha,
  supportedSourceManifests,
  tableWitnesses,
} from "./restore-rehearsal-common";
import type { FileWitness, Fixture, LoadedFixture, Witnesses } from "./restore-rehearsal-types";

const partNames = ["postgres.dump", "forgejo.tar.gz", "state.tar.gz", "openbao.snap"];
const coreStateFiles = [
  "kubernetes-installation.json",
  "openbao/bootstrap.json",
  "openbao/factory-login.json",
];

export type SourceContractCheck = (
  repository: string,
  chartRevision: string,
  applicationRevision: string,
) => Promise<boolean>;

function fileWitnesses(value: FileWitness[]) {
  requireThat(Array.isArray(value), "File witnesses are required");
  const names = new Set<string>();
  for (const entry of value) {
    keys(entry, entry.link === undefined ? "path bytes sha256" : "path bytes sha256 link");
    memberPath(entry.path);
    requireThat(
      !names.has(entry.path) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        sha.test(entry.sha256) &&
        (entry.link === undefined || typeof entry.link === "string"),
      "Invalid or duplicate file witness",
    );
    names.add(entry.path);
  }
}

async function validateCoreFixture(
  path: string,
  owner: string,
  repoRoot: string,
  matchesContract: SourceContractCheck,
) {
  const raw = await privateJSON(path);
  keys(raw, "schema owner source set privateRoot evidenceDirectory docker retained images limits");
  const f = raw as unknown as Fixture;
  requireThat(
    f.schema === 1 && /^[a-f0-9]{32}$/.test(owner) && f.owner === owner,
    "Explicit owner does not match private fixture",
  );
  keys(
    f.source,
    "chartRevision applicationRevision namespace namespaceUID release factoryOrigin forgejoOrigin storageClass",
  );
  const sourceManifest =
    supportedSourceManifests.find(
      (entry) =>
        entry.chartRevision === f.source.chartRevision &&
        entry.applicationRevision === f.source.applicationRevision,
    ) ??
    ((await matchesContract(repoRoot, f.source.chartRevision, f.source.applicationRevision))
      ? { requiredStateFiles: managedTLSState }
      : undefined);
  requireThat(
    sourceManifest &&
      /^[a-f0-9-]{36}$/.test(f.source.namespaceUID) &&
      [f.source.namespace, f.source.release].every((v) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(v)) &&
      typeof f.source.storageClass === "string",
    "Source identity is incomplete or from a different chart",
  );
  for (const origin of [f.source.factoryOrigin, f.source.forgejoOrigin]) {
    const url = new URL(origin);
    requireThat(
      url.protocol === "https:" && url.origin === origin && !url.username && !url.password,
      "Expected credential-free source HTTPS origins",
    );
  }
  requireThat(/^\d{8}T\d{6}Z$/.test(f.set), "Explicit backup set required");
  await ownedPath(f.privateRoot, true);
  requireThat(
    path === join(f.privateRoot, "fixture.json"),
    "Fixture must be privateRoot/fixture.json",
  );
  absolute(f.evidenceDirectory);
  await ownedPath(dirname(f.evidenceDirectory), true, false);
  keys(f.docker, "host daemonID platform");
  requireThat(
    /^unix:\/\/\/[^,\0\r\n]+$/.test(f.docker.host) &&
      /^[a-zA-Z0-9:_-]+$/.test(f.docker.daemonID) &&
      ["linux/amd64", "linux/arm64"].includes(f.docker.platform),
    "An explicit local daemon identity and Linux platform are required",
  );
  keys(f.retained, "paths containers volumes networks");
  requireThat(
    Array.isArray(f.retained.paths) && f.retained.paths.length,
    "Retained installation path denylist required",
  );
  for (const denied of f.retained.paths) {
    absolute(denied);
    requireThat(
      !overlaps(denied, f.privateRoot) && !overlaps(denied, f.evidenceDirectory),
      "Private inputs or evidence overlap retained storage",
    );
  }
  requireThat(
    !overlaps(f.privateRoot, f.evidenceDirectory),
    "Evidence must be outside raw private inputs",
  );
  requireThat(
    same(f.images, images),
    "Only this source's exact pinned data-service/tool images are accepted",
  );
  keys(
    f.limits,
    "memoryMiB cpus pids tmpfsMiB commandTimeoutSeconds requiredDiskBytes availableDiskBytes",
  );
  const {
    memoryMiB,
    pids,
    tmpfsMiB,
    commandTimeoutSeconds,
    requiredDiskBytes,
    availableDiskBytes,
  } = f.limits;
  requireThat(
    Object.values(f.limits).every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) &&
      [
        memoryMiB,
        pids,
        tmpfsMiB,
        commandTimeoutSeconds,
        requiredDiskBytes,
        availableDiskBytes,
      ].every(Number.isSafeInteger) &&
      requiredDiskBytes <= availableDiskBytes,
    "Explicit positive resource limits and disk allowance required",
  );
  for (const kind of ["containers", "networks", "volumes"] as const)
    requireThat(
      Array.isArray(f.retained[kind]) &&
        f.retained[kind].every((v) => typeof v === "string" && /^[a-zA-Z0-9_.-]+$/.test(v)),
      "Explicit retained Docker resource denylists required, including observed empty arrays",
    );
  for (const resource of resourcePlan(f)) {
    const bucket =
      resource.kind === "container"
        ? "containers"
        : resource.kind === "network"
          ? "networks"
          : "volumes";
    requireThat(
      !f.retained[bucket].includes(resource.name),
      "Destination overlaps a retained resource",
    );
  }
  const privateEntries = (await readdir(f.privateRoot)).sort();
  const allowedInputs = ["fixture.json", "witnesses.json", f.set, "objects", "tls"].sort();
  requireThat(
    privateEntries.every((name) => allowedInputs.includes(name)),
    "Private fixture root must contain only declared inputs, no Docker config or provisioner files",
  );
  return { f, sourceManifest, privateEntries, allowedInputs };
}

async function validateBackupPartsAndObjects(f: Fixture, w: Witnesses) {
  requireThat(
    same(Object.keys(w.parts).sort(), [...partNames].sort()),
    "Every backup part needs a compressed-byte SHA-256",
  );
  const setDirectory = join(f.privateRoot, f.set);
  await ownedPath(setDirectory, true);
  await ownedPath(join(setDirectory, "COMPLETE"), false);
  const entries = await readdir(setDirectory);
  requireThat(
    !entries.some((name) => /(?:\.part$|\.skipped$|\.failed$)/.test(name)),
    "Partial or skipped backup is not a full rehearsal input",
  );
  for (const name of partNames) {
    const file = join(setDirectory, name);
    const info = await ownedPath(file, false);
    requireThat(
      info.size > 0 && sha.test(w.parts[name] ?? ""),
      "Complete nonempty parts and real hashes required",
    );
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
    requireThat(hasher.digest("hex") === w.parts[name], "Backup part does not match its witness");
  }
  fileWitnesses(w.objects);
  requireThat(
    w.objects.every((v) => !v.link),
    "Object mirrors must contain ordinary files",
  );
  const objects = join(f.privateRoot, "objects");
  const found: string[] = [];
  const walk = async (directory: string) => {
    await ownedPath(directory, true);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else {
        await ownedPath(child, false);
        found.push(relative(objects, child));
      }
    }
  };
  await walk(objects);
  requireThat(
    same(found.sort(), w.objects.map((v) => v.path).sort()),
    "Object mirror inventory differs from independent witnesses",
  );
}

function validateForgejoAndStateWitnesses(w: Witnesses, requiredStateFiles: readonly string[]) {
  keys(w.forgejo, "tables files repositories");
  tableWitnesses(w.forgejo.tables);
  fileWitnesses(w.forgejo.files);
  requireThat(
    ["forgejo.sqlite3", "forgejo-db.sql", "app.ini"].every((name) =>
      w.forgejo.files.some(
        (entry) => entry.path === name && entry.link === undefined && entry.bytes > 0,
      ),
    ),
    "Forgejo standalone SQLite snapshot, SQL archive and original configuration witnesses are required",
  );
  requireThat(
    Array.isArray(w.forgejo.repositories) &&
      w.forgejo.repositories.every(
        (p) => memberPath(p) && p.startsWith("repos/") && p.endsWith(".git"),
      ),
    "Expected bare repository paths required",
  );
  requireThat(
    same(
      [...w.forgejo.repositories].sort(),
      w.forgejo.files
        .filter((entry) => /^repos\/.+\.git\/HEAD$/.test(entry.path))
        .map((entry) => entry.path.slice(0, -5))
        .sort(),
    ),
    "Every archived bare repository needs its own Git validation",
  );
  keys(w.state, "files excludedProvisionerPaths credentialReview");
  fileWitnesses(w.state.files);
  requireThat(
    w.state.credentialReview === "no-native-provisioner-material-in-included-files" &&
      Array.isArray(w.state.excludedProvisionerPaths),
    "Explicit operator credential classification required",
  );
  for (const excluded of w.state.excludedProvisionerPaths)
    requireThat(
      memberPath(excluded) && w.state.files.some((v) => v.path === excluded),
      "Excluded provisioner paths must identify exact witnessed files",
    );
  for (const entry of w.state.files)
    requireThat(
      !/provisioner|kubeconfig|service-account.*token/i.test(entry.path) ||
        w.state.excludedProvisionerPaths.includes(entry.path),
      "Native provisioner material must never enter destination state",
    );
  const requireStateFiles = (paths: readonly string[], nonempty: boolean, message: string) => {
    for (const filePath of paths)
      requireThat(
        w.state.files.some((v) => v.path === filePath && !v.link && (!nonempty || v.bytes > 0)) &&
          !w.state.excludedProvisionerPaths.includes(filePath),
        message,
      );
  };
  requireStateFiles(
    coreStateFiles,
    false,
    "Original installation identity and OpenBao material must be present",
  );
  requireStateFiles(
    requiredStateFiles,
    true,
    "Supported source requires its original witnessed retained state",
  );
}

/** Reads private inputs and, for content profiles, local Git objects. No daemon or writes. */
export async function loadFixtureFromRepo(
  path: string,
  owner: string,
  mode: "run" | "inspect" | "cleanup",
  repoRoot: string,
  matchesContract: SourceContractCheck,
): Promise<LoadedFixture | Fixture> {
  requireThat(["run", "inspect", "cleanup"].includes(mode), "Unknown fixture load mode");
  const { f, sourceManifest, privateEntries, allowedInputs } = await validateCoreFixture(
    path,
    owner,
    repoRoot,
    matchesContract,
  );
  if (mode === "cleanup") return f;
  requireThat(same(privateEntries, allowedInputs), "Private fixture inputs are incomplete");
  const evidence = await lstat(f.evidenceDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  requireThat(
    mode === "inspect" || !evidence,
    "Evidence destination already exists; use explicit cleanup, not reuse",
  );
  if (evidence) await ownedPath(f.evidenceDirectory, true);
  const w = (await privateJSON(join(f.privateRoot, "witnesses.json"))) as Witnesses;
  keys(w, "schema owner source set provenance parts postgres forgejo state objects openbao");
  requireThat(
    w.schema === 1 &&
      w.owner === f.owner &&
      w.set === f.set &&
      same(w.source, f.source) &&
      w.provenance === "independent-source-observation",
    "Witnesses must bind independent source observations to this owner, set and installation",
  );
  await validateBackupPartsAndObjects(f, w);
  tableWitnesses(w.postgres, true);
  requireThat(
    requiredTables.every((table) => Object.hasOwn(w.postgres, table)),
    "Product, Source/Writer and native-binding table witnesses are required, including empty tables",
  );
  validateForgejoAndStateWitnesses(w, sourceManifest.requiredStateFiles);
  await ownedPath(join(f.privateRoot, "tls"), true);
  for (const name of ["ca.crt", "tls.crt", "tls.key"])
    await ownedPath(join(f.privateRoot, "tls", name), false);
  requireThat(
    Array.isArray(w.openbao) &&
      w.openbao.length > 0 &&
      w.openbao.every(
        (v) =>
          /^factory\/data\/(?:projects|models|mcp|identity|imports|release-access|release-publish)\/[a-zA-Z0-9/_-]+$/.test(
            v.path,
          ) &&
          !v.path.includes("..") &&
          sha.test(v.sha256),
      ),
    "At least one real existing AppRole-readable KV witness is required",
  );
  const minimumBytes = [...w.state.files, ...w.forgejo.files, ...w.objects, ...w.objects].reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  requireThat(
    Number.isSafeInteger(minimumBytes) && f.limits.requiredDiskBytes >= minimumBytes,
    "Working disk allowance is smaller than the witnessed raw data, before PostgreSQL expansion",
  );
  return {
    ...f,
    witnesses: w,
    witnessDigest: new Bun.CryptoHasher("sha256").update(JSON.stringify(w)).digest("hex"),
  };
}
