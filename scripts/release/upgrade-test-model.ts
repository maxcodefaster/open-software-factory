// Pure helpers for upgrade-test.ts. Nothing here touches the cluster, the network or the file system.
import { createHash } from "node:crypto";
import {
  podMemoryRequestMiB,
  quantityMiB,
  scratchRequestsMiB,
} from "../kubernetes/restore-rehearsal-model";

// ---- Ownership

export const ownerLabel = "factory.dev/upgrade-test-owner";
export const managedByValue = "factory-upgrade-test";
const namespacePattern = /^factory-upgrade-([0-9a-f]{8})$/;

export function upgradeNamespace(id: string) {
  if (!/^[0-9a-f]{8}$/.test(id))
    throw new Error("An upgrade test id is eight lowercase hex digits");
  return `factory-upgrade-${id}`;
}

export function upgradeIDFromNamespace(namespace: string) {
  return namespacePattern.exec(namespace)?.[1] ?? null;
}

// Namespaces that belong to retained installations or to Factory's own workers and editors. The
// namespace pattern already excludes them. This list is a second, independent refusal.
export function protectedNamespace(namespace: string) {
  return (
    namespace === "factory-acme-sized-20261103" ||
    /^factory-(box|editor|workspace|runtime|preflight|storage-check)-/.test(namespace) ||
    !namespacePattern.test(namespace)
  );
}

type Labels = Record<string, string> | null | undefined;

/** The namespace may be deleted only when its name and both labels say this run created it. */
export function requireOwnedNamespace(id: string, namespace: string, labels: Labels) {
  if (protectedNamespace(namespace) || namespace !== upgradeNamespace(id))
    throw new Error(`${namespace} is not the namespace of upgrade test ${id}; nothing was deleted`);
  if (labels?.[ownerLabel] !== id || labels["app.kubernetes.io/managed-by"] !== managedByValue)
    throw new Error(`${namespace} does not carry the owner label ${id}; nothing was deleted`);
}

export type Claim = { name: string; namespace?: string; labels?: Labels };

/**
 * Splits a namespace's claims by this run's label. A claim labelled for another run blocks the
 * deletion. An unlabelled claim was created by the chart or Factory inside this run's own
 * namespace, so the caller labels it first and then deletes it by label.
 */
export function claimOwnership(id: string, namespace: string, claims: readonly Claim[]) {
  const owned: string[] = [];
  const unlabelled: string[] = [];
  const foreign: string[] = [];
  for (const claim of claims) {
    if (claim.namespace !== undefined && claim.namespace !== namespace) {
      foreign.push(`${claim.namespace}/${claim.name}`);
      continue;
    }
    const owner = claim.labels?.[ownerLabel];
    if (owner === id) owned.push(claim.name);
    else if (owner === undefined) unlabelled.push(claim.name);
    else foreign.push(claim.name);
  }
  return { owned: owned.sort(), unlabelled: unlabelled.sort(), foreign: foreign.sort() };
}

type Volume = { name: string; claimNamespace?: string; claimName?: string };

/** Volumes to remove after their claims are gone: exactly the ones bound to this run's claims. */
export function ownedVolumes(namespace: string, claimNames: readonly string[], volumes: Volume[]) {
  const names = new Set(claimNames);
  return volumes
    .filter(
      (volume) =>
        volume.claimNamespace === namespace && volume.claimName && names.has(volume.claimName),
    )
    .map((volume) => volume.name)
    .sort();
}

const runtimeNamespace = /^factory-(box|editor|workspace|runtime)-/;

/** Worker, editor or Sandbox namespaces that appeared during the run. None may. */
export function newRuntimeNamespaces(before: readonly string[], after: readonly string[]) {
  const known = new Set(before);
  return after.filter((name) => runtimeNamespace.test(name) && !known.has(name)).sort();
}

// ---- Options

export type ChartSource = { kind: "path"; path: string } | { kind: "git"; commit: string };

export function parseChartSource(value: string): ChartSource {
  if (value.startsWith("git:")) {
    const commit = value.slice(4);
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`${value} is not git:<commit>`);
    return { kind: "git", commit };
  }
  if (!value) throw new Error("A chart path is empty");
  return { kind: "path", path: value };
}

export type Options = {
  fromChart: ChartSource;
  fromImage: string;
  toChart: ChartSource;
  toImage: string;
  node: string;
  context: string;
  release: string;
  values: string[];
  allow: string[];
  ignoreTables: string[];
  ignoreColumns: string[];
  ignoreConsole: string[];
  keep: boolean;
  cleanup: string;
};

export const help = `Upgrade a previous Factory build to a new one and prove that no data is lost:

  mise exec -- bun run release:upgrade-test --from-chart PATH|git:COMMIT --from-image REF \\
    --to-chart PATH --to-image REF --node NODE --values FILE [--values FILE]
    [--context NAME] [--allow GLOB] [--ignore-table schema.table] [--ignore-column NAME]
    [--ignore-console REGEX] [--keep]
  mise exec -- bun run release:upgrade-test --cleanup factory-upgrade-<8 hex> [--context NAME]

--from-chart git:COMMIT extracts deploy/helm/factory at that commit with git archive.
--values supplies the private values both builds need (the Factorybox worker image, executable
hash and architecture, a storage class). The script overrides every origin, Secret and size it
must, starts no worker and sets executionReserveTarget to 0. "helm get values factory -n factory
-o yaml" from a working installation is a good source.
--allow GLOB accepts a difference the first diff would otherwise refuse. Findings are named
row:<schema.table>, column:<schema.table>.<column>, table:<name>, migration, forgejo:<owner/repo>,
openbao:<path> and object:<key>. The second upgrade accepts nothing.
--keep leaves the namespace for inspection. --cleanup removes an interrupted run after
checking its owner label. Writes a receipt to .factory/test-results/upgrade-test/<namespace>.json.`;

function take(args: string[], index: number, flag: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

export function parseOptions(args: string[]): Options {
  const options = {
    fromChart: "",
    fromImage: "",
    toChart: "",
    toImage: "",
    node: "",
    context: "",
    release: "factory",
    values: [] as string[],
    allow: [] as string[],
    ignoreTables: [] as string[],
    ignoreColumns: [] as string[],
    ignoreConsole: [] as string[],
    keep: false,
    cleanup: "",
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index] ?? "";
    if (flag === "--keep") {
      options.keep = true;
      continue;
    }
    const value = take(args, index, flag);
    index++;
    if (flag === "--from-chart") options.fromChart = value;
    else if (flag === "--from-image") options.fromImage = value;
    else if (flag === "--to-chart") options.toChart = value;
    else if (flag === "--to-image") options.toImage = value;
    else if (flag === "--node") options.node = value;
    else if (flag === "--context") options.context = value;
    else if (flag === "--values") options.values.push(value);
    else if (flag === "--allow") options.allow.push(value);
    else if (flag === "--ignore-table") options.ignoreTables.push(value);
    else if (flag === "--ignore-column") options.ignoreColumns.push(value);
    else if (flag === "--ignore-console") options.ignoreConsole.push(value);
    else if (flag === "--cleanup") options.cleanup = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.cleanup) {
    if (!upgradeIDFromNamespace(options.cleanup))
      throw new Error(`${options.cleanup} is not an upgrade test namespace`);
    return {
      ...options,
      fromChart: { kind: "path", path: "" },
      toChart: { kind: "path", path: "" },
    };
  }
  for (const [flag, value] of [
    ["--from-chart", options.fromChart],
    ["--from-image", options.fromImage],
    ["--to-chart", options.toChart],
    ["--to-image", options.toImage],
    ["--node", options.node],
  ] as const)
    if (!value) throw new Error(`${flag} is required`);
  for (const image of [options.fromImage, options.toImage])
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image))
      throw new Error(`${image} is not an image reference`);
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(options.node))
    throw new Error(`${options.node} is not a node name`);
  for (const pattern of options.ignoreConsole) new RegExp(pattern);
  return {
    ...options,
    fromChart: parseChartSource(options.fromChart),
    toChart: parseChartSource(options.toChart),
  };
}

// ---- Chart values

export type UpgradeValuesInput = {
  node: string;
  ports: { factory: number; forgejo: number; zero: number };
};

const service = (memoryMiB: number, cpu: string) => ({
  resources: { requests: { cpu, memory: `${memoryMiB}Mi` } },
});

/**
 * Applied after the operator's own values, so these win. Origins are loopback ports this run
 * forwards. Secrets are generated by the chart. Backups and the execution reserve are off because
 * this test starts no worker and needs no backup claim. Requests stay small so the release fits
 * beside the retained installation.
 */
export function upgradeValues(input: UpgradeValuesInput) {
  const origin = (port: number) => `http://127.0.0.1:${port}`;
  return {
    development: true,
    publicURL: origin(input.ports.factory),
    forgejoPublicURL: origin(input.ports.forgejo),
    developmentZeroURL: origin(input.ports.zero),
    adminEmail: "admin@factory.local",
    imagePullPolicy: "IfNotPresent",
    factorybox: { nodeName: input.node },
    executionReserveTarget: 0,
    backup: { enabled: false },
    ingress: { enabled: false },
    registryCASecret: "",
    existingSecrets: { credentials: "", objects: "", openbaoTLS: "", revision: "" },
    openbao: { ...service(scratchRequestsMiB.openbao, "25m"), recovery: { enabled: false } },
    postgres: service(scratchRequestsMiB.postgres, "25m"),
    forgejo: service(scratchRequestsMiB.forgejo, "25m"),
    objectStorage: service(scratchRequestsMiB.objects, "25m"),
    zero: service(scratchRequestsMiB.zero, "50m"),
    resources: { requests: { cpu: "100m", memory: `${scratchRequestsMiB.factory}Mi` } },
  };
}

// ---- Memory

// The pre-upgrade maintenance Job requests 64 MiB by default and runs beside the old Factory Pod.
const maintenanceJobMiB = 64;
const safetyMarginMiB = 128;

export function upgradeMemoryNeedMiB() {
  return (
    Object.values(scratchRequestsMiB).reduce((sum, value) => sum + value, 0) +
    maintenanceJobMiB +
    safetyMarginMiB
  );
}

type PodLike = Parameters<typeof podMemoryRequestMiB>[0] & { metadata?: { namespace?: string } };

export type MemoryPlan = {
  fits: boolean;
  allocatableMiB: number;
  requestedMiB: number;
  freeMiB: number;
  neededMiB: number;
  largest: Array<{ namespace: string; requestedMiB: number }>;
  advice: string;
};

export function memoryPlan(allocatable: string, pods: readonly PodLike[]): MemoryPlan {
  const allocatableMiB = quantityMiB(allocatable);
  const byNamespace = new Map<string, number>();
  for (const pod of pods) {
    const namespace = pod.metadata?.namespace ?? "unknown";
    byNamespace.set(namespace, (byNamespace.get(namespace) ?? 0) + podMemoryRequestMiB(pod));
  }
  const requestedMiB = [...byNamespace.values()].reduce((sum, value) => sum + value, 0);
  const freeMiB = allocatableMiB - requestedMiB;
  const neededMiB = upgradeMemoryNeedMiB();
  const largest = [...byNamespace.entries()]
    .map(([namespace, requested]) => ({ namespace, requestedMiB: Math.round(requested) }))
    .sort((a, b) => b.requestedMiB - a.requestedMiB)
    .slice(0, 5);
  const fits = freeMiB >= neededMiB;
  const advice = fits
    ? `${Math.round(freeMiB)} MiB of requests are free; this run needs ${neededMiB} MiB.`
    : `Only ${Math.round(freeMiB)} MiB of memory requests are free and this run needs ${neededMiB} MiB. ` +
      `Stop a disposable installation or an idle release first. Namespaces holding the most requests: ${largest
        .map((entry) => `${entry.namespace} (${entry.requestedMiB} MiB)`)
        .join(", ")}. This script never stops anything for you.`;
  return {
    fits,
    allocatableMiB: Math.round(allocatableMiB),
    requestedMiB: Math.round(requestedMiB),
    freeMiB: Math.round(freeMiB),
    neededMiB,
    largest,
    advice,
  };
}

// ---- SQL

export function sqlLiteral(value: string) {
  if (value.includes("\0")) throw new Error("A SQL literal cannot hold a NUL character");
  return `'${value.replaceAll("'", "''")}'`;
}

function identifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier ${value}`);
  return `"${value}"`;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidLiteral(value: string) {
  if (!uuid.test(value)) throw new Error(`${value} is not a UUID`);
  return `'${value}'`;
}

/** Tables whose rows change by themselves or are not application data. */
export const defaultIgnoredTables = [
  "factory.schema_migration",
  "auth.session",
  "auth.verification",
  "factory.read_version",
  "factory.installation_maintenance",
];

// Timestamps and leases that a running Factory refreshes without any user action.
const volatileColumn =
  /(^|_)(updated_?at|last_seen_at|last_active_at|observed_at|heartbeat[a-z_]*)$|^lease_|^hook_lease/i;

export function isVolatileColumn(column: string, extra: readonly string[] = []) {
  return volatileColumn.test(column) || extra.includes(column);
}

export type TableMeta = { name: string; columns: string[]; primaryKey: string[] };

// One JSON document: every ordinary table outside the Zero cache and system schemas.
export const catalogSQL = `SELECT coalesce(jsonb_agg(entry ORDER BY entry->>'name'), '[]'::jsonb)::text FROM (
  SELECT jsonb_build_object(
    'name', n.nspname || '.' || c.relname,
    'columns', (SELECT coalesce(jsonb_agg(a.attname ORDER BY a.attnum), '[]'::jsonb) FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
    'primaryKey', coalesce((SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM pg_index i
      CROSS JOIN LATERAL unnest(string_to_array(i.indkey::text, ' ')::int2[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indrelid = c.oid AND i.indisprimary), '[]'::jsonb)) AS entry
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname !~ '^(pg_.*|information_schema|_.*|zero.*|cdc.*)$'
) tables`;

export function parseCatalog(output: string): TableMeta[] {
  const parsed = JSON.parse(output.trim()) as unknown;
  if (!Array.isArray(parsed)) throw new Error("The table catalog is not a list");
  return parsed.map((entry: { name: string; columns: string[]; primaryKey: string[] }) => ({
    name: String(entry.name),
    columns: entry.columns.map(String),
    primaryKey: entry.primaryKey.map(String),
  }));
}

export function ignoredTable(name: string, extra: readonly string[] = []) {
  return defaultIgnoredTables.includes(name) || extra.includes(name);
}

/**
 * One statement per table. Each row prints as a JSON array [table, key, cells], where cells maps
 * a column to a short hash of its value. Values never leave the database, so passwords and tokens
 * are not copied. Columns come from the live table so a new column cannot hide behind an old list.
 */
export function rowFingerprintSQL(table: TableMeta, ignoreColumns: readonly string[] = []) {
  const [schema, relation] = table.name.split(".");
  if (!schema || !relation) throw new Error(`${table.name} is not schema.table`);
  const excluded = table.columns.filter((column) => isVolatileColumn(column, ignoreColumns));
  const exclusion = `ARRAY[${excluded.map(sqlLiteral).join(", ")}]::text[]`;
  const filtered = `(to_jsonb(t) - ${exclusion})`;
  const key = table.primaryKey.length
    ? `jsonb_build_array(${table.primaryKey.map((column) => `t.${identifier(column)}`).join(", ")})::text`
    : `md5(${filtered}::text)`;
  const cells = `(SELECT coalesce(jsonb_object_agg(e.key, left(md5(e.value::text), 12)), '{}'::jsonb) FROM jsonb_each(${filtered}) e)`;
  return `SELECT jsonb_build_array(${sqlLiteral(table.name)}, ${key}, ${cells})::text FROM ${identifier(schema)}.${identifier(relation)} t;`;
}

/** The whole database in one repeatable-read snapshot. */
export function snapshotSQL(tables: readonly TableMeta[], ignoreColumns: readonly string[] = []) {
  return [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    ...tables.map((table) => rowFingerprintSQL(table, ignoreColumns)),
    "COMMIT;",
  ].join("\n");
}

export type TableData = { columns: string[]; rows: Record<string, Record<string, string>> };

export function parseRowLines(
  output: string,
  tables: readonly TableMeta[],
  ignoreColumns: readonly string[] = [],
) {
  const result: Record<string, TableData> = {};
  for (const table of tables) result[table.name] = { columns: [], rows: {} };
  for (const line of output.split("\n")) {
    if (!line.startsWith("[")) continue;
    const [name, key, cells] = JSON.parse(line) as [string, string, Record<string, string>];
    const data = result[name];
    if (!data) throw new Error(`Unexpected table ${name} in the snapshot`);
    data.rows[key] = cells;
  }
  for (const table of tables) {
    const data = result[table.name];
    if (data)
      data.columns = table.columns.filter((column) => !isVolatileColumn(column, ignoreColumns));
  }
  return result;
}

// ---- Fingerprint

export type Fingerprint = {
  migrations: number[];
  tables: Record<string, TableData>;
  // "owner/repo|head:<branch>" -> commit SHA, "owner/repo|file:<path>" -> blob SHA
  forgejo: Record<string, string>;
  openbao: { sealed: boolean; paths: Record<string, string> };
  // key -> "<size>:<etag>"
  objects: Record<string, string>;
};

function sortedJSON(cells: Record<string, string>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(cells).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}

/** A digest of every row, independent of the order the rows or columns arrive in. */
export function tableDigest(data: TableData) {
  const hash = createHash("sha256");
  for (const key of Object.keys(data.rows).sort()) {
    hash.update(key);
    hash.update("\n");
    hash.update(sortedJSON(data.rows[key] ?? {}));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 32);
}

export function summarize(fingerprint: Fingerprint) {
  const tables = Object.fromEntries(
    Object.entries(fingerprint.tables)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, data]) => [
        name,
        { rows: Object.keys(data.rows).length, digest: tableDigest(data) },
      ]),
  );
  const repositories = new Set(Object.keys(fingerprint.forgejo).map((key) => key.split("|")[0]));
  return {
    migrations: fingerprint.migrations,
    tables,
    totalRows: Object.values(tables).reduce((sum, table) => sum + table.rows, 0),
    forgejo: { repositories: repositories.size, entries: Object.keys(fingerprint.forgejo).length },
    openbao: {
      sealed: fingerprint.openbao.sealed,
      paths: Object.keys(fingerprint.openbao.paths).length,
    },
    objects: Object.keys(fingerprint.objects).length,
  };
}

/** Secret paths that could not be read and decrypted. */
export function unreadableSecrets(fingerprint: Fingerprint) {
  return Object.entries(fingerprint.openbao.paths)
    .filter(([, digest]) => digest === "unreadable")
    .map(([path]) => path)
    .sort();
}

// ---- Diff

export type Finding = {
  /** Matches --allow globs, for example row:factory.ticket */
  id: string;
  kind: "removed" | "changed" | "added";
  key: string;
  before?: string;
  after?: string;
};

export type Rules = {
  allow: readonly string[];
  allowNewTables: boolean;
  allowNewColumns: boolean;
  allowNewMigrations: boolean;
};

/** Rules for the upgrade itself: new migrations, tables and columns are expected. */
export const upgradeRules = (allow: readonly string[] = []): Rules => ({
  allow,
  allowNewTables: true,
  allowNewColumns: true,
  allowNewMigrations: true,
});

/** Rules for a second upgrade to the same build: nothing at all may differ. */
export const noopRules: Rules = {
  allow: [],
  allowNewTables: false,
  allowNewColumns: false,
  allowNewMigrations: false,
};

export function globMatches(pattern: string, value: string) {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

export type Diff = { ok: boolean; violations: Finding[]; allowed: Finding[] };

function compareMaps(
  area: string,
  scope: (key: string) => string,
  before: Record<string, string>,
  after: Record<string, string>,
  out: Finding[],
) {
  for (const key of Object.keys(before).sort()) {
    const next = after[key];
    if (next === undefined)
      out.push({ id: `${area}:${scope(key)}`, kind: "removed", key, before: before[key] ?? "" });
    else if (next !== before[key])
      out.push({
        id: `${area}:${scope(key)}`,
        kind: "changed",
        key,
        before: before[key] ?? "",
        after: next,
      });
  }
  for (const key of Object.keys(after).sort())
    if (before[key] === undefined)
      out.push({ id: `${area}:${scope(key)}`, kind: "added", key, after: after[key] ?? "" });
}

export function diffFingerprints(before: Fingerprint, after: Fingerprint, rules: Rules): Diff {
  const findings: Finding[] = [];
  const automatic = new Set<Finding>();

  // Migrations are applied in order, so the old list must be a prefix of the new one.
  for (const version of before.migrations)
    if (!after.migrations.includes(version))
      findings.push({ id: "migration", kind: "removed", key: `migration ${version}` });
  const contiguous = after.migrations.every((version, index) => version === index + 1);
  if (!contiguous)
    findings.push({
      id: "migration",
      kind: "changed",
      key: "applied migrations",
      before: before.migrations.join(","),
      after: after.migrations.join(","),
    });
  for (const version of after.migrations)
    if (!before.migrations.includes(version)) {
      const finding: Finding = { id: "migration", kind: "added", key: `migration ${version}` };
      findings.push(finding);
      if (rules.allowNewMigrations) automatic.add(finding);
    }

  for (const name of Object.keys(before.tables).sort()) {
    const was = before.tables[name];
    const now = after.tables[name];
    if (!was) continue;
    if (!now) {
      findings.push({ id: `table:${name}`, kind: "removed", key: name });
      continue;
    }
    for (const column of was.columns)
      if (!now.columns.includes(column))
        findings.push({
          id: `column:${name}.${column}`,
          kind: "removed",
          key: `${name}.${column}`,
        });
    for (const column of now.columns)
      if (!was.columns.includes(column)) {
        const finding: Finding = {
          id: `column:${name}.${column}`,
          kind: "added",
          key: `${name}.${column}`,
        };
        findings.push(finding);
        if (rules.allowNewColumns) automatic.add(finding);
      }
    for (const key of Object.keys(was.rows).sort()) {
      const cells = was.rows[key] ?? {};
      const next = now.rows[key];
      if (!next) {
        findings.push({ id: `row:${name}`, kind: "removed", key: `${name}#${key}` });
        continue;
      }
      for (const column of Object.keys(cells).sort()) {
        const value = next[column];
        // A removed column is reported once for the table, not once per row.
        if (value !== undefined && value !== cells[column])
          findings.push({
            id: `row:${name}`,
            kind: "changed",
            key: `${name}#${key}.${column}`,
            before: cells[column] ?? "",
            after: value,
          });
      }
    }
    for (const key of Object.keys(now.rows).sort())
      if (!was.rows[key])
        findings.push({ id: `row:${name}`, kind: "added", key: `${name}#${key}` });
  }
  for (const name of Object.keys(after.tables).sort()) {
    const now = after.tables[name];
    if (before.tables[name] || !now) continue;
    const finding: Finding = { id: `table:${name}`, kind: "added", key: name };
    findings.push(finding);
    if (rules.allowNewTables) automatic.add(finding);
    // The rows of a new table belong to it. They are not new rows of an old table.
    for (const key of Object.keys(now.rows).sort()) {
      const row: Finding = { id: `row:${name}`, kind: "added", key: `${name}#${key}` };
      findings.push(row);
      if (rules.allowNewTables) automatic.add(row);
    }
  }

  const repository = (key: string) => key.split("|")[0] ?? key;
  compareMaps("forgejo", repository, before.forgejo, after.forgejo, findings);
  if (before.openbao.sealed !== after.openbao.sealed)
    findings.push({
      id: "openbao:sealed",
      kind: "changed",
      key: "sealed",
      before: String(before.openbao.sealed),
      after: String(after.openbao.sealed),
    });
  compareMaps("openbao", (key) => key, before.openbao.paths, after.openbao.paths, findings);
  compareMaps("object", (key) => key, before.objects, after.objects, findings);

  const violations: Finding[] = [];
  const allowed: Finding[] = [];
  for (const finding of findings)
    (automatic.has(finding) || rules.allow.some((glob) => globMatches(glob, finding.id))
      ? allowed
      : violations
    ).push(finding);
  return { ok: violations.length === 0, violations, allowed };
}

export function formatFinding(finding: Finding) {
  const change =
    finding.kind === "changed" ? ` (${finding.before ?? ""} -> ${finding.after ?? ""})` : "";
  return `${finding.kind.padEnd(7)} ${finding.id.padEnd(40)} ${finding.key}${change}`;
}

export function formatDiff(label: string, diff: Diff, limit = 60) {
  const lines = diff.violations.slice(0, limit).map(formatFinding);
  const more = diff.violations.length - lines.length;
  return [
    `${label}: ${diff.violations.length} refused, ${diff.allowed.length} allowed`,
    ...lines.map((line) => `  ${line}`),
    ...(more > 0 ? [`  ... and ${more} more in the receipt`] : []),
  ].join("\n");
}

// ---- Seed data

export type SeedInput = {
  adminID: string;
  projectID: string;
  slug: string;
  name: string;
  repositoryURL: string;
  commitSha: string;
  tickets: Array<{ id: string; title: string; description: string; state: string }>;
  wiki: { pageID: string; slug: string; title: string; first: string; second: string };
  revisionIDs: [string, string];
  model: {
    connectionID: string;
    commandID: string;
    secretKey: string;
    fingerprint: string;
  };
};

const ticketStates = new Set(["inbox", "backlog", "ready", "in-progress", "cancelled", "done"]);

/** Plain rows for the parts of a Project that need a runtime or a model to create. */
export function seedSQL(input: SeedInput) {
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error("A commit SHA is 40 hex digits");
  if (!/^[0-9a-f]{64}$/.test(input.model.fingerprint))
    throw new Error("A model fingerprint is 64 hex digits");
  const id = uuidLiteral;
  const text = sqlLiteral;
  const [firstRevision, secondRevision] = input.revisionIDs;
  return [
    "BEGIN;",
    `INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${id(input.projectID)},${text(input.slug)},${text(input.name)},${text(input.repositoryURL)},'main','.devcontainer/devcontainer.json',${id(input.adminID)});`,
    `INSERT INTO factory.project_membership(project_id,user_id,role,updated_by,manage_project)
      VALUES(${id(input.projectID)},${id(input.adminID)},'developer',${id(input.adminID)},true) ON CONFLICT DO NOTHING;`,
    ...input.tickets.map((ticket) => {
      if (!ticketStates.has(ticket.state)) throw new Error(`Unknown Ticket state ${ticket.state}`);
      return `INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
        VALUES(${id(ticket.id)},${id(input.projectID)},${text(ticket.title)},${text(ticket.description)},${text(ticket.state)}::factory.ticket_state,${id(input.adminID)});`;
    }),
    `INSERT INTO factory.knowledge_page(id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by,sort_order)
      VALUES(${id(input.wiki.pageID)},${id(input.projectID)},${text(input.wiki.slug)},${text(input.wiki.title)},${text(input.wiki.first)},${text(input.wiki.first)},${text(input.commitSha)},${id(input.adminID)},0);`,
    `INSERT INTO factory.knowledge_page_alias(project_id,slug,page_id) VALUES(${id(input.projectID)},${text(input.wiki.slug)},${id(input.wiki.pageID)});`,
    `INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,citations,created_by)
      VALUES(${id(firstRevision)},${id(input.wiki.pageID)},1,'generated',${text(input.wiki.title)},${text(input.wiki.first)},${text(input.wiki.first)},${text(input.commitSha)},'[]'::jsonb,${id(input.adminID)});`,
    `UPDATE factory.knowledge_page SET current_revision_id=${id(firstRevision)} WHERE id=${id(input.wiki.pageID)};`,
    `INSERT INTO factory.knowledge_revision(id,page_id,ordinal,kind,title,body,generated_body,source_commit_sha,citations,created_by)
      VALUES(${id(secondRevision)},${id(input.wiki.pageID)},2,'human',${text(input.wiki.title)},${text(input.wiki.second)},${text(input.wiki.first)},${text(input.commitSha)},'[]'::jsonb,${id(input.adminID)});`,
    `UPDATE factory.knowledge_page SET current_body=${text(input.wiki.second)},current_revision_id=${id(secondRevision)},version=version+1,updated_at=now() WHERE id=${id(input.wiki.pageID)};`,
    `INSERT INTO factory.model_connection_write(command_id,connection_id,base_version,provider,endpoint,fingerprint,secret_key,state,created_by,committed_at)
      VALUES(${id(input.model.commandID)},${id(input.model.connectionID)},0,'openai','https://api.openai.com/v1',${text(input.model.fingerprint)},${text(input.model.secretKey)},'committed',${id(input.adminID)},now());`,
    `INSERT INTO factory.model_connection_version(connection_id,version,provider,endpoint,secret_key,created_by)
      VALUES(${id(input.model.connectionID)},1,'openai','https://api.openai.com/v1',${text(input.model.secretKey)},${id(input.adminID)});`,
    "COMMIT;",
  ].join("\n");
}

/** Assigns a Ticket to a person, which is what puts it in their Inbox. */
export function assignmentSQL(input: {
  ticketID: string;
  userID: string;
  actorID: string;
  eventID: string;
}) {
  return [
    "BEGIN;",
    `INSERT INTO factory.ticket_responsibility(ticket_id,user_id) VALUES(${uuidLiteral(input.ticketID)},${uuidLiteral(input.userID)});`,
    `INSERT INTO factory.ticket_responsibility_event(id,ticket_id,user_id,actor_id,expected_version)
      VALUES(${uuidLiteral(input.eventID)},${uuidLiteral(input.ticketID)},${uuidLiteral(input.userID)},${uuidLiteral(input.actorID)},0);`,
    `INSERT INTO factory.ticket_follow(ticket_id,user_id,following) VALUES(${uuidLiteral(input.ticketID)},${uuidLiteral(input.actorID)},true) ON CONFLICT DO NOTHING;`,
    "COMMIT;",
  ].join("\n");
}

/** The secret paths the database names, as restore-rehearsal reads them. */
export const secretKeysSQL =
  "SELECT k FROM (SELECT secret_key AS k FROM factory.model_connection_version UNION SELECT secret_key FROM factory.mcp_connection UNION SELECT secret_key FROM factory.project_environment UNION SELECT secret_key FROM factory.release_access) s WHERE k IS NOT NULL ORDER BY 1";

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function secretReadScript(login: { roleID: string; secretID: string }, keys: string[]) {
  const read = keys.map(
    (key) =>
      `if out=$(bao kv get -mount=factory -field=data ${shellQuote(key)} 2>/dev/null); then echo ${shellQuote(`${key}|`)}"$(printf '%s' "$out" | sha256sum | cut -c1-16)"; else echo ${shellQuote(`${key}|unreadable`)}; fi`,
  );
  return [
    "set -eu",
    "export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt",
    `BAO_TOKEN=$(bao write -field=token auth/approle/login role_id=${shellQuote(login.roleID)} secret_id=${shellQuote(login.secretID)})`,
    "export BAO_TOKEN",
    ...read,
    "",
  ].join("\n");
}

/** Writes one KV secret as Factory's own AppRole. The JSON arrives in a here-document. */
export function secretWriteScript(
  login: { roleID: string; secretID: string },
  key: string,
  json: string,
) {
  if (json.includes("\nJSON\n"))
    throw new Error("The secret payload cannot contain its terminator");
  return [
    "set -eu",
    "export BAO_ADDR=https://127.0.0.1:8200 BAO_CACERT=/bao/tls/ca.crt",
    `BAO_TOKEN=$(bao write -field=token auth/approle/login role_id=${shellQuote(login.roleID)} secret_id=${shellQuote(login.secretID)})`,
    "export BAO_TOKEN",
    `bao kv put -mount=factory ${shellQuote(key)} - >/dev/null <<'JSON'`,
    json,
    "JSON",
    "",
  ].join("\n");
}

export function parsePaths(output: string) {
  const result: Record<string, string> = {};
  for (const line of output.split("\n").filter(Boolean)) {
    const separator = line.lastIndexOf("|");
    if (separator < 1) throw new Error(`Unexpected row ${JSON.stringify(line)}`);
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

// ---- Console

export function unexpectedConsole(messages: readonly string[], ignore: readonly string[]) {
  const patterns = ignore.map((pattern) => new RegExp(pattern));
  return messages.filter((message) => !patterns.some((pattern) => pattern.test(message)));
}

// ---- Receipt

export const rollbackExpectation =
  "Not performed. A chart rollback does not roll the database back. After an upgrade applies a " +
  "migration, the previous image refuses the newer schema at startup (the migrator will not " +
  "downgrade), so a rollback is expected to leave Factory not ready while every row, repository, " +
  "secret and object stays untouched. Recovery is a restore from the last complete backup set " +
  "into a new installation, or upgrading forward to a fixed build.";
