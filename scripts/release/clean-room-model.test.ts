import { expect, test } from "bun:test";
import {
  backupJobName,
  capacityVerdict,
  classifyClaims,
  cleanRoomIDFromNamespace,
  cleanRoomNamespace,
  cleanRoomValues,
  clusterObjectNames,
  consoleProblems,
  controlPlaneRequests,
  createReceipt,
  disappeared,
  finishReceipt,
  genericSettings,
  help,
  imageKind,
  listSetsScript,
  managedBrowserTrustLimit,
  namespaceManifest,
  newestSet,
  openbaoVerdict,
  ownedClusterObjects,
  ownedRuntimeNamespaces,
  ownedVolumes,
  packageVersion,
  parseChartArgument,
  parseOptions,
  pinning,
  readinessVerdict,
  receiptPath,
  receiptVerdict,
  redact,
  requireCleanRoomNativeInventory,
  requiredChecks,
  requireNativeChart,
  runtimeNamespacesNotAttributed,
  serializeReceipt,
  serverErrors,
  totalMiB,
  usablePgRestore,
  verifyOwnedNamespace,
} from "./clean-room-model";

test("the native clean-room Namespace explicitly admits trusted control-plane API clients", () => {
  const manifest = namespaceManifest("0a1b2c3d", new Date("2026-11-13T11:50:00Z"));
  expect(manifest.metadata.labels["ate.dev/api-access"]).toBe("true");
});

const digest = `ghcr.io/example/factory@sha256:${"1".repeat(64)}`;
const nativeValues = {
  factoryOrigin: "https://factory.owned-cleanroom.invalid",
  forgejoOrigin: "https://git.owned-cleanroom.invalid",
  ingressClass: "owned-ingress",
  ingressNamespaceLabels: { "kubernetes.io/metadata.name": "owned-ingress" },
  configurationSecret: "factory-native-configuration",
  provisionerSecret: "factory-native-provisioner",
  tlsSecret: "factory-ingress-tls",
};

test("native clean-room values carry their explicit HTTPS and fresh Secret inputs", () => {
  const input = { node: "owned-node", native: nativeValues };
  const { values } = cleanRoomValues(input);
  expect(values["development"]).toBe(false);
  expect(values["publicURL"]).toBe(nativeValues.factoryOrigin);
  expect(values["forgejoPublicURL"]).toBe(nativeValues.forgejoOrigin);
  expect(values["substrate"]).toEqual({
    workspaceConfigurationSecret: nativeValues.configurationSecret,
    provisionerTokenSecret: nativeValues.provisionerSecret,
  });
  expect(values["developmentZeroURL"]).toBeUndefined();
  expect(values["ingress"]).toMatchObject({ enabled: true, tlsSecret: nativeValues.tlsSecret });
});

test("managed clean-room values leave TLS issuance to Helm and ignore inherited TLS overrides", () => {
  const { values, ignored } = cleanRoomValues({
    node: "owned",
    native: { ...nativeValues, tlsSecret: "" },
    extra: { ingress: { enabled: false, tlsSecret: "retained-certificate" } },
  });
  expect(values["ingress"]).toMatchObject({ enabled: true, tlsSecret: "" });
  expect(ignored).toEqual(["ingress.enabled", "ingress.tlsSecret"]);
});

test("clean-room help distinguishes the external default from explicit managed browser qualification", () => {
  expect(help).toContain("external certificate/key/CA bundle");
  expect(help).toContain("existing complete external fixtures need no tlsMode field");
  expect(help).toContain('Use explicit tlsMode: "managed"');
  expect(help).toContain(
    "does not enroll Chromium trust or pass browser acceptance until its CA is trusted",
  );
  expect(help).toContain("Ordinary Helm installation still defaults to managed TLS");
});

test("native commissioning is required before a clean-room creation can start", () => {
  expect(() => parseOptions(["--factory-image", digest])).toThrow("--native-fixture");
});

test("a clean-room Namespace round-trips its id and nothing else matches", () => {
  expect(cleanRoomNamespace("0a1b2c3d")).toBe("factory-cleanroom-0a1b2c3d");
  expect(cleanRoomIDFromNamespace("factory-cleanroom-0a1b2c3d")).toBe("0a1b2c3d");
  for (const other of [
    "factory",
    "factory-acme-sized-20261103",
    "factory-cleanroom-0A1B2C3D",
    "factory-cleanroom-0a1b2c3",
    "factory-cleanroom-0a1b2c3d-x",
    "factory-box-0a1b2c3d",
    "factory-restore-rehearsal-0a1b2c3d",
  ])
    expect(cleanRoomIDFromNamespace(other)).toBeNull();
  expect(() => cleanRoomNamespace("xyz")).toThrow();
});

test("the Namespace is created with the owner labels the cleanup later demands", () => {
  const manifest = namespaceManifest("0a1b2c3d", new Date("2026-11-05T10:00:00Z"));
  expect(manifest.metadata.name).toBe("factory-cleanroom-0a1b2c3d");
  expect(manifest.metadata.labels).toEqual({
    "factory.dev/clean-room-owner": "0a1b2c3d",
    "app.kubernetes.io/managed-by": "factory-clean-room",
    "ate.dev/api-access": "true",
  });
  expect(verifyOwnedNamespace({ metadata: { ...manifest.metadata, uid: "u-1" } }, "0a1b2c3d")).toBe(
    "u-1",
  );
});

test("cleanup refuses a Namespace without this run's exact name and labels", () => {
  const owned = {
    name: "factory-cleanroom-0a1b2c3d",
    uid: "u-1",
    labels: {
      "factory.dev/clean-room-owner": "0a1b2c3d",
      "app.kubernetes.io/managed-by": "factory-clean-room",
    },
  };
  expect(() =>
    verifyOwnedNamespace({ metadata: { ...owned, name: "factory" } }, "0a1b2c3d"),
  ).toThrow("is not factory-cleanroom-0a1b2c3d");
  expect(() =>
    verifyOwnedNamespace(
      { metadata: { ...owned, name: "factory-acme-sized-20261103", labels: owned.labels } },
      "0a1b2c3d",
    ),
  ).toThrow();
  expect(() => verifyOwnedNamespace({ metadata: { ...owned, labels: {} } }, "0a1b2c3d")).toThrow(
    "owner label",
  );
  expect(() =>
    verifyOwnedNamespace(
      {
        metadata: {
          ...owned,
          labels: { ...owned.labels, "factory.dev/clean-room-owner": "ffffffff" },
        },
      },
      "0a1b2c3d",
    ),
  ).toThrow("owner label");
  expect(() =>
    verifyOwnedNamespace(
      {
        metadata: { ...owned, labels: { ...owned.labels, "app.kubernetes.io/managed-by": "Helm" } },
      },
      "0a1b2c3d",
    ),
  ).toThrow("owner label");
  expect(() =>
    verifyOwnedNamespace({ metadata: { name: owned.name, labels: owned.labels } }, "0a1b2c3d"),
  ).toThrow("no UID");
  expect(() =>
    verifyOwnedNamespace({ metadata: { ...owned, uid: "replaced" } }, "0a1b2c3d", "u-1"),
  ).toThrow("original Namespace UID");
});

test("only exactly named, chart-labelled cluster objects are ours", () => {
  const names = clusterObjectNames("0a1b2c3d");
  expect(names.clusterRoles).toEqual([
    "factory-cleanroom-0a1b2c3d-factory",
    "factory-cleanroom-0a1b2c3d-factory-preflight",
  ]);
  const labels = { "app.kubernetes.io/name": "factory", "app.kubernetes.io/instance": "factory" };
  const items = [
    { metadata: { name: "factory-cleanroom-0a1b2c3d-factory", labels } },
    { metadata: { name: "factory-cleanroom-0a1b2c3d-factory-preflight", labels: {} } },
    { metadata: { name: "factory-factory", labels } },
    { metadata: { name: "factory-cleanroom-ffffffff-factory", labels } },
  ];
  expect(ownedClusterObjects(items, names.clusterRoles)).toEqual([
    "factory-cleanroom-0a1b2c3d-factory",
  ]);
});

test("known chart claims are separated from anything unexpected", () => {
  const { chart, unexpected } = classifyClaims([
    "data-factory-postgres-0",
    "data-factory-forgejo-0",
    "config-factory-forgejo-0",
    "data-factory-openbao-0",
    "data-factory-zero-0",
    "store-factory-backup-store-0",
    "factory-state",
    "factory-objects",
    "factory-storage-check-probe",
    "data-other-postgres-0",
  ]);
  expect(chart).toHaveLength(8);
  expect(unexpected).toEqual(["factory-storage-check-probe", "data-other-postgres-0"]);
});

test("a volume is ours only through our Namespace and a recorded claim UID", () => {
  const volume = (name: string, namespace: string, uid: string) => ({
    metadata: { name },
    spec: { claimRef: { namespace, uid } },
  });
  const volumes = [
    volume("pv-a", "factory-cleanroom-0a1b2c3d", "claim-1"),
    volume("pv-b", "factory-cleanroom-0a1b2c3d", "claim-other"),
    volume("pv-c", "factory", "claim-1"),
    { metadata: { name: "pv-d" }, spec: {} },
  ];
  expect(ownedVolumes(volumes, ["factory-cleanroom-0a1b2c3d"], new Set(["claim-1"]))).toEqual([
    "pv-a",
  ]);
});

test("only editor Namespaces with recorded UIDs can belong to Kubernetes-only cleanup", () => {
  const editor = (suffix: string, uid: string, managed = "open-software-factory") => ({
    metadata: {
      name: `factory-editor-${suffix.repeat(32)}`,
      uid,
      labels: { "app.kubernetes.io/managed-by": managed },
    },
  });
  const namespaces = [
    editor("a", "uid-ours"),
    editor("b", "uid-retained"),
    editor("c", "uid-ours", "other"),
    {
      metadata: {
        name: `factory-box-${"d".repeat(32)}`,
        uid: "uid-ours",
        labels: { "app.kubernetes.io/managed-by": "open-software-factory" },
      },
    },
    { metadata: { name: "factory-acme-sized-20261103", uid: "uid-ours", labels: {} } },
  ];
  expect(
    ownedRuntimeNamespaces(namespaces, new Set(["uid-ours"])).map((item) => item.name),
  ).toEqual([`factory-editor-${"a".repeat(32)}`]);
  expect(
    runtimeNamespacesNotAttributed([`factory-editor-${"b".repeat(32)}`], namespaces, [
      `factory-editor-${"a".repeat(32)}`,
    ]),
  ).toEqual([`factory-editor-${"c".repeat(32)}`]);
  expect(disappeared(["a", "b", "c"], ["a"], ["b"])).toEqual(["c"]);
});

test("a chart is a file, an OCI reference with an optional version, or the working tree", () => {
  expect(parseChartArgument("")).toEqual({ kind: "working-tree" });
  expect(parseChartArgument("./factory-0.1.0-beta.1.tgz")).toEqual({
    kind: "package",
    path: "./factory-0.1.0-beta.1.tgz",
  });
  expect(parseChartArgument("oci://ghcr.io/maxcodefaster/charts/factory:0.1.0-beta.1")).toEqual({
    kind: "oci",
    reference: "oci://ghcr.io/maxcodefaster/charts/factory",
    version: "0.1.0-beta.1",
  });
  expect(parseChartArgument("oci://localhost:5000/charts/factory")).toEqual({
    kind: "oci",
    reference: "oci://localhost:5000/charts/factory",
    version: null,
  });
  expect(() => parseChartArgument("https://example.com/factory.tgz")).toThrow();
  expect(() => parseChartArgument("./factory")).toThrow();
});

test("a digest image is normal, a specific local tag is allowed and :latest is refused", () => {
  expect(imageKind(digest)).toBe("digest");
  expect(imageKind("open-software-factory:release-0a1b2c3")).toBe("local-tag");
  expect(() => imageKind("open-software-factory:latest")).toThrow();
  expect(() => imageKind("open-software-factory")).toThrow();
  expect(() => imageKind("ghcr.io/example/factory@sha256:abc")).toThrow();
});

test("options need a chart or an image, reject unknown flags and accept cleanup alone", () => {
  expect(() => parseOptions([])).toThrow();
  expect(() => parseOptions(["--factory-image", digest, "--bogus", "x"])).toThrow();
  expect(() => parseOptions(["--factory-image"])).toThrow();
  expect(() => parseOptions(["--cleanup", "factory"])).toThrow();
  const options = parseOptions([
    "--factory-image",
    digest,
    "--node",
    "orbstack",
    "--native-fixture",
    "/owned/native.json",
    "--keep",
    "--with-sandbox",
    "--small-requests",
  ]);
  expect(options).toMatchObject({
    factoryImage: digest,
    node: "orbstack",
    keep: true,
    withSandbox: true,
    smallRequests: true,
  });
  expect(
    parseOptions([
      "--chart",
      "oci://ghcr.io/x/factory:0.1.0",
      "--native-fixture",
      "/owned/native.json",
    ]).chart,
  ).toContain("oci://");
  expect(() =>
    parseOptions(["--factory-image", "factory:local", "--native-fixture", "/owned/native.json"]),
  ).toThrow("immutable Factory image digest");
  expect(parseOptions(["--cleanup", "factory-cleanroom-0a1b2c3d"]).cleanup).toBe(
    "factory-cleanroom-0a1b2c3d",
  );
  expect(() =>
    parseOptions([
      "--cleanup",
      "factory-cleanroom-0a1b2c3d",
      "--native-fixture",
      "/owned/native.json",
    ]),
  ).toThrow("accepts only");
  expect(() =>
    parseOptions([
      "--factory-image",
      digest,
      "--native-fixture",
      "/owned/one.json",
      "--native-fixture",
      "/owned/two.json",
    ]),
  ).toThrow("unambiguous");
});

test("a native chart pins only the control-plane image, never a Factorybox worker", () => {
  expect(pinning({ image: "" })).toEqual({ image: "", imagePinned: false });
  expect(pinning({ image: digest })).toEqual({ image: digest, imagePinned: true });
  expect(packageVersion("0a1b2c3d")).toBe("0.0.0-cleanroom.0a1b2c3d");
});

test("clean-room refuses old chart contracts instead of supplying compatibility values", () => {
  const native = {
    image: digest,
    substrate: { workspaceConfigurationSecret: "", provisionerTokenSecret: "" },
  };
  expect(() => requireNativeChart(native)).not.toThrow();
  for (const old of [
    {},
    { image: digest },
    { ...native, substrate: { workspaceConfigurationSecret: "" } },
    { ...native, factorybox: {} },
    { ...native, executionReserveTarget: 0 },
  ])
    expect(() => requireNativeChart(old)).toThrow("native-only Factory chart");
});

// The shape of a retained installation's values file, with invented identity.
const retained = {
  image: "registry.example/factory@sha256:abc",
  imagePullPolicy: "IfNotPresent",
  publicURL: "https://factory.retained.example",
  forgejoPublicURL: "https://git.retained.example",
  development: false,
  adminEmail: "owner@retained.example",
  storageClass: "local-path",
  stateSize: "2Gi",
  databaseSize: "10Gi",
  existingSecrets: { credentials: "retained-credentials", objects: "retained-objects" },
  registryCASecret: "retained-ca",
  modelAllowedOrigins: ["https://models.retained.example"],
  gitAllowedOrigins: ["https://git.retained.example"],
  factorybox: {
    nodeName: "retained-node",
    image: "registry.example/worker@sha256:def",
    memoryHeadroomMiB: 1024,
    claimGiB: 48,
  },
  postgres: { resources: { requests: { memory: "96Mi" } } },
  objectStorage: { size: "4Gi" },
  backup: {
    enabled: false,
    size: "10Gi",
    remote: { existingSecret: "retained-remote", path: "x:y" },
  },
};

test("generated values take sizes and storage from an extra file and nothing that names an installation", () => {
  const { values, ignored } = cleanRoomValues({
    node: "orbstack",
    native: nativeValues,
    extra: retained,
  });
  expect(values).toMatchObject({
    development: false,
    publicURL: nativeValues.factoryOrigin,
    forgejoPublicURL: nativeValues.forgejoOrigin,
    storageClass: "local-path",
    stateSize: "2Gi",
    databaseSize: "10Gi",
    ingress: { enabled: true },
    backup: { enabled: true, size: "10Gi" },
    objectStorage: { size: "4Gi" },
    postgres: { resources: { requests: { memory: "96Mi" } } },
  });
  const text = JSON.stringify(values);
  for (const identity of [
    "retained",
    "owner@",
    "existingSecrets",
    "registryCASecret",
    "modelAllowedOrigins",
    "gitAllowedOrigins",
    "registry.example",
  ])
    expect(text).not.toContain(identity);
  expect(ignored).toContain("existingSecrets.credentials");
  expect(ignored).toContain("publicURL");
  expect(ignored).toContain("factorybox.nodeName");
  expect(ignored).toContain("backup.enabled");
  expect(ignored).toContain("backup.remote.existingSecret");
  expect(ignored.join(" ")).not.toContain("retained.example");
});

test("the retained installation's own file can never reproduce its identity", () => {
  const { values } = cleanRoomValues({ node: "n1", native: nativeValues, extra: retained });
  expect(values["existingSecrets"]).toBeUndefined();
  expect(values["adminEmail"]).toBeUndefined();
  expect(values["image"]).toBeUndefined();
  expect(values["factorybox"]).toBeUndefined();
  expect(genericSettings({ unknown: { nested: 1 } }).ignored).toEqual(["unknown.nested"]);
});

test("a control-plane image override cannot supply a legacy worker", () => {
  const { values } = cleanRoomValues({
    node: "n1",
    native: nativeValues,
    image: digest,
  });
  expect(values).toMatchObject({
    image: digest,
    imagePullPolicy: "IfNotPresent",
  });
  expect(values["factorybox"]).toBeUndefined();
});

test("unobserved or native resources refuse destructive Kubernetes-only cleanup", () => {
  const uid = crypto.randomUUID();
  expect([...requireCleanRoomNativeInventory({ code: 0, stdout: `${uid}\n` })]).toEqual([uid]);
  expect(() => requireCleanRoomNativeInventory({ code: 1, stdout: "" })).toThrow("unavailable");
  expect(() =>
    requireCleanRoomNativeInventory({ code: 0, stdout: "native-resources-present\n" }),
  ).toThrow("not yet qualified");
  expect(() => requireCleanRoomNativeInventory({ code: 0, stdout: "garbled\n" })).toThrow(
    "invalid",
  );
});

test("a missing capacity observation node is refused", () => {
  expect(() => cleanRoomValues({ node: "", native: nativeValues })).toThrow();
});

const defaults = {
  resources: { requests: { cpu: "250m", memory: "512Mi" } },
  postgres: { resources: { requests: { memory: "128Mi" } } },
  forgejo: { resources: { requests: { memory: "256Mi" } } },
  openbao: { resources: { requests: { memory: "128Mi" } } },
  zero: { resources: { requests: { memory: "256Mi" } } },
  objectStorage: { resources: { requests: { memory: "128Mi" } } },
  backup: { resources: { requests: { memory: "128Mi" } } },
};

test("managed TLS reserves its renewal Job without charging external or disabled TLS", () => {
  const baseline = controlPlaneRequests(defaults);
  const managed = controlPlaneRequests({ ...defaults, ingress: { enabled: true, tlsSecret: "" } });
  expect(managed.at(-1)).toEqual({
    name: "managed ingress TLS renewal",
    mib: 64,
    cpuMilli: 10,
  });
  expect(totalMiB(managed) - totalMiB(baseline)).toBe(64);
  expect(
    managed.reduce((sum, line) => sum + line.cpuMilli, 0) -
      baseline.reduce((sum, line) => sum + line.cpuMilli, 0),
  ).toBe(10);
  for (const ingress of [
    { enabled: false, tlsSecret: "" },
    { enabled: true, tlsSecret: "operator-owned" },
  ])
    expect(controlPlaneRequests({ ...defaults, ingress })).toEqual(baseline);
  const input = {
    node: "owned",
    allocatable: `${totalMiB(baseline)}Mi`,
    allocatableCPU: "8",
    pods: [],
    smallRequests: false,
  };
  expect(capacityVerdict({ ...input, needed: baseline }).fits).toBe(true);
  expect(capacityVerdict({ ...input, needed: managed }).fits).toBe(false);
  expect(
    capacityVerdict({
      ...input,
      allocatable: "20Gi",
      allocatableCPU: `${baseline.reduce((sum, line) => sum + line.cpuMilli, 0)}m`,
      needed: managed,
    }).fits,
  ).toBe(false);
});

test("small requests lower the control plane's scheduling memory and keep limits", () => {
  const full = totalMiB(controlPlaneRequests(defaults));
  expect(full).toBe(512 + 128 + 256 + 128 + 256 + 128 + 8 + 128 + 128);
  const { values } = cleanRoomValues(
    { node: "n", native: nativeValues, smallRequests: true },
    {
      ...defaults,
      postgres: { resources: { requests: { memory: "128Mi" }, limits: { memory: "512Mi" } } },
    },
  );
  const small = controlPlaneRequests({ ...defaults, ...(values as object) });
  expect(totalMiB(small)).toBeLessThan(full);
  expect(
    ((values["postgres"] as Record<string, unknown>)["resources"] as Record<string, unknown>)[
      "limits"
    ],
  ).toEqual({ memory: "512Mi" });
});

function pod(namespace: string, name: string, memory: string) {
  return {
    metadata: { namespace, name },
    status: { phase: "Running" },
    spec: { containers: [{ name: "app", resources: { requests: { memory } } }] },
  };
}

test("capacity names what to stop when the control plane does not fit", () => {
  const needed = controlPlaneRequests(defaults);
  const crowded = [pod("factory", "factory-zero-0", "256Mi"), pod("factory", "big", "28Gi")];
  const tight = capacityVerdict({
    node: "orbstack",
    allocatable: "29Gi",
    allocatableCPU: "8",
    pods: crowded,
    needed,
    smallRequests: false,
  });
  expect(tight.fits).toBe(false);
  expect(tight.detail).toContain("--small-requests");
  expect(tight.detail).toContain("factory/big (28672 MiB)");
  expect(tight.detail).toContain("this script stops nothing");
  const roomy = capacityVerdict({
    node: "orbstack",
    allocatable: "29Gi",
    allocatableCPU: "8",
    pods: [pod("factory", "small", "1Gi")],
    needed,
    smallRequests: false,
  });
  expect(roomy.fits).toBe(true);
  expect(
    capacityVerdict({
      node: "n",
      allocatable: "1Gi",
      allocatableCPU: "8",
      pods: [],
      needed,
      smallRequests: true,
    }).detail,
  ).not.toContain("Rerun with --small-requests");
});

test("clean-room refuses exhausted CPU before installation even when memory fits", () => {
  const busy = {
    ...pod("owned", "cpu-reservation", "1Gi"),
    spec: {
      containers: [{ name: "app", resources: { requests: { cpu: "7950m", memory: "1Gi" } } }],
    },
  };
  const verdict = capacityVerdict({
    node: "owned",
    allocatable: "20Gi",
    allocatableCPU: "8",
    pods: [busy],
    needed: controlPlaneRequests(defaults),
    smallRequests: false,
  });
  expect(verdict).toMatchObject({ fits: false, headroomMilliCPU: 50, neededMilliCPU: 315 });
  expect(verdict.detail).toContain("50 millicores");
  expect(verdict.detail).toContain("315 millicores");
  expect(verdict.detail).toContain("this script stops nothing");
});

test("clean-room counts CPU resize, init peaks, overhead and terminating reservations", () => {
  const active = {
    metadata: { name: "resizing", namespace: "owned", deletionTimestamp: "2026-11-14T00:00:00Z" },
    spec: {
      containers: [{ name: "app", resources: { requests: { cpu: "1", memory: "1Gi" } } }],
      initContainers: [
        { name: "sidecar", restartPolicy: "Always", resources: { requests: { cpu: "250m" } } },
        { name: "init", resources: { requests: { cpu: "2" } } },
      ],
      overhead: { cpu: "125m" },
    },
    status: {
      phase: "Running",
      containerStatuses: [{ name: "app", allocatedResources: { cpu: "3" } }],
    },
  };
  const observation = structuredClone(active);
  const input = {
    node: "owned",
    allocatable: "20Gi",
    allocatableCPU: "4",
    pods: [active, { ...active, status: { phase: "Succeeded" } }],
    needed: [{ name: "control plane", mib: 128, cpuMilli: 626 }],
    smallRequests: true,
  };
  expect(capacityVerdict(input)).toMatchObject({ fits: false, headroomMilliCPU: 625 });
  expect(
    capacityVerdict({ ...input, needed: [{ name: "control plane", mib: 128, cpuMilli: 625 }] }),
  ).toMatchObject({ fits: true, headroomMilliCPU: 625 });
  expect(active).toEqual(observation);
});

test("control-plane CPU quantities include limit defaults and the backup init peak", () => {
  const lines = controlPlaneRequests({
    resources: { requests: { cpu: "0.0001" } },
    postgres: { resources: { limits: { cpu: "0.125", memory: "128Mi" } } },
  });
  expect(lines.find((line) => line.name === "factory")?.cpuMilli).toBe(1);
  expect(lines.find((line) => line.name === "postgres")).toMatchObject({
    cpuMilli: 125,
    mib: 128,
  });
  expect(lines.find((line) => line.name === "backup job")).toMatchObject({
    cpuMilli: 10,
    mib: 16,
  });
  for (const cpu of ["unknown", "-1", { invalid: true }])
    expect(() => controlPlaneRequests({ resources: { requests: { cpu } } })).toThrow();
});

test("clean-install headroom uses native admission accounting for restartable init sidecars, resize, overhead and terminating Pods", () => {
  const active = {
    ...pod("owned", "resizing", "1Gi"),
    metadata: {
      namespace: "owned",
      name: "resizing",
      deletionTimestamp: "2026-11-13T00:00:00Z",
    },
    spec: {
      containers: [{ name: "app", resources: { requests: { memory: "1Gi" } } }],
      initContainers: [
        {
          name: "sidecar",
          restartPolicy: "Always",
          resources: { requests: { memory: "256Mi" } },
        },
        { name: "init", resources: { requests: { memory: "2Gi" } } },
      ],
      overhead: { memory: "128Mi" },
    },
    status: {
      phase: "Running",
      containerStatuses: [{ name: "app", allocatedResources: { memory: "3Gi" } }],
    },
  };
  const observation = structuredClone(active);
  const verdict = capacityVerdict({
    node: "owned",
    allocatable: "4Gi",
    allocatableCPU: "8",
    pods: [active, { ...pod("owned", "done", "4Gi"), status: { phase: "Succeeded" } }],
    needed: [{ name: "control plane", mib: 768, cpuMilli: 0 }],
    smallRequests: false,
  });
  expect(verdict.headroomMiB).toBe(640);
  expect(verdict.fits).toBe(false);
  expect(verdict.detail).toContain("owned/resizing (3456 MiB)");
  expect(active).toEqual(observation);
});

test("fractional or invalid reservations never become free control-plane capacity", () => {
  expect(totalMiB([{ name: "small", mib: 0.001 }])).toBe(1);
  expect(
    capacityVerdict({
      node: "owned",
      allocatable: "1048576",
      allocatableCPU: "8",
      pods: [pod("owned", "small", "0.001")],
      needed: [{ name: "control plane", mib: 1, cpuMilli: 0 }],
      smallRequests: false,
    }),
  ).toMatchObject({ fits: false, headroomMiB: 0 });
  for (const memory of ["unknown", "-1Gi"])
    expect(() =>
      capacityVerdict({
        node: "owned",
        allocatable: "4Gi",
        allocatableCPU: "8",
        pods: [pod("owned", "invalid", memory)],
        needed: [],
        smallRequests: false,
      }),
    ).toThrow();
  expect(() =>
    controlPlaneRequests({ resources: { requests: { memory: { unknown: true } } } }),
  ).toThrow("Kubernetes quantity");
  expect(controlPlaneRequests({ resources: { requests: { memory: 1048576 } } })[0]?.mib).toBe(1);
});

test("readiness needs a 200, the ready header and a startup id", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  expect(
    readinessVerdict({
      status: 200,
      headers: headers({ "x-open-factory": "ready", "x-open-factory-startup": "abc" }),
    }),
  ).toEqual({ ready: true, startupID: "abc" });
  expect(readinessVerdict({ status: 503, headers: headers({}) }).ready).toBe(false);
  expect(
    readinessVerdict({ status: 200, headers: headers({ "x-open-factory": "ready" }) }).ready,
  ).toBe(false);
});

test("console errors and 5xx fail the browser check, unauthenticated probes do not", () => {
  const problems = consoleProblems([
    { type: "log", text: "hello" },
    { type: "warning", text: "careful" },
    {
      type: "error",
      text: "Failed to load resource: the server responded with a status of 401 ()",
    },
    { type: "error", text: "Uncaught TypeError: x is not a function" },
    {
      type: "error",
      text: "Failed to load resource: the server responded with a status of 500 ()",
    },
  ]);
  expect(problems.ignoredUnauthenticated).toBe(1);
  expect(problems.errors).toHaveLength(2);
  expect(
    serverErrors([
      { status: 200, url: "http://127.0.0.1:1/a" },
      { status: 404, url: "http://127.0.0.1:1/b" },
      { status: 502, url: "http://127.0.0.1:1/api/x?token=secret#frag" },
    ]),
  ).toEqual(["502 http://127.0.0.1:1/api/x"]);
});

test("OpenBao must be initialized and unsealed", () => {
  expect(openbaoVerdict('{"initialized":true,"sealed":false}').ok).toBe(true);
  expect(openbaoVerdict('{"initialized":true,"sealed":true}').detail).toContain("sealed");
  expect(openbaoVerdict('{"initialized":false}').ok).toBe(false);
  expect(openbaoVerdict("not json").ok).toBe(false);
  expect(openbaoVerdict("").ok).toBe(false);
});

test("the newest complete backup set is found and the job name is derived from the id", () => {
  expect(newestSet("20261105T020000Z 1\n20261105T030000Z 0\n20261104T020000Z 1\n")).toBe(
    "20261105T020000Z",
  );
  expect(newestSet("20261105T030000Z 0\n")).toBeNull();
  expect(newestSet("objects 1\n../20261105T030000Z 1\n20261105T030000Z 1 extra\n")).toBeNull();
  expect(newestSet("")).toBeNull();
  expect(listSetsScript()).toContain("COMPLETE");
  expect(backupJobName("0a1b2c3d")).toBe("backup-cleanroom-0a1b2c3d");
});

test("only a version 16 pg_restore is used for the backup check", () => {
  expect(usablePgRestore("pg_restore (PostgreSQL) 16.4")).toBe(true);
  expect(usablePgRestore("pg_restore (PostgreSQL) 17.0")).toBe(false);
  expect(usablePgRestore("")).toBe(false);
});

function passing(withSandbox = false) {
  const receipt = createReceipt({
    id: "0a1b2c3d",
    context: "orbstack",
    startedAt: new Date("2026-11-05T10:00:00Z"),
    options: { keep: false, withSandbox, smallRequests: false, extraValues: false },
  });
  receipt.checks = requiredChecks.map((name) => ({
    name,
    status: "passed" as const,
    detail: "ok",
    durationMs: 1,
  }));
  receipt.cleanup = { ...receipt.cleanup, state: "removed" };
  receipt.namespaceUID = "owned-original-namespace";
  return receipt;
}

test("a receipt starts as a running record naming its Namespace", () => {
  const receipt = createReceipt({
    id: "0a1b2c3d",
    context: "orbstack",
    startedAt: new Date("2026-11-05T10:00:00Z"),
    options: { keep: false, withSandbox: false, smallRequests: false, extraValues: false },
  });
  expect(receipt).toMatchObject({
    schema: 1,
    scope: "control-plane-check",
    nativeProductAcceptance: false,
    namespace: "factory-cleanroom-0a1b2c3d",
    namespaceUID: null,
    release: "factory",
    state: "running",
    passed: false,
    finishedAt: null,
    cleanup: { state: "not-started", deleted: [], remaining: [], errors: [] },
  });
  expect(receiptPath("factory-cleanroom-0a1b2c3d")).toBe(
    ".factory/test-results/clean-room/factory-cleanroom-0a1b2c3d.json",
  );
  expect(() => receiptPath("factory")).toThrow();
});

test("a run passes only with every check recorded and the cleanup complete", () => {
  const done = finishReceipt(passing(), new Date("2026-11-05T10:30:00Z"));
  expect(done).toMatchObject({ state: "finished", passed: true, durationMs: 30 * 60_000 });
  expect(done.failure).toBeUndefined();
  expect(done.scope).toBe("control-plane-check");
  expect(done.nativeProductAcceptance).toBe(false);
  expect(finishReceipt(passing(true), new Date()).nativeProductAcceptance).toBe(false);

  const missing = passing();
  missing.checks = missing.checks.filter((check) => check.name !== "helm-test");
  expect(finishReceipt(missing, new Date()).failure).toContain("helm-test was not run");

  const failed = passing();
  failed.checks = failed.checks.map((check) =>
    check.name === "sign-in" ? { ...check, status: "failed" as const } : check,
  );
  expect(finishReceipt(failed, new Date()).passed).toBe(false);

  const leftover = passing();
  leftover.cleanup = { ...leftover.cleanup, remaining: ["pv/pv-a"] };
  expect(finishReceipt(leftover, new Date()).failure).toContain("resources remain");

  const notRemoved = passing();
  notRemoved.cleanup = { ...notRemoved.cleanup, state: "failed" };
  expect(finishReceipt(notRemoved, new Date()).passed).toBe(false);
});

test("an interrupt during the last step or cleanup cannot turn green checks into a passed run", () => {
  for (const keep of [false, true]) {
    const receipt = { ...passing(), interrupted: true };
    if (keep) {
      receipt.options.keep = true;
      receipt.cleanup.state = "kept";
    }
    expect(receiptVerdict(receipt).passed).toBe(false);
    const done = finishReceipt(receipt, new Date());
    expect(done.passed).toBe(false);
    expect(done.failure).toContain("interrupted");
  }
});

test("skips are accepted only where the limit is documented", () => {
  const skip = (receipt: ReturnType<typeof passing>, names: string[]) => {
    receipt.checks = receipt.checks.map((check) =>
      names.includes(check.name) ? { ...check, status: "skipped" as const } : check,
    );
    return receipt;
  };
  expect(receiptVerdict(skip(passing(), ["project-starter", "ticket", "wiki-edit"])).passed).toBe(
    true,
  );
  expect(receiptVerdict(skip(passing(true), ["project-starter", "ticket"]), true).problems).toEqual(
    ["project-starter was skipped", "ticket was skipped"],
  );
  expect(receiptVerdict(skip(passing(true), ["wiki-edit", "backup-check"]), true).passed).toBe(
    true,
  );
  expect(receiptVerdict(skip(passing(), ["install"])).problems).toEqual(["install was skipped"]);
});

test("managed HTTPS readiness or a browser-trust limitation never substitutes for browser acceptance", () => {
  for (const withSandbox of [false, true])
    for (const status of ["failed", "skipped"] as const) {
      const receipt = passing(withSandbox);
      receipt.native.tlsMode = "managed";
      receipt.limits.push(managedBrowserTrustLimit);
      receipt.checks = receipt.checks.map((check) =>
        ["sign-in", "settings-models", "browser-clean"].includes(check.name)
          ? { ...check, status, detail: "Managed CA is not trusted by Chromium" }
          : check,
      );
      expect(finishReceipt(receipt, new Date()).passed).toBe(false);
    }
  const missingTrust = passing();
  missingTrust.checks = missingTrust.checks.filter((check) => check.name !== "public-trust");
  expect(finishReceipt(missingTrust, new Date()).failure).toContain("public-trust was not run");
});

test("--keep passes only when cleanup was deliberately skipped", () => {
  const kept = passing();
  kept.options = { ...kept.options, keep: true };
  kept.cleanup = { ...kept.cleanup, state: "kept" };
  expect(receiptVerdict(kept).passed).toBe(true);
  kept.cleanup = { ...kept.cleanup, state: "removed" };
  expect(receiptVerdict(kept).passed).toBe(false);
});

test("a receipt refuses to carry a secret and redaction removes it from text", () => {
  const receipt = passing();
  expect(serializeReceipt(receipt, ["generated-admin-password"])).toContain('"schema": 1');
  receipt.limits.push("the password generated-admin-password leaked");
  expect(() => serializeReceipt(receipt, ["generated-admin-password"])).toThrow("secret");
  expect(redact("login generated-admin-password ok", ["generated-admin-password"])).toBe(
    "login [redacted] ok",
  );
  expect(redact("short", ["abc"])).toBe("short");
});

test("a failure message overrides the verdict reasons", () => {
  expect(finishReceipt(passing(), new Date(), "install failed").failure).toBe("install failed");
  expect(finishReceipt(passing(), new Date(), "install failed").passed).toBe(false);
});
