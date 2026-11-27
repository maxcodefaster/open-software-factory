import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { renderSubstrateTemplate, substrateBootstrapCA } from "./substrate-template";

function fixture() {
  const project = parseSubstrateProjectTemplate(
    JSON.stringify({
      containers: [
        {
          name: "work",
          image: `registry.test/project@sha256:${"a".repeat(64)}`,
          command: ["/bin/sh", "-ec"],
          args: ["printf '%s\\n' \"$MODE\"; ./prepare", "--", "two words"],
          env: [
            { name: "MODE", value: `literal \${NOT_EXPANDED}` },
            { name: "EMPTY", value: "" },
          ],
          volumeMounts: [
            { name: "source", mountPath: "/workspaces/monorepo" },
            { name: "work-cache", mountPath: "/home/project/.cache" },
          ],
        },
        {
          name: "database",
          image: `registry.test/postgres@sha256:${"b".repeat(64)}`,
          command: ["/usr/local/bin/docker-entrypoint.sh", "postgres"],
          args: ["-c", "log_line_prefix=%m [%p] ", "-c", "port=15432"],
          env: [{ name: "PGDATA", value: "/var/lib/postgresql/data" }],
          volumeMounts: [{ name: "database", mountPath: "/var/lib/postgresql/data" }],
          wakeupProbe: {
            httpGet: { path: "/ready", port: 15433 },
            timeoutSeconds: 120,
          },
        },
        {
          name: "cache",
          image: `registry.test/cache@sha256:${"c".repeat(64)}`,
          command: ["/usr/local/bin/cache-server", "--no-daemon"],
        },
      ],
      volumes: [
        { name: "source", durableDir: {} },
        { name: "work-cache", durableDir: {} },
        { name: "database", durableDir: {} },
      ],
    }),
  );
  const config = {
    workloadImage: `registry.test/factory@sha256:${"f".repeat(64)}`,
    workerSelector: { "factory.dev/deployment": "owned", "kubernetes.io/arch": "arm64" },
  };
  const bootstrap = {
    sourceHandoff: true,
    inputStop: { version: 1, openCodeVersion: "2.3.2" },
    projectTemplate: { path: ".factory/actor-template.json", sha256: "d".repeat(64) },
    assignment: {
      version: 1,
      runtimeAttemptId: "owned-attempt",
      generation: 3,
      workspaceFolder: "/old/control/project",
      remoteWorkspaceFolder: "/old/project",
      checkoutFolder: "/old/checkout",
      connectorStateDir: "/old/connector",
      repositoryUrl: "https://factory.test/internal/runtime-source/owned/repository-capability",
      repositoryIdentity: "owned-project",
      revision: "owned-revision",
      preserveWorkspace: true,
      actorTemplatePath: ".factory/actor-template.json",
      controlUrl: "wss://factory.test/internal/runtime-connector",
      environmentVersion: 7,
      channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
      processes: [{ name: "app", command: ["/bin/sh", "-c", "start-app"] }],
    },
    source: {
      workspaceId: "owned-workspace",
      projectId: "owned-project",
      revision: "owned-revision",
      repositoryUrl: "https://factory.test/internal/runtime-source/owned/repository-capability",
      originUrl: "https://factory.test/internal/runtime-source/owned/repository-capability",
      branch: "main",
    },
    parentToken: "parent-capability",
    childToken: "child-capability",
    factoryCA: "-----BEGIN CERTIFICATE-----\nfactory-public-ca\n-----END CERTIFICATE-----\n",
    entryTokens: {
      work: "work-entry-capability",
      database: "database-entry-capability",
      cache: "cache-entry-capability",
    } as Record<string, string>,
  };
  return { project, config, bootstrap };
}

type Template = ReturnType<typeof renderSubstrateTemplate>;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function render(f = fixture()) {
  return renderSubstrateTemplate("owned", f.config, f.bootstrap, f.project);
}

function container(template: Template, name: string) {
  const found = template.containers.find((item) => item.name === name);
  if (!found) throw new Error(`Missing rendered container: ${name}`);
  return found;
}

function payload(template: Template, name: string) {
  const key = name === "factory-control" ? "FACTORY_SUBSTRATE_BOOTSTRAP" : "FACTORY_NATIVE_PROJECT";
  const env = container(template, name).env.find((variable) => variable.name === key);
  if (!env) throw new Error(`Missing bootstrap environment: ${name}`);
  return JSON.parse(env.value) as Record<string, unknown>;
}

describe("native Actor template rendering", () => {
  test("runs trusted control and digest-pinned Project containers directly", () => {
    const f = fixture();
    const template = render(f);
    expect(template.metadata).toEqual({ atespace: "owned", name: "runtime" });
    expect(template.containers.map(({ name }) => name)).toEqual([
      "factory-control",
      "work",
      "database",
      "cache",
    ]);
    expect(container(template, "factory-control")).toMatchObject({
      image: f.config.workloadImage,
      command: ["/usr/local/bin/factory-runtime-connector", "native-parent"],
      wakeupProbe: { httpGet: { path: "/readyz", port: 18081 }, timeoutSeconds: 300 },
      securityContext: {
        capabilities: {
          drop: ["ALL"],
          add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"],
        },
      },
    });
    for (const project of f.project.containers) {
      const actual = container(template, project.name);
      expect(actual.image).toBe(project.image);
      expect(actual.command).toEqual([
        "/opt/factory-tools/usr/local/bin/factory-runtime-connector",
        "native-project",
      ]);
      expect(actual).not.toHaveProperty("args");
      expect(actual.securityContext).toEqual({ capabilities: { drop: ["ALL"] } });
      expect(actual.wakeupProbe).toEqual(project.wakeupProbe);
    }
    expect(JSON.stringify(template)).not.toContain("factory-rootless");
    expect(JSON.stringify(template)).not.toContain("/home/rootless");
  });

  test("keeps the full Work Assignment and child token in their exact native wire fields", () => {
    const f = fixture();
    const template = render(f);
    expect(payload(template, "work")).toEqual({
      container: "work",
      entryToken: f.bootstrap.entryTokens["work"],
      factoryCA: f.bootstrap.factoryCA,
      assignment: {
        ...f.bootstrap.assignment,
        workspaceFolder: "/workspaces/monorepo/project",
        remoteWorkspaceFolder: "/workspaces/monorepo/project",
        checkoutFolder: "/workspaces/monorepo/project",
        connectorStateDir: "/tmp/factory-connector",
      },
      childToken: f.bootstrap.childToken,
      preparation: {
        command: ["/bin/sh", "-ec", "printf '%s\\n' \"$MODE\"; ./prepare", "--", "two words"],
      },
    });
    expect(payload(template, "work")["assignment"]).not.toHaveProperty("childToken");
    expect(payload(template, "work")).not.toHaveProperty("command");
    const { entryTokens, ...controlBootstrap } = f.bootstrap;
    expect(payload(template, "factory-control")).toEqual({
      ...controlBootstrap,
      assignment: {
        ...f.bootstrap.assignment,
        workspaceFolder: "/var/lib/factory/source/project",
        remoteWorkspaceFolder: "/var/lib/factory/source/project",
        checkoutFolder: "/var/lib/factory/source/project",
        connectorStateDir: "/var/lib/factory/control",
      },
    });
    const controlWire = JSON.stringify(payload(template, "factory-control"));
    expect(controlWire).not.toContain("entryTokens");
    for (const token of Object.values(entryTokens)) expect(controlWire).not.toContain(token);
  });

  test("omits Work preparation when the Project has not declared a command", () => {
    const f = fixture();
    delete required(f.project.containers[0]).command;
    delete required(f.project.containers[0]).args;
    expect(payload(render(f), "work")).not.toHaveProperty("preparation");
    expect(payload(render(f), "work")).not.toHaveProperty("command");
  });

  test.each(["database", "cache"])(
    "%s receives only its own entry capability, minimal pinned identity and exact service argv",
    (name) => {
      const f = fixture();
      const project = required(f.project.containers.find((item) => item.name === name));
      const wire = payload(render(f), name);
      expect(wire).toEqual({
        container: name,
        entryToken: f.bootstrap.entryTokens[name],
        factoryCA: f.bootstrap.factoryCA,
        assignment: {
          version: 1,
          runtimeAttemptId: "owned-attempt",
          generation: 3,
          controlUrl: f.bootstrap.assignment.controlUrl,
          environmentVersion: 7,
        },
        command: [...required(project.command), ...(project.args ?? [])],
      });
      const serialized = JSON.stringify(wire);
      for (const secret of [
        f.bootstrap.parentToken,
        f.bootstrap.childToken,
        f.bootstrap.assignment.repositoryUrl,
        f.bootstrap.source.workspaceId,
        ...Object.entries(f.bootstrap.entryTokens)
          .filter(([container]) => container !== name)
          .map(([, token]) => token),
      ])
        expect(serialized).not.toContain(secret);
      expect(wire).not.toHaveProperty("preparation");
    },
  );

  test("Work never receives Parent authority, Source admission or any service entry token", () => {
    const f = fixture();
    const work = payload(render(f), "work");
    for (const key of ["parentToken", "source", "sourceHandoff", "inputStop", "entryTokens"])
      expect(work).not.toHaveProperty(key);
    const serialized = JSON.stringify(work);
    for (const secret of [
      f.bootstrap.parentToken,
      required(f.bootstrap.entryTokens["database"]),
      required(f.bootstrap.entryTokens["cache"]),
    ])
      expect(serialized).not.toContain(secret);
  });

  test.each(["/workspaces/monorepo", "/checkout", "/project"])(
    "keeps Source mount %s distinct from its actual project checkout",
    (mountPath) => {
      const f = fixture();
      required(required(f.project.containers[0]).volumeMounts?.[0]).mountPath = mountPath;
      const template = render(f);
      expect(container(template, "work").volumeMounts).toContainEqual({
        name: "source",
        mountPath,
      });
      expect(payload(template, "work")["assignment"]).toMatchObject({
        workspaceFolder: `${mountPath}/project`,
        remoteWorkspaceFolder: `${mountPath}/project`,
      });
      expect(container(template, "factory-control").volumeMounts).toContainEqual({
        name: "source",
        mountPath: "/var/lib/factory/source",
      });
      expect(template.volumes.filter(({ name }) => name === "source")).toEqual([
        { name: "source", durableDir: {} },
      ]);
    },
  );

  test("shares public trust/tools, but only Work reads admitted Skills and control state stays private", () => {
    const f = fixture();
    const template = render(f);
    expect(template.volumes).toEqual([
      ...f.project.volumes,
      { name: "factory-state", durableDir: {} },
      { name: "factory-public", durableDir: {} },
      { name: "factory-skills", durableDir: {} },
      { name: "factory-tools", image: { reference: f.config.workloadImage } },
      {
        name: "factory-trust",
        systemInfo: {
          dataSources: [
            {
              trustBundle: {
                names: ["egress-mitm.ate.dev", "system-roots.ate.dev"],
                path: "trust-bundle.pem",
              },
            },
          ],
        },
      },
      {
        name: "factory-identity",
        systemInfo: {
          dataSources: [
            { actorMetadata: { items: [{ field: "ACTOR_METADATA_FIELD_UID", path: "uid" }] } },
          ],
        },
      },
    ]);
    for (const actual of template.containers) {
      expect(actual.volumeMounts).toContainEqual({
        name: "factory-public",
        mountPath: "/run/factory-public",
      });
      expect(actual.volumeMounts).toContainEqual({
        name: "factory-trust",
        mountPath: "/run/ate/egress-trust-bundle",
      });
      expect(actual.volumeMounts).toContainEqual({
        name: "factory-identity",
        mountPath: "/run/ate/identity",
      });
      expect(new Set(actual.volumeMounts.map(({ name }) => name)).size).toBe(
        actual.volumeMounts.length,
      );
      if (actual.name === "factory-control") {
        expect(actual.volumeMounts).toContainEqual({
          name: "factory-state",
          mountPath: "/var/lib/factory/control",
        });
        expect(actual.volumeMounts).toContainEqual({
          name: "factory-skills",
          mountPath: "/var/lib/factory/skills",
        });
        continue;
      }
      const original = required(f.project.containers.find(({ name }) => name === actual.name));
      for (const mount of original.volumeMounts ?? [])
        expect(actual.volumeMounts).toContainEqual(mount);
      expect(actual.volumeMounts).toContainEqual({
        name: "factory-tools",
        mountPath: "/opt/factory-tools",
      });
      expect(actual.volumeMounts.some(({ name }) => name === "factory-state")).toBe(false);
      expect(actual.volumeMounts.some(({ mountPath }) => mountPath.includes("/control"))).toBe(
        false,
      );
      expect(actual.env.some(({ name }) => name === "FACTORY_SUBSTRATE_BOOTSTRAP")).toBe(false);
      if (actual.name === "work")
        expect(actual.volumeMounts).toContainEqual({
          name: "factory-skills",
          mountPath: "/run/factory-skills",
        });
      else expect(actual.volumeMounts.some(({ name }) => name === "factory-skills")).toBe(false);
      if (actual.name !== "work")
        for (const name of ["source", "work-cache"])
          expect(actual.volumeMounts.some((mount) => mount.name === name)).toBe(false);
    }
    const publicVolume = template.volumes.find(({ name }) => name === "factory-public");
    for (const token of [
      f.bootstrap.parentToken,
      f.bootstrap.childToken,
      ...Object.values(f.bootstrap.entryTokens),
    ])
      expect(JSON.stringify(publicVolume)).not.toContain(token);
  });

  test("preserves literal Project env and pins Factory transport to the root-owned public trust path", () => {
    const f = fixture();
    // Admission also rejects reserved env; the renderer never lets it replace
    // the fixed native-project trust input or inject duplicate bootstrap keys.
    for (const project of f.project.containers)
      project.env = [
        ...(project.env ?? []),
        { name: "FACTORY_NATIVE_PROJECT", value: "not-an-entry-capability" },
        { name: "SSL_CERT_FILE", value: "/tmp/project-ca.pem" },
        { name: "GIT_SSL_CAINFO", value: "/tmp/project-ca.pem" },
        { name: "NODE_EXTRA_CA_CERTS", value: "/tmp/project-ca.pem" },
      ];
    const template = render(f);
    for (const project of f.project.containers) {
      const actual = container(template, project.name);
      for (const literal of required(project.env).slice(0, -4))
        expect(actual.env).toContainEqual(literal);
      for (const name of ["SSL_CERT_FILE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"])
        expect(actual.env.filter((variable) => variable.name === name)).toEqual([
          { name, value: "/run/factory-public/trust.pem" },
        ]);
      expect(actual.env.filter(({ name }) => name === "FACTORY_NATIVE_PROJECT")).toHaveLength(1);
      expect(JSON.stringify(actual)).not.toContain("/tmp/project-ca.pem");
      expect(actual.securityContext.capabilities).toEqual({ drop: ["ALL"] });
      expect(payload(template, project.name)).not.toHaveProperty("caFile");
    }
  });

  test("retains standard resources and placement, prefers MEMORY and disables golden snapshots", () => {
    const f = fixture();
    expect(f.project).not.toHaveProperty("snapshotConfig");
    const template = render(f);
    expect(template.resources.limits).toEqual({
      cpuMillicores: "1500",
      memoryBytes: "1073741824",
    });
    expect(template.workerSelector).toEqual({ matchLabels: f.config.workerSelector });
    expect(template.snapshotConfig).toEqual({
      preferredFidelity: "SNAPSHOT_FIDELITY_MEMORY",
      goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
    });
    expect(
      renderSubstrateTemplate(
        "owned",
        { ...f.config, resources: { cpuMilli: 2500, memoryMiB: 4096 } },
        f.bootstrap,
        f.project,
      ).resources.limits,
    ).toEqual({ cpuMillicores: "2500", memoryBytes: "4294967296" });
  });

  test.each(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"] as const)(
    "renders explicit %s exactly, leaving all unrelated native spec and inputs unchanged",
    (preferredFidelity) => {
      const f = fixture();
      const defaultTemplate = render(f);
      f.project = parseSubstrateProjectTemplate(
        JSON.stringify({ ...f.project, snapshotConfig: { preferredFidelity } }),
      );
      const before = structuredClone(f);
      const template = render(f);
      expect(template.snapshotConfig).toStrictEqual({
        preferredFidelity,
        goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
      });
      expect(template).toStrictEqual({
        ...defaultTemplate,
        snapshotConfig: {
          preferredFidelity,
          goldenSnapshotConfig: { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" },
        },
      });
      expect(f).toStrictEqual(before);
    },
  );

  test.each(["work", "database", "cache"])("fails closed without the %s entry token", (name) => {
    const f = fixture();
    delete f.bootstrap.entryTokens[name];
    expect(() => render(f)).toThrow(`Native Project entry token is missing: ${name}`);
    f.bootstrap.entryTokens[name] = "";
    expect(() => render(f)).toThrow(`Native Project entry token is missing: ${name}`);
  });

  test.each(["factory-state", "factory-public", "factory-skills"])(
    "never aliases Project data with the Factory-owned %s volume",
    (name) => {
      const f = fixture();
      f.project.volumes.push({ name, durableDir: {} });
      expect(() => render(f)).toThrow("belong to Factory control");
    },
  );

  test.each([
    "/opt/factory-tools",
    "/opt/factory-tools/usr",
    "/run/factory-public",
    "/run/factory-public/trust.pem",
    "/run/factory-skills",
    "/run/factory-skills/admitted",
  ])("rejects Project mounts shadowing %s", (mountPath) => {
    const f = fixture();
    required(required(f.project.containers[0]).volumeMounts?.[0]).mountPath = mountPath;
    expect(() => render(f)).toThrow("must not overlap Factory");
  });

  test("renders deterministically from frozen inputs without mutating or aliasing them", () => {
    const f = fixture();
    const before = structuredClone(f);
    function freeze(value: unknown) {
      if (value === null || typeof value !== "object") return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    freeze(f);
    const first = render(f);
    expect(first).toEqual(render(f));
    expect(f).toEqual(before);
    first.workerSelector.matchLabels["kubernetes.io/arch"] = "changed";
    required(container(first, "work").env.find(({ name }) => name === "MODE")).value = "changed";
    required(container(first, "work").volumeMounts[0]).mountPath = "/changed";
    required(container(first, "database").wakeupProbe).httpGet.path = "/changed";
    const source = required(first.volumes.find(({ name }) => name === "source"));
    if (!("durableDir" in source)) throw new Error("Missing Source durable directory");
    Object.assign(source.durableDir, { changed: true });
    required(
      container(first, "work").volumeMounts.find(({ name }) => name === "factory-public"),
    ).mountPath = "/changed";
    expect(container(first, "cache").volumeMounts).toContainEqual({
      name: "factory-public",
      mountPath: "/run/factory-public",
    });
    expect(f).toEqual(before);
    expect(render(f)).not.toEqual(first);
  });
});

test("substrateBootstrapCA retains exact public CA behavior without admitting private keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-template-trust-"));
  const previous = process.env["FACTORY_REGISTRY_CA_FILE"];
  try {
    const factoryCA = "\n-----BEGIN CERTIFICATE-----\nfactory-ca\n-----END CERTIFICATE-----\n\n";
    const registryCA = "-----BEGIN CERTIFICATE-----\nregistry-ca\n-----END CERTIFICATE-----\n";
    const factoryFile = join(directory, "factory.pem");
    const registryFile = join(directory, "registry.pem");
    writeFileSync(factoryFile, factoryCA);
    writeFileSync(registryFile, factoryCA.trim());
    for (const file of [
      undefined,
      "/etc/ssl/certs/ca-certificates.crt",
      factoryFile,
      registryFile,
    ]) {
      if (file === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
      else process.env["FACTORY_REGISTRY_CA_FILE"] = file;
      expect(substrateBootstrapCA(factoryFile)).toBe(factoryCA);
    }
    process.env["FACTORY_REGISTRY_CA_FILE"] = registryFile;
    writeFileSync(registryFile, registryCA);
    expect(substrateBootstrapCA(factoryFile)).toBe(`${factoryCA.trimEnd()}\n${registryCA}`);
    for (const kind of [
      "PRIVATE KEY",
      "RSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "OPENSSH PRIVATE KEY",
    ]) {
      writeFileSync(registryFile, `${registryCA}-----BEGIN ${kind}-----\nnot-public`);
      expect(() => substrateBootstrapCA(factoryFile)).toThrow("public certificates only");
    }
    writeFileSync(registryFile, "not a certificate");
    expect(() => substrateBootstrapCA(factoryFile)).toThrow("public certificates only");
    process.env["FACTORY_REGISTRY_CA_FILE"] = join(directory, "missing.pem");
    expect(() => substrateBootstrapCA(factoryFile)).toThrow();
    delete process.env["FACTORY_REGISTRY_CA_FILE"];
    writeFileSync(factoryFile, `${factoryCA}-----BEGIN PRIVATE KEY-----\nnot-public`);
    expect(() => substrateBootstrapCA(factoryFile)).toThrow("public certificates only");
  } finally {
    if (previous === undefined) delete process.env["FACTORY_REGISTRY_CA_FILE"];
    else process.env["FACTORY_REGISTRY_CA_FILE"] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
