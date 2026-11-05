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
  imageKind,
  listSetsScript,
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
  requiredChecks,
  runtimeNamespacesNotAttributed,
  serializeReceipt,
  serverErrors,
  totalMiB,
  usablePgRestore,
  verifyOwnedNamespace,
} from "./clean-room-model";

const digest = `ghcr.io/example/factory@sha256:${"1".repeat(64)}`;
const ports = { factory: 58110, forgejo: 58111, zero: 58112 };

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

test("runtime Namespaces count as ours only by a UID the installation database recorded", () => {
  const box = (suffix: string, uid: string, managed = "open-software-factory") => ({
    metadata: {
      name: `factory-box-${suffix.repeat(32)}`,
      uid,
      labels: { "app.kubernetes.io/managed-by": managed },
    },
  });
  const namespaces = [
    box("a", "uid-ours"),
    box("b", "uid-retained"),
    box("c", "uid-ours", "other"),
    { metadata: { name: "factory-acme-sized-20261103", uid: "uid-ours", labels: {} } },
  ];
  expect(
    ownedRuntimeNamespaces(namespaces, new Set(["uid-ours"])).map((item) => item.name),
  ).toEqual([`factory-box-${"a".repeat(32)}`]);
  expect(
    runtimeNamespacesNotAttributed([`factory-box-${"b".repeat(32)}`], namespaces, [
      `factory-box-${"a".repeat(32)}`,
    ]),
  ).toEqual([`factory-box-${"c".repeat(32)}`]);
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
  expect(parseOptions(["--chart", "oci://ghcr.io/x/factory:0.1.0"]).chart).toContain("oci://");
  expect(parseOptions(["--cleanup", "factory-cleanroom-0a1b2c3d"]).cleanup).toBe(
    "factory-cleanroom-0a1b2c3d",
  );
});

test("a chart pins the image and worker or leaves them to the caller", () => {
  expect(pinning({ image: "", factorybox: { image: "" } })).toMatchObject({
    imagePinned: false,
    workerPinned: false,
  });
  expect(
    pinning({
      image: digest,
      factorybox: {
        image: `ghcr.io/example/worker@sha256:${"2".repeat(64)}`,
        executableSHA256: "3".repeat(64),
        architecture: "arm64",
      },
    }),
  ).toMatchObject({ imagePinned: true, workerPinned: true });
  expect(packageVersion("0a1b2c3d")).toBe("0.0.0-cleanroom.0a1b2c3d");
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
    ports,
    extra: retained,
  });
  expect(values).toMatchObject({
    development: true,
    publicURL: "http://127.0.0.1:58110",
    forgejoPublicURL: "http://127.0.0.1:58111",
    developmentZeroURL: "http://127.0.0.1:58112",
    storageClass: "local-path",
    stateSize: "2Gi",
    databaseSize: "10Gi",
    ingress: { enabled: false },
    backup: { enabled: true, size: "10Gi" },
    objectStorage: { size: "4Gi" },
    postgres: { resources: { requests: { memory: "96Mi" } } },
    factorybox: { nodeName: "orbstack", memoryHeadroomMiB: 1024, claimGiB: 48 },
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
  const { values } = cleanRoomValues({ node: "n1", ports, extra: retained });
  expect(values["existingSecrets"]).toBeUndefined();
  expect(values["adminEmail"]).toBeUndefined();
  expect(values["image"]).toBeUndefined();
  expect((values["factorybox"] as Record<string, unknown>)["image"]).toBeUndefined();
  expect(genericSettings({ unknown: { nested: 1 } }).ignored).toEqual(["unknown.nested"]);
});

test("an image and worker override are set, with IfNotPresent for local tags", () => {
  const { values } = cleanRoomValues({
    node: "n1",
    ports,
    image: "open-software-factory:release-0a1b2c3",
    worker: {
      image: `w@sha256:${"2".repeat(64)}`,
      executableSHA256: "3".repeat(64),
      architecture: "arm64",
    },
  });
  expect(values).toMatchObject({
    image: "open-software-factory:release-0a1b2c3",
    imagePullPolicy: "IfNotPresent",
    factorybox: { nodeName: "n1", architecture: "arm64", executableSHA256: "3".repeat(64) },
  });
});

test("bad ports and a missing node are refused", () => {
  expect(() => cleanRoomValues({ node: "n", ports: { ...ports, zero: ports.factory } })).toThrow();
  expect(() => cleanRoomValues({ node: "n", ports: { ...ports, zero: 80 } })).toThrow();
  expect(() => cleanRoomValues({ node: "", ports })).toThrow();
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

test("small requests lower the control plane's scheduling memory and keep limits", () => {
  const full = totalMiB(controlPlaneRequests(defaults));
  expect(full).toBe(512 + 128 + 256 + 128 + 256 + 128 + 8 + 128 + 128);
  const { values } = cleanRoomValues(
    { node: "n", ports, smallRequests: true },
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
    spec: { containers: [{ resources: { requests: { memory } } }] },
  };
}

test("capacity names what to stop when the control plane does not fit", () => {
  const needed = controlPlaneRequests(defaults);
  const crowded = [pod("factory", "factory-zero-0", "256Mi"), pod("factory", "big", "28Gi")];
  const tight = capacityVerdict({
    node: "orbstack",
    allocatable: "29Gi",
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
    pods: [pod("factory", "small", "1Gi")],
    needed,
    smallRequests: false,
  });
  expect(roomy.fits).toBe(true);
  expect(
    capacityVerdict({ node: "n", allocatable: "1Gi", pods: [], needed, smallRequests: true })
      .detail,
  ).not.toContain("Rerun with --small-requests");
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
    namespace: "factory-cleanroom-0a1b2c3d",
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
