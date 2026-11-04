import { expect, test } from "bun:test";
import {
  checksumSQL,
  compareMaps,
  failedConstraints,
  holdPolicy,
  jailPolicy,
  memoryHeadroomMiB,
  namespaceRewriteSQL,
  newestCompleteSet,
  orphanedConstraints,
  parseObjectListing,
  parsePairs,
  podMemoryRequestMiB,
  quantityMiB,
  receiptName,
  rehearsalIDFromNamespace,
  rehearsalNamespace,
  restoreErrorCount,
  rewriteInstallationIdentity,
  rewriteServiceNamespace,
  scratchRequestsMiB,
  scratchValues,
  setAgeMinutes,
  summarize,
  toolboxNetworkPolicy,
  toolboxPod,
} from "./restore-rehearsal-model";

test("a rehearsal Namespace round-trips its id and nothing else matches", () => {
  expect(rehearsalNamespace("0a1b2c3d")).toBe("factory-restore-rehearsal-0a1b2c3d");
  expect(rehearsalIDFromNamespace("factory-restore-rehearsal-0a1b2c3d")).toBe("0a1b2c3d");
  for (const namespace of [
    "factory",
    "factory-acme-sized-20261103",
    "factory-restore-rehearsal-0a1b2c3",
    "factory-restore-rehearsal-0a1b2c3dd",
    "factory-restore-rehearsal-0A1B2C3D",
    "x-factory-restore-rehearsal-0a1b2c3d",
  ])
    expect(rehearsalIDFromNamespace(namespace)).toBeNull();
  expect(() => rehearsalNamespace("not-hex!")).toThrow();
});

test("the newest complete set wins and incomplete or foreign entries are ignored", () => {
  expect(
    newestCompleteSet([
      { name: "20261104T153048Z", complete: true },
      { name: "20261104T212949Z", complete: true },
      { name: "20261104T230000Z", complete: false },
      { name: "objects", complete: true },
    ]),
  ).toBe("20261104T212949Z");
  expect(newestCompleteSet([{ name: "20261104T230000Z", complete: false }])).toBeNull();
  expect(newestCompleteSet([])).toBeNull();
});

test("set age is measured in minutes from the UTC name", () => {
  expect(setAgeMinutes("20261104T212949Z", new Date("2026-11-04T22:29:49Z"))).toBe(60);
  expect(() => setAgeMinutes("objects", new Date())).toThrow();
  expect(receiptName(new Date("2026-11-04T22:29:49.123Z"))).toBe("20261104T222949Z.json");
});

test("memory quantities and node headroom", () => {
  expect(quantityMiB("128Mi")).toBe(128);
  expect(quantityMiB("2Gi")).toBe(2048);
  expect(quantityMiB("1048576")).toBe(1);
  expect(quantityMiB("0")).toBe(0);
  expect(() => quantityMiB("lots")).toThrow();
  const running = {
    status: { phase: "Running" },
    spec: {
      containers: [
        { resources: { requests: { memory: "256Mi" } } },
        { resources: { requests: { memory: "64Mi" } } },
        {},
      ],
      initContainers: [{ resources: { requests: { memory: "16Mi" } } }],
    },
  };
  expect(podMemoryRequestMiB(running)).toBe(320);
  const largeInit = {
    spec: {
      containers: [{ resources: { requests: { memory: "8Mi" } } }],
      initContainers: [{ resources: { requests: { memory: "100Mi" } } }],
    },
  };
  expect(podMemoryRequestMiB(largeInit)).toBe(100);
  expect(podMemoryRequestMiB({ ...running, status: { phase: "Succeeded" } })).toBe(0);
  expect(memoryHeadroomMiB("1Gi", [running, largeInit])).toBe(1024 - 420);
});

// Policies and values are plain JSON, so tests read them untyped.
const doc = (value: unknown) => JSON.parse(JSON.stringify(value));

const liveValues = {
  development: true,
  image: "registry/factory@sha256:old",
  publicURL: "http://127.0.0.1:58510",
  forgejoPublicURL: "http://127.0.0.1:58511",
  developmentZeroURL: "http://127.0.0.1:58512",
  storageClass: "",
  backup: { enabled: true, schedule: "17 2 * * *" },
  executionReserveTarget: 2,
  factorybox: { nodeName: "orbstack" },
  postgres: {
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "512Mi" } },
  },
  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "2Gi" } },
  registryCASecret: "factory-registry-ca",
};

test("scratch values change only the image, backups, reserve, requests and Secrets", () => {
  const values = doc(
    scratchValues(liveValues, { release: "acme-sized", image: "factory:release-new" }),
  );
  expect(values["image"]).toBe("factory:release-new");
  expect(values["publicURL"]).toBe("http://127.0.0.1:58510");
  expect(values["forgejoPublicURL"]).toBe("http://127.0.0.1:58511");
  expect(values["developmentZeroURL"]).toBe("http://127.0.0.1:58512");
  expect(values["backup"]).toEqual({ enabled: false, schedule: "17 2 * * *" });
  expect(values["ingress"]).toEqual({ enabled: false });
  expect(values["executionReserveTarget"]).toBe(0);
  expect(values["existingSecrets"]).toEqual({
    credentials: "acme-sized-credentials",
    objects: "acme-sized-objects",
  });
  expect(values["postgres"].resources).toEqual({
    requests: { cpu: "25m", memory: `${scratchRequestsMiB.postgres}Mi` },
    limits: { memory: "512Mi" },
  });
  expect(values["resources"].requests.memory).toBe(`${scratchRequestsMiB.factory}Mi`);
  expect(values["resources"].limits).toEqual({ memory: "2Gi" });
  expect(values["factorybox"]).toEqual({ nodeName: "orbstack" });
  expect(values["registryCASecret"]).toBe("factory-registry-ca");
  expect(liveValues.executionReserveTarget).toBe(2);
});

test("the retained installation identity is replaced and validated", () => {
  const retained = JSON.stringify({
    namespace: "factory-acme-sized-20261103",
    release: "acme-sized",
    factoryURL: "http://127.0.0.1:58510",
    forgeURL: "http://127.0.0.1:58511",
    storageClass: "",
  });
  const scratch = {
    namespace: "factory-restore-rehearsal-0a1b2c3d",
    release: "acme-sized",
    factoryURL: "http://127.0.0.1:41001",
    forgeURL: "http://127.0.0.1:41002",
    storageClass: "",
  };
  expect(JSON.parse(rewriteInstallationIdentity(retained, scratch))).toEqual(scratch);
  expect(() => rewriteInstallationIdentity('{"namespace":"x"}', scratch)).toThrow(/release/);
});

test("the hold policy is scoped by the owner label and denies Factory and Zero Pods", () => {
  const [policy, binding] = doc(holdPolicy("0a1b2c3d"));
  expect(policy.metadata.name).toBe("restore-rehearsal-hold-0a1b2c3d");
  expect(policy.spec.matchConstraints.resourceRules[0].resources).toEqual(["pods"]);
  expect(policy.spec.validations[0].expression).toContain('["factory", "zero"]');
  expect(binding.spec.validationActions).toEqual(["Deny"]);
  expect(binding.spec.matchResources.namespaceSelector.matchLabels).toEqual({
    "factory.dev/rehearsal-owner": "0a1b2c3d",
  });
  expect(binding.metadata.labels["factory.dev/rehearsal-owner"]).toBe("0a1b2c3d");
});

test("the jail policy matches one ServiceAccount and allows only its own Namespace", () => {
  const [policy, binding] = doc(
    jailPolicy("0a1b2c3d", "factory-restore-rehearsal-0a1b2c3d", "acme-sized"),
  );
  expect(policy.spec.matchConditions[0].expression).toBe(
    'request.userInfo.username == "system:serviceaccount:factory-restore-rehearsal-0a1b2c3d:acme-sized"',
  );
  const expression: string = policy.spec.validations[0].expression;
  expect(expression).toContain('request.namespace == "factory-restore-rehearsal-0a1b2c3d"');
  expect(expression).toContain('request.name.startsWith("factory-storage-check-")');
  expect(expression).not.toContain("factory-box");
  expect(policy.spec.matchConstraints.resourceRules[0].operations).toEqual([
    "CREATE",
    "UPDATE",
    "DELETE",
    "CONNECT",
  ]);
  expect(policy.spec.matchConstraints.resourceRules[0].resources).toEqual(["*/*"]);
  expect(binding.spec.policyName).toBe(policy.metadata.name);
});

test("the toolbox mounts each claim a restore replaces and reaches only Garage", () => {
  const pod = toolboxPod({
    id: "0a1b2c3d",
    name: "restore-toolbox",
    image: "rclone@sha256:abc",
    release: "acme-sized",
    scratchGiB: 3,
    objectsSecret: "acme-sized-objects",
    objectsEndpoint: "http://acme-sized-objects.ns.svc:3900",
  });
  const claims = pod.spec.volumes.flatMap((volume) =>
    "persistentVolumeClaim" in volume ? [volume.persistentVolumeClaim.claimName] : [],
  );
  expect(claims.sort()).toEqual([
    "acme-sized-state",
    "config-acme-sized-forgejo-0",
    "data-acme-sized-forgejo-0",
    "data-acme-sized-openbao-0",
    "data-acme-sized-zero-0",
  ]);
  expect(pod.metadata.labels["factory.dev/rehearsal-toolbox"]).toBe("true");
  expect(JSON.stringify(pod)).not.toContain("backup");
  const policy = toolboxNetworkPolicy("0a1b2c3d", "acme-sized");
  expect(policy.spec.podSelector.matchLabels["app.kubernetes.io/component"]).toBe("objects");
  expect(policy.spec.ingress[0]?.ports).toEqual([{ protocol: "TCP", port: 3900 }]);
});

test("comparisons name what is missing, extra and different", () => {
  const live = new Map([
    ["a", "1"],
    ["b", "2"],
    ["c", "3"],
  ]);
  expect(compareMaps(live, new Map(live)).equal).toBe(true);
  const result = compareMaps(
    live,
    new Map([
      ["a", "1"],
      ["b", "9"],
      ["d", "4"],
    ]),
  );
  expect(result).toEqual({
    equal: false,
    compared: 3,
    missing: ["c"],
    extra: ["d"],
    different: [{ key: "b", live: "2", scratch: "9" }],
  });
});

test("row and object listings parse and reject malformed lines", () => {
  expect(parsePairs("factory.project|2\nauth.user|2\n\n")).toEqual(
    new Map([
      ["factory.project", "2"],
      ["auth.user", "2"],
    ]),
  );
  expect(parsePairs("models/a/b|abc123")).toEqual(new Map([["models/a/b", "abc123"]]));
  expect(() => parsePairs("no separator")).toThrow();
  expect(parseObjectListing("70;bucket/a/0-x\n762;bucket/a/1-y\n")).toEqual(
    new Map([
      ["bucket/a/0-x", "70"],
      ["bucket/a/1-y", "762"],
    ]),
  );
  expect(() => parseObjectListing("garbage")).toThrow();
});

test("checksum SQL covers each table and refuses anything but schema.table", () => {
  const sql = checksumSQL(["factory.project", "auth.user"]);
  expect(sql.split(" UNION ALL ")).toHaveLength(2);
  expect(sql).toContain("FROM factory.project t");
  expect(() => checksumSQL(["factory.project; DROP TABLE x"])).toThrow();
});

test("a summary lists exactly the failed checks", () => {
  expect(
    summarize([
      { name: "a", ok: true, detail: "" },
      { name: "b", ok: false, detail: "" },
    ]),
  ).toEqual({ ok: false, passed: 1, failed: ["b"] });
  expect(summarize([])).toEqual({ ok: true, passed: 0, failed: [] });
});

test("a Namespace move rewrites Service addresses and nothing else", () => {
  const text =
    "http://acme-sized-internal.old-ns.svc:3000/x http://old-ns.example.com acme-sized-forgejo.old-ns.svc";
  expect(rewriteServiceNamespace(text, "old-ns", "new-ns")).toBe(
    "http://acme-sized-internal.new-ns.svc:3000/x http://old-ns.example.com acme-sized-forgejo.new-ns.svc",
  );
  expect(() => rewriteServiceNamespace(text, "old ns", "new-ns")).toThrow();
  const sql = namespaceRewriteSQL("old-ns", "new-ns");
  expect(sql).toContain("UPDATE factory.project SET repository_url = replace(repository_url");
  expect(sql).toContain("'.old-ns.svc', '.new-ns.svc'");
  expect(sql.split("UPDATE ")).toHaveLength(4);
  expect(() => namespaceRewriteSQL("old'; DROP TABLE x; --", "new-ns")).toThrow();
});

test("only foreign keys with orphaned rows are reported", () => {
  expect(
    orphanedConstraints(
      "a_fkey|factory.change_writer|30\nb_fkey|factory.project|0\nc_fkey|auth.account|2\n\n",
    ),
  ).toEqual([
    { constraint: "a_fkey", table: "factory.change_writer", rows: 30 },
    { constraint: "c_fkey", table: "auth.account", rows: 2 },
  ]);
  expect(orphanedConstraints("")).toEqual([]);
});

test("pg_restore diagnostics name the foreign keys it could not recreate", () => {
  const diagnostics = [
    'pg_restore: error: could not execute query: ERROR:  insert or update on table "b" violates foreign key constraint "b_fkey"',
    'DETAIL:  Key (id)=(1) is not present in table "a".',
    "Command was: ALTER TABLE ONLY factory.b",
    "    ADD CONSTRAINT b_fkey FOREIGN KEY (id) REFERENCES factory.a(id);",
    "pg_restore: error: could not execute query: ERROR:  boom",
    "Command was: ALTER TABLE ONLY factory.c",
    "    ADD CONSTRAINT a_fkey FOREIGN KEY (id) REFERENCES factory.a(id) ON DELETE CASCADE;",
    "pg_restore: warning: errors ignored on restore: 2",
  ].join("\n");
  expect(failedConstraints(diagnostics)).toEqual(["a_fkey", "b_fkey"]);
  expect(restoreErrorCount(diagnostics)).toBe(2);
  expect(failedConstraints("")).toEqual([]);
});
