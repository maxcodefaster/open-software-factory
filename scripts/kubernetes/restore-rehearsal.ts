// Explicit offline data-service acceptance. This never starts Factory, Zero or a Forgejo server.
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import upstream from "../../upstream.json";
import type { Output, RunOptions } from "../owned-client-process";

export const images: Record<string, string> = {
  postgres:
    "docker.io/library/postgres:16.14-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8",
  forgejo:
    "codeberg.org/forgejo/forgejo:17.0.0-rootless@sha256:6554520f7574602100b7d6620c6ac5b18cec30325f823777497eac36234f5cf8",
  garage: upstream.garage.image,
  openbao: upstream.openbao.image,
  rclone: upstream.rclone.image,
  tools: upstream.node.image,
};
// Reviewed source profiles, not a caller-supplied revision allowlist. These pairs share the
// pinned backup formats, schema and data-service images. Managed-TLS profiles retain their CA.
// Chart and application commits are independent; only the explicitly reviewed pairs qualify.
// The complete source identity must still match the independent witness manifest below.
export const supportedSourceManifests = [
  {
    chartRevision: "39d7969bb3acd93d0bc497a5748cce08ae435091",
    applicationRevision: "089ca64dbc9ab48f3b452151a2d694d7aabe3a10",
    requiredStateFiles: [],
  },
  {
    chartRevision: "4438e7580db77df3d861e0bcbd5b1f77c914c365",
    applicationRevision: "4438e7580db77df3d861e0bcbd5b1f77c914c365",
    requiredStateFiles: ["ingress-tls/identity.json"],
  },
  {
    chartRevision: "5609f4cd76bd5203c6ad17ae33a330e65614bb9f",
    applicationRevision: "4438e7580db77df3d861e0bcbd5b1f77c914c365",
    requiredStateFiles: ["ingress-tls/identity.json"],
  },
  {
    chartRevision: "62288627d2a5b69d5de7b6c2478199d290a5792b",
    applicationRevision: "62288627d2a5b69d5de7b6c2478199d290a5792b",
    requiredStateFiles: ["ingress-tls/identity.json"],
  },
  {
    chartRevision: "701ceb9258a1afd298080b0a7075c77ebe906e36",
    applicationRevision: "701ceb9258a1afd298080b0a7075c77ebe906e36",
    requiredStateFiles: ["ingress-tls/identity.json"],
  },
  {
    chartRevision: "37db8559833c59925bca477fb1a4d1b29feb15d1",
    applicationRevision: "37db8559833c59925bca477fb1a4d1b29feb15d1",
    requiredStateFiles: ["ingress-tls/identity.json"],
  },
] as const;
const label = "factory.restore-rehearsal";
const sha = /^[a-f0-9]{64}$/;
const identifier = /^[a-z_][a-z0-9_]*$/;
const postgresIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const partNames = ["postgres.dump", "forgejo.tar.gz", "state.tar.gz", "openbao.snap"];
export const requiredTables = [
  "factory.project",
  "factory.ticket",
  "factory.change",
  "factory.change_writer",
  "factory.runtime_attempt",
  "factory.substrate_binding",
  "factory.substrate_source",
  "factory.substrate_workspace",
  "factory.substrate_isolated",
  "factory.substrate_verification",
  "factory.substrate_prebuild",
  "factory.substrate_worker_capacity",
  "factory.substrate_capacity_installation",
  "factory.substrate_actor_rpc",
  "factory.substrate_input_stop",
  "factory.schema_migration",
];
type Digest = { rows: number; sha256: string };
export type FileWitness = { path: string; bytes: number; sha256: string; link?: string };
type Source = {
  chartRevision: string;
  applicationRevision: string;
  namespace: string;
  namespaceUID: string;
  release: string;
  factoryOrigin: string;
  forgejoOrigin: string;
  storageClass: string;
};
export type Witnesses = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  provenance: "independent-source-observation";
  parts: Record<string, string>;
  postgres: Record<string, Digest>;
  forgejo: { tables: Record<string, Digest>; files: FileWitness[]; repositories: string[] };
  state: {
    files: FileWitness[];
    excludedProvisionerPaths: string[];
    credentialReview: "no-native-provisioner-material-in-included-files";
  };
  objects: FileWitness[];
  openbao: { path: string; sha256: string }[];
};
export type Fixture = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  privateRoot: string;
  evidenceDirectory: string;
  docker: { host: string; daemonID: string; platform: string };
  retained: { paths: string[]; containers: string[]; volumes: string[]; networks: string[] };
  images: Record<string, string>;
  limits: {
    memoryMiB: number;
    cpus: number;
    pids: number;
    tmpfsMiB: number;
    commandTimeoutSeconds: number;
    requiredDiskBytes: number;
    availableDiskBytes: number;
  };
};
export type LoadedFixture = Fixture & { witnesses: Witnesses; witnessDigest: string };
export type Execute = (
  command: string[],
  options?: RunOptions & { env?: Record<string, string> },
) => Promise<Output>;

function requireThat(value: unknown, detail: string): asserts value {
  if (!value) throw Error(detail);
}
function same(a: unknown, b: unknown): boolean {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  return (
    same(Object.keys(left).sort(), Object.keys(right).sort()) &&
    Object.keys(left).every((key) => same(left[key], right[key]))
  );
}
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      same(Object.keys(value).sort(), expected.split(" ").sort()),
    "Unexpected private fixture schema",
  );
}
function absolute(path: unknown): asserts path is string {
  requireThat(
    typeof path === "string" &&
      isAbsolute(path) &&
      resolve(path) === path &&
      !/[\0\r\n,:]/.test(path),
    "Expected a canonical absolute path without Docker mount delimiters",
  );
}
export function memberPath(path: string) {
  requireThat(
    typeof path === "string" &&
      path.length > 0 &&
      ![...path].some((char) => char.charCodeAt(0) < 32 || char === "\\") &&
      !isAbsolute(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe relative backup path",
  );
  return path;
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
async function ownedPath(path: string, directory: boolean, privateMode = true) {
  absolute(path);
  const info = await lstat(path);
  requireThat(
    !info.isSymbolicLink() &&
      (directory ? info.isDirectory() : info.isFile()) &&
      (directory || info.nlink === 1) &&
      info.uid === process.getuid?.() &&
      (info.mode & (privateMode ? 0o077 : 0o022)) === 0 &&
      (await realpath(path)) === path,
    "Inputs must be owned regular private paths, without symlink ancestors",
  );
  return info;
}
async function privateJSON(path: string): Promise<unknown> {
  await ownedPath(path, false);
  // Do not include parse errors, filenames, or input values in public diagnostics.
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Error("Private JSON is unreadable");
  }
}
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
function tableWitnesses(value: Record<string, Digest>, postgres = false) {
  requireThat(
    value && typeof value === "object" && Object.keys(value).length,
    "Table witnesses are required",
  );
  for (const [table, digest] of Object.entries(value)) {
    const parts = table.split(".");
    requireThat(
      postgres
        ? parts.length === 2 &&
            ["auth", "factory"].includes(parts[0] ?? "") &&
            postgresIdentifier.test(parts[1] ?? "")
        : identifier.test(table),
      "Unsafe witness table",
    );
    keys(digest, "rows sha256");
    requireThat(
      Number.isSafeInteger(digest.rows) && digest.rows >= 0 && sha.test(digest.sha256),
      "A real row count and SHA-256 are required for every table",
    );
  }
}

/** Reads only explicit private input metadata and compressed-byte hashes. No daemon or writes. */
export function loadFixture(
  path: string,
  owner: string,
  mode?: "run" | "inspect",
): Promise<LoadedFixture>;
export function loadFixture(path: string, owner: string, mode: "cleanup"): Promise<Fixture>;
export async function loadFixture(
  path: string,
  owner: string,
  mode: "run" | "inspect" | "cleanup" = "run",
): Promise<LoadedFixture | Fixture> {
  requireThat(["run", "inspect", "cleanup"].includes(mode), "Unknown fixture load mode");
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
  const sourceManifest = supportedSourceManifests.find(
    (entry) =>
      entry.chartRevision === f.source.chartRevision &&
      entry.applicationRevision === f.source.applicationRevision,
  );
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
  requireThat(
    Object.values(f.limits).every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) &&
      [
        f.limits.memoryMiB,
        f.limits.pids,
        f.limits.tmpfsMiB,
        f.limits.commandTimeoutSeconds,
        f.limits.requiredDiskBytes,
        f.limits.availableDiskBytes,
      ].every(Number.isSafeInteger) &&
      f.limits.requiredDiskBytes <= f.limits.availableDiskBytes,
    "Explicit positive resource limits and disk allowance required",
  );
  for (const kind of ["containers", "networks", "volumes"] as const) {
    requireThat(
      Array.isArray(f.retained[kind]) &&
        f.retained[kind].every((v) => typeof v === "string" && /^[a-zA-Z0-9_.-]+$/.test(v)),
      "Explicit retained Docker resource denylists required, including observed empty arrays",
    );
  }
  for (const resource of resourcePlan(f))
    requireThat(
      !f.retained[
        resource.kind === "container"
          ? "containers"
          : resource.kind === "network"
            ? "networks"
            : "volumes"
      ].includes(resource.name),
      "Destination overlaps a retained resource",
    );
  const privateEntries = (await readdir(f.privateRoot)).sort();
  const allowedInputs = ["fixture.json", "witnesses.json", f.set, "objects", "tls"].sort();
  requireThat(
    privateEntries.every((name) => allowedInputs.includes(name)),
    "Private fixture root must contain only declared inputs, no Docker config or provisioner files",
  );
  // Cleanup must remain possible after a failed/incomplete input transfer. Its return type
  // deliberately has no witness fields, so it cannot masquerade as a validated restore input.
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
  // Inspection only relaxes absence of an owned evidence directory. Every input/witness/part
  // check below is identical to a new run; no receipt or archive is created or overwritten.
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
  tableWitnesses(w.postgres, true);
  requireThat(
    requiredTables.every((table) => Object.hasOwn(w.postgres, table)),
    "Product, Source/Writer and native-binding table witnesses are required, including empty tables",
  );
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
  for (const path of [
    "kubernetes-installation.json",
    "openbao/bootstrap.json",
    "openbao/factory-login.json",
  ])
    requireThat(
      w.state.files.some((v) => v.path === path && !v.link) &&
        !w.state.excludedProvisionerPaths.includes(path),
      "Original installation identity and OpenBao material must be present",
    );
  for (const path of sourceManifest.requiredStateFiles)
    requireThat(
      w.state.files.some((v) => v.path === path && !v.link && v.bytes > 0) &&
        !w.state.excludedProvisionerPaths.includes(path),
      "Supported source requires its original witnessed retained state",
    );
  fileWitnesses(w.objects);
  requireThat(
    w.objects.every((v) => !v.link),
    "Object mirrors must contain ordinary files",
  );
  const objects = join(f.privateRoot, "objects");
  const found: string[] = [];
  async function walk(path: string) {
    await ownedPath(path, true);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else {
        await ownedPath(child, false);
        found.push(relative(objects, child));
      }
    }
  }
  await walk(objects);
  requireThat(
    same(found.sort(), w.objects.map((v) => v.path).sort()),
    "Object mirror inventory differs from independent witnesses",
  );
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

type Kind = "network" | "volume" | "container";
type Resource = {
  kind: Kind;
  key: string;
  name: string;
  id: string | null;
  created: string | null;
  state: "planned" | "confirmed" | "removed" | "unconfirmed";
};
export function resourcePlan(f: Pick<Fixture, "owner">): Resource[] {
  return [
    { kind: "network" as const, key: "network" },
    ...[
      "control",
      "state",
      "postgres-data",
      "forgejo-data",
      "forgejo-config",
      "objects-data",
      "objects-input",
      "openbao-data",
    ].map((key) => ({ kind: "volume" as const, key })),
    ...["tools", "postgres", "forgejo", "garage", "rclone", "openbao", "bao-client"].map((key) => ({
      kind: "container" as const,
      key,
    })),
  ].map((v) => ({
    ...v,
    name: `factory-restore-${f.owner}-${v.key}`,
    id: null,
    created: null,
    state: "planned",
  }));
}
type Journal = {
  schema: 1;
  owner: string;
  run: string;
  source: Source;
  set: string;
  daemonID: string;
  resources: Resource[];
};
export type Receipt = {
  schema: 1;
  owner: string;
  source: Source;
  set: string;
  status: "incomplete" | "data-services-passed";
  components: Record<
    "postgres" | "forgejo" | "objects" | "openbao" | "state",
    "not-run" | "passed" | "failed"
  >;
  cleanup: "confirmed" | "unconfirmed";
  nativeActivation: "not-run-not-qualified";
  limits: Fixture["limits"];
  witnessDigest: string;
};
async function persist(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${name}.${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, join(directory, name));
}
const absent = (output: Output) =>
  output.code !== 0 &&
  /^Error(?: response from daemon)?: (?:[^\n]*no such (?:container|object|network|volume)\b|network [a-zA-Z0-9_.-]+ not found\b)/i.test(
    output.stderr.trim(),
  );
const projection = (kind: Kind) =>
  kind === "container"
    ? '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Config.Labels}}}'
    : kind === "network"
      ? '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"labels":{{json .Labels}},"internal":{{json .Internal}}}'
      : '{"id":{{json .Name}},"name":{{json .Name}},"created":{{json .CreatedAt}},"labels":{{json .Labels}}}';
function docker(f: Fixture, ...args: string[]) {
  // --config points only at the supplied private fixture, never the user's Docker login/context.
  return ["docker", "--config", f.privateRoot, "--host", f.docker.host, ...args];
}
function labels(journal: Journal, resource: Resource) {
  return {
    [`${label}.owner`]: journal.owner,
    [`${label}.run`]: journal.run,
    [`${label}.resource`]: resource.key,
    [`${label}.source`]: journal.source.namespaceUID,
    [`${label}.set`]: journal.set,
  };
}
async function observe(f: Fixture, journal: Journal, resource: Resource, execute: Execute) {
  const output = await execute(
    docker(
      f,
      resource.kind,
      "inspect",
      "--format",
      projection(resource.kind),
      resource.id ?? resource.name,
    ),
    { allowFailure: true },
  );
  if (absent(output)) return null;
  requireThat(output.code === 0, "Destination observation unconfirmed");
  let observed: {
    id: string;
    name: string;
    created: string;
    labels: Record<string, string>;
    internal?: boolean;
  };
  try {
    observed = JSON.parse(output.stdout);
  } catch {
    throw Error("Destination observation unreadable");
  }
  requireThat(
    typeof observed.id === "string" &&
      typeof observed.created === "string" &&
      observed.name.replace(/^\//, "") === resource.name &&
      (resource.kind === "volume" ? observed.id === resource.name : sha.test(observed.id)) &&
      (!resource.id || observed.id === resource.id) &&
      (!resource.created || observed.created === resource.created) &&
      observed.labels &&
      Object.entries(labels(journal, resource)).every(
        ([key, value]) => observed.labels[key] === value,
      ) &&
      (resource.kind !== "network" || observed.internal === true),
    "Destination identity/labels changed; nothing removed",
  );
  return observed;
}
export async function cleanupOwned(f: Fixture, journal: Journal, execute: Execute) {
  let confirmed = true;
  // Removing containers joins daemon-owned execs before volumes/network are considered.
  const ordered = [...journal.resources]
    .reverse()
    .sort((a, b) => Number(b.kind === "container") - Number(a.kind === "container"));
  for (const resource of ordered) {
    if (resource.state === "removed") continue;
    try {
      const observed = await observe(f, journal, resource, execute);
      if (observed) {
        resource.id = observed.id;
        resource.created = observed.created;
        await persist(f.evidenceDirectory, "ownership.json", journal);
        const output = await execute(
          docker(
            f,
            resource.kind,
            "rm",
            ...(resource.kind === "container" ? ["--force"] : []),
            observed.id,
          ),
          { allowFailure: true },
        );
        requireThat(output.code === 0, "Exact owned resource removal failed");
        requireThat(
          (await observe(f, journal, resource, execute)) === null,
          "Owned resource removal not observed",
        );
      }
      resource.state = "removed";
    } catch {
      resource.state = "unconfirmed";
      confirmed = false;
    }
    await persist(f.evidenceDirectory, "ownership.json", journal);
  }
  return confirmed;
}

// Scripts contain no credential values. Only the private input mount and owned volumes carry raw data.
export const invocation = <T>(fn: (config: T) => Promise<void>, config: T) =>
  `await (${fn.toString()})(${JSON.stringify(config)});`;
export async function rehearse(
  f: LoadedFixture,
  execute: Execute = safeExecute,
  signal?: AbortSignal,
): Promise<Receipt> {
  execute = boundedExecute(f, execute);
  signal?.throwIfAborted();
  const planned = resourcePlan(f);
  const output = await execute(
    docker(
      f,
      "info",
      "--format",
      '{"id":{{json .ID}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}',
    ),
    { signal },
  );
  const info = JSON.parse(output.stdout);
  requireThat(
    output.code === 0 &&
      info.id === f.docker.daemonID &&
      info.cpus >= f.limits.cpus * 3 &&
      info.memory >= f.limits.memoryMiB * 3 * 1024 ** 2,
    "Daemon identity/capacity does not match explicit fixture",
  );
  for (const image of Object.values(images)) {
    const result = await execute(
      docker(f, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image),
      { signal },
    );
    requireThat(
      result.code === 0 && result.stdout.trim() === f.docker.platform,
      "Pinned image must already exist for the explicit platform; no pulls",
    );
  }
  for (const resource of planned) {
    const result = await execute(
      docker(f, resource.kind, "inspect", "--format", projection(resource.kind), resource.name),
      { signal, allowFailure: true },
    );
    requireThat(
      absent(result),
      "Destination name is occupied or its absence is unconfirmed; nothing created",
    );
  }
  signal?.throwIfAborted();
  await mkdir(f.evidenceDirectory, { mode: 0o700 });
  const journal: Journal = {
    schema: 1,
    owner: f.owner,
    run: randomUUID(),
    source: f.source,
    set: f.set,
    daemonID: f.docker.daemonID,
    resources: [],
  };
  const receipt: Receipt = {
    schema: 1,
    owner: f.owner,
    source: f.source,
    set: f.set,
    status: "incomplete",
    components: {
      postgres: "not-run",
      forgejo: "not-run",
      objects: "not-run",
      openbao: "not-run",
      state: "not-run",
    },
    cleanup: "unconfirmed",
    nativeActivation: "not-run-not-qualified",
    limits: f.limits,
    witnessDigest: f.witnessDigest,
  };
  const resources = new Map(planned.map((v) => [v.key, v]));
  const get = (key: string) => {
    const resource = resources.get(key);
    if (!resource) throw Error("Unknown owned resource");
    return resource;
  };
  const name = (key: string) => get(key).name;
  const control = ["--mount", `type=volume,src=${name("control")},dst=/control`];
  const input = ["--mount", `type=bind,src=${f.privateRoot},dst=/input,readonly`];
  const volume = (key: string, target: string, ro = false) => [
    "--mount",
    `type=volume,src=${name(key)},dst=${target}${ro ? ",readonly" : ""}`,
  ];
  let fatal = false;
  async function command(args: string[], input?: string, env?: Record<string, string>) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(f.limits.commandTimeoutSeconds * 1000);
    let result: Output;
    try {
      result = await execute(docker(f, ...args), {
        ...(input === undefined ? {} : { input }),
        ...(env === undefined ? {} : { env }),
        allowFailure: true,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      // A killed client does not terminate a daemon-owned exec. Stop the entire rehearsal
      // before another component starts; exact-ID cleanup kills and joins its container.
      if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError"))
        fatal = true;
      throw Error("Owned command completion unconfirmed; sensitive diagnostics suppressed");
    }
    signal?.throwIfAborted();
    requireThat(
      !timeout.aborted && result.code === 0,
      "Owned restore command failed; sensitive output suppressed",
    );
    return result.stdout.trim();
  }
  async function create(key: string, args: string[] = [], env?: Record<string, string>) {
    const resource = get(key);
    signal?.throwIfAborted();
    journal.resources.push(resource);
    await persist(f.evidenceDirectory, "ownership.json", journal);
    await command(
      [
        resource.kind,
        "create",
        ...Object.entries(labels(journal, resource)).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        ...args,
        ...(resource.kind === "container" ? [] : [resource.name]),
      ],
      undefined,
      env,
    );
    const observed = await observe(f, journal, resource, execute);
    requireThat(observed, "Original create could not be confirmed");
    resource.id = observed.id;
    resource.created = observed.created;
    resource.state = "confirmed";
    await persist(f.evidenceDirectory, "ownership.json", journal);
  }
  async function container(
    key: string,
    image: string,
    args: string[],
    entrypoint: string,
    tail: string[],
    env?: Record<string, string>,
  ) {
    await create(
      key,
      [
        "--name",
        name(key),
        "--pull",
        "never",
        "--platform",
        f.docker.platform,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        String(f.limits.pids),
        "--memory",
        `${f.limits.memoryMiB}m`,
        "--cpus",
        String(f.limits.cpus),
        "--log-driver=none",
        "--restart=no",
        "--tmpfs",
        `/tmp:rw,nosuid,nodev,noexec,size=${f.limits.tmpfsMiB}m`,
        ...args,
        "--entrypoint",
        entrypoint,
        image,
        ...tail,
      ],
      env,
    );
    await command(["container", "start", get(key).id ?? ""]);
  }
  const exec = async (key: string, script: string, shell = "node") => {
    try {
      return await command(
        [
          "exec",
          "-i",
          get(key).id ?? "",
          ...(shell === "node" ? ["node", "--input-type=module"] : [shell, "-s"]),
        ],
        script,
      );
    } catch {
      // This shared staging container must not keep an uncertain raw-data writer alive.
      if (key === "tools") fatal = true;
      throw Error("Owned component command failed; sensitive diagnostics suppressed");
    }
  };
  async function component(key: keyof Receipt["components"], action: () => Promise<void>) {
    signal?.throwIfAborted();
    try {
      await action();
      signal?.throwIfAborted();
      receipt.components[key] = "passed";
    } catch {
      receipt.components[key] = "failed";
    } finally {
      const clients = {
        state: [],
        postgres: ["postgres"],
        forgejo: ["forgejo"],
        objects: ["rclone", "garage"],
        openbao: ["bao-client", "openbao"],
      }[key];
      for (const client of clients)
        if (get(client).id && !signal?.aborted) {
          try {
            await command(["container", "stop", get(client).id ?? ""]);
          } catch {
            receipt.components[key] = "failed";
            fatal = true;
          }
        }
    }
    await persist(f.evidenceDirectory, "result.json", receipt);
    signal?.throwIfAborted();
    requireThat(!fatal, "Owned client completion unconfirmed; stop before subsequent components");
  }
  try {
    await persist(f.evidenceDirectory, "result.json", receipt);
    await create("network", ["--internal", "--driver", "bridge"]);
    for (const resource of planned.filter((v) => v.kind === "volume"))
      await create(resource.key, ["--driver", "local"]);
    const toolsMounts = [
      ...control,
      ...input,
      ...volume("state", "/state"),
      ...volume("forgejo-data", "/forgejo"),
      ...volume("forgejo-config", "/forgejo-config"),
      ...volume("openbao-data", "/bao-data"),
      ...volume("postgres-data", "/pg-data"),
      ...volume("objects-data", "/objects-data"),
      ...volume("objects-input", "/objects-input"),
    ];
    await container(
      "tools",
      images["tools"] ?? "",
      [
        "--network",
        "none",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--cap-add=DAC_OVERRIDE",
        ...toolsMounts,
      ],
      "node",
      ["-e", "setInterval(()=>{},2147483647)"],
    );
    await component("state", async () => {
      const config = {
        root: "",
        set: f.set,
        source: f.source,
        diskBytes: f.limits.requiredDiskBytes,
        witnessDigest: f.witnessDigest,
      };
      await exec("tools", invocation(restoreFiles, { ...config, verifyOnly: true }));
      await exec("tools", invocation(restoreFiles, config));
    });
    requireThat(
      receipt.components.state === "passed",
      "Archive/state staging failed; no data services started",
    );
    await component("postgres", async () => {
      await container(
        "postgres",
        images["postgres"] ?? "",
        [
          "--network",
          "none",
          ...control,
          ...volume("postgres-data", "/var/lib/postgresql/data"),
          "--tmpfs",
          "/var/run/postgresql:rw,nosuid,nodev,uid=999,gid=999,mode=0775",
          "--user",
          "999:999",
          "-e",
          "POSTGRES_DB=factory",
          "-e",
          "POSTGRES_USER=factory",
          "-e",
          "POSTGRES_PASSWORD_FILE=/control/pg-password",
          "-e",
          "PGDATA=/var/lib/postgresql/data/pgdata",
        ],
        "docker-entrypoint.sh",
        ["postgres", "-c", "listen_addresses=", "-c", "wal_level=logical"],
      );
      await exec(
        "postgres",
        `set -euo pipefail
until test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U factory -d factory; do sleep 1; done
pg_restore --exit-on-error --single-transaction --no-owner -U factory -d factory /control/postgres.dump >/dev/null 2>&1
`,
        "bash",
      );
      const foreignKeys = await readFile(
        resolve(import.meta.dir, "../../deploy/helm/factory/files/backup/foreign-keys.sql"),
        "utf8",
      );
      const observed = JSON.parse(
        await exec("postgres", postgresWitnessProgram(f.witnesses.postgres, foreignKeys), "bash"),
      );
      requireThat(
        same(observed, f.witnesses.postgres),
        "Restored PostgreSQL inventory/row digests differ",
      );
    });
    await component("forgejo", async () => {
      await exec("tools", invocation(validateForgejoDatabase, { root: "" }));
      await exec(
        "tools",
        `const fs = await import("node:fs/promises");
await fs.chown("/forgejo/data/forgejo.db", 1000, 1000);
await fs.chmod("/forgejo/data/forgejo.db", 0o600);`,
      );
      await container(
        "forgejo",
        images["forgejo"] ?? "",
        [
          "--network",
          "none",
          "--user",
          "1000:1000",
          ...volume("forgejo-data", "/var/lib/gitea", true),
          ...volume("forgejo-config", "/etc/gitea", true),
        ],
        "sh",
        ["-c", "while :; do sleep 3600; done"],
      );
      // No server, hooks, migrations or restored executable files are started.
      await exec(
        "forgejo",
        forgejoWitnessProgram(
          f.witnesses.forgejo.repositories.map(
            (repo) => `/var/lib/gitea/git/repositories/${repo.slice(6)}`,
          ),
        ),
        "sh",
      );
    });
    await component("objects", async () => {
      const access = `GK${randomBytes(16).toString("hex")}`,
        secret = randomBytes(32).toString("hex"),
        rpc = randomBytes(32).toString("hex");
      await exec(
        "tools",
        `const fs = await import("node:fs/promises");
await fs.writeFile("/control/object-access", ${JSON.stringify(access)}, {mode:0o600});
await fs.writeFile("/control/object-secret", ${JSON.stringify(secret)}, {mode:0o600});`,
      );
      await container(
        "garage",
        images["garage"] ?? "",
        [
          "--network",
          name("network"),
          "--network-alias",
          "garage",
          "--dns",
          "127.0.0.1",
          "--user",
          "1000:1000",
          ...volume("objects-data", "/data"),
          ...control,
          "-e",
          "GARAGE_DEFAULT_BUCKET=factory",
          "-e",
          "GARAGE_DEFAULT_ACCESS_KEY",
          "-e",
          "GARAGE_DEFAULT_SECRET_KEY",
          "-e",
          "GARAGE_RPC_SECRET",
        ],
        "/garage",
        ["-c", "/control/garage.toml", "server", "--single-node", "--default-bucket"],
        {
          GARAGE_DEFAULT_ACCESS_KEY: access,
          GARAGE_DEFAULT_SECRET_KEY: secret,
          GARAGE_RPC_SECRET: rpc,
        },
      );
      await container(
        "rclone",
        images["rclone"] ?? "",
        [
          "--network",
          name("network"),
          "--dns",
          "127.0.0.1",
          ...control,
          ...volume("objects-input", "/objects-input", true),
        ],
        "sh",
        ["-c", "while :; do sleep 3600; done"],
      );
      await exec(
        "rclone",
        `set -eu
export HOME=/tmp RCLONE_CONFIG=/dev/null RCLONE_CONFIG_OBJECTS_TYPE=s3 RCLONE_CONFIG_OBJECTS_PROVIDER=Other
export RCLONE_CONFIG_OBJECTS_ENDPOINT=http://garage:3900 RCLONE_CONFIG_OBJECTS_REGION=garage RCLONE_CONFIG_OBJECTS_FORCE_PATH_STYLE=true
RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID="$(cat /control/object-access)"; export RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID
RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY="$(cat /control/object-secret)"; export RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY
until rclone lsf objects:factory >/dev/null 2>&1; do sleep 1; done
rclone copy /objects-input objects:factory --create-empty-src-dirs --retries 1 >/dev/null 2>&1
rclone check /objects-input objects:factory --download --retries 1 >/dev/null 2>&1
`,
        "sh",
      );
    });
    await component("openbao", async () => {
      await container(
        "openbao",
        images["openbao"] ?? "",
        [
          "--network",
          "none",
          "--user",
          "100:1000",
          ...control,
          ...volume("openbao-data", "/bao/data"),
        ],
        "/usr/bin/bao",
        ["server", "-config=/control/bao.json"],
      );
      await container(
        "bao-client",
        images["tools"] ?? "",
        [
          "--network",
          `container:${get("openbao").id}`,
          "--cap-add=DAC_OVERRIDE",
          ...control,
          ...volume("state", "/state", true),
        ],
        "node",
        ["-e", "setInterval(()=>{},2147483647)"],
      );
      await exec("bao-client", invocation(openBaoRequest, { action: "initialize" }));
      await exec(
        "openbao",
        `set -eu
export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/control/tls/ca.crt
BAO_TOKEN="$(cat /control/temporary-root-token)"; export BAO_TOKEN
bao operator raft snapshot restore -force /control/openbao.snap >/dev/null 2>&1
`,
        "sh",
      );
      await exec("bao-client", invocation(openBaoRequest, { action: "validate" }));
    });
  } catch {
    // Unknown/cancelled outcomes are incomplete. Never serialize command errors or raw service output.
  } finally {
    receipt.cleanup = (await cleanupOwned(f, journal, execute)) ? "confirmed" : "unconfirmed";
    if (
      !signal?.aborted &&
      receipt.cleanup === "confirmed" &&
      Object.values(receipt.components).every((v) => v === "passed")
    )
      receipt.status = "data-services-passed";
    await persist(f.evidenceDirectory, "result.json", receipt);
  }
  return receipt;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export function forgejoWitnessProgram(repositories: string[]) {
  return `set -eu
export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
${repositories
  .map(
    (repo) => `# Restored config, including includes, must not weaken the independent check.
if git --git-dir=${shellQuote(repo)} config --includes --get-regexp '^fsck\\.' >/dev/null 2>&1; then
  exit 1
else
  test "$?" -eq 1
fi
git --git-dir=${shellQuote(repo)} fsck --full --strict >/dev/null 2>&1`,
  )
  .join("\n")}
`;
}
export function postgresWitnessProgram(tables: Record<string, Digest>, foreignKeys: string) {
  tableWitnesses(tables, true);
  const names = Object.keys(tables).sort();
  return `set -euo pipefail
# PG_WITNESS: canonical COPY bytes, no raw row leaves the owned container.
export PGOPTIONS='-c timezone=UTC -c extra_float_digits=3 -c bytea_output=hex -c default_transaction_read_only=on'
psql() { command psql -X -q -v ON_ERROR_STOP=1 -U factory -d factory "$@"; }
actual="$(psql -Atc "SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('auth','factory') AND c.relkind='r' ORDER BY (n.nspname||'.'||c.relname) COLLATE \\"C\\"")"
test "$actual" = ${shellQuote(names.join("\n"))}
test "$(psql -Atc "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('auth','factory') AND c.contype='f' AND NOT c.convalidated")" = 0
fk="$(psql -At <<'FACTORY_FK_SQL'
${foreignKeys}
FACTORY_FK_SQL
)"
test -n "$fk"
if printf '%s\\n' "$fk" | grep -qv '|0$'; then exit 1; fi
printf '{'
${names
  .map((table, i) => {
    const qualified = table
      .split(".")
      .map((part) => `"${part}"`)
      .join(".");
    return `count="$(psql -Atc 'SELECT count(*) FROM ${qualified}')"
digest="$(psql -c 'COPY (SELECT row_to_json(t)::text AS row FROM ${qualified} t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT' | sha256sum)"
printf '${i ? "," : ""}"${table}":{"rows":%s,"sha256":"%s"}' "$count" "\${digest%% *}"`;
  })
  .join("\n")}
printf '}'
`;
}

async function safeExecute(
  command: string[],
  options: RunOptions & { env?: Record<string, string> } = {},
) {
  // Do not inherit Docker contexts, proxy variables, credentials or application authority.
  const child = Bun.spawn(command, {
    env: { PATH: process.env["PATH"] ?? "", ...options.env },
    stdin:
      options.input === undefined
        ? "ignore"
        : options.input instanceof Blob
          ? options.input
          : new Blob([options.input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    timer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    options.signal?.throwIfAborted();
    return { stdout, stderr, code };
  } finally {
    if (child.exitCode === null && child.signalCode === null) stop();
    await child.exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}
function boundedExecute(f: Fixture, execute: Execute): Execute {
  return async (command, options = {}) => {
    const deadline = AbortSignal.timeout(f.limits.commandTimeoutSeconds * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const result = await execute(command, { ...options, signal });
    signal.throwIfAborted();
    return result;
  };
}

// Each function below is self-contained so the exact tested implementation can run through
// `docker exec -i ... node --input-type=module`. It needs only the already pinned Node image.
// The optional root is for synthetic local unit fixtures, never an operator-controlled destination.
export async function restoreFiles(config: {
  root: string;
  set: string;
  source: Source;
  diskBytes: number;
  witnessDigest?: string;
  verifyOnly?: boolean;
}) {
  const fs = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const { createHash, randomBytes } = await import("node:crypto");
  const { createGunzip } = await import("node:zlib");
  const path = await import("node:path");
  const at = (name: string) => `${config.root}${name}`;
  const w: Witnesses = JSON.parse(await fs.readFile(at("/input/witnesses.json"), "utf8"));
  const fail = () => {
    throw Error(
      "Archive, content witness or original state identity failed; raw diagnostics suppressed",
    );
  };
  if (
    !w.forgejo.files.some(
      (entry) => entry.path === "forgejo.sqlite3" && entry.link === undefined && entry.bytes > 0,
    )
  )
    fail();
  if (
    config.witnessDigest &&
    createHash("sha256").update(JSON.stringify(w)).digest("hex") !== config.witnessDigest
  )
    fail();
  function safe(name: string) {
    const value = name.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    if (!value || value === ".") return "";
    if (
      path.isAbsolute(value) ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char === "\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail();
    return value;
  }
  async function parents(file: string, root: string) {
    const rel = path.relative(root, path.dirname(file));
    if (rel.startsWith("..") || path.isAbsolute(rel)) fail();
    let parent = root;
    for (const component of rel.split("/").filter(Boolean)) {
      parent = path.join(parent, component);
      await fs.mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const info = await fs.lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) fail();
    }
  }
  async function fileHash(file: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  }
  type Destination = { root: string; relative: string } | null;
  // Strict streaming tar reader. No archive member name or link is passed to tar/shell.
  // Sparse files, devices, FIFOs and unknown tar extensions refuse instead of disappearing.
  async function archive(
    file: string,
    expected: FileWitness[],
    destination: (name: string) => Destination,
    snapshot = false,
  ) {
    const source = createReadStream(file);
    const unzip = source.pipe(createGunzip());
    source.on("error", (error) => unzip.destroy(error));
    const iterator = unzip[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0),
      offset = 0,
      ended = false;
    async function consume(size: number, sink?: (bytes: Buffer) => Promise<void>) {
      while (size > 0) {
        if (offset === buffer.length) {
          const next = await iterator.next();
          if (next.done) fail();
          buffer = Buffer.from(next.value as Uint8Array);
          offset = 0;
        }
        const n = Math.min(size, buffer.length - offset);
        const chunk = buffer.subarray(offset, offset + n);
        if (sink) await sink(chunk);
        offset += n;
        size -= n;
      }
    }
    async function small(size: number) {
      if (size > 1024 ** 2) fail();
      const chunks: Buffer[] = [];
      await consume(size, async (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      return Buffer.concat(chunks);
    }
    function number(header: Buffer, start: number, length: number) {
      const raw = header
        .subarray(start, start + length)
        .toString("ascii")
        .replace(/\0.*$/, "")
        .trim();
      if (!/^[0-7]*$/.test(raw)) fail();
      const value = Number.parseInt(raw || "0", 8);
      if (!Number.isSafeInteger(value) || value < 0) fail();
      return value;
    }
    const text = (b: Buffer, start: number, length: number) =>
      b
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/, "");
    const wanted = new Map(expected.map((entry) => [entry.path, entry]));
    const seen = new Set<string>();
    const symlinks = new Map<string, Map<string, string>>();
    const snapshotHashes = new Map<string, string>();
    let sums = "";
    let extensions: Record<string, string> = {};
    const directories: { file: string; mode: number; uid: number; gid: number }[] = [];
    try {
      while (!ended) {
        const header = await small(512);
        if (header.every((byte) => byte === 0)) {
          const second = await small(512);
          if (!second.every((byte) => byte === 0) || Object.keys(extensions).length) fail();
          if (!buffer.subarray(offset).every((byte) => byte === 0)) fail();
          for await (const chunk of { [Symbol.asyncIterator]: () => iterator })
            if (!Buffer.from(chunk as Uint8Array).every((byte) => byte === 0)) fail();
          ended = true;
          break;
        }
        const checksum = number(header, 148, 8);
        let actual = 0;
        header.forEach((value, index) => {
          actual += index >= 148 && index < 156 ? 32 : value;
        });
        if (checksum !== actual) fail();
        let name = text(header, 0, 100);
        const prefix = text(header, 345, 155);
        // GNU tar's old header uses this area for other fields, not a USTAR prefix.
        if (text(header, 257, 6) === "ustar" && header[262] === 0 && prefix)
          name = `${prefix}/${name}`;
        const type = text(header, 156, 1) || "0";
        const size = number(header, 124, 12);
        if (["x", "L", "K"].includes(type)) {
          const data = await small(size);
          if (type === "L")
            extensions["path"] = data.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
          else if (type === "K")
            extensions["linkpath"] = data.toString("utf8").replace(/\0.*$/, "").replace(/\n$/, "");
          else {
            let cursor = 0;
            while (cursor < data.length) {
              const space = data.indexOf(32, cursor);
              const length = Number(data.subarray(cursor, space).toString("ascii"));
              if (
                space < cursor ||
                !Number.isSafeInteger(length) ||
                length <= space - cursor + 2 ||
                cursor + length > data.length
              )
                fail();
              const record = data.subarray(space + 1, cursor + length - 1).toString("utf8");
              const equals = record.indexOf("=");
              const key = record.slice(0, equals);
              if (
                equals < 1 ||
                !["path", "linkpath", "mtime", "atime", "ctime", "uid", "gid"].includes(key)
              )
                fail();
              extensions[key] = record.slice(equals + 1);
              cursor += length;
            }
          }
          await consume((512 - (size % 512)) % 512);
          continue;
        }
        name = safe(extensions["path"] ?? name);
        const link = extensions["linkpath"] ?? text(header, 157, 100);
        const uid = Number(extensions["uid"] ?? number(header, 108, 8));
        const gid = Number(extensions["gid"] ?? number(header, 116, 8));
        const mode = number(header, 100, 8) & 0o777; // never restore setuid/setgid
        extensions = {};
        if (
          ![uid, gid].every((v) => Number.isSafeInteger(v) && v >= 0) ||
          !["0", "2", "5"].includes(type) ||
          (type !== "0" && size !== 0)
        )
          fail();
        const target = name ? destination(name) : null;
        if (type === "5") {
          if (target && !config.verifyOnly) {
            const file = path.join(target.root, target.relative);
            await parents(path.join(file, ".directory"), target.root);
            directories.push({ file, mode, uid, gid });
          }
          continue;
        }
        const witness = wanted.get(name);
        if (snapshot) {
          if (
            !["meta.json", "state.bin", "SHA256SUMS", "SHA256SUMS.sealed"].includes(name) ||
            seen.has(name) ||
            type !== "0" ||
            (name === "SHA256SUMS" && size > 1024 ** 2)
          )
            fail();
        } else if (
          !witness ||
          seen.has(name) ||
          witness.bytes !== size ||
          (type === "2") !== (witness.link !== undefined) ||
          (type === "2" && witness.link !== link)
        )
          fail();
        seen.add(name);
        const hash = createHash("sha256");
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        if (type === "2") {
          if (
            path.isAbsolute(link) ||
            [...link].some((char) => char.charCodeAt(0) < 32 || char === "\\")
          )
            fail();
          const base = target
            ? path.join(target.root, target.relative)
            : path.join("/checked-archive", name);
          const root = target?.root ?? "/checked-archive";
          const rel = path.relative(root, path.resolve(path.dirname(base), link));
          if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) fail();
          const links = symlinks.get(root) ?? new Map<string, string>();
          links.set(path.relative(root, base), link);
          symlinks.set(root, links);
        }
        const output =
          target && !config.verifyOnly ? path.join(target.root, target.relative) : null;
        if (output && target) await parents(output, target.root);
        try {
          if (output && type === "0") handle = await fs.open(output, "wx", 0o600);
          await consume(size, async (chunk) => {
            hash.update(chunk);
            if (snapshot && name === "SHA256SUMS") sums += chunk.toString("utf8");
            if (handle) await handle.writeFile(chunk);
          });
          if (type === "2") hash.update(link);
          const actualHash = hash.digest("hex");
          if (snapshot) snapshotHashes.set(name, actualHash);
          else if (actualHash !== witness?.sha256) fail();
          if (output) {
            if (type === "2") {
              if (
                path.isAbsolute(link) ||
                [...link].some((char) => char.charCodeAt(0) < 32 || char === "\\")
              )
                fail();
              const resolved = path.resolve(path.dirname(output), link);
              const rel = path.relative(target?.root ?? "", resolved);
              if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) fail();
              await fs.symlink(link, output);
              await fs.lchown(output, uid, gid);
            } else {
              await handle?.chown(uid, gid);
              await handle?.chmod(mode);
            }
          }
        } finally {
          await handle?.close();
        }
        await consume((512 - (size % 512)) % 512);
      }
      if (snapshot) {
        if (!["meta.json", "state.bin", "SHA256SUMS"].every((v) => seen.has(v))) fail();
        for (const name of ["meta.json", "state.bin"])
          if (
            !sums
              .split("\n")
              .some(
                (line) =>
                  line === `${snapshotHashes.get(name)}  ${name}` ||
                  line === `${snapshotHashes.get(name)} *${name}`,
              )
          )
            fail();
      } else if (seen.size !== wanted.size) fail();
      // Resolve components in filesystem order, not with path.resolve: a/.. can escape
      // when a itself points to ".". Check forward references too, before extraction.
      for (const links of symlinks.values())
        for (const name of links.keys()) {
          let pending = name.split("/");
          const resolved: string[] = [];
          let hops = 0;
          while (pending.length) {
            const component = pending.shift();
            if (!component || component === ".") continue;
            if (component === "..") {
              if (!resolved.length) fail();
              resolved.pop();
              continue;
            }
            resolved.push(component);
            const target = links.get(resolved.join("/"));
            if (target !== undefined) {
              if (!target || ++hops > 40) fail();
              resolved.pop();
              pending = [...target.split("/"), ...pending];
            }
          }
        }
      for (const entry of directories.reverse()) {
        await fs.chown(entry.file, entry.uid, entry.gid);
        await fs.chmod(entry.file, entry.mode);
      }
    } finally {
      source.destroy();
      unzip.destroy();
    }
  }
  const roots = [
    "/control",
    "/state",
    "/forgejo",
    "/forgejo-config",
    "/bao-data",
    "/pg-data",
    "/objects-data",
    "/objects-input",
  ];
  for (const root of roots) {
    if ((await fs.readdir(at(root))).length) fail();
    const disk = await fs.statfs(at(root));
    if (Number(disk.bavail) * Number(disk.bsize) < config.diskBytes) fail();
  }
  // Recheck compressed inputs inside the read-only mount. In-place input mutation cannot pass.
  for (const [name, expected] of Object.entries(w.parts))
    if ((await fileHash(at(`/input/${config.set}/${name}`))) !== expected) fail();
  await archive(at(`/input/${config.set}/state.tar.gz`), w.state.files, (name) =>
    w.state.excludedProvisionerPaths.includes(name) ? null : { root: at("/state"), relative: name },
  );
  await archive(at(`/input/${config.set}/forgejo.tar.gz`), w.forgejo.files, (name) => {
    if (name === "forgejo.sqlite3") return { root: at("/forgejo"), relative: "data/forgejo.db" };
    // Keep the SQL and live raw database in the complete inventory, but never execute or use them.
    if (name === "forgejo-db.sql") return null;
    if (name === "app.ini") return { root: at("/forgejo-config"), relative: "app.ini" };
    if (name === "data") return null;
    if (name.startsWith("data/")) {
      if (/^data\/data\/forgejo\.db(?:$|[-.])/.test(name)) return null;
      return { root: at("/forgejo"), relative: name.slice(5) };
    }
    if (name === "repos") return null;
    if (name.startsWith("repos/"))
      return { root: at("/forgejo"), relative: `git/repositories/${name.slice(6)}` };
    if (name === "custom" || name.startsWith("custom/"))
      return { root: at("/forgejo"), relative: name };
    fail();
    return null;
  });
  // Stream and verify the snapshot's meta/state sums without extracting it or buffering state.bin.
  await archive(at(`/input/${config.set}/openbao.snap`), [], () => null, true);
  for (const entry of w.objects) {
    const source = at(`/input/objects/${entry.path}`);
    const info = await fs.lstat(source);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== entry.bytes ||
      (await fileHash(source)) !== entry.sha256
    )
      fail();
  }
  if (config.verifyOnly) return;
  const identity = JSON.parse(await fs.readFile(at("/state/kubernetes-installation.json"), "utf8"));
  const expectedIdentity = {
    runtime: "substrate",
    namespace: config.source.namespace,
    release: config.source.release,
    factoryURL: config.source.factoryOrigin,
    forgeURL: config.source.forgejoOrigin,
    storageClass: config.source.storageClass,
  };
  if (
    Object.keys(identity).length !== Object.keys(expectedIdentity).length ||
    Object.entries(expectedIdentity).some(([k, v]) => identity[k] !== v)
  )
    fail();
  for (const entry of w.objects) {
    const source = at(`/input/objects/${entry.path}`);
    const info = await fs.lstat(source);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== entry.bytes ||
      (await fileHash(source)) !== entry.sha256
    )
      fail();
    const target = at(`/objects-input/${entry.path}`);
    await parents(target, at("/objects-input"));
    await fs.copyFile(source, target, 1);
    if ((await fileHash(target)) !== entry.sha256) fail();
    await fs.chmod(target, 0o600);
  }
  for (const [name, uid] of [
    ["postgres.dump", 999],
    ["openbao.snap", 100],
  ] as const) {
    await fs.copyFile(at(`/input/${config.set}/${name}`), at(`/control/${name}`), 1);
    if ((await fileHash(at(`/control/${name}`))) !== w.parts[name]) fail();
    await fs.chown(at(`/control/${name}`), uid, uid === 100 ? 1000 : 999);
    await fs.chmod(at(`/control/${name}`), 0o600);
  }
  for (const [directory, uid, gid] of [
    ["/pg-data", 999, 999],
    ["/bao-data", 100, 1000],
    ["/objects-data", 1000, 1000],
  ] as const)
    await fs.chown(at(directory), uid, gid);
  await fs.chmod(at("/control"), 0o755);
  await fs.writeFile(at("/control/witnesses.json"), JSON.stringify(w), { mode: 0o600, flag: "wx" });
  await fs.writeFile(at("/control/pg-password"), randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
  await fs.chown(at("/control/pg-password"), 999, 999);
  await fs.mkdir(at("/control/tls"), { mode: 0o755 });
  for (const name of ["ca.crt", "tls.crt", "tls.key"]) {
    await fs.copyFile(at(`/input/tls/${name}`), at(`/control/tls/${name}`), 1);
    await fs.chown(at(`/control/tls/${name}`), 100, 1000);
    await fs.chmod(at(`/control/tls/${name}`), name === "tls.key" ? 0o600 : 0o644);
  }
  await fs.writeFile(
    at("/control/bao.json"),
    JSON.stringify({
      storage: { raft: { path: "/bao/data", node_id: "factory" } },
      api_addr: "https://127.0.0.1:8200",
      cluster_addr: "https://127.0.0.1:8201",
      listener: {
        tcp: {
          address: "127.0.0.1:8200",
          tls_cert_file: "/control/tls/tls.crt",
          tls_key_file: "/control/tls/tls.key",
        },
      },
      ui: false,
    }),
    { mode: 0o644, flag: "wx" },
  );
  await fs.writeFile(
    at("/control/garage.toml"),
    `metadata_dir="/data/meta"
data_dir="/data/blocks"
db_engine="sqlite"
replication_factor=1
rpc_bind_addr="127.0.0.1:3901"
rpc_public_addr="127.0.0.1:3901"
[s3_api]
s3_region="garage"
api_bind_addr="0.0.0.0:3900"
root_domain=".objects.invalid"
`,
    { mode: 0o644, flag: "wx" },
  );
  // Git/SQLite tools run as the normal Forgejo user, never its server entrypoint.
  async function own(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await own(file);
      await fs.lchown(file, 1000, 1000);
    }
    await fs.chown(directory, 1000, 1000);
  }
  await own(at("/forgejo"));
  await own(at("/forgejo-config"));
}

export async function validateForgejoDatabase(config: { root: string }) {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");
  const at = (name: string) => `${config.root}${name}`;
  const w: Witnesses = JSON.parse(await fs.readFile(at("/control/witnesses.json"), "utf8"));
  const fail = (): never => {
    throw Error("Forgejo database/files differ from private witnesses");
  };
  const file = at("/forgejo/data/forgejo.db");
  const expectedFile = w.forgejo.files.find((entry) => entry.path === "forgejo.sqlite3") ?? fail();
  const info = await fs.lstat(file);
  if (
    expectedFile.link !== undefined ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size !== expectedFile.bytes
  )
    fail();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await fs.lstat(`${file}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (sidecar) fail();
  }
  const { createReadStream } = await import("node:fs");
  const fileHash = createHash("sha256");
  for await (const chunk of createReadStream(file)) fileHash.update(chunk);
  if (fileHash.digest("hex") !== expectedFile.sha256) fail();
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    // Reject a WAL-format main file even if its required WAL was omitted from the archive.
    if (
      bytesRead !== header.length ||
      header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      fail();
  } finally {
    await handle.close();
  }
  // Only the witnessed Online Backup snapshot is authoritative. Never run forgejo-db.sql,
  // open the archived live main.db, start Forgejo or reconstruct migration metadata.
  const db = new DatabaseSync(file, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    if (
      db.prepare("PRAGMA journal_mode").get()?.["journal_mode"] !== "delete" ||
      db.prepare("PRAGMA integrity_check").get()?.["integrity_check"] !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail();
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((v) => String(v["name"]));
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(w.forgejo.tables).sort())) fail();
    // SQLite witnesses hash sorted JSON row arrays in PRAGMA table_info column order, one LF per row.
    // Blob values use {"hex":"..."}; 64-bit integers use {"integer":"..."} to avoid precision loss.
    for (const name of names) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail();
      const statement = db.prepare(`SELECT * FROM "${name}"`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows = statement
        .all()
        .map((row) =>
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === "bigint"
              ? { integer: String(value) }
              : value instanceof Uint8Array
                ? { hex: Buffer.from(value).toString("hex") }
                : value,
          ),
        )
        .sort();
      const hash = createHash("sha256");
      for (const row of rows) hash.update(`${row}\n`);
      const expected = w.forgejo.tables[name];
      if (!expected || expected.rows !== rows.length || expected.sha256 !== hash.digest("hex"))
        fail();
    }
  } finally {
    db.close();
  }
  const app = await fs.lstat(at("/forgejo-config/app.ini"));
  if (!app.isFile() || app.size === 0) fail();
  // The complete archive inventory/digests were checked before opening the snapshot read-only.
  // Require all operator-declared bare repositories, including repositories with no commits.
  for (const repo of w.forgejo.repositories) {
    if (!repo.startsWith("repos/")) fail();
    const root = at(`/forgejo/git/repositories/${repo.slice(6)}`);
    if (
      !(await fs.lstat(`${root}/HEAD`)).isFile() ||
      !(await fs.lstat(`${root}/objects`)).isDirectory()
    )
      fail();
  }
}

export async function openBaoRequest(config: { action: "initialize" | "validate" }) {
  const fs = await import("node:fs/promises");
  const https = await import("node:https");
  const { createHash } = await import("node:crypto");
  const ca = await fs.readFile("/control/tls/ca.crt");
  const fail = (): never => {
    throw Error("OpenBao restore/unseal/AppRole witness failed; sensitive output suppressed");
  };
  async function request(path: string, body?: unknown, token?: string) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    type Body = {
      initialized?: boolean;
      sealed?: boolean;
      keys_base64?: string[];
      root_token?: string;
      auth?: { client_token?: string };
      data?: { data?: unknown };
    };
    return new Promise<{ code: number; body: Body }>((accept, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: 8200,
          path: `/v1/${path}`,
          ca,
          method: encoded === undefined ? "GET" : "POST",
          timeout: 5000,
          headers: {
            ...(encoded ? { "content-type": "application/json" } : {}),
            ...(token ? { "X-Vault-Token": token } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 8 * 1024 ** 2) response.destroy(Error("Private response too large"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              accept({
                code: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch {
              reject(Error("Private response invalid"));
            }
          });
        },
      );
      req.once("timeout", () => req.destroy(Error("Owned TLS request timed out")));
      req.once("error", reject);
      req.end(encoded);
    });
  }
  // Readiness retries are inside the explicit operator command deadline, not a success fallback.
  async function active() {
    for (;;) {
      const current = await request("sys/health");
      if (
        current.code === 200 &&
        current.body.initialized === true &&
        current.body.sealed === false
      )
        return;
      if (current.body.sealed !== false) return fail();
      await new Promise((accept) => setTimeout(accept, 500));
    }
  }
  let health: Awaited<ReturnType<typeof request>>;
  for (;;) {
    try {
      health = await request("sys/health");
      break;
    } catch {
      await new Promise((accept) => setTimeout(accept, 500));
    }
  }
  if (config.action === "initialize") {
    if (health.body["initialized"] !== false) fail();
    const initialized = await request("sys/init", { secret_shares: 1, secret_threshold: 1 });
    // sys/init uses keys_base64, matching Factory's existing bootstrap API.
    const key = initialized.body["keys_base64"]?.[0],
      token = initialized.body["root_token"];
    if (initialized.code !== 200 || typeof key !== "string" || typeof token !== "string")
      return fail();
    const unsealed = await request("sys/unseal", { key });
    if (unsealed.code !== 200 || unsealed.body["sealed"] !== false) fail();
    await active();
    await fs.writeFile("/control/temporary-root-token", token, { mode: 0o600, flag: "wx" });
    await fs.chown("/control/temporary-root-token", 100, 1000);
    return;
  }
  // The force restore must reseal, invalidating the temporary initialized identity.
  if (health.body["initialized"] !== true || health.body["sealed"] !== true) fail();
  const original = JSON.parse(await fs.readFile("/state/openbao/bootstrap.json", "utf8"));
  if (!Array.isArray(original.keys_base64) || original.keys_base64.length !== 1) fail();
  const unsealed = await request("sys/unseal", { key: original.keys_base64[0] });
  if (unsealed.code !== 200 || unsealed.body["sealed"] !== false) fail();
  await active();
  await fs.unlink("/control/temporary-root-token");
  const login = JSON.parse(await fs.readFile("/state/openbao/factory-login.json", "utf8"));
  if (typeof login.role_id !== "string" || typeof login.secret_id !== "string") fail();
  const issued = await request("auth/approle/login", {
    role_id: login.role_id,
    secret_id: login.secret_id,
  });
  const token = issued.body["auth"]?.client_token;
  if (issued.code !== 200 || typeof token !== "string") fail();
  function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  const w: Witnesses = JSON.parse(await fs.readFile("/control/witnesses.json", "utf8"));
  for (const expected of w.openbao) {
    const response = await request(expected.path, undefined, token);
    const value = response.body["data"]?.data;
    if (
      response.code !== 200 ||
      !value ||
      createHash("sha256").update(canonical(value)).digest("hex") !== expected.sha256
    )
      fail();
  }
  // This scoped AppRole token has no revoke-self policy in the pinned Factory role.
  // It exists only inside this soon-deleted isolated raft volume, never in evidence or argv.
}

async function main(args: string[]) {
  const mode =
    args[0] === "--run"
      ? "run"
      : args[0] === "--cleanup"
        ? "cleanup"
        : args[0] === "--inspect"
          ? "inspect"
          : "plan";
  requireThat(
    args.length === 5 &&
      ["--run", "--cleanup", "--plan", "--inspect"].includes(args[0] ?? "") &&
      args[1] === "--fixture" &&
      args[3] === "--owner",
    "Usage: restore-rehearsal.ts --plan|--inspect|--run|--cleanup --fixture /private/fixture.json --owner <32 hex>",
  );
  if (mode === "plan" || mode === "inspect") {
    const f = await loadFixture(
      args[2] ?? "",
      args[4] ?? "",
      mode === "inspect" ? "inspect" : "run",
    );
    console.log(
      JSON.stringify(
        {
          kind:
            mode === "inspect"
              ? "isolated-data-service-restore-inspection"
              : "isolated-data-service-restore-plan",
          owner: f.owner,
          source: f.source,
          set: f.set,
          images,
          resources: resourcePlan(f).map(({ kind, name }) => ({ kind, name })),
          limits: f.limits,
          witnessDigest: f.witnessDigest,
          nativeActivation: "not-run-not-qualified",
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const controller = new AbortController();
  let interrupted = 0;
  const interrupt = () => {
    interrupted ||= 130;
    controller.abort();
  };
  const terminate = () => {
    interrupted ||= 143;
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (mode === "cleanup") {
      const f = await loadFixture(args[2] ?? "", args[4] ?? "", "cleanup");
      await ownedPath(f.evidenceDirectory, true);
      const raw = (await privateJSON(join(f.evidenceDirectory, "ownership.json"))) as Journal;
      requireThat(
        raw.schema === 1 &&
          raw.owner === f.owner &&
          raw.set === f.set &&
          same(raw.source, f.source) &&
          raw.daemonID === f.docker.daemonID &&
          /^[a-f0-9-]{36}$/.test(raw.run) &&
          Array.isArray(raw.resources),
        "Cleanup journal does not match explicit fixture",
      );
      const allowed = resourcePlan(f);
      for (const resource of raw.resources)
        requireThat(
          allowed.some(
            (entry) =>
              entry.kind === resource.kind &&
              entry.name === resource.name &&
              entry.key === resource.key,
          ),
          "Journal contains a resource outside this exact owned plan",
        );
      const execute = boundedExecute(f, safeExecute);
      const observed = await execute(docker(f, "info", "--format", "{{.ID}}"));
      requireThat(
        observed.code === 0 && observed.stdout.trim() === raw.daemonID,
        "Cleanup daemon identity differs",
      );
      // Interruptions keep their unsuccessful exit status, but do not abandon owned cleanup.
      const confirmed = await cleanupOwned(f, raw, execute);
      await persist(f.evidenceDirectory, "cleanup.json", { owner: f.owner, confirmed });
      return interrupted || (confirmed ? 0 : 1);
    }
    const f = await loadFixture(args[2] ?? "", args[4] ?? "");
    const result = await rehearse(f, safeExecute, controller.signal);
    console.log(
      `Isolated restore: ${result.status}; cleanup ${result.cleanup}; native activation not qualified`,
    );
    return interrupted || (result.status === "data-services-passed" ? 0 : 1);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error(
      "Restore rehearsal refused or incomplete; private input/command diagnostics suppressed",
    );
    process.exitCode = 1;
  }
}
