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
          env?: Array<{ name: string; value?: string }>;
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
  expect(defaultConfig?.data?.["FACTORY_FACTORYBOX_BOUNDED_BYTES"]).toBe(String(8 * 1024 ** 3));
  expect(defaultConfig?.data?.["FACTORY_FACTORYBOX_CLAIM_GIB"]).toBe("32");
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
});

test.each([
  { store: "7", claim: "32" },
  { store: "33", claim: "64" },
  { store: "8.5", claim: "32" },
  { store: "24", claim: "40" },
  { store: "8", claim: "31" },
  { store: "8", claim: "32.5" },
  { store: "8", claim: "2048" },
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
