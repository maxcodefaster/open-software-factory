import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse, parseAllDocuments } from "yaml";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import upstream from "../../upstream.json";

const chart = "deploy/helm/factory";
const applicationImage = `registry.example/factory@sha256:${"a".repeat(64)}`;
const localValues = [
  "--set",
  `image=${applicationImage}`,
  "--set",
  "publicURL=http://127.0.0.1:58000",
  "--set",
  "forgejoPublicURL=https://git.example.com",
  "--set",
  "developmentZeroURL=http://127.0.0.1:58002",
  "--set",
  "development=true",
];
async function helm(args: string[], nativeDefaults = true) {
  if (args[0] === "template" && nativeDefaults) {
    if (!args.some((value) => value.startsWith("substrate.workspaceConfigurationSecret=")))
      args.push("--set", "substrate.workspaceConfigurationSecret=native-workspaces");
    if (!args.some((value) => value.startsWith("substrate.provisionerTokenSecret=")))
      args.push("--set", "substrate.provisionerTokenSecret=native-provisioner");
  }
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
          livenessProbe?: {
            exec?: { command: string[] };
            tcpSocket?: { port: number };
            periodSeconds: number;
            timeoutSeconds: number;
            failureThreshold: number;
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
  subjects?: Array<{ kind: string; name: string; namespace?: string }>;
  roleRef?: { kind: string; name: string };
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

test("native installation configuration and separately rotating credentials are required", async () => {
  const missing = await helm(["template", "portable", chart, ...localValues], false);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("substrate.workspaceConfigurationSecret");
  const noOwner = await helm(
    [
      "template",
      "portable",
      chart,
      ...localValues,
      "--set",
      "substrate.workspaceConfigurationSecret=native-workspaces",
    ],
    false,
  );
  expect(noOwner.exitCode).not.toBe(0);
  expect(noOwner.stderr).toContain("substrate.provisionerTokenSecret");
  const all = await resources();
  const app = all.find((r) => r.kind === "Deployment" && r.metadata.name === "portable");
  expect(app?.spec?.template?.spec.containers[0]?.env).toContainEqual({
    name: "FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION",
    value: "/run/factory/substrate-configuration/configuration.json",
  });
  const projected = JSON.stringify(app?.spec?.template?.spec.volumes);
  expect(projected).toContain('"audience":"api.ate-system.svc"');
  expect(projected).toContain('"expirationSeconds":600');
  expect(projected).toContain('"secretName":"native-provisioner"');
  const role = all.find(
    (r) => r.kind === "ClusterRole" && r.metadata.name === "factory-proof-portable",
  );
  expect(role?.rules?.filter((rule) => rule.apiGroups?.includes("ate.dev"))).toEqual([
    { apiGroups: ["ate.dev"], resources: ["workerpools"], verbs: ["get", "list", "create"] },
    { apiGroups: ["ate.dev"], resources: ["sandboxconfigs"], verbs: ["get"] },
  ]);
});

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

test("the chart has native configuration and no legacy worker or execution reserve settings", async () => {
  const all = await resources();
  const config = all.find(
    (item) => item.kind === "ConfigMap" && item.metadata.name === "portable-config",
  )?.data;
  expect(config).toBeDefined();
  expect(
    Object.keys(config ?? {}).some(
      (name) =>
        name.startsWith("FACTORY_FACTORYBOX") || name === "FACTORY_EXECUTION_RESERVE_TARGET",
    ),
  ).toBe(false);
  const values = parse(await readFile(`${chart}/values.yaml`, "utf8"));
  expect(values).not.toHaveProperty("factorybox");
  expect(values).not.toHaveProperty("executionReserveTarget");
  expect(values.stateSize).toBe("8Gi");
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
    ])
      expect(definition).not.toContain(forbidden);
  }
  const dependencies = all.filter((resource) => resource.kind === "StatefulSet");
  expect(dependencies).toHaveLength(6);
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
  const expected = {
    postgres: imagePins.postgres,
    forgejo: imagePins.forgejo,
    zero: imagePins.zero,
    openbao: imagePins.openbao,
    objects: imagePins.garage,
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

test("PostgreSQL liveness does not depend on container exec under runtime load", async () => {
  const { all } = await renderAll();
  const postgres = workloads(all).find((item) => item.metadata.name === "portable-postgres")?.spec
    .template.spec.containers[0];
  expect(postgres?.livenessProbe).toEqual({
    tcpSocket: { port: 5432 },
    timeoutSeconds: 10,
    periodSeconds: 20,
    failureThreshold: 6,
  });
});

test("OpenBao liveness does not restart an encrypted store because container exec stalls", async () => {
  const openbao = (await resources()).find(
    (resource) => resource.kind === "StatefulSet" && resource.metadata.name === "portable-openbao",
  )?.spec?.template?.spec.containers[0];
  expect(openbao?.livenessProbe).toEqual({
    tcpSocket: { port: 8200 },
    periodSeconds: 20,
    timeoutSeconds: 10,
    failureThreshold: 6,
  });
  for (const probe of [openbao?.startupProbe, openbao?.readinessProbe]) {
    const command = probe?.exec?.command.join(" ") ?? "";
    expect(command).toContain("bao status -address=https://");
    expect(command).toContain("-ca-cert=/bao/tls/ca.crt");
    expect(command).toContain('test "$result" -eq 0 -o "$result" -eq 2');
  }
  const config = (await resources()).find(
    (resource) => resource.metadata.name === "portable-config",
  )?.data;
  expect(config?.["FACTORY_OPENBAO_URL"]).toBe("https://portable-openbao.factory-proof.svc:8200");
  expect(config?.["FACTORY_OPENBAO_CA_FILE"]).toBe("/run/factory/openbao/ca.crt");
});

test("browser origins and internal Kubernetes callbacks remain separate", async () => {
  const all = await resources();
  const config = all.find((resource) => resource.metadata.name === "portable-config")?.data;
  expect(config?.["FACTORY_BASE_URL"]).toBe("http://127.0.0.1:58000");
  expect(config?.["FACTORY_FORGEJO_PUBLIC_URL"]).toBe("https://git.example.com");
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
  const missing = await helm(["template", "portable", chart, "--set", `image=${applicationImage}`]);
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
    `image=${applicationImage}`,
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

test("the local preset keeps Factory/planning on loopback but requires native secrets and Forge HTTPS", async () => {
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
  expect(config?.["FACTORY_FORGEJO_PUBLIC_URL"]).toBe("https://git.factory.example");
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
  env?: Array<{
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef?: { name: string }; fieldRef?: { fieldPath: string } };
  }>;
  livenessProbe?: {
    tcpSocket?: { port: number };
    periodSeconds?: number;
    failureThreshold?: number;
    timeoutSeconds?: number;
  };
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
  const all = await resources();
  const account = all.find(
    (resource) => resource.kind === "Deployment" && resource.metadata.name === "portable",
  )?.spec?.template?.spec.serviceAccountName;
  const binding = all.find(
    (resource) =>
      resource.kind === "ClusterRoleBinding" &&
      resource.subjects?.some(
        (subject) => subject.kind === "ServiceAccount" && subject.name === account,
      ),
  );
  const role = all.find(
    (resource) =>
      resource.kind === "ClusterRole" && resource.metadata.name === binding?.roleRef?.name,
  );
  expect(role).toBeDefined();
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
  expect(granted("", "nodes")).toEqual(["get", "list"]);
  expect(granted("metrics.k8s.io", "pods")).toEqual([]);
  expect(granted("", "events")).toEqual([]);
  expect(granted("storage.k8s.io", "storageclasses")).toEqual([]);
});

test("every workload container drops capabilities and uses the runtime seccomp profile", async () => {
  const { all } = await renderAll();
  const found = workloads(all);
  expect(found.map((item) => item.metadata.name).sort()).toEqual([
    "portable",
    "portable-backup",
    "portable-backup-store",
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
  for (const workload of workloads(all).filter(
    (item) =>
      !["Job", "CronJob"].includes(item.kind) && item.metadata.name !== "portable-backup-store",
  )) {
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
  expect(sources("factory")).toEqual([
    "factory",
    "zero",
    "forgejo",
    "namespace:open-software-factory",
  ]);
  expect(
    byName
      .get("portable-allow-factory")
      ?.spec.ingress?.flatMap((rule) => rule.from ?? [])
      .find((peer) => peer.podSelector?.matchLabels["app.kubernetes.io/component"] === "factory"),
  ).toEqual({
    podSelector: {
      matchLabels: {
        "app.kubernetes.io/instance": "portable",
        "app.kubernetes.io/component": "factory",
      },
    },
  });
  expect(sources("forgejo")).toEqual(["factory"]);
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

test("fresh OpenBao TLS has a distinct CA issuer and verifies its original leaf", async () => {
  const { all } = await renderAll();
  const secret = all.find(
    (item) => item.kind === "Secret" && item.metadata.name === "portable-openbao-tls",
  );
  if (!secret?.data) throw new Error("Missing generated OpenBao identity");
  const ca = new X509Certificate(Buffer.from(secret.data["ca.crt"] ?? "", "base64"));
  const leaf = new X509Certificate(Buffer.from(secret.data["tls.crt"] ?? "", "base64"));
  expect(ca.ca).toBe(true);
  expect(leaf.ca).toBe(false);
  expect(leaf.verify(ca.publicKey)).toBe(true);
  expect(leaf.issuer).toBe(ca.subject);
  expect(leaf.subject).not.toBe(ca.subject);
  expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
});

test("operator-owned Secrets replace generated ones and roll the pods that read them", async () => {
  const generated = await renderAll();
  const generatedSecrets = generated.all.filter((item) => item.kind === "Secret");
  expect(generatedSecrets.map((item) => item.metadata.name).sort()).toEqual([
    "portable-credentials",
    "portable-objects",
    "portable-openbao-tls",
  ]);
  for (const workload of workloads(generated.all).filter(
    (item) => item.metadata.name !== "portable",
  ))
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
  expect(hooks.map((item) => item.kind)).toEqual(["Job"]);
  const job = hooks.find((item) => item.kind === "Job");
  const definition = JSON.stringify(job?.spec);
  expect(definition).not.toContain('privileged":true');
  expect(definition).not.toContain("hostPath");
  expect(job?.spec?.template?.spec.containers[0]?.command).toEqual([
    "bun",
    "scripts/kubernetes/preflight.ts",
    "--service-account",
  ]);
  const role = all.find(
    (item) => item.kind === "ClusterRole" && item.metadata.name.endsWith("-preflight"),
  );
  for (const rule of role?.rules ?? []) {
    expect(rule.verbs).not.toContain("update");
    expect(rule.verbs).not.toContain("patch");
  }
});

test("preflight authentication and read-only RBAC survive dependency hook success until the Job finishes", async () => {
  const all = await resources();
  const job = all.find((item) => item.kind === "Job" && item.metadata.name.endsWith("-preflight"));
  const account = job?.spec?.template?.spec.serviceAccountName;
  const binding = all.find(
    (item) =>
      item.kind === "ClusterRoleBinding" &&
      item.subjects?.some(
        (subject) => subject.kind === "ServiceAccount" && subject.name === account,
      ),
  );
  const dependencies = [
    all.find((item) => item.kind === "ServiceAccount" && item.metadata.name === account),
    binding,
    all.find(
      (item) => item.kind === "ClusterRole" && item.metadata.name === binding?.roleRef?.name,
    ),
  ].filter((item): item is Resource => Boolean(item));
  expect(dependencies).toHaveLength(3);
  for (const resource of dependencies) {
    const cleanup = resource.metadata.annotations?.["helm.sh/hook-delete-policy"]?.split(",");
    expect(resource.metadata.annotations?.["helm.sh/hook"]).toBeUndefined();
    // Helm completes non-Job hooks as soon as they exist. Deleting here revokes
    // the ServiceAccount/token and binding before the later test Job can read.
    expect(cleanup ?? []).not.toContain("hook-succeeded");
  }
  expect(job?.metadata.annotations?.["helm.sh/hook-delete-policy"]?.split(",")).toContain(
    "hook-succeeded",
  );
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
  const holder = all.find(
    (item) => item.kind === "StatefulSet" && item.metadata.name === "portable-backup-store",
  ) as unknown as {
    spec: {
      persistentVolumeClaimRetentionPolicy: { whenDeleted: string };
      volumeClaimTemplates: Array<{
        metadata: { name: string };
        spec: { resources: { requests: { storage: string } } };
      }>;
    };
  };
  // A stand-alone claim would stay Pending under WaitForFirstConsumer and stall `helm --wait`.
  expect(
    all.some(
      (item) => item.kind === "PersistentVolumeClaim" && item.metadata.name === "portable-backup",
    ),
  ).toBe(false);
  expect(holder.spec.persistentVolumeClaimRetentionPolicy.whenDeleted).toBe("Retain");
  expect(holder.spec.volumeClaimTemplates[0]?.metadata.name).toBe("store");
  expect(holder.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage).toBe("40Gi");
  const cron = (workloads(all) as Workload[]).find((item) => item.kind === "CronJob");
  const raw = all.find((item) => item.kind === "CronJob") as unknown as {
    spec: { schedule: string; concurrencyPolicy: string };
  };
  expect(raw.spec.schedule).toBe("17 2 * * *");
  expect(raw.spec.concurrencyPolicy).toBe("Forbid");
  const pod = cron?.spec.template.spec;
  expect(pod?.initContainers?.map((container) => container.name)).toEqual([
    "own-backup",
    "stage-kubectl",
    "stage-bao",
  ]);
  expect(pod?.containers.map((container) => container.name)).toEqual(["backup"]);
  expect(pod?.containers[0]?.command).toEqual(["sh", "/scripts/run.sh"]);
  expect(
    pod?.initContainers?.find((container) => container.name === "stage-kubectl")?.command,
  ).toEqual(["cp", "/usr/local/bin/kubectl", "/usr/local/bin/factory-sqlite", "/tools/"]);
  expect(pod?.initContainers?.find((container) => container.name === "stage-bao")?.command).toEqual(
    ["cp", "/usr/bin/bao", "/tools/bao"],
  );
  for (const container of pod?.initContainers?.slice(1) ?? [])
    expect(container.volumeMounts).toEqual([{ name: "tools", mountPath: "/tools" }]);
  // Only the ownership init container and locked runner may mount the backup PVC.
  expect(
    [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]
      .filter((container) => container.volumeMounts?.some((mount) => mount.name === "backup"))
      .map((container) => container.name),
  ).toEqual(["own-backup", "backup"]);
  expect(pod?.containers[0]?.volumeMounts).toContainEqual({
    name: "tools",
    mountPath: "/tools",
    readOnly: true,
  });
  const claims = pod?.volumes?.flatMap((volume) =>
    volume.persistentVolumeClaim ? [volume.persistentVolumeClaim] : [],
  );
  expect(claims).toEqual([
    { claimName: "store-portable-backup-store-0" },
    { claimName: "portable-state", readOnly: true },
  ]);
  // Only the locked runner sees state and credentials; the tool-staging containers do not.
  const mounts = (pod?.initContainers ?? [])
    .concat(pod?.containers ?? [])
    .filter((container) => container.volumeMounts?.some((mount) => mount.name === "state"));
  expect(mounts.map((container) => container.name)).toEqual(["backup"]);
  expect(mounts[0]?.volumeMounts?.find((mount) => mount.name === "state")?.readOnly).toBe(true);
  expect(JSON.stringify(pod?.affinity)).toContain('"app.kubernetes.io/component":"factory"');
  const runner = pod?.containers[0];
  expect(runner?.env).toContainEqual({ name: "BACKUP_RETENTION", value: "7" });
  expect(runner?.env?.some((entry) => entry.name === "BACKUP_REMOTE")).toBe(false);
  expect(runner?.env).toContainEqual({ name: "POSTGRES_POD", value: "portable-postgres-0" });
  expect(runner?.env).toContainEqual({ name: "FORGEJO_POD", value: "portable-forgejo-0" });
  expect(runner?.env).toContainEqual({
    name: "BACKUP_POD_UID",
    valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
  });
  expect(runner?.env?.some((entry) => entry.name === "PGPASSWORD")).toBe(false);
});

test("backup images are pinned and match the maintained service pins", async () => {
  const all = await resources();
  const pod = workloads(all).find((item) => item.kind === "CronJob")?.spec.template.spec;
  const images = new Map(
    [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])].map((container) => [
      container.name,
      container.image,
    ]),
  );
  expect(
    workloads(all).find((workload) => workload.metadata.name === "portable-postgres")?.spec.template
      .spec.containers[0]?.image,
  ).toBe(imagePins.postgres);
  expect(images.get("stage-bao")).toBe(imagePins.openbao);
  for (const name of ["own-backup", "backup"]) expect(images.get(name)).toBe(imagePins.rclone);
  // Both static tools come from the application, not an extra image or live package install.
  expect(images.get("stage-kubectl")).toBe(applicationImage);
  for (const [name, image] of images)
    if (name !== "stage-kubectl") expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(imagePins.rclone).toContain(`:${upstream.rclone.version}@sha256:`);
});

test("the backup ServiceAccount may only exec into the exact PostgreSQL and Forgejo Pods", async () => {
  const all = await resources();
  const role = all.find((item) => item.kind === "Role" && item.metadata.name === "portable-backup");
  expect(role?.rules as unknown).toEqual([
    {
      apiGroups: [""],
      resources: ["pods"],
      resourceNames: ["portable-postgres-0", "portable-forgejo-0"],
      verbs: ["get"],
    },
    {
      apiGroups: [""],
      resources: ["pods/exec"],
      resourceNames: ["portable-postgres-0", "portable-forgejo-0"],
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
    "foreign-keys.sql",
    "forgejo.sh",
    "objects.sh",
    "openbao.sh",
    "postgres.sh",
    "prepare.sh",
    "run.sh",
  ]);
  expect(scripts["run.sh"]).toContain('exec 9>>"$BACKUP/.lock"');
  expect(scripts["run.sh"]).toContain("flock -n 9");
  expect(scripts["run.sh"]).toContain("prepare postgres forgejo objects openbao finalize");
  expect(scripts["common.sh"]).toContain("retry()");
  for (const name of ["postgres", "forgejo", "objects", "openbao"])
    expect(scripts[`${name}.sh`]).toMatch(/step \w+ retry \d+/);
  expect(scripts["postgres.sh"]).toContain("pg_dump --format=custom");
  expect(scripts["postgres.sh"]).toContain("pg_restore --list");
  // A source with orphaned rows is kept but flagged, because pg_restore cannot recreate its keys.
  expect(scripts["postgres.sh"]).toContain("/scripts/foreign-keys.sql");
  expect(scripts["postgres.sh"]).toContain("postgres.orphans");
  expect(scripts["foreign-keys.sql"]).toContain("contype = 'f'");
  expect(scripts["forgejo.sh"]).toContain("forgejo dump");
  expect(scripts["openbao.sh"]).toContain("bao operator raft snapshot save");
  expect(scripts["finalize.sh"]).toContain("exit 1");
});

test("a default install backs OpenBao up with the AppRole login Factory stores in a Secret", async () => {
  const all = await resources();
  const pod = workloads(all).find((item) => item.kind === "CronJob")?.spec.template.spec;
  const openbao = pod?.containers[0];
  expect(openbao?.volumeMounts).toContainEqual({
    name: "openbao-login",
    mountPath: "/openbao-login",
    readOnly: true,
  });
  expect(openbao?.volumeMounts?.some((mount) => mount.name === "openbao-token")).toBe(false);
  // Optional, so the first run before Factory's bootstrap writes openbao.skipped instead of failing.
  expect(pod?.volumes as unknown[]).toContainEqual({
    name: "openbao-login",
    secret: {
      secretName: "portable-backup-openbao",
      optional: true,
      items: [
        { key: "role-id", path: "role-id" },
        { key: "secret-id", path: "secret-id" },
      ],
    },
  });
  // No other container sees the login.
  const mounting = (pod?.initContainers ?? [])
    .concat(pod?.containers ?? [])
    .filter((container) => container.volumeMounts?.some((mount) => mount.name === "openbao-login"));
  expect(mounting.map((container) => container.name)).toEqual(["backup"]);
  const scripts = all.find(
    (item) => item.metadata.name === "portable-backup" && item.kind === "ConfigMap",
  )?.data as Record<string, string>;
  expect(scripts["openbao.sh"]).toContain("auth/approle/login");
  expect(scripts["openbao.sh"]).toContain("role_id=@/openbao-login/role-id");
  expect(scripts["openbao.sh"]).toContain("secret_id=@/openbao-login/secret-id");
  expect(scripts["openbao.sh"]).toContain("openbao.skipped");
  // The chart does not render the Secret; Factory creates it, and it carries no placeholder values.
  expect(all.some((item) => item.metadata.name === "portable-backup-openbao")).toBe(false);
});

test("native installations have no legacy unauthenticated OpenBao recovery listener", async () => {
  const all = await resources();
  expect(JSON.stringify(all)).not.toContain("8210");
  expect(all.some((item) => item.metadata.name === "portable-openbao-recovery")).toBe(false);
  const values = parse(await readFile(`${chart}/values.yaml`, "utf8"));
  expect(values.openbao).not.toHaveProperty("recovery");
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
  const openbao = pod?.containers[0];
  expect(openbao?.volumeMounts).toContainEqual({
    name: "openbao-token",
    mountPath: "/openbao-token",
    readOnly: true,
  });
  // The override replaces the default login instead of adding to it.
  expect(openbao?.volumeMounts?.some((mount) => mount.name === "openbao-login")).toBe(false);
  expect(pod?.volumes?.some((volume) => volume.name === "openbao-login")).toBe(false);
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
