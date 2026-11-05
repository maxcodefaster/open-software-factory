import { expect, test } from "bun:test";
import {
  assignmentSQL,
  catalogSQL,
  claimOwnership,
  diffFingerprints,
  type Fingerprint,
  formatDiff,
  globMatches,
  isVolatileColumn,
  memoryPlan,
  newRuntimeNamespaces,
  noopRules,
  ownedVolumes,
  ownerLabel,
  parseChartSource,
  parseOptions,
  parsePaths,
  parseRowLines,
  protectedNamespace,
  requireOwnedNamespace,
  rowFingerprintSQL,
  secretReadScript,
  secretWriteScript,
  seedSQL,
  sqlLiteral,
  summarize,
  tableDigest,
  unexpectedConsole,
  unreadableSecrets,
  upgradeIDFromNamespace,
  upgradeMemoryNeedMiB,
  upgradeNamespace,
  upgradeRules,
  upgradeValues,
} from "./upgrade-test-model";

const id = "0a1b2c3d";
const managed = { [ownerLabel]: id, "app.kubernetes.io/managed-by": "factory-upgrade-test" };

function fingerprint(): Fingerprint {
  return {
    migrations: [1, 2, 3],
    tables: {
      "factory.ticket": {
        columns: ["id", "title", "state"],
        rows: {
          '["t1"]': { id: "a1", title: "b1", state: "c1" },
          '["t2"]': { id: "a2", title: "b2", state: "c2" },
        },
      },
      "auth.user": { columns: ["id", "email"], rows: { '["u1"]': { id: "x", email: "y" } } },
    },
    forgejo: {
      "factory-mutation/starter|head:main": "a".repeat(40),
      "factory-mutation/starter|file:package.json": "b".repeat(40),
    },
    openbao: { sealed: false, paths: { "models/c/d": "0123456789abcdef" } },
    objects: { "upgrade-test/fixture.txt": "12:abc" },
  };
}

function copy(value: Fingerprint): Fingerprint {
  return structuredClone(value);
}

test("a namespace belongs to a run only by name and both labels", () => {
  expect(upgradeNamespace(id)).toBe("factory-upgrade-0a1b2c3d");
  expect(upgradeIDFromNamespace("factory-upgrade-0a1b2c3d")).toBe(id);
  expect(upgradeIDFromNamespace("factory-upgrade-0A1B2C3D")).toBeNull();
  expect(() => upgradeNamespace("short")).toThrow();
  expect(() => requireOwnedNamespace(id, upgradeNamespace(id), managed)).not.toThrow();
  expect(() => requireOwnedNamespace(id, upgradeNamespace(id), {})).toThrow("owner label");
  expect(() =>
    requireOwnedNamespace(id, upgradeNamespace(id), { ...managed, [ownerLabel]: "ffffffff" }),
  ).toThrow("owner label");
  expect(() =>
    requireOwnedNamespace(id, upgradeNamespace(id), {
      ...managed,
      "app.kubernetes.io/managed-by": "Helm",
    }),
  ).toThrow("owner label");
  expect(() => requireOwnedNamespace(id, "factory-upgrade-ffffffff", managed)).toThrow(
    "not the namespace",
  );
});

test("retained installations, workers and editors are never owned", () => {
  for (const name of [
    "factory-acme-sized-20261103",
    "factory-box-0123456789ab",
    "factory-editor-abc",
    "factory",
    "default",
    "kube-system",
    "factory-upgrade-xyz",
  ]) {
    expect(protectedNamespace(name)).toBe(true);
    expect(() => requireOwnedNamespace(id, name, managed)).toThrow();
  }
  expect(protectedNamespace("factory-upgrade-0a1b2c3d")).toBe(false);
});

test("claims split into this run's, unlabelled chart claims and another run's", () => {
  const result = claimOwnership(id, "factory-upgrade-0a1b2c3d", [
    { name: "factory-state", namespace: "factory-upgrade-0a1b2c3d", labels: { [ownerLabel]: id } },
    { name: "data-factory-postgres-0", namespace: "factory-upgrade-0a1b2c3d", labels: {} },
    { name: "other", namespace: "factory-upgrade-0a1b2c3d", labels: { [ownerLabel]: "ffffffff" } },
    { name: "stray", namespace: "elsewhere", labels: { [ownerLabel]: id } },
  ]);
  expect(result.owned).toEqual(["factory-state"]);
  expect(result.unlabelled).toEqual(["data-factory-postgres-0"]);
  expect(result.foreign).toEqual(["elsewhere/stray", "other"]);
});

test("only volumes bound to this run's claims are listed for removal", () => {
  const volumes = [
    { name: "pv-a", claimNamespace: "factory-upgrade-0a1b2c3d", claimName: "factory-state" },
    { name: "pv-b", claimNamespace: "factory", claimName: "factory-state" },
    { name: "pv-c", claimNamespace: "factory-upgrade-0a1b2c3d", claimName: "unrelated" },
    { name: "pv-d" },
  ];
  expect(ownedVolumes("factory-upgrade-0a1b2c3d", ["factory-state"], volumes)).toEqual(["pv-a"]);
});

test("a worker or editor namespace that appears during the run is reported", () => {
  expect(
    newRuntimeNamespaces(
      ["factory", "factory-box-aaaaaaaaaaaa"],
      [
        "factory",
        "factory-box-aaaaaaaaaaaa",
        "factory-box-bbbbbbbbbbbb",
        "factory-editor-cccc",
        "other",
      ],
    ),
  ).toEqual(["factory-box-bbbbbbbbbbbb", "factory-editor-cccc"]);
});

test("options need both builds and a node, and a chart can come from a commit", () => {
  const parsed = parseOptions([
    "--from-chart",
    "git:7b339b88",
    "--from-image",
    "open-software-factory:release-7b339b88",
    "--to-chart",
    "deploy/helm/factory",
    "--to-image",
    "open-software-factory:release-new",
    "--node",
    "orbstack",
    "--values",
    "private.yaml",
    "--allow",
    "row:factory.usage_*",
    "--keep",
  ]);
  expect(parsed.fromChart).toEqual({ kind: "git", commit: "7b339b88" });
  expect(parsed.toChart).toEqual({ kind: "path", path: "deploy/helm/factory" });
  expect(parsed.values).toEqual(["private.yaml"]);
  expect(parsed.keep).toBe(true);
  expect(() => parseOptions(["--node", "orbstack"])).toThrow("--from-chart is required");
  expect(() => parseOptions(["--bogus", "x"])).toThrow("Unknown option");
  expect(() => parseOptions(["--node"])).toThrow("needs a value");
  expect(() => parseChartSource("git:not-a-commit")).toThrow();
  expect(parseOptions(["--cleanup", "factory-upgrade-0a1b2c3d"]).cleanup).toBe(
    "factory-upgrade-0a1b2c3d",
  );
  expect(() => parseOptions(["--cleanup", "factory-box-0a1b2c3d4e5f"])).toThrow(
    "not an upgrade test namespace",
  );
});

test("generated values start no worker, no backup and no ingress, and use the run's ports", () => {
  const values = upgradeValues({ node: "orbstack", ports: { factory: 1, forgejo: 2, zero: 3 } });
  expect(values.executionReserveTarget).toBe(0);
  expect(values.backup.enabled).toBe(false);
  expect(values.ingress.enabled).toBe(false);
  expect(values.publicURL).toBe("http://127.0.0.1:1");
  expect(values.forgejoPublicURL).toBe("http://127.0.0.1:2");
  expect(values.developmentZeroURL).toBe("http://127.0.0.1:3");
  expect(values.factorybox.nodeName).toBe("orbstack");
  expect(values.existingSecrets.credentials).toBe("");
});

test("the memory plan says what is free and which namespaces hold the most", () => {
  const pod = (namespace: string, memory: string) => ({
    metadata: { namespace },
    status: { phase: "Running" },
    spec: { containers: [{ resources: { requests: { memory } } }] },
  });
  const pods = [pod("big", "6Gi"), pod("small", "512Mi"), pod("small", "512Mi")];
  const tight = memoryPlan("7Gi", pods);
  expect(tight.requestedMiB).toBe(7168);
  expect(tight.fits).toBe(false);
  expect(tight.largest[0]).toEqual({ namespace: "big", requestedMiB: 6144 });
  expect(tight.advice).toContain("big (6144 MiB)");
  expect(tight.advice).toContain("never stops anything");
  const roomy = memoryPlan(`${upgradeMemoryNeedMiB() + 8192}Mi`, pods);
  expect(roomy.fits).toBe(true);
  const finished = memoryPlan("2Gi", [{ ...pod("done", "2Gi"), status: { phase: "Succeeded" } }]);
  expect(finished.requestedMiB).toBe(0);
});

test("a table digest ignores row and column order and changes with any value", () => {
  const a = { columns: ["a", "b"], rows: { r1: { a: "1", b: "2" }, r2: { a: "3", b: "4" } } };
  const reordered = {
    columns: ["b", "a"],
    rows: { r2: { b: "4", a: "3" }, r1: { b: "2", a: "1" } },
  };
  const changed = { columns: ["a", "b"], rows: { r1: { a: "1", b: "2" }, r2: { a: "3", b: "5" } } };
  const fewer = { columns: ["a", "b"], rows: { r1: { a: "1", b: "2" } } };
  expect(tableDigest(a)).toBe(tableDigest(reordered));
  expect(tableDigest(a)).not.toBe(tableDigest(changed));
  expect(tableDigest(a)).not.toBe(tableDigest(fewer));
  expect(tableDigest(a)).toMatch(/^[0-9a-f]{32}$/);
});

test("the summary counts rows and digests every table", () => {
  const summary = summarize(fingerprint());
  expect(summary.tables["factory.ticket"]?.rows).toBe(2);
  expect(summary.totalRows).toBe(3);
  expect(summary.forgejo).toEqual({ repositories: 1, entries: 2 });
  expect(summary.openbao).toEqual({ sealed: false, paths: 1 });
  expect(summary.objects).toBe(1);
});

test("volatile columns are the timestamps a running Factory refreshes", () => {
  for (const column of ["updated_at", "updatedAt", "last_seen_at", "lease_owner", "observed_at"])
    expect(isVolatileColumn(column)).toBe(true);
  for (const column of ["created_at", "title", "state", "expires_at"])
    expect(isVolatileColumn(column)).toBe(false);
  expect(isVolatileColumn("state", ["state"])).toBe(true);
});

test("the row statement hashes cells in the database and quotes every name", () => {
  const sql = rowFingerprintSQL(
    {
      name: "auth.oauthClient",
      columns: ["id", "secret", "updatedAt"],
      primaryKey: ["id"],
    },
    ["secret"],
  );
  expect(sql).toContain('FROM "auth"."oauthClient" t');
  expect(sql).toContain("ARRAY['secret', 'updatedAt']::text[]");
  expect(sql).toContain('jsonb_build_array(t."id")');
  expect(sql).toContain("left(md5(e.value::text), 12)");
  expect(() =>
    rowFingerprintSQL({ name: "factory.bad;drop", columns: [], primaryKey: [] }),
  ).toThrow("Unsafe identifier");
  expect(rowFingerprintSQL({ name: "factory.keyless", columns: ["a"], primaryKey: [] })).toContain(
    "md5((to_jsonb(t)",
  );
  expect(catalogSQL).toContain("pg_class");
});

test("row output parses into tables and refuses an unknown one", () => {
  const tables = [{ name: "factory.ticket", columns: ["id", "updated_at"], primaryKey: ["id"] }];
  const parsed = parseRowLines(
    ["BEGIN", '["factory.ticket","[\\"t1\\"]",{"id":"aa"}]', "COMMIT"].join("\n"),
    tables,
  );
  expect(parsed["factory.ticket"]?.rows['["t1"]']).toEqual({ id: "aa" });
  expect(parsed["factory.ticket"]?.columns).toEqual(["id"]);
  expect(() => parseRowLines('["other","k",{}]', tables)).toThrow("Unexpected table");
});

test("an identical fingerprint has no findings", () => {
  const diff = diffFingerprints(fingerprint(), fingerprint(), noopRules);
  expect(diff).toEqual({ ok: true, violations: [], allowed: [] });
});

test("a removed or changed row, repository file, secret or object is refused", () => {
  const after = copy(fingerprint());
  delete after.tables["factory.ticket"]?.rows['["t1"]'];
  const t2 = after.tables["factory.ticket"]?.rows['["t2"]'];
  if (t2) t2["title"] = "changed";
  after.forgejo["factory-mutation/starter|head:main"] = "c".repeat(40);
  delete after.forgejo["factory-mutation/starter|file:package.json"];
  after.openbao.paths["models/c/d"] = "ffffffffffffffff";
  delete after.objects["upgrade-test/fixture.txt"];
  const diff = diffFingerprints(fingerprint(), after, upgradeRules());
  expect(diff.ok).toBe(false);
  const lines = diff.violations.map((finding) => `${finding.kind} ${finding.id}`);
  expect(lines).toContain("removed row:factory.ticket");
  expect(lines).toContain("changed row:factory.ticket");
  expect(lines).toContain("changed forgejo:factory-mutation/starter");
  expect(lines).toContain("removed forgejo:factory-mutation/starter");
  expect(lines).toContain("changed openbao:models/c/d");
  expect(lines).toContain("removed object:upgrade-test/fixture.txt");
  const text = formatDiff("upgrade", diff);
  expect(text).toContain("6 refused");
  expect(text).toContain('factory.ticket#["t1"]');
  expect(text).toContain("(b2 -> changed)");
});

test("a changed digest names the table, the row and the column", () => {
  const after = copy(fingerprint());
  const user = after.tables["auth.user"]?.rows['["u1"]'];
  if (user) user["email"] = "z";
  const diff = diffFingerprints(fingerprint(), after, upgradeRules());
  expect(diff.violations).toEqual([
    {
      id: "row:auth.user",
      kind: "changed",
      key: 'auth.user#["u1"].email',
      before: "y",
      after: "z",
    },
  ]);
});

test("new migrations, tables and columns are allowed on upgrade and refused when nothing may change", () => {
  const after = copy(fingerprint());
  after.migrations = [1, 2, 3, 4];
  after.tables["factory.new_thing"] = { columns: ["id"], rows: { '["n1"]': { id: "q" } } };
  const ticket = after.tables["factory.ticket"];
  if (ticket) {
    ticket.columns.push("priority");
    for (const row of Object.values(ticket.rows)) row["priority"] = "p";
  }
  const upgrade = diffFingerprints(fingerprint(), after, upgradeRules());
  expect(upgrade.ok).toBe(true);
  expect(upgrade.allowed.map((finding) => `${finding.kind} ${finding.id}`)).toEqual([
    "added migration",
    "added column:factory.ticket.priority",
    "added table:factory.new_thing",
    "added row:factory.new_thing",
  ]);
  const noop = diffFingerprints(fingerprint(), after, noopRules);
  expect(noop.ok).toBe(false);
  expect(noop.violations).toHaveLength(4);
});

test("a new row in an old table needs an explicit allowance", () => {
  const after = copy(fingerprint());
  const ticket = after.tables["factory.ticket"];
  if (ticket) ticket.rows['["t3"]'] = { id: "a3", title: "b3", state: "c3" };
  const refused = diffFingerprints(fingerprint(), after, upgradeRules());
  expect(refused.ok).toBe(false);
  expect(refused.violations[0]).toMatchObject({ kind: "added", id: "row:factory.ticket" });
  expect(diffFingerprints(fingerprint(), after, upgradeRules(["row:factory.ticket"])).ok).toBe(
    true,
  );
  expect(diffFingerprints(fingerprint(), after, upgradeRules(["row:factory.*"])).ok).toBe(true);
  expect(diffFingerprints(fingerprint(), after, upgradeRules(["row:auth.*"])).ok).toBe(false);
  // The second upgrade accepts no allowance at all.
  expect(diffFingerprints(fingerprint(), after, { ...noopRules, allow: [] }).ok).toBe(false);
});

test("a removed table, a removed column and a removed migration are refused", () => {
  const after = copy(fingerprint());
  delete after.tables["auth.user"];
  after.tables["factory.ticket"] = {
    columns: ["id", "title"],
    rows: after.tables["factory.ticket"]?.rows ?? {},
  };
  after.migrations = [1, 3];
  const diff = diffFingerprints(fingerprint(), after, upgradeRules());
  const lines = diff.violations.map((finding) => `${finding.kind} ${finding.id}`);
  expect(lines).toContain("removed table:auth.user");
  expect(lines).toContain("removed column:factory.ticket.state");
  expect(lines).toContain("removed migration");
  expect(lines).toContain("changed migration");
});

test("a seal or an unreadable secret is not hidden by matching digests", () => {
  const sealed = copy(fingerprint());
  sealed.openbao.sealed = true;
  expect(diffFingerprints(fingerprint(), sealed, upgradeRules()).violations[0]?.id).toBe(
    "openbao:sealed",
  );
  const broken = copy(fingerprint());
  broken.openbao.paths["models/c/d"] = "unreadable";
  expect(unreadableSecrets(broken)).toEqual(["models/c/d"]);
  expect(unreadableSecrets(fingerprint())).toEqual([]);
});

test("globs match whole names with a star", () => {
  expect(globMatches("row:factory.*", "row:factory.ticket")).toBe(true);
  expect(globMatches("row:factory.ticket", "row:factory.ticket_x")).toBe(false);
  expect(globMatches("row:factory.t.cket", "row:factory.ticket")).toBe(false);
  expect(globMatches("*", "anything")).toBe(true);
});

test("seed SQL escapes text and refuses malformed identities", () => {
  const input = {
    adminID: crypto.randomUUID(),
    projectID: crypto.randomUUID(),
    slug: "upgrade-starter",
    name: "It's a project",
    repositoryURL:
      "http://factory-forgejo.factory-upgrade-0a1b2c3d.svc:3000/factory-mutation/x.git",
    commitSha: "a".repeat(40),
    tickets: [
      {
        id: crypto.randomUUID(),
        title: "Backlog '; DROP TABLE x; --",
        description: "",
        state: "backlog",
      },
    ],
    wiki: {
      pageID: crypto.randomUUID(),
      slug: "upgrade-notes",
      title: "Upgrade notes",
      first: "First",
      second: "Second",
    },
    revisionIDs: [crypto.randomUUID(), crypto.randomUUID()] as [string, string],
    model: {
      connectionID: crypto.randomUUID(),
      commandID: crypto.randomUUID(),
      secretKey: "models/a/b",
      fingerprint: "b".repeat(64),
    },
  };
  const sql = seedSQL(input);
  expect(sql).toStartWith("BEGIN;");
  expect(sql).toEndWith("COMMIT;");
  expect(sql).toContain("'It''s a project'");
  expect(sql).toContain("'Backlog ''; DROP TABLE x; --'");
  expect(sql.match(/INSERT INTO factory\.knowledge_revision/g)).toHaveLength(2);
  expect(() => seedSQL({ ...input, commitSha: "nope" })).toThrow("40 hex");
  expect(() => seedSQL({ ...input, adminID: "not-a-uuid" })).toThrow("not a UUID");
  expect(() =>
    seedSQL({ ...input, tickets: [{ ...input.tickets[0], state: "bogus" } as never] }),
  ).toThrow("Unknown Ticket state");
  expect(sqlLiteral("a'b")).toBe("'a''b'");
  expect(() => sqlLiteral("a\0b")).toThrow();
  const assign = assignmentSQL({
    ticketID: crypto.randomUUID(),
    userID: crypto.randomUUID(),
    actorID: crypto.randomUUID(),
    eventID: crypto.randomUUID(),
  });
  expect(assign).toContain("factory.ticket_responsibility_event");
});

test("the secret script quotes its inputs and prints digests, never values", () => {
  const script = secretReadScript({ roleID: "role'id", secretID: "secret" }, ["models/a/b"]);
  expect(script).toContain("role_id='role'\"'\"'id'");
  expect(script).toContain("bao kv get -mount=factory -field=data 'models/a/b'");
  expect(script).toContain("sha256sum");
  expect(parsePaths("models/a/b|0123456789abcdef\nmodels/c|unreadable\n")).toEqual({
    "models/a/b": "0123456789abcdef",
    "models/c": "unreadable",
  });
  expect(() => parsePaths("garbage")).toThrow("Unexpected row");
});

test("console messages match ignore patterns and everything else counts", () => {
  expect(unexpectedConsole(["error: boom", "error: favicon.ico 404"], ["favicon"])).toEqual([
    "error: boom",
  ]);
  expect(unexpectedConsole([], [])).toEqual([]);
});

test("the secret write script keeps the payload in a here-document", () => {
  const script = secretWriteScript({ roleID: "r", secretID: "s" }, "models/a/b", '{"apiKey":"x"}');
  expect(script).toContain("bao kv put -mount=factory 'models/a/b' - >/dev/null <<'JSON'");
  expect(script).toContain('\n{"apiKey":"x"}\nJSON\n');
  expect(() => secretWriteScript({ roleID: "r", secretID: "s" }, "k", "a\nJSON\nb")).toThrow(
    "terminator",
  );
});
