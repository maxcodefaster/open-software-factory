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
];
async function helm(args: string[]) {
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
    publishNotReadyAddresses?: boolean;
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec: {
        containers: Array<{
          name: string;
          image: string;
          command?: string[];
          env?: Array<{ name: string; value?: string }>;
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
  expect(dependencies).toHaveLength(4);
  for (const dependency of dependencies)
    expect(dependency.spec?.template?.spec.automountServiceAccountToken).toBe(false);
});

test("all standard service images retain the maintained exact upstream pins", async () => {
  const all = await resources();
  const compose = parse(await readFile("deploy/local/compose.yaml", "utf8"));
  const expected = {
    postgres: compose.services.postgres.image,
    forgejo: compose.services.forgejo.image,
    zero: compose.services["zero-cache"].image,
    openbao: upstream.openbao.image,
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
