import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse, parseAllDocuments } from "yaml";
import upstream from "../../upstream.json";

const chart = "deploy/helm/factory";
const localValues = [
  "--set",
  "image=owned-factory-proof:unit",
  "--set",
  "publicURL=http://127.0.0.1:58000",
  "--set",
  "forgejoPublicURL=http://127.0.0.1:58001",
  "--set",
  "developmentZeroURL=http://127.0.0.1:58002",
  "--set",
  "development=true",
  "--set",
  `factorybox.image=registry.invalid/worker@sha256:${"a".repeat(64)}`,
  "--set",
  `factorybox.executableSHA256=${"b".repeat(64)}`,
  "--set",
  "factorybox.nodeName=owned-node",
  "--set",
  "factorybox.kernel=6.12.0",
  "--set",
  "factorybox.architecture=amd64",
];
async function helm(args: string[]) {
  if (args[0] === "template")
    args.push(
      "--set",
      `factorybox.image=registry.invalid/worker@sha256:${"a".repeat(64)}`,
      "--set",
      `factorybox.executableSHA256=${"b".repeat(64)}`,
      "--set",
      "factorybox.nodeName=owned-node",
      "--set",
      "factorybox.kernel=6.12.0",
    );
  if (args[0] === "template" && !args.some((value) => value.startsWith("factorybox.architecture=")))
    args.push("--set", "factorybox.architecture=amd64");
  const child = Bun.spawn(["helm", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
type Resource = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
  spec?: {
    progressDeadlineSeconds?: number;
    publishNotReadyAddresses?: boolean;
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers: Array<{
          name: string;
          image: string;
          command?: string[];
          args?: string[];
          env?: Array<{ name: string; value?: string }>;
          startupProbe?: {
            exec?: { command: string[] };
            httpGet?: { path: string; port: number };
            periodSeconds: number;
            failureThreshold: number;
            timeoutSeconds?: number;
          };
          readinessProbe?: {
            exec?: { command: string[] };
            tcpSocket?: { port: number };
            httpGet?: { path: string; port: number };
            periodSeconds: number;
            timeoutSeconds: number;
          };
          resources?: {
            requests: Record<string, string>;
            limits: Record<string, string>;
          };
        }>;
        automountServiceAccountToken?: boolean;
        serviceAccountName?: string;
        volumes?: unknown[];
      };
    };
    strategy?: { type: string };
    rules?: Array<{
      host: string;
      http: {
        paths: Array<{
          path: string;
          backend: { service: { name: string; port: { number: number } } };
        }>;
      };
    }>;
    tls?: Array<{ hosts: string[] }>;
  };
  rules?: Array<{ resources?: string[]; verbs?: string[]; apiGroups?: string[] }>;
};
let rendered: Promise<Resource[]> | undefined;
function resources() {
  rendered ??= (async () => {
    const result = await helm([
      "template",
      "portable",
      chart,
      "--namespace",
      "factory-proof",
      ...localValues,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return parseAllDocuments(result.stdout).map((document) => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON() as Resource;
    });
  })();
  return rendered;
}

test("maintenance resources are independently configurable without changing the upgrade fence", async () => {
  const defaultJob = (await resources()).find((resource) => resource.kind === "Job");
  expect(defaultJob?.spec?.template?.spec.containers[0]?.resources).toEqual({
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "1", memory: "256Mi" },
  });
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set-string",
    "maintenance.resources.requests.cpu=10m",
    "--set-string",
    "maintenance.resources.requests.memory=48Mi",
    "--set-string",
    "resources.requests.cpu=200m",
  ]);
  expect(result.exitCode).toBe(0);
  const all = parseAllDocuments(result.stdout).map((document) => document.toJSON() as Resource);
  const job = all.find((resource) => resource.kind === "Job");
  expect(job?.spec?.template?.spec.containers[0]?.resources).toEqual({
    requests: { cpu: "10m", memory: "48Mi" },
    limits: { cpu: "1", memory: "256Mi" },
  });
  expect(job?.spec?.template?.spec.containers[0]?.command).toEqual([
    "bun",
    "scripts/kubernetes/maintenance.ts",
  ]);
  expect(job?.metadata.annotations?.["helm.sh/hook"]).toBe("pre-upgrade");
  expect(job?.spec?.template?.spec.automountServiceAccountToken).toBe(false);
  expect(
    all.find((resource) => resource.kind === "Deployment")?.spec?.template?.spec.containers[0]
      ?.resources?.requests["cpu"],
  ).toBe("200m");
});

test("worker storage capacity is explicit before its immutable first admission", async () => {
  const defaultConfig = (await resources()).find(
    (resource) =>
      resource.kind === "ConfigMap" && resource.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"],
  );
  expect(defaultConfig?.data?.["FACTORY_FACTORYBOX_BOUNDED_BYTES"]).toBe(String(64 * 1024 ** 3));
  expect(defaultConfig?.data?.["FACTORY_FACTORYBOX_MINIMUM_BOUNDED_BYTES"]).toBe(
    String(8 * 1024 ** 3),
  );
  expect(defaultConfig?.data?.["FACTORY_FACTORYBOX_CLAIM_GIB"]).toBe("128");
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "factorybox.storeGiB=24",
    "--set",
    "factorybox.claimGiB=48",
  ]);
  expect(result.exitCode).toBe(0);
  const config = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON() as Resource)
    .find(
      (resource) =>
        resource.kind === "ConfigMap" && resource.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"],
    );
  expect(config?.data?.["FACTORY_FACTORYBOX_BOUNDED_BYTES"]).toBe(String(24 * 1024 ** 3));
  expect(config?.data?.["FACTORY_FACTORYBOX_CLAIM_GIB"]).toBe("48");
  expect(config?.data?.["FACTORY_FACTORYBOX_MINIMUM_BOUNDED_BYTES"]).toBe(String(8 * 1024 ** 3));
});

test.each(["0", "7", "8.5", "65"])(
  "worker rejects an invalid automatic minimum %s",
  async (minimum) => {
    const result = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set-string",
      `factorybox.minimumStoreGiB=${minimum}`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("factorybox.minimumStoreGiB");
  },
);

test("worker chart accepts a larger store with actual claim headroom", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "factorybox.storeGiB=256",
    "--set",
    "factorybox.claimGiB=512",
  ]);
  expect(result.exitCode).toBe(0);
  const config = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON() as Resource)
    .find(
      (resource) =>
        resource.kind === "ConfigMap" && resource.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"],
    );
  expect(config?.data?.["FACTORY_FACTORYBOX_BOUNDED_BYTES"]).toBe(String(256 * 1024 ** 3));
  expect(config?.data?.["FACTORY_FACTORYBOX_CLAIM_GIB"]).toBe("512");
});

test("fresh worker CPU requests are distinct from their qualified burst ceiling", async () => {
  const defaults = (await resources()).find(
    (item) => item.kind === "ConfigMap" && item.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"],
  );
  expect(defaults?.data?.["FACTORY_FACTORYBOX_CPU_REQUEST_MILLI"]).toBe("100");
  expect(defaults?.data?.["FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB"]).toBe("2048");
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "factorybox.cpuRequestMilli=250",
  ]);
  expect(result.exitCode).toBe(0);
  const config = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON() as Resource)
    .find((item) => item.kind === "ConfigMap" && item.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"]);
  expect(config?.data?.["FACTORY_FACTORYBOX_CPU_REQUEST_MILLI"]).toBe("250");
});

test.each(["-1", "1.5", "invalid"])(
  "invalid worker memory headroom %s is refused",
  async (value) => {
    const result = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set-string",
      `factorybox.memoryHeadroomMiB=${value}`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("factorybox.memoryHeadroomMiB");
  },
);

test.each([
  ["0", "0"],
  ["null", "2048"],
] as const)(
  "worker memory headroom %s preserves explicit zero or an older values document's default",
  async (value, expected) => {
    const result = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set",
      `factorybox.memoryHeadroomMiB=${value}`,
    ]);
    expect(result.exitCode).toBe(0);
    const config = parseAllDocuments(result.stdout)
      .map((document) => document.toJSON() as Resource)
      .find((item) => item.kind === "ConfigMap" && item.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"]);
    expect(config?.data?.["FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB"]).toBe(expected);
  },
);

test.each(["0", "9", "100.5", "3001", "invalid"])(
  "invalid worker CPU request %s is refused before installation",
  async (value) => {
    const result = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set-string",
      `factorybox.cpuRequestMilli=${value}`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("factorybox.cpuRequestMilli");
  },
);

test("operators can right-size dependency CPU reservations without raising their limits", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    ...["postgres", "forgejo", "openbao", "zero", "objectStorage"].flatMap((name) => [
      "--set",
      `${name}.resources.requests.cpu=25m`,
    ]),
  ]);
  expect(result.exitCode).toBe(0);
  const all = parseAllDocuments(result.stdout).map((document) => document.toJSON() as Resource);
  for (const [component, limit] of [
    ["postgres", "1"],
    ["forgejo", "2"],
    ["openbao", "1"],
    ["zero", "2"],
    ["objects", "1"],
  ]) {
    const workload = all.find(
      (item) => item.metadata.name === `portable-${component}` && item.kind === "StatefulSet",
    );
    const container = workload?.spec?.template?.spec.containers[0];
    expect(container?.resources?.requests["cpu"]).toBe("25m");
    expect(container?.resources?.limits["cpu"]).toBe(limit);
  }
});

test.each([
  { store: "7", claim: "32" },
  { store: "64", claim: "80" },
  { store: "8.5", claim: "32" },
  { store: "24", claim: "40" },
  { store: "8", claim: "31" },
  { store: "8", claim: "32.5" },
  { store: "8", claim: "8388608" },
])("worker storage capacity rejects invalid operator values $store/$claim", async (capacity) => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set-string",
    `factorybox.storeGiB=${capacity.store}`,
    "--set-string",
    `factorybox.claimGiB=${capacity.claim}`,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("factorybox.");
});

test.each(["arm64", "amd64"] as const)(
  "the chart preserves an explicit %s worker profile independently of application placement",
  async (architecture) => {
    const rendered = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set",
      `factorybox.architecture=${architecture}`,
    ]);
    expect(rendered.exitCode).toBe(0);
    const config = parseAllDocuments(rendered.stdout)
      .map((document) => document.toJSON() as Resource)
      .find(
        (resource) =>
          resource.kind === "ConfigMap" && resource.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"],
      );
    expect(config?.data?.["FACTORY_FACTORYBOX_ARCHITECTURE"]).toBe(architecture);
  },
);

test("native mirror hosts share the import allowlist without permitting private or unencrypted destinations", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "gitAllowedOrigins[0]=https://git.example.com",
  ]);
  expect(result.exitCode).toBe(0);
  const all = parseAllDocuments(result.stdout).map((document) => document.toJSON() as Resource);
  const config = all.find(
    (item) => item.kind === "ConfigMap" && item.data?.["FACTORY_GIT_IMPORT_ORIGINS"],
  );
  expect(config?.data?.["FACTORY_GIT_IMPORT_ORIGINS"]).toBe(
    "https://github.com,https://gitlab.com,https://codeberg.org,https://git.example.com",
  );
  const defaultConfig = (await resources()).find(
    (item) => item.kind === "ConfigMap" && item.data?.["FACTORY_GIT_IMPORT_ORIGINS"],
  );
  expect(defaultConfig?.data?.["FACTORY_GIT_IMPORT_ORIGINS"]).toBe(
    "https://github.com,https://gitlab.com,https://codeberg.org",
  );
  const forge = all.find(
    (item) => item.kind === "StatefulSet" && item.metadata.name === "portable-forgejo",
  );
  const environment = forge?.spec?.template?.spec.containers[0]?.env;
  expect(environment).toContainEqual({
    name: "FORGEJO__migrations__ALLOWED_DOMAINS",
    value: "github.com,gitlab.com,codeberg.org,git.example.com",
  });
  expect(environment).toContainEqual({
    name: "FORGEJO__migrations__ALLOW_UNENCRYPTED",
    value: "false",
  });
  const blocked = environment?.find(
    (item) => item.name === "FORGEJO__migrations__BLOCKED_DOMAINS",
  )?.value;
  expect(blocked).toContain("169.254.*");
  expect(blocked).toContain("172.1[6-9].*");
  expect(blocked).toContain("fe[89ab]*:*");
  expect(blocked).not.toContain("/");
  for (const origin of [
    "http://git.example.com",
    "https://*.example.com",
    "https://user:token@git.example.com",
    "https://git.example.com/path",
    "https://git.example.com:8443",
  ]) {
    const invalid = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set-string",
      `gitAllowedOrigins[0]=${origin}`,
    ]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("gitAllowedOrigins");
  }
});

test("the chart rejects an unsupported worker architecture before installing resources", async () => {
  const rendered = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "factorybox.architecture=riscv64",
  ]);
  expect(rendered.exitCode).not.toBe(0);
  expect(rendered.stderr).toContain("factorybox.architecture must be arm64 or amd64");
});

test("the repository chart is a Kubernetes installation, not a host Docker launcher", async () => {
  const all = await resources();
  const application = all.find((resource) => resource.kind === "Deployment");
  const pod = application?.spec?.template?.spec;
  expect(pod?.serviceAccountName).toBe("portable");
  expect(application?.spec?.strategy?.type).toBe("Recreate");
  expect(pod?.containers[0]?.command).toEqual([
    "flock",
    "--nonblock",
    "--no-fork",
    "/var/lib/factory/bootstrap.lock",
    "bun",
    "scripts/kubernetes/start.ts",
  ]);
  for (const resource of all.filter((value) => value.spec?.template)) {
    const definition = JSON.stringify(resource.spec);
    for (const forbidden of [
      "docker.sock",
      "hostPath",
      "host.orb.internal",
      "host.docker.internal",
      "orbstack",
      "hostNetwork",
      "KUBECONFIG",
    ])
      expect(definition).not.toContain(forbidden);
  }
  const dependencies = all.filter((resource) => resource.kind === "StatefulSet");
  expect(dependencies).toHaveLength(5);
  for (const dependency of dependencies)
    expect(dependency.spec?.template?.spec.automountServiceAccountToken).toBe(false);
});

test("the planning cache uses an explicit small worker count rather than host CPU count", async () => {
  const all = await resources();
  const zero = all.find(
    (resource) => resource.kind === "StatefulSet" && resource.metadata.name === "portable-zero",
  );
  expect(zero?.spec?.template?.spec.containers[0]?.env).toContainEqual({
    name: "ZERO_NUM_SYNC_WORKERS",
    value: "1",
  });
  const local = parse(await readFile("deploy/local/compose.yaml", "utf8"));
  expect(local.services["zero-cache"].environment.ZERO_NUM_SYNC_WORKERS).toBe(
    "$" + "{FACTORY_LOCAL_ZERO_SYNC_WORKERS:-1}",
  );
  const override = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "zeroSyncWorkers=2",
  ]);
  expect(override.exitCode).toBe(0);
  const overridden = parseAllDocuments(override.stdout)
    .map((document) => document.toJSON() as Resource)
    .find(
      (resource) => resource.kind === "StatefulSet" && resource.metadata.name === "portable-zero",
    );
  expect(overridden?.spec?.template?.spec.containers[0]?.env).toContainEqual({
    name: "ZERO_NUM_SYNC_WORKERS",
    value: "2",
  });
  for (const value of ["0", "-1", "1.5", "invalid"]) {
    const invalid = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set",
      `zeroSyncWorkers=${value}`,
    ]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("zeroSyncWorkers");
  }
});

test("all standard service images retain the maintained exact upstream pins", async () => {
  const all = await resources();
  const compose = parse(await readFile("deploy/local/compose.yaml", "utf8"));
  const expected = {
    postgres: compose.services.postgres.image,
    forgejo: compose.services.forgejo.image,
    zero: compose.services["zero-cache"].image,
    openbao: upstream.openbao.image,
    objects: upstream.garage.image,
  };
  for (const [role, image] of Object.entries(expected)) {
    const workload = all.find(
      (resource) =>
        resource.metadata.name === `portable-${role}` && resource.kind === "StatefulSet",
    );
    expect(workload?.spec?.template?.spec.containers[0]?.image).toBe(image);
    expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  }
});

test("the chart provides one private persistent file store without operator S3 configuration", async () => {
  const all = await resources();
  const config = all.find((resource) => resource.metadata.name === "portable-config")?.data;
  expect(config?.["FACTORY_OBJECT_S3_ENDPOINT"]).toBe(
    "http://portable-objects.factory-proof.svc:3900",
  );
  expect(config?.["FACTORY_OBJECT_S3_BUCKET"]).toBe("factory");
  expect(config?.["FACTORY_OBJECT_S3_REGION"]).toBe("garage");
  const secret = all.find(
    (resource) => resource.kind === "Secret" && resource.metadata.name === "portable-objects",
  );
  expect(Buffer.from(secret?.data?.["access-key-id"] ?? "", "base64").toString()).toMatch(
    /^GK[a-f0-9]{32}$/,
  );
  for (const key of ["secret-access-key", "rpc-secret"])
    expect(Buffer.from(secret?.data?.[key] ?? "", "base64").toString()).toMatch(/^[a-f0-9]{64}$/);
  const claim = all.find(
    (resource) =>
      resource.kind === "PersistentVolumeClaim" && resource.metadata.name === "portable-objects",
  );
  for (const retained of [secret, claim])
    expect(retained?.metadata.annotations?.["helm.sh/resource-policy"]).toBe("keep");
  const objectService = all.find(
    (resource) => resource.kind === "Service" && resource.metadata.name === "portable-objects",
  );
  expect(objectService?.spec).toMatchObject({ type: "ClusterIP" });
  const application = all.find((resource) => resource.kind === "Deployment");
  expect(application?.spec?.template?.spec.containers[0]?.env).toEqual(
    expect.arrayContaining([
      {
        name: "FACTORY_OBJECT_S3_ACCESS_KEY_ID",
        valueFrom: { secretKeyRef: { name: "portable-objects", key: "access-key-id" } },
      },
      {
        name: "FACTORY_OBJECT_S3_SECRET_ACCESS_KEY",
        valueFrom: { secretKeyRef: { name: "portable-objects", key: "secret-access-key" } },
      },
    ]),
  );
  const template = await readFile(`${chart}/templates/objects.yaml`, "utf8");
  expect(template).toContain('lookup "v1" "Secret"');
  expect(template).toContain("Refusing to replace access to existing file data");
});

test("old external attachment configuration cannot silently switch retained files to an empty store", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "attachments.endpoint=https://previous.example",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Transfer retained external attachments");
});

test("every upgrade replaces Factory even when its image and configuration are unchanged", async () => {
  const application = (await resources()).find((resource) => resource.kind === "Deployment");
  // The pre-upgrade hook fences admissions. A no-op Pod template would leave
  // that fence enabled forever because only the replacement bootstrap clears it.
  expect(application?.spec?.template?.metadata?.annotations?.["factory.dev/upgrade-revision"]).toBe(
    "1",
  );
  expect(await readFile(`${chart}/templates/factory.yaml`, "utf8")).toContain(
    "factory.dev/upgrade-revision: {{ .Release.Revision | quote }}",
  );
});

test("cold installation progress allows the documented twenty-minute readiness window", async () => {
  const application = (await resources()).find((resource) => resource.kind === "Deployment");
  expect(application?.spec?.progressDeadlineSeconds).toBe(1_200);
  const container = application?.spec?.template?.spec.containers[0];
  const probe = container?.startupProbe;
  expect(probe?.httpGet).toEqual({ path: "/health/ready?installation=complete", port: 3000 });
  expect(container?.readinessProbe?.httpGet).toEqual(probe?.httpGet);
  expect(probe?.exec).toBeUndefined();
  expect(container?.readinessProbe?.exec).toBeUndefined();
  expect((probe?.periodSeconds ?? 0) * (probe?.failureThreshold ?? 0)).toBeGreaterThanOrEqual(
    1_200,
  );
});

test("PostgreSQL readiness allows its own connection check to finish under execution load", async () => {
  const postgres = (await resources()).find(
    (resource) => resource.kind === "StatefulSet" && resource.metadata.name === "portable-postgres",
  )?.spec?.template?.spec.containers[0];
  expect(postgres?.startupProbe?.exec?.command).toEqual([
    "pg_isready",
    "-U",
    "factory",
    "-d",
    "factory",
    "-t",
    "3",
  ]);
  expect(postgres?.startupProbe?.timeoutSeconds).toBeGreaterThanOrEqual(5);
  expect(postgres?.readinessProbe?.tcpSocket).toEqual({ port: 5432 });
  expect(postgres?.readinessProbe?.exec).toBeUndefined();
});

test("PostgreSQL detects lost coordination peers without expiring healthy idle owners", async () => {
  const postgres = (await resources()).find(
    (resource) => resource.kind === "StatefulSet" && resource.metadata.name === "portable-postgres",
  )?.spec?.template?.spec.containers[0];
  const args = postgres?.args ?? [];
  expect(args[0]).toBe("postgres");
  const settings = Object.fromEntries(
    args.flatMap((argument, index) => (args[index - 1] === "-c" ? [argument.split("=", 2)] : [])),
  );
  expect(settings).toMatchObject({
    wal_level: "logical",
    tcp_keepalives_idle: "30",
    tcp_keepalives_interval: "10",
    tcp_keepalives_count: "3",
    tcp_user_timeout: "60000",
    client_connection_check_interval: "1000",
    idle_session_timeout: "0",
  });
});

test("browser origins and internal Kubernetes callbacks remain separate", async () => {
  const all = await resources();
  const config = all.find((resource) => resource.metadata.name === "portable-config")?.data;
  expect(config?.["FACTORY_BASE_URL"]).toBe("http://127.0.0.1:58000");
  expect(config?.["FACTORY_FORGEJO_PUBLIC_URL"]).toBe("http://127.0.0.1:58001");
  expect(config?.["FACTORY_ZERO_CACHE_PUBLIC_URL"]).toBe("http://127.0.0.1:58002/zero");
  expect(config?.["FACTORY_INTERNAL_URL"]).toBe("http://portable-internal.factory-proof.svc:3000");
  expect(config?.["FACTORY_FORGEJO_API_URL"]).toBe(
    "http://portable-forgejo.factory-proof.svc:3000/api/v1/",
  );
  expect(config?.["KUBECONFIG"]).toBe("/tmp/factory-kubernetes/config.json");
  expect(config?.["FACTORY_KUBERNETES_CONTEXT"]).toBe("factory");
  expect(config?.["FACTORY_AUTH_COOKIE_PREFIX"]).toMatch(/^factory-[a-f0-9]{16}$/);
  const internal = all.find((resource) => resource.metadata.name === "portable-internal");
  const publicService = all.find(
    (resource) => resource.kind === "Service" && resource.metadata.name === "portable-factory",
  );
  expect(internal?.spec?.publishNotReadyAddresses).toBe(true);
  expect(publicService?.spec?.publishNotReadyAddresses).not.toBe(true);
});

test("installation permissions do not grant RBAC administration or wildcard access", async () => {
  const role = (await resources()).find((resource) => resource.kind === "ClusterRole");
  expect(role?.rules?.length).toBeGreaterThan(0);
  for (const rule of role?.rules ?? []) {
    expect(rule.resources).not.toContain("*");
    expect(rule.verbs).not.toContain("*");
    expect(rule.apiGroups).not.toContain("*");
    for (const forbidden of ["clusterroles", "clusterrolebindings", "roles", "rolebindings"])
      expect(rule.resources).not.toContain(forbidden);
  }
});

test("offline upgrades refuse to silently replace retained credentials and TLS identities", async () => {
  const result = await helm(["template", "portable", chart, "--is-upgrade", ...localValues]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("retained Factory credentials are missing");
});

test("non-development installations require deliberate HTTPS browser origins", async () => {
  const missing = await helm(["template", "portable", chart, "--set", "image=owned-proof:unit"]);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("publicURL");
  const unsafe = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "development=false",
  ]);
  expect(unsafe.exitCode).not.toBe(0);
  expect(unsafe.stderr).toContain("HTTPS");
  const insecureDevelopment = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set",
    "publicURL=http://public.example",
  ]);
  expect(insecureDevelopment.exitCode).not.toBe(0);
  expect(insecureDevelopment.stderr).toContain("loopback");
});

test("standard Ingress routes the public UI, Forgejo and single-label runtime wildcard", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    "--set",
    "image=owned-factory-proof:unit",
    "--set",
    "publicURL=https://factory.example.com",
    "--set",
    "forgejoPublicURL=https://git.example.com",
    "--set",
    "ingress.enabled=true",
    "--set",
    "ingress.tlsSecret=existing-certificate",
  ]);
  expect(result.exitCode).toBe(0);
  if (result.exitCode) throw new Error(result.stderr);
  const ingress = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON() as Resource)
    .find((resource) => resource.kind === "Ingress");
  expect(ingress?.spec?.rules?.map((rule) => rule.host)).toEqual([
    "factory.example.com",
    "git.example.com",
    "*.runtime.factory.example.com",
  ]);
  expect(ingress?.spec?.tls?.[0]?.hosts).toEqual([
    "factory.example.com",
    "git.example.com",
    "*.runtime.factory.example.com",
  ]);
  expect(ingress?.spec?.rules?.[0]?.http.paths[0]).toMatchObject({
    path: "/zero",
    backend: { service: { name: "portable-zero", port: { number: 4848 } } },
  });
  const config = parseAllDocuments(result.stdout)
    .map((document) => document.toJSON() as Resource)
    .find((resource) => resource.metadata.name === "portable-config")?.data;
  expect(config?.["FACTORY_ZERO_CACHE_PUBLIC_URL"]).toBe("https://factory.example.com/zero");
});

test("local planning transport keeps the same cookie hostname on a separate listener", async () => {
  for (const invalid of [
    "http://localhost:58002",
    "http://127.0.0.1:58000",
    "https://127.0.0.1:58002",
    "http://127.0.0.1:58002/other",
    "http://key@127.0.0.1:58002",
  ]) {
    const result = await helm([
      "template",
      "portable",
      chart,
      ...localValues,
      "--set",
      `developmentZeroURL=${invalid}`,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("developmentZeroURL");
  }
});

test("the local preset is installable with one image setting and keeps all browser access on loopback", async () => {
  const result = await helm([
    "template",
    "factory",
    chart,
    "--values",
    `${chart}/values.local.yaml`,
    "--set-string",
    "image=owned-factory-proof:unit",
  ]);
  expect(result.exitCode).toBe(0);
  const all = parseAllDocuments(result.stdout).map((document) => document.toJSON() as Resource);
  const config = all.find((resource) => resource.metadata.name === "factory-config")?.data;
  expect(config?.["NODE_ENV"]).toBe("development");
  expect(config?.["FACTORY_BASE_URL"]).toBe("http://127.0.0.1:58000");
  expect(config?.["FACTORY_FORGEJO_PUBLIC_URL"]).toBe("http://127.0.0.1:58001");
  expect(config?.["FACTORY_ZERO_CACHE_PUBLIC_URL"]).toBe("http://127.0.0.1:58002/zero");
  expect(all.some((resource) => resource.kind === "Ingress")).toBe(false);
});

type Container = {
  name: string;
  image: string;
  securityContext?: {
    runAsUser?: number;
    runAsNonRoot?: boolean;
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[]; add?: string[] };
    seccompProfile?: { type: string };
  };
  command?: string[];
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string } } }>;
  livenessProbe?: { periodSeconds?: number; failureThreshold?: number; timeoutSeconds?: number };
  readinessProbe?: unknown;
  startupProbe?: unknown;
};
type Workload = {
  kind: string;
  metadata: { name: string };
  spec: {
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        securityContext?: {
          seccompProfile?: { type: string };
          fsGroup?: number;
          runAsUser?: number;
        };
        serviceAccountName?: string;
        automountServiceAccountToken?: boolean;
        affinity?: unknown;
        containers: Container[];
        initContainers?: Container[];
        volumes?: Array<{
          name: string;
          secret?: { secretName: string };
          persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
        }>;
      };
    };
  };
};
type Policy = {
  kind: string;
  metadata: { name: string };
  spec: {
    podSelector: {
      matchLabels?: Record<string, string>;
      matchExpressions?: Array<{ values: string[] }>;
    };
    policyTypes: string[];
    ingress?: Array<{
      from?: Array<{
        podSelector?: { matchLabels: Record<string, string> };
        namespaceSelector?: { matchLabels?: Record<string, string> };
      }>;
      ports?: Array<{ port: number }>;
    }>;
    egress?: Array<{ to?: unknown[]; ports?: Array<{ port: number; protocol: string }> }>;
  };
};

async function renderAll(extra: string[] = []) {
  const result = await helm(["template", "portable", chart, ...localValues, ...extra]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return {
    text: result.stdout,
    all: parseAllDocuments(result.stdout).map((document) => document.toJSON() as Resource),
  };
}
type CronJob = {
  kind: "CronJob";
  metadata: { name: string };
  spec: { jobTemplate: { spec: Workload["spec"] } };
};
// A CronJob is reported with the pod template of its Job so every workload check covers it.
function workloads(all: Resource[]) {
  return (all as unknown as Array<Workload | CronJob>).flatMap((item): Workload[] => {
    if (item.kind === "CronJob")
      return [
        { kind: "CronJob", metadata: item.metadata, spec: (item as CronJob).spec.jobTemplate.spec },
      ];
    return ["Deployment", "StatefulSet", "Job"].includes(item.kind) ? [item as Workload] : [];
  });
}
function policies(all: Resource[]) {
  return (all as unknown as Policy[]).filter((item) => item.kind === "NetworkPolicy");
}

test.each([
  ["default local preset", []],
  [
    "operator-owned secrets",
    [
      "--set",
      "existingSecrets.credentials=owned-credentials",
      "--set",
      "existingSecrets.objects=owned-objects",
      "--set",
      "existingSecrets.openbaoTLS=owned-tls",
    ],
  ],
  [
    "Ingress with a controller namespace",
    [
      "--set",
      "development=false",
      "--set",
      "developmentZeroURL=",
      "--set",
      "publicURL=https://factory.example.com",
      "--set",
      "forgejoPublicURL=https://git.example.com",
      "--set",
      "ingress.enabled=true",
      "--set",
      "networkPolicy.ingressControllerNamespaceSelector.matchLabels.team=edge",
    ],
  ],
  ["policies disabled", ["--set", "networkPolicy.enabled=false"]],
  ["backups disabled", ["--set", "backup.enabled=false"]],
  [
    "backups copied to a remote with an OpenBao snapshot token",
    [
      "--set",
      "backup.remote.existingSecret=backup-remote",
      "--set",
      "backup.remote.path=offsite:bucket/factory",
      "--set",
      "backup.openbao.tokenSecret=bao-snapshot",
    ],
  ],
])(
  "the %s renders valid Kubernetes objects",
  async (_name, extra) => {
    const { text } = await renderAll(extra);
    const checker = Bun.spawn(
      [
        "kubeconform",
        "-strict",
        "-summary",
        "-ignore-missing-schemas",
        "-kubernetes-version",
        "1.35.0",
      ],
      { stdin: new Response(text), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(checker.stdout).text(),
      new Response(checker.stderr).text(),
      checker.exited,
    ]);
    expect(`${stdout}${stderr}`).toContain("Invalid: 0, Errors: 0");
    expect(exitCode).toBe(0);
  },
  60_000,
);

test("the application ServiceAccount has no cluster-wide Secret watch, update or wildcard grants", async () => {
  const role = (await resources()).find((resource) => resource.kind === "ClusterRole");
  const rules = role?.rules ?? [];
  const granted = (group: string, resource: string) =>
    rules
      .filter((rule) => rule.apiGroups?.includes(group) && rule.resources?.includes(resource))
      .flatMap((rule) => rule.verbs ?? []);
  expect(granted("", "secrets").sort()).toEqual(["create", "delete", "get", "list", "patch"]);
  for (const rule of rules) {
    expect(rule.verbs).not.toContain("watch");
    expect(rule.verbs).not.toContain("deletecollection");
    expect(rule.verbs).not.toContain("escalate");
    expect(rule.verbs).not.toContain("impersonate");
    if (rule.verbs?.includes("update")) expect(rule.resources).toEqual(["namespaces/finalize"]);
  }
  expect(granted("", "pods/exec").sort()).toEqual(["create", "get"]);
  expect(granted("", "pods/portforward").sort()).toEqual(["create", "get"]);
  expect(granted("", "nodes")).toEqual(["get"]);
  expect(granted("", "events")).toEqual([]);
  expect(granted("storage.k8s.io", "storageclasses")).toEqual([]);
});

test("every workload container drops capabilities and uses the runtime seccomp profile", async () => {
  const { all } = await renderAll();
  const found = workloads(all);
  expect(found.map((item) => item.metadata.name).sort()).toEqual([
    "portable",
    "portable-backup",
    "portable-forgejo",
    "portable-maintenance",
    "portable-objects",
    "portable-openbao",
    "portable-postgres",
    "portable-preflight",
    "portable-zero",
  ]);
  for (const workload of found) {
    const pod = workload.spec.template.spec;
    expect(pod.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
    for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
      const security = container.securityContext;
      expect(security?.allowPrivilegeEscalation).toBe(false);
      expect(security?.capabilities?.drop).toEqual(["ALL"]);
      expect(security?.readOnlyRootFilesystem).toBe(true);
      expect(security?.seccompProfile?.type).toBe("RuntimeDefault");
    }
  }
});

test("only the volume-ownership init containers run as root", async () => {
  const { all } = await renderAll();
  const roots: string[] = [];
  for (const workload of workloads(all)) {
    const pod = workload.spec.template.spec;
    for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
      if (container.securityContext?.runAsNonRoot !== true)
        roots.push(`${workload.metadata.name}/${container.name}`);
    }
  }
  expect(roots.sort()).toEqual([
    "portable-backup/own-backup",
    "portable-openbao/own-data",
    "portable-zero/own-data",
    "portable/own-state",
  ]);
  const added = workloads(all).flatMap((workload) =>
    (workload.spec.template.spec.initContainers ?? []).flatMap(
      (container) => container.securityContext?.capabilities?.add ?? [],
    ),
  );
  expect(new Set(added)).toEqual(new Set(["CHOWN", "DAC_OVERRIDE", "FOWNER"]));
});

test("unprivileged services use the user their images define", async () => {
  const { all } = await renderAll();
  const user = (name: string) =>
    workloads(all).find((item) => item.metadata.name === name)?.spec.template.spec.securityContext
      ?.runAsUser;
  expect(user("portable-postgres")).toBe(999);
  expect(user("portable-forgejo")).toBe(1000);
  expect(user("portable-zero")).toBe(1000);
  expect(user("portable-openbao")).toBe(100);
  expect(user("portable-objects")).toBe(1000);
  expect(user("portable-backup")).toBe(1000);
});

test("every long-running service has liveness separate from readiness", async () => {
  const { all } = await renderAll();
  for (const workload of workloads(all).filter((item) => !["Job", "CronJob"].includes(item.kind))) {
    const container = workload.spec.template.spec.containers[0];
    expect(container?.livenessProbe).toBeDefined();
    expect(container?.readinessProbe).toBeDefined();
    expect(container?.livenessProbe).not.toEqual(container?.readinessProbe);
    expect(container?.livenessProbe?.timeoutSeconds).toBeGreaterThanOrEqual(10);
    expect(
      (container?.livenessProbe?.periodSeconds ?? 0) *
        (container?.livenessProbe?.failureThreshold ?? 0),
    ).toBeGreaterThanOrEqual(120);
  }
  for (const name of ["portable", "portable-forgejo", "portable-zero", "portable-openbao"])
    expect(
      workloads(all).find((item) => item.metadata.name === name)?.spec.template.spec.containers[0]
        ?.startupProbe,
    ).toBeDefined();
});

test("default-deny ingress is followed by only the flows Factory uses", async () => {
  const { all } = await renderAll();
  const found = policies(all);
  const byName = new Map(found.map((policy) => [policy.metadata.name, policy]));
  expect(byName.get("portable-default-deny-ingress")?.spec).toMatchObject({
    podSelector: { matchLabels: { "app.kubernetes.io/instance": "portable" } },
    policyTypes: ["Ingress"],
  });
  const sources = (name: string) =>
    byName
      .get(`portable-allow-${name}`)
      ?.spec.ingress?.flatMap((rule) => rule.from ?? [])
      .map(
        (peer) =>
          peer.podSelector?.matchLabels["app.kubernetes.io/component"] ??
          `namespace:${peer.namespaceSelector?.matchLabels?.["app.kubernetes.io/managed-by"]}`,
      );
  expect(sources("factory")).toEqual(["zero", "forgejo", "namespace:open-software-factory"]);
  expect(sources("forgejo")).toEqual(["factory", "namespace:open-software-factory"]);
  expect(sources("zero")).toEqual(["factory"]);
  expect(sources("postgres")).toEqual(["factory", "zero", "maintenance", "backup"]);
  expect(sources("openbao")).toEqual(["factory", "openbao", "backup"]);
  expect(sources("objects")).toEqual(["factory", "backup"]);
  for (const backend of ["postgres", "openbao", "objects"])
    expect(sources(backend)?.some((source) => source.startsWith("namespace:"))).toBe(false);
  const egress = byName.get("portable-restrict-backend-egress")?.spec;
  expect(egress?.policyTypes).toEqual(["Egress"]);
  expect(egress?.egress?.[0]?.to).toBeUndefined();
  expect(egress?.egress?.[0]?.ports).toEqual([
    { protocol: "UDP", port: 53 },
    { protocol: "TCP", port: 53 },
  ]);
});

test("Ingress controller access follows the Ingress setting and namespace selector", async () => {
  const none = policies((await renderAll()).all)
    .flatMap((policy) => policy.spec.ingress ?? [])
    .flatMap((rule) => rule.from ?? []);
  expect(none.some((peer) => peer.namespaceSelector?.matchLabels?.["team"])).toBe(false);
  const { all } = await renderAll([
    "--set",
    "development=false",
    "--set",
    "developmentZeroURL=",
    "--set",
    "publicURL=https://factory.example.com",
    "--set",
    "forgejoPublicURL=https://git.example.com",
    "--set",
    "ingress.enabled=true",
    "--set",
    "networkPolicy.ingressControllerNamespaceSelector.matchLabels.team=edge",
  ]);
  const edge = policies(all).filter((policy) =>
    policy.spec.ingress?.some((rule) =>
      rule.from?.some((peer) => peer.namespaceSelector?.matchLabels?.["team"] === "edge"),
    ),
  );
  expect(edge.map((policy) => policy.metadata.name).sort()).toEqual([
    "portable-allow-factory",
    "portable-allow-forgejo",
    "portable-allow-zero",
  ]);
  const open = policies(
    (
      await renderAll([
        "--set",
        "development=false",
        "--set",
        "developmentZeroURL=",
        "--set",
        "publicURL=https://factory.example.com",
        "--set",
        "forgejoPublicURL=https://git.example.com",
        "--set",
        "ingress.enabled=true",
      ])
    ).all,
  ).find((policy) => policy.metadata.name === "portable-allow-zero");
  expect(open?.spec.ingress?.[0]?.from).toContainEqual({ namespaceSelector: {} });
});

test("network policies can be disabled", async () => {
  expect(policies((await renderAll(["--set", "networkPolicy.enabled=false"])).all)).toHaveLength(0);
});

test("operator-owned Secrets replace generated ones and roll the pods that read them", async () => {
  const generated = await renderAll();
  const generatedSecrets = generated.all.filter((item) => item.kind === "Secret");
  expect(generatedSecrets.map((item) => item.metadata.name).sort()).toEqual([
    "portable-credentials",
    "portable-objects",
    "portable-openbao-tls",
  ]);
  for (const workload of workloads(generated.all))
    expect(
      workload.spec.template.metadata?.annotations?.["checksum/existing-secrets"],
    ).toBeUndefined();
  const owned = await renderAll([
    "--set",
    "existingSecrets.credentials=owned-credentials",
    "--set",
    "existingSecrets.objects=owned-objects",
    "--set",
    "existingSecrets.openbaoTLS=owned-tls",
    "--set",
    "existingSecrets.revision=7",
  ]);
  expect(owned.all.filter((item) => item.kind === "Secret")).toEqual([]);
  const secretNames = new Set(
    workloads(owned.all).flatMap((workload) =>
      [
        ...workload.spec.template.spec.containers,
        ...(workload.spec.template.spec.initContainers ?? []),
      ].flatMap((container) =>
        (container.env ?? []).flatMap((entry) =>
          entry.valueFrom?.secretKeyRef ? [entry.valueFrom.secretKeyRef.name] : [],
        ),
      ),
    ),
  );
  expect(secretNames).toEqual(new Set(["owned-credentials", "owned-objects"]));
  const claimed = (name: string) =>
    workloads(owned.all).find((item) => item.metadata.name === name)?.spec.template.metadata
      ?.annotations?.["checksum/existing-secrets"];
  for (const name of ["portable", "portable-zero", "portable-objects", "portable-openbao"])
    expect(claimed(name)).toMatch(/^[a-f0-9]{64}$/);
  expect(claimed("portable-postgres")).toBeUndefined();
  const rolled = await renderAll([
    "--set",
    "existingSecrets.credentials=owned-credentials",
    "--set",
    "existingSecrets.revision=8",
  ]);
  const before = await renderAll([
    "--set",
    "existingSecrets.credentials=owned-credentials",
    "--set",
    "existingSecrets.revision=7",
  ]);
  const checksum = (rendered: Resource[]) =>
    workloads(rendered).find((item) => item.metadata.name === "portable")?.spec.template.metadata
      ?.annotations?.["checksum/existing-secrets"];
  expect(checksum(rolled.all)).not.toBe(checksum(before.all));
  const tls = workloads(owned.all)
    .find((item) => item.metadata.name === "portable-openbao")
    ?.spec.template.spec.volumes?.find((volume) => volume.name === "tls");
  expect(tls?.secret?.secretName).toBe("owned-tls");
});

test("an empty application image is refused with an actionable message", async () => {
  const result = await helm([
    "template",
    "portable",
    chart,
    ...localValues,
    "--set-string",
    "image=",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("image is required");
});

test("every chart-owned service image is pinned by digest", async () => {
  const { all } = await renderAll();
  for (const workload of workloads(all).filter((item) => item.metadata.name !== "portable")) {
    if (["Job", "CronJob"].includes(workload.kind)) continue;
    for (const container of [
      ...workload.spec.template.spec.containers,
      ...(workload.spec.template.spec.initContainers ?? []),
    ])
      expect(container.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  }
});

test("the preflight is a Helm test hook that is not privileged and never runs at install", async () => {
  const all = await resources();
  const hooks = all.filter((item) => item.metadata.annotations?.["helm.sh/hook"] === "test");
  expect(hooks.map((item) => item.kind).sort()).toEqual([
    "ClusterRole",
    "ClusterRoleBinding",
    "Job",
    "ServiceAccount",
  ]);
  const job = hooks.find((item) => item.kind === "Job");
  const definition = JSON.stringify(job?.spec);
  expect(definition).not.toContain('privileged":true');
  expect(definition).not.toContain("hostPath");
  expect(job?.spec?.template?.spec.containers[0]?.command?.slice(0, 2)).toEqual([
    "bun",
    "scripts/kubernetes/preflight.ts",
  ]);
  const role = hooks.find((item) => item.kind === "ClusterRole");
  for (const rule of role?.rules ?? []) {
    expect(rule.verbs).not.toContain("update");
    expect(rule.verbs).not.toContain("patch");
  }
});

test("Factory runs as an unprivileged user and fixes retained state ownership once", async () => {
  const { all } = await renderAll();
  const factory = workloads(all).find((item) => item.metadata.name === "portable");
  const pod = factory?.spec.template.spec;
  const main = pod?.containers[0];
  expect(main?.securityContext).toMatchObject({
    runAsUser: 1000,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  });
  // A pod fsGroup would add group access to every retained state file, and the OpenBao token
  // file must stay private to its owner.
  expect(pod?.securityContext?.fsGroup).toBeUndefined();
  const init = pod?.initContainers?.[0];
  expect(init?.name).toBe("own-state");
  expect(init?.securityContext?.runAsUser).toBe(0);
  expect(init?.securityContext?.capabilities?.add).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
  expect(init?.volumeMounts).toEqual([{ name: "state", mountPath: "/var/lib/factory" }]);
  const script = init?.command?.at(-1) ?? "";
  expect(script).toContain('test -e "$marker" && exit 0');
  expect(script.indexOf("chown -R 1000:1000 /var/lib/factory")).toBeLessThan(
    script.indexOf(': > "$marker"'),
  );
  expect(init?.image).toBe(main?.image);
});

test("the release smoke tests start the Factory image as the unprivileged user the chart uses", async () => {
  for (const file of [".github/workflows/checks.yaml", ".github/workflows/images.yaml"])
    expect(await readFile(file, "utf8")).toContain("--user 1000:1000");
});

test("backups are on by default and write to one dedicated retained claim", async () => {
  const all = await resources();
  const claim = all.find(
    (item) => item.kind === "PersistentVolumeClaim" && item.metadata.name === "portable-backup",
  );
  expect(claim?.metadata.annotations?.["helm.sh/resource-policy"]).toBe("keep");
  const requested = (claim?.spec as unknown as { resources: { requests: { storage: string } } })
    ?.resources;
  expect(requested?.requests.storage).toBe("40Gi");
  const cron = (workloads(all) as Workload[]).find((item) => item.kind === "CronJob");
  const raw = all.find((item) => item.kind === "CronJob") as unknown as {
    spec: { schedule: string; concurrencyPolicy: string };
  };
  expect(raw.spec.schedule).toBe("17 2 * * *");
  expect(raw.spec.concurrencyPolicy).toBe("Forbid");
  const pod = cron?.spec.template.spec;
  expect(pod?.initContainers?.map((container) => container.name)).toEqual([
    "own-backup",
    "prepare",
    "postgres",
    "forgejo",
    "objects",
    "openbao",
  ]);
  expect(pod?.containers.map((container) => container.name)).toEqual(["finalize"]);
  const claims = pod?.volumes?.flatMap((volume) =>
    volume.persistentVolumeClaim ? [volume.persistentVolumeClaim] : [],
  );
  expect(claims).toEqual([
    { claimName: "portable-backup" },
    { claimName: "portable-state", readOnly: true },
  ]);
  // The read-only state claim is mounted by the OpenBao step alone.
  const mounts = (pod?.initContainers ?? [])
    .concat(pod?.containers ?? [])
    .filter((container) => container.volumeMounts?.some((mount) => mount.name === "state"));
  expect(mounts.map((container) => container.name)).toEqual(["openbao"]);
  expect(mounts[0]?.volumeMounts?.find((mount) => mount.name === "state")?.readOnly).toBe(true);
  expect(JSON.stringify(pod?.affinity)).toContain('"app.kubernetes.io/component":"factory"');
  const finalize = pod?.containers[0];
  expect(finalize?.env).toContainEqual({ name: "BACKUP_RETENTION", value: "7" });
  expect(finalize?.env?.some((entry) => entry.name === "BACKUP_REMOTE")).toBe(false);
});

test("backup images are pinned and match the maintained service pins", async () => {
  const all = await resources();
  const compose = parse(await readFile("deploy/local/compose.yaml", "utf8"));
  const pod = workloads(all).find((item) => item.kind === "CronJob")?.spec.template.spec;
  const images = new Map(
    [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])].map((container) => [
      container.name,
      container.image,
    ]),
  );
  expect(images.get("postgres")).toBe(compose.services.postgres.image);
  expect(images.get("openbao")).toBe(upstream.openbao.image);
  for (const name of ["own-backup", "prepare", "objects", "finalize"])
    expect(images.get(name)).toBe(upstream.rclone.image);
  // The Forgejo step needs kubectl, which only the Factory image carries.
  expect(images.get("forgejo")).toBe("owned-factory-proof:unit");
  for (const [name, image] of images)
    if (name !== "forgejo") expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(upstream.rclone.image).toContain(`:${upstream.rclone.version}@sha256:`);
});

test("the backup ServiceAccount may only exec into the Forgejo Pod", async () => {
  const all = await resources();
  const role = all.find((item) => item.kind === "Role" && item.metadata.name === "portable-backup");
  expect(role?.rules as unknown).toEqual([
    {
      apiGroups: [""],
      resources: ["pods"],
      resourceNames: ["portable-forgejo-0"],
      verbs: ["get"],
    },
    {
      apiGroups: [""],
      resources: ["pods/exec"],
      resourceNames: ["portable-forgejo-0"],
      verbs: ["get", "create"],
    },
  ]);
  const binding = all.find(
    (item) => item.kind === "RoleBinding" && item.metadata.name === "portable-backup",
  ) as unknown as { subjects: Array<{ name: string }> };
  expect(binding.subjects as unknown).toEqual([
    { kind: "ServiceAccount", name: "portable-backup" },
  ]);
  const cluster = all.find((item) => item.kind === "ClusterRoleBinding");
  expect(JSON.stringify(cluster)).not.toContain("portable-backup");
});

test("backup Jobs may reach only the data services they read", async () => {
  const { all } = await renderAll();
  const byName = new Map(policies(all).map((policy) => [policy.metadata.name, policy]));
  const from = (name: string) =>
    byName
      .get(`portable-allow-${name}`)
      ?.spec.ingress?.flatMap((rule) => rule.from ?? [])
      .some((peer) => peer.podSelector?.matchLabels["app.kubernetes.io/component"] === "backup");
  expect(["postgres", "openbao", "objects"].map(from)).toEqual([true, true, true]);
  expect(["factory", "forgejo", "zero"].map(from)).toEqual([false, false, false]);
  const without = policies((await renderAll(["--set", "backup.enabled=false"])).all);
  expect(JSON.stringify(without)).not.toContain('"backup"');
  expect(
    without.find((policy) => policy.metadata.name === "portable-allow-postgres")?.spec.ingress,
  ).toHaveLength(1);
});

test("backups retry network calls and keep failed steps from hiding behind later ones", async () => {
  const all = await resources();
  const scripts = all.find(
    (item) => item.metadata.name === "portable-backup" && item.kind === "ConfigMap",
  )?.data as Record<string, string>;
  expect(Object.keys(scripts).sort()).toEqual([
    "common.sh",
    "finalize.sh",
    "forgejo.sh",
    "objects.sh",
    "openbao.sh",
    "postgres.sh",
    "prepare.sh",
  ]);
  expect(scripts["common.sh"]).toContain("retry()");
  for (const name of ["postgres", "forgejo", "objects", "openbao"])
    expect(scripts[`${name}.sh`]).toMatch(/step \w+ retry \d+/);
  expect(scripts["postgres.sh"]).toContain("pg_dump --format=custom");
  expect(scripts["postgres.sh"]).toContain("pg_restore --list");
  expect(scripts["forgejo.sh"]).toContain("forgejo dump");
  expect(scripts["openbao.sh"]).toContain("bao operator raft snapshot save");
  expect(scripts["finalize.sh"]).toContain("exit 1");
});

test("backups can send sets to an operator remote and carry an OpenBao snapshot token", async () => {
  const { all } = await renderAll([
    "--set",
    "backup.remote.existingSecret=backup-remote",
    "--set",
    "backup.remote.path=offsite:bucket/factory",
    "--set",
    "backup.openbao.tokenSecret=bao-snapshot",
    "--set",
    "backup.retention=14",
  ]);
  const pod = workloads(all).find((item) => item.kind === "CronJob")?.spec.template.spec;
  const finalize = pod?.containers[0];
  expect(finalize?.env).toContainEqual({ name: "BACKUP_REMOTE", value: "offsite:bucket/factory" });
  expect(finalize?.env).toContainEqual({ name: "BACKUP_RETENTION", value: "14" });
  expect(finalize?.volumeMounts).toContainEqual({
    name: "remote",
    mountPath: "/rclone",
    readOnly: true,
  });
  const openbao = pod?.initContainers?.find((container) => container.name === "openbao");
  expect(openbao?.volumeMounts).toContainEqual({
    name: "openbao-token",
    mountPath: "/openbao-token",
    readOnly: true,
  });
  expect(pod?.volumes?.some((volume) => volume.secret?.secretName === "backup-remote")).toBe(true);
});

test("backup settings are validated and the whole feature can be disabled", async () => {
  const { all } = await renderAll(["--set", "backup.enabled=false"]);
  expect(JSON.stringify(all)).not.toContain("portable-backup");
  for (const [setting, message] of [
    ["backup.retention=0", "backup.retention"],
    ["backup.retention=1.5", "backup.retention"],
    ["backup.remote.path=offsite:bucket", "set together"],
    ["backup.remote.existingSecret=backup-remote", "set together"],
    ["backup.schedule=", "backup.schedule"],
  ] as const) {
    const result = await helm(["template", "portable", chart, ...localValues, "--set", setting]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  }
}, 60_000);

test("no PodDisruptionBudget is rendered because every service is a single replica on an RWO volume", async () => {
  expect((await resources()).some((item) => item.kind === "PodDisruptionBudget")).toBe(false);
  for (const workload of workloads(await resources()))
    if (workload.kind === "Deployment" || workload.kind === "StatefulSet")
      expect((workload.spec as unknown as { replicas: number }).replicas).toBe(1);
});
