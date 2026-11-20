// Pure helpers for clean-room.ts. Nothing here touches the cluster, the network or the file system.
import {
  kubernetesPodRequestedResources,
  kubernetesResourceQuantity,
} from "../../packages/runtime-kubernetes/src/worker-resource-admission";
import type { NativeCleanRoomValues } from "./clean-room-native";

export const ownerLabel = "factory.dev/clean-room-owner";
export const managedBy = "factory-clean-room";
export const releaseName = "factory";
const namespacePattern = /^factory-cleanroom-([0-9a-f]{8})$/;
const runtimeNamespace = /^factory-editor-[a-f0-9]{32}$/;

export function cleanRoomNamespace(id: string) {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("A clean-room id is eight lowercase hex digits");
  return `factory-cleanroom-${id}`;
}

export function cleanRoomIDFromNamespace(namespace: string) {
  return namespacePattern.exec(namespace)?.[1] ?? null;
}

export function namespaceManifest(id: string, startedAt: Date) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: cleanRoomNamespace(id),
      labels: {
        [ownerLabel]: id,
        "app.kubernetes.io/managed-by": managedBy,
        "ate.dev/api-access": "true",
      },
      annotations: { "factory.dev/clean-room-started-at": startedAt.toISOString() },
    },
  };
}

type NamespaceLike = {
  metadata?: {
    name?: string;
    uid?: string;
    labels?: Record<string, string> | null;
  };
};

/** Refuses a Namespace that does not carry this run's exact name and both owner labels. */
export function verifyOwnedNamespace(namespace: NamespaceLike, id: string, originalUID?: string) {
  const expected = cleanRoomNamespace(id);
  const labels = namespace.metadata?.labels ?? {};
  if (namespace.metadata?.name !== expected)
    throw new Error(`Namespace ${namespace.metadata?.name ?? "?"} is not ${expected}`);
  if (labels[ownerLabel] !== id || labels["app.kubernetes.io/managed-by"] !== managedBy)
    throw new Error(`${expected} does not carry the clean-room owner label ${id}; nothing deleted`);
  if (!namespace.metadata?.uid) throw new Error(`${expected} has no UID`);
  if (originalUID && namespace.metadata.uid !== originalUID)
    throw new Error(`${expected} differs from its original Namespace UID; nothing changed`);
  return namespace.metadata.uid;
}

export function chartName(release = releaseName) {
  return release.slice(0, 40).replace(/-+$/, "");
}

/** The cluster-scoped objects the chart (and its test hook) create, named after the Namespace. */
export function clusterObjectNames(id: string, release = releaseName) {
  const base = `${cleanRoomNamespace(id)}-${chartName(release)}`;
  return {
    clusterRoles: [base, `${base}-preflight`],
    clusterRoleBindings: [base, `${base}-preflight`],
  };
}

type Named = { metadata?: { name?: string; labels?: Record<string, string> | null } };

/** Only an object with an exact expected name that also carries the chart's instance label. */
export function ownedClusterObjects(
  items: readonly Named[],
  expected: readonly string[],
  release = releaseName,
) {
  return items
    .filter(
      (item) =>
        expected.includes(item.metadata?.name ?? "") &&
        item.metadata?.labels?.["app.kubernetes.io/instance"] === release &&
        item.metadata?.labels?.["app.kubernetes.io/name"] === "factory",
    )
    .map((item) => item.metadata?.name ?? "");
}

function claimPatterns(release: string) {
  const name = chartName(release).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^(data|config)-${name}-(postgres|forgejo|openbao|zero|objects)-0$`),
    new RegExp(`^store-${name}-backup-store-0$`),
    new RegExp(`^${name}-(state|objects|objects-data)$`),
  ];
}

/** PVCs the chart is known to create. Anything else in the Namespace is reported, not hidden. */
export function classifyClaims(names: readonly string[], release = releaseName) {
  const patterns = claimPatterns(release);
  const known = (name: string) => patterns.some((pattern) => pattern.test(name));
  return { chart: names.filter(known), unexpected: names.filter((name) => !known(name)) };
}

type VolumeLike = {
  metadata?: { name?: string };
  spec?: { claimRef?: { namespace?: string; uid?: string; name?: string } };
};

/** A PV is ours only when its claim was in our Namespace and the claim UID is one we recorded. */
export function ownedVolumes(
  volumes: readonly VolumeLike[],
  namespaces: readonly string[],
  claimUIDs: ReadonlySet<string>,
) {
  return volumes
    .filter((volume) => {
      const ref = volume.spec?.claimRef;
      return Boolean(
        ref?.namespace && namespaces.includes(ref.namespace) && ref.uid && claimUIDs.has(ref.uid),
      );
    })
    .map((volume) => volume.metadata?.name ?? "")
    .filter(Boolean);
}

/**
 * Factory creates a Namespace per independent editor. They carry no label that
 * names this run, so ownership is the UID the installation's own database recorded for them.
 */
export function ownedRuntimeNamespaces(
  namespaces: readonly NamespaceLike[],
  recordedUIDs: ReadonlySet<string>,
) {
  return namespaces
    .filter(
      (namespace) =>
        namespace.metadata?.labels?.["app.kubernetes.io/managed-by"] === "open-software-factory" &&
        runtimeNamespace.test(namespace.metadata?.name ?? "") &&
        Boolean(namespace.metadata?.uid) &&
        recordedUIDs.has(namespace.metadata?.uid ?? ""),
    )
    .map((namespace) => ({
      name: namespace.metadata?.name ?? "",
      uid: namespace.metadata?.uid ?? "",
    }));
}

export function requireCleanRoomNativeInventory(result: { code: number; stdout: string }) {
  if (result.code !== 0)
    throw new Error("Native cleanup inventory is unavailable; installation retained");
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes("native-resources-present"))
    throw new Error(
      "Native cleanup is not yet qualified by this clean-room harness; installation retained",
    );
  if (lines.some((line) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(line)))
    throw new Error("Native cleanup inventory is invalid; installation retained");
  return new Set(lines);
}

export function runtimeNamespacesNotAttributed(
  before: readonly string[],
  after: readonly NamespaceLike[],
  owned: readonly string[],
) {
  return after
    .map((namespace) => namespace.metadata?.name ?? "")
    .filter(
      (name) => runtimeNamespace.test(name) && !before.includes(name) && !owned.includes(name),
    );
}

export function disappeared(
  before: readonly string[],
  after: readonly string[],
  deleted: readonly string[],
) {
  const present = new Set(after);
  return before.filter((name) => !present.has(name) && !deleted.includes(name));
}

// ---- Options

export type Options = {
  chart: string;
  factoryImage: string;
  node: string;
  values: string;
  nativeFixture: string;
  context: string;
  keep: boolean;
  withSandbox: boolean;
  smallRequests: boolean;
  cleanup: string;
};

export const help = `Check an owned native-chart control plane. This is not native product acceptance:

  mise exec -- bun run release:clean-room --native-fixture FILE [--chart FILE.tgz|oci://REF[:VERSION]] [--factory-image REF]
    [--node NODE] [--values FILE] [--context NAME] [--small-requests] [--with-sandbox] [--keep]
  mise exec -- bun run release:clean-room --cleanup factory-cleanroom-<8 hex> [--context NAME]

--chart defaults to packaging this working tree with scripts/release/package-chart.ts, using
--factory-image (required then) and its exact embedded native artifact catalog.
--factory-image must be an immutable digest reference.
--native-fixture supplies fresh native runtime and provisioner inputs. Helper TLS defaults to an
external certificate/key/CA bundle; existing complete external fixtures need no tlsMode field.
Use explicit tlsMode: "managed" for the chart-managed proof path without certificate files.
That path does not enroll Chromium trust or pass browser acceptance until its CA is trusted.
Ordinary Helm installation still defaults to managed TLS. See deploy/helm/factory/README.md.
No retained installation is copied.
--node is required when the cluster has more than one node.
--values supplies extra settings. Only storage and size settings are used; identity is never copied.
--small-requests lowers scheduling memory requests so the control plane fits a crowded node.
--with-sandbox runs the Project, Ticket and Wiki steps. Creating a Starter Project makes Factory
create native execution resources, so it is off by default. Public HTTPS is required; the
browser must trust the Ingress certificate. The helper never edits browser or host trust; unavailable
trust fails browser checks, even without --with-sandbox. DNS and native workers are operator inputs.
Native cleanup still refuses recorded or unobserved native resources rather than deleting them.
--keep skips cleanup so you can debug the installation.
Writes .factory/test-results/clean-room/<namespace>.json.`;

export function parseOptions(args: string[]): Options {
  const options: Options = {
    chart: "",
    factoryImage: "",
    node: "",
    values: "",
    nativeFixture: "",
    context: "",
    keep: false,
    withSandbox: false,
    smallRequests: false,
    cleanup: "",
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag || seen.has(flag)) throw new Error("Clean-room options must be unambiguous");
    seen.add(flag);
    if (flag === "--keep") options.keep = true;
    else if (flag === "--with-sandbox") options.withSandbox = true;
    else if (flag === "--small-requests") options.smallRequests = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) throw new Error(help);
      if (flag === "--chart") options.chart = value;
      else if (flag === "--factory-image") options.factoryImage = value;
      else if (flag === "--node") options.node = value;
      else if (flag === "--values") options.values = value;
      else if (flag === "--native-fixture") options.nativeFixture = value;
      else if (flag === "--context") options.context = value;
      else if (flag === "--cleanup") options.cleanup = value;
      else throw new Error(help);
    }
  }
  if (options.cleanup) {
    if (!cleanRoomIDFromNamespace(options.cleanup))
      throw new Error("--cleanup takes a factory-cleanroom-<8 hex> namespace");
    if (
      options.nativeFixture ||
      options.factoryImage ||
      options.chart ||
      options.values ||
      options.node ||
      options.keep ||
      options.withSandbox ||
      options.smallRequests
    )
      throw new Error("--cleanup accepts only its Namespace and optional context");
    return options;
  }
  if (options.node && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(options.node))
    throw new Error("--node must be a Kubernetes node name");
  if (!options.chart && !options.factoryImage)
    throw new Error("Pass --chart, or --factory-image so the working tree chart can be packaged.");
  if (!options.nativeFixture)
    throw new Error("Pass --native-fixture with explicit fresh native installation inputs.");
  if (options.factoryImage && imageKind(options.factoryImage) !== "digest")
    throw new Error("Native clean-room installation requires an immutable Factory image digest");
  if (options.chart) parseChartArgument(options.chart);
  return options;
}

// ---- Chart and image

export type ChartSource =
  | { kind: "package"; path: string }
  | { kind: "oci"; reference: string; version: string | null }
  | { kind: "working-tree" };

export function parseChartArgument(value: string): ChartSource {
  if (!value) return { kind: "working-tree" };
  if (value.startsWith("oci://")) {
    // oci://host/path/factory:0.1.0-beta.1 names the version after the last slash.
    const slash = value.lastIndexOf("/");
    const colon = value.indexOf(":", slash + 1);
    if (colon === -1) return { kind: "oci", reference: value, version: null };
    const version = value.slice(colon + 1);
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version))
      throw new Error("An OCI chart version must look like 0.1.0 or 0.1.0-beta.1");
    return { kind: "oci", reference: value.slice(0, colon), version };
  }
  if (!value.endsWith(".tgz") || /^[a-z]+:\/\//i.test(value))
    throw new Error("--chart takes a .tgz file or an oci:// reference");
  return { kind: "package", path: value };
}

const digestImage = /^[a-z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/;
const taggedImage = /^[a-z0-9][a-zA-Z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A published digest reference is the normal case; a local tag is allowed for a local run. */
export function imageKind(reference: string): "digest" | "local-tag" {
  if (digestImage.test(reference)) return "digest";
  if (taggedImage.test(reference) && !reference.endsWith(":latest")) return "local-tag";
  throw new Error(
    "--factory-image must be a digest reference (name@sha256:...) or a specific local tag, never :latest",
  );
}

export type Values = Record<string, unknown>;

export function record(value: unknown): Values {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};
}

/** What the chart's own defaults pin, and so what the caller does not have to supply. */
export function pinning(defaults: Values) {
  const image = String(defaults["image"] ?? "");
  return {
    image,
    imagePinned: digestImage.test(image),
  };
}

export function requireNativeChart(defaults: Values) {
  const native = record(defaults["substrate"]);
  if (
    typeof native["workspaceConfigurationSecret"] !== "string" ||
    typeof native["provisionerTokenSecret"] !== "string" ||
    "factorybox" in defaults ||
    "executionReserveTarget" in defaults
  )
    throw new Error("Clean-room checks require the native-only Factory chart");
}

export function packageVersion(id: string) {
  cleanRoomNamespace(id);
  return `0.0.0-cleanroom.${id}`;
}

// ---- Values

const allowedSettings = [
  "storageClass",
  "stateSize",
  "databaseSize",
  "forgejoSize",
  "openbaoSize",
  "zeroSize",
  "zeroSyncWorkers",
  "imagePullPolicy",
  "objectStorage.size",
  "objectStorage.resources",
  "backup.size",
  "backup.resources",
  "resources",
  "postgres.resources",
  "forgejo.resources",
  "openbao.resources",
  "zero.resources",
  "maintenance.resources",
  "networkPolicy.enabled",
] as const;

// Optional requests for the clean-room control plane, not native Actor limits.
const smallRequestsMiB = {
  postgres: 64,
  forgejo: 96,
  objects: 32,
  openbao: 64,
  zero: 128,
  factory: 256,
} as const;

function leafPaths(value: unknown, prefix = ""): string[] {
  const object = record(value);
  if (!Object.keys(object).length) return prefix ? [prefix] : [];
  return Object.entries(object).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function covered(path: string) {
  return allowedSettings.some((allowed) => path === allowed || path.startsWith(`${allowed}.`));
}

function pick(source: Values, path: string) {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || !(key in (current as Values))) return undefined;
    current = (current as Values)[key];
  }
  return current;
}

function put(target: Values, path: string, value: unknown) {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = record(current[key]);
    current[key] = next;
    current = next;
  }
  current[keys.at(-1) ?? ""] = value;
}

/**
 * Copies storage, size and resource settings out of a caller's values file. Origins, Secret names,
 * images, the node, credentials and everything else that identifies an installation are dropped
 * and reported by path, never by value.
 */
export function genericSettings(extra: unknown) {
  const source = record(extra);
  const copied: Values = {};
  for (const path of allowedSettings) {
    const value = pick(source, path);
    if (value !== undefined) put(copied, path, structuredClone(value));
  }
  return {
    values: copied,
    ignored: leafPaths(source)
      .filter((path) => !covered(path))
      .sort(),
  };
}

export function deepMerge(base: Values, overlay: Values): Values {
  const merged: Values = { ...base };
  for (const [key, value] of Object.entries(overlay))
    merged[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? deepMerge(record(base[key]), value as Values)
        : value;
  return merged;
}

export type CleanRoomValuesInput = {
  node: string;
  native: NativeCleanRoomValues;
  image?: string;
  extra?: unknown;
  smallRequests?: boolean;
};

function lowered(resources: unknown, memoryMiB: number, cpu: string) {
  const live = record(resources);
  return { ...live, requests: { ...record(live["requests"]), cpu, memory: `${memoryMiB}Mi` } };
}

/** Everything the run supplies itself. Nothing here comes from a retained installation. */
export function cleanRoomValues(input: CleanRoomValuesInput, defaults: Values = {}) {
  const generic = genericSettings(input.extra);
  if (!input.node) throw new Error("A node name is required");
  let values: Values = {
    development: false,
    publicURL: input.native.factoryOrigin,
    forgejoPublicURL: input.native.forgejoOrigin,
    ingress: {
      enabled: true,
      className: input.native.ingressClass,
      tlsSecret: input.native.tlsSecret,
    },
    substrate: {
      workspaceConfigurationSecret: input.native.configurationSecret,
      provisionerTokenSecret: input.native.provisionerSecret,
    },
    networkPolicy: {
      ingressControllerNamespaceSelector: { matchLabels: input.native.ingressNamespaceLabels },
    },
    backup: { enabled: true },
  };
  if (input.image)
    values = deepMerge(values, { image: input.image, imagePullPolicy: "IfNotPresent" });
  values = deepMerge(values, generic.values);
  if (input.smallRequests) {
    const merged = deepMerge(defaults, values);
    const service = (key: string, memoryMiB: number, cpu: string) => ({
      resources: lowered(record(merged[key])["resources"], memoryMiB, cpu),
    });
    values = deepMerge(values, {
      resources: lowered(merged["resources"], smallRequestsMiB.factory, "100m"),
      postgres: service("postgres", smallRequestsMiB.postgres, "25m"),
      forgejo: service("forgejo", smallRequestsMiB.forgejo, "25m"),
      openbao: service("openbao", smallRequestsMiB.openbao, "25m"),
      zero: service("zero", smallRequestsMiB.zero, "50m"),
      objectStorage: service("objectStorage", smallRequestsMiB.objects, "25m"),
    });
  }
  return { values, ignored: generic.ignored };
}

// ---- Capacity

export type MemoryLine = { name: string; mib: number };
type SchedulingLine = MemoryLine & { cpuMilli: number };

const backupStoreMiB = 8;
const testProbeMiB = 128;

/** Scheduler reservations, including backup, test and managed TLS renewal Jobs. */
export function controlPlaneRequests(values: Values): SchedulingLine[] {
  const request = (value: unknown, resource: "cpu" | "memory") => {
    const resources = record(value);
    const amount = record(resources["requests"])[resource] ?? record(resources["limits"])[resource];
    if (amount === undefined) return 0;
    if (typeof amount !== "string" && typeof amount !== "number")
      throw new Error(`Control-plane ${resource} request is not a Kubernetes quantity`);
    return kubernetesResourceQuantity(amount, resource);
  };
  const line = (name: string, resources: unknown) => ({
    name,
    mib: request(resources, "memory") / 1024 ** 2,
    cpuMilli: request(resources, "cpu"),
  });
  const section = (name: string, key = name) => line(name, record(values[key])["resources"]);
  const backup = section("backup job", "backup");
  return [
    line("factory", values["resources"]),
    section("postgres"),
    section("forgejo"),
    section("openbao"),
    section("zero"),
    section("objects", "objectStorage"),
    { name: "backup store", mib: backupStoreMiB, cpuMilli: 5 },
    { ...backup, mib: Math.max(16, backup.mib), cpuMilli: Math.max(10, backup.cpuMilli) },
    { name: "helm test probe", mib: testProbeMiB, cpuMilli: 50 },
    ...(record(values["ingress"])["enabled"] && !record(values["ingress"])["tlsSecret"]
      ? [{ name: "managed ingress TLS renewal", mib: 64, cpuMilli: 10 }]
      : []),
  ];
}

export function totalMiB(lines: readonly MemoryLine[]) {
  return Math.ceil(lines.reduce((sum, line) => sum + line.mib, 0));
}

type PodLike = {
  metadata?: { name?: string; namespace?: string };
  spec: unknown;
  status?: unknown;
};

export function largestRequesters(pods: readonly PodLike[], count = 5) {
  return pods
    .map((pod) => ({
      pod: `${pod.metadata?.namespace ?? "?"}/${pod.metadata?.name ?? "?"}`,
      mib: Math.ceil(kubernetesPodRequestedResources(pod).memoryBytes / 1024 ** 2),
    }))
    .filter((item) => item.mib > 0)
    .sort((left, right) => right.mib - left.mib)
    .slice(0, count);
}

export function capacityVerdict(input: {
  node: string;
  allocatable: string;
  allocatableCPU: string;
  pods: readonly PodLike[];
  needed: readonly SchedulingLine[];
  smallRequests: boolean;
}) {
  const allocated = kubernetesResourceQuantity(input.allocatable, "memory");
  const allocatedCPU = kubernetesResourceQuantity(input.allocatableCPU, "cpu");
  const requests = input.pods.map((pod) => kubernetesPodRequestedResources(pod));
  const reserved = requests.reduce((sum, request) => sum + request.memoryBytes, 0);
  const reservedCPU = requests.reduce((sum, request) => sum + request.cpuMilli, 0);
  const neededMilliCPU = input.needed.reduce((sum, line) => sum + line.cpuMilli, 0);
  if (
    !Number.isSafeInteger(reserved) ||
    !Number.isSafeInteger(reservedCPU) ||
    !Number.isSafeInteger(neededMilliCPU) ||
    input.needed.some((line) => !Number.isSafeInteger(line.cpuMilli) || line.cpuMilli < 0)
  )
    throw new Error("Node resource requests exceed safe admission accounting");
  const headroomMiB = Math.floor((allocated - reserved) / 1024 ** 2);
  const headroomMilliCPU = allocatedCPU - reservedCPU;
  const neededMiB = totalMiB(input.needed);
  const fits = headroomMiB >= neededMiB && headroomMilliCPU >= neededMilliCPU;
  const top = largestRequesters(input.pods)
    .map((item) => `${item.pod} (${item.mib} MiB)`)
    .join(", ");
  return {
    fits,
    node: input.node,
    headroomMiB,
    headroomMilliCPU,
    neededMiB,
    neededMilliCPU,
    detail: fits
      ? `${headroomMiB} MiB of allocatable memory and ${headroomMilliCPU} millicores are unrequested on ${input.node}; the control plane needs ${neededMiB} MiB and ${neededMilliCPU} millicores`
      : `${input.node} has ${headroomMiB} MiB of allocatable memory and ${headroomMilliCPU} millicores unrequested; the control plane needs ${neededMiB} MiB and ${neededMilliCPU} millicores. ${
          input.smallRequests ? "" : "Rerun with --small-requests, or "
        }stop workloads there to free ${Math.max(0, neededMiB - headroomMiB)} MiB and ${Math.max(0, neededMilliCPU - headroomMilliCPU)} millicores. The largest memory requesters are ${top || "none"}. Stop only what you can restart; this script stops nothing.`,
  };
}

// ---- Readiness, browser and OpenBao

export function readinessVerdict(response: {
  status: number;
  headers: { get(name: string): string | null | undefined };
}) {
  const startupID = response.headers.get("x-open-factory-startup") ?? "";
  return {
    ready:
      response.status === 200 &&
      response.headers.get("x-open-factory") === "ready" &&
      startupID !== "",
    startupID,
  };
}

export type ConsoleEntry = { type: string; text: string };
export type ResponseEntry = { status: number; url: string };

/** Chrome logs every 401 from an unauthenticated session probe as a console error. */
const unauthenticated =
  /Failed to load resource: the server responded with a status of (401|403)\b/;

export function consoleProblems(entries: readonly ConsoleEntry[]) {
  const errors = entries.filter((entry) => entry.type === "error");
  return {
    errors: errors.filter((entry) => !unauthenticated.test(entry.text)).map((entry) => entry.text),
    ignoredUnauthenticated: errors.filter((entry) => unauthenticated.test(entry.text)).length,
  };
}

export function redactURL(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

export function serverErrors(responses: readonly ResponseEntry[]) {
  return responses
    .filter((response) => response.status >= 500)
    .map((response) => `${response.status} ${redactURL(response.url)}`);
}

export function openbaoVerdict(output: string) {
  let status: { initialized?: boolean; sealed?: boolean };
  try {
    status = JSON.parse(output || "{}") as typeof status;
  } catch {
    return { ok: false, detail: "bao status did not return JSON" };
  }
  if (status.initialized !== true) return { ok: false, detail: "OpenBao is not initialized" };
  if (status.sealed !== false) return { ok: false, detail: "OpenBao is sealed" };
  return { ok: true, detail: "OpenBao is initialized and unsealed" };
}

export const settingsLimit =
  "A clean installation holds no provider key, so this proves OpenBao is unsealed and the model connection list reads. It does not prove that a stored provider key decrypts.";
export const projectLimit =
  "Creating a Starter Project prepares native images and starts Preview. This harness has not qualified native provisioning, cleanup or the complete Ticket journey. Without --with-sandbox the run stops at the empty board.";
export const wikiLimit =
  "Wiki pages exist only after Wiki generation, which needs a configured model connection. A clean installation has none, so the page edit is skipped rather than faked.";
export const managedBrowserTrustLimit =
  "Managed public CA trust is supplied only to the helper's HTTPS probe, not Chromium. The helper never changes browser or host trust. An untrusted root fails browser checks and the run, including with --with-sandbox; HTTPS readiness alone is not browser acceptance.";

// ---- Backup

export function listSetsScript() {
  return 'for d in /backup/[0-9]*T*Z; do [ -d "$d" ] && printf "%s %s\\n" "$(basename "$d")" "$([ -f "$d/COMPLETE" ] && echo 1 || echo 0)"; done; true';
}

export function newestSet(output: string) {
  return (
    output
      .split("\n")
      .flatMap((line) => {
        const match = /^(\d{8}T\d{6}Z) 1$/.exec(line);
        return match?.[1] ? [match[1]] : [];
      })
      .sort()
      .at(-1) ?? null
  );
}

/** restore-check needs pg_restore of major version 16, the server's. */
export function usablePgRestore(versionOutput: string) {
  return /\(PostgreSQL\) 16\.\d+/.test(versionOutput);
}

export function backupJobName(id: string) {
  return `backup-cleanroom-${cleanRoomNamespace(id).slice(-8)}`;
}

// ---- Receipt

export type CheckStatus = "passed" | "failed" | "skipped";
export type Check = { name: string; status: CheckStatus; detail: string; durationMs: number };

export type CleanupState = {
  state: "not-started" | "removed" | "kept" | "failed";
  deleted: string[];
  remaining: string[];
  errors: string[];
  unattributedRuntimeNamespaces: string[];
  disappeared: string[];
  unexpectedClaims: string[];
};

export function emptyCleanup(): CleanupState {
  return {
    state: "not-started",
    deleted: [],
    remaining: [],
    errors: [],
    unattributedRuntimeNamespaces: [],
    disappeared: [],
    unexpectedClaims: [],
  };
}

export type Receipt = {
  schema: 1;
  scope: "control-plane-check";
  nativeProductAcceptance: false;
  id: string;
  namespace: string;
  namespaceUID: string | null;
  release: string;
  state: "running" | "finished";
  passed: boolean;
  interrupted: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  context: string;
  node: string;
  platform: string;
  tools: Record<string, string>;
  chart: Record<string, unknown>;
  images: Record<string, unknown>;
  native: {
    tlsMode?: "managed" | "external";
    configurationSHA256?: string;
    certificateSHA256?: string;
    caSecretName?: string;
    caSecretUID?: string;
    caSecretResourceVersion?: string;
    caFingerprint256?: string;
    caExpiresAt?: string;
    editorPrincipal?: string;
    factoryOrigin?: string;
    forgejoOrigin?: string;
    secretNames?: string[];
  };
  options: { keep: boolean; withSandbox: boolean; smallRequests: boolean; extraValues: boolean };
  scheduling: Record<string, unknown>;
  values: { ignoredKeys: string[] };
  timingsMs: Record<string, number>;
  checks: Check[];
  limits: string[];
  screenshots: string[];
  cleanup: CleanupState;
  failure?: string;
};

export function createReceipt(input: {
  id: string;
  context: string;
  startedAt: Date;
  options: Receipt["options"];
}): Receipt {
  return {
    schema: 1,
    scope: "control-plane-check",
    nativeProductAcceptance: false,
    id: input.id,
    namespace: cleanRoomNamespace(input.id),
    namespaceUID: null,
    release: releaseName,
    state: "running",
    passed: false,
    interrupted: false,
    startedAt: input.startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    context: input.context,
    node: "",
    platform: `${process.platform}/${process.arch}`,
    tools: {},
    chart: {},
    images: {},
    native: {},
    options: input.options,
    scheduling: {},
    values: { ignoredKeys: [] },
    timingsMs: {},
    checks: [],
    limits: [],
    screenshots: [],
    cleanup: emptyCleanup(),
  };
}

/** Every run records each of these. The Project steps may be skipped only without --with-sandbox. */
export const requiredChecks = [
  "native-inputs",
  "tools",
  "capacity",
  "chart",
  "chart-configuration",
  "namespace",
  "native-secrets",
  "install",
  "public-trust",
  "helm-test",
  "readiness",
  "admin-credential",
  "sign-in",
  "openbao",
  "settings-models",
  "project-starter",
  "ticket",
  "wiki-edit",
  "browser-clean",
  "backup-job",
  "backup-check",
] as const;

/** Skips with a documented reason that never hide a failure. */
function skipAllowed(name: string, withSandbox: boolean) {
  if (name === "wiki-edit" || name === "backup-check") return true;
  return !withSandbox && (name === "project-starter" || name === "ticket");
}

export function receiptVerdict(
  receipt: Pick<Receipt, "checks" | "cleanup" | "options" | "namespaceUID" | "interrupted">,
  withSandbox = receipt.options.withSandbox,
) {
  const problems: string[] = [];
  if (receipt.interrupted) problems.push("run was interrupted");
  if (!receipt.namespaceUID) problems.push("original Namespace identity was not confirmed");
  for (const name of requiredChecks) {
    const check = receipt.checks.find((item) => item.name === name);
    if (!check) problems.push(`${name} was not run`);
    else if (check.status === "failed") problems.push(`${name} failed`);
    else if (check.status === "skipped" && !skipAllowed(name, withSandbox))
      problems.push(`${name} was skipped`);
  }
  if (receipt.options.keep) {
    if (receipt.cleanup.state !== "kept")
      problems.push(`cleanup was ${receipt.cleanup.state}, not kept`);
  } else {
    if (receipt.cleanup.state !== "removed") problems.push(`cleanup was ${receipt.cleanup.state}`);
    if (receipt.cleanup.remaining.length) problems.push("resources remain after cleanup");
    if (receipt.cleanup.errors.length) problems.push("cleanup reported errors");
  }
  return { passed: problems.length === 0, problems };
}

export function finishReceipt(receipt: Receipt, finishedAt: Date, failure?: string): Receipt {
  const verdict = receiptVerdict(receipt);
  const reason = failure ?? (verdict.problems.length ? verdict.problems.join("; ") : undefined);
  return {
    ...receipt,
    scope: "control-plane-check",
    nativeProductAcceptance: false,
    state: "finished",
    passed: verdict.passed && !failure,
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - Date.parse(receipt.startedAt),
    ...(reason ? { failure: reason } : {}),
  };
}

/** Serializes a receipt and refuses to write any of the given secrets. */
export function serializeReceipt(receipt: Receipt, secrets: readonly string[] = []) {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const secret of secrets)
    if (secret.length >= 6 && text.includes(secret))
      throw new Error("The receipt would contain a secret; refusing to write it");
  return text;
}

export function redact(text: string, secrets: readonly string[]) {
  return secrets.reduce(
    (current, secret) => (secret.length >= 6 ? current.replaceAll(secret, "[redacted]") : current),
    text,
  );
}

export function receiptPath(namespace: string) {
  if (!cleanRoomIDFromNamespace(namespace)) throw new Error("Not a clean-room namespace");
  return `.factory/test-results/clean-room/${namespace}.json`;
}
