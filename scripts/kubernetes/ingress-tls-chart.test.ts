import { expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { parseAllDocuments } from "yaml";

type Resource = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  type?: string;
  data?: Record<string, string>;
  spec?: {
    tls?: Array<{ secretName: string; hosts: string[] }>;
    schedule?: string;
    concurrencyPolicy?: string;
    template?: { spec: Pod };
    jobTemplate?: { spec: { template: { spec: Pod } } };
  };
  rules?: Array<{
    apiGroups: string[];
    resources: string[];
    resourceNames: string[];
    verbs: string[];
  }>;
};
type Pod = {
  serviceAccountName: string;
  containers: Array<{ name: string; command: string[]; volumeMounts?: Array<{ name: string }> }>;
  initContainers?: Pod["containers"];
  volumes: Array<{
    name: string;
    secret?: { secretName: string; items: Array<{ key: string; path: string }> };
    projected?: {
      sources: Array<{ secret: { name: string; items: Array<{ key: string; path: string }> } }>;
    };
  }>;
};
const hosts = ["factory.example.com", "git.example.com", "*.runtime.factory.example.com"] as const;
async function render(extra: string[] = []) {
  const child = Bun.spawn(
    [
      "helm",
      "template",
      "portable",
      "deploy/helm/factory",
      "--namespace",
      "factory-proof",
      "--set-string",
      `image=registry.example/factory@sha256:${"a".repeat(64)}`,
      "--set",
      "publicURL=https://factory.example.com",
      "--set",
      "forgejoPublicURL=https://git.example.com",
      "--set",
      "substrate.workspaceConfigurationSecret=native-workspaces",
      "--set",
      "substrate.provisionerTokenSecret=native-provisioner",
      "--set",
      "ingress.enabled=true",
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(stderr);
  return parseAllDocuments(stdout).map((document) => {
    if (document.errors.length) throw document.errors[0];
    return document.toJSON() as Resource;
  });
}

test("Ingress supplies its own retained CA and valid certificates without host certificate inputs", async () => {
  const all = await render();
  const root = all.find(
    (item) => item.kind === "Secret" && item.metadata.name === "portable-ingress-ca",
  );
  const leaf = all.find(
    (item) => item.kind === "Secret" && item.metadata.name === "portable-ingress-tls",
  );
  expect(root?.kind).toBe("Secret");
  expect(leaf?.type).toBe("kubernetes.io/tls");
  const decode = (item: Resource | undefined, key: string) =>
    Buffer.from(item?.data?.[key] ?? "", "base64").toString();
  const ca = new X509Certificate(decode(root, "ca.crt"));
  const certificate = new X509Certificate(decode(leaf, "tls.crt"));
  expect(ca.ca).toBe(true);
  expect(ca.verify(ca.publicKey)).toBe(true);
  expect(ca.checkPrivateKey(createPrivateKey(decode(root, "ca.key")))).toBe(true);
  expect(certificate.ca).toBe(false);
  expect(certificate.verify(ca.publicKey)).toBe(true);
  expect(certificate.checkPrivateKey(createPrivateKey(decode(leaf, "tls.key")))).toBe(true);
  expect(certificate.checkHost(hosts[0])).toBe(hosts[0]);
  expect(certificate.checkHost(hosts[1])).toBe(hosts[1]);
  expect(certificate.checkHost("qa.runtime.factory.example.com")).toBe(hosts[2]);
  expect(certificate.checkHost("other.example.com")).toBeUndefined();
  expect(decode(leaf, "ca.crt")).toBe(decode(root, "ca.crt"));
  for (const resource of [root, leaf]) {
    expect(resource?.metadata.annotations?.["helm.sh/resource-policy"]).toBe("keep");
    expect(resource?.metadata.annotations?.["factory.dev/tls-hosts"]).toBe(JSON.stringify(hosts));
  }
  const ingress = all.find((item) => item.kind === "Ingress");
  expect(ingress?.spec?.tls).toEqual([{ secretName: "portable-ingress-tls", hosts: [...hosts] }]);
});

test("only issuer containers mount the signing key and the renewal Job can patch only its leaf Secret", async () => {
  const all = await render();
  const job = all.find(
    (item) => item.kind === "CronJob" && item.metadata.name.endsWith("-ingress-tls"),
  );
  expect(job?.spec?.schedule).toBe("43 3 * * *");
  expect(job?.spec?.concurrencyPolicy).toBe("Forbid");
  const pod = job?.spec?.jobTemplate?.spec.template.spec;
  expect(pod?.serviceAccountName).toBe("portable-ingress-tls");
  expect(pod?.containers[0]?.command).toEqual(["bun", "scripts/kubernetes/ingress-tls.ts"]);
  const role = all.find(
    (item) => item.kind === "Role" && item.metadata.name.endsWith("-ingress-tls"),
  );
  expect(role?.rules).toEqual([
    {
      apiGroups: [""],
      resources: ["secrets"],
      resourceNames: ["portable-ingress-tls"],
      verbs: ["get", "patch"],
    },
  ]);
  const application = all.find((item) => item.kind === "Deployment")?.spec?.template?.spec;
  const ownershipScript =
    application?.initContainers
      ?.find((container) => container.name === "own-state")
      ?.command.join("\n") ?? "";
  expect(ownershipScript).toContain("chmod 0700 /var/lib/factory");
  expect(ownershipScript.indexOf("chmod 0700")).toBeLessThan(
    ownershipScript.indexOf('test -e "$marker"'),
  );
  const projection = application?.volumes.find((item) => item.name === "substrate-configuration");
  expect(projection?.projected?.sources).toEqual([
    {
      secret: {
        name: "native-workspaces",
        items: [{ key: "configuration.json", path: "configuration.json" }],
      },
    },
    { secret: { name: "portable-ingress-ca", items: [{ key: "ca.crt", path: "factory-ca.pem" }] } },
  ]);
  expect(application?.containers[0]?.volumeMounts?.map((mount) => mount.name)).not.toContain(
    "ingress-ca",
  );
  expect(
    application?.initContainers
      ?.find((container) => container.name === "ensure-ingress-tls")
      ?.volumeMounts?.map((mount) => mount.name),
  ).toContain("ingress-ca");
  expect(JSON.stringify(pod)).toContain('"key":"ca.key"');
});

test("an operator certificate keeps external trust ownership and adds no issuer or renewal Job", async () => {
  const all = await render(["--set", "ingress.tlsSecret=enterprise-certificate"]);
  expect(all.some((item) => item.metadata.name === "portable-ingress-ca")).toBe(false);
  expect(all.some((item) => item.metadata.name === "portable-ingress-tls")).toBe(false);
  const ingress = all.find((item) => item.kind === "Ingress");
  expect(ingress?.spec?.tls?.[0]?.secretName).toBe("enterprise-certificate");
  const application = all.find((item) => item.kind === "Deployment")?.spec?.template?.spec;
  expect(
    application?.volumes.find((item) => item.name === "substrate-configuration")?.secret,
  ).toEqual({
    secretName: "native-workspaces",
    items: [
      { key: "configuration.json", path: "configuration.json" },
      { key: "factory-ca.pem", path: "factory-ca.pem" },
    ],
  });
});

test("managed issuance rejects two origins that collapse to the same Ingress hostname", async () => {
  await expect(render(["--set", "publicURL=https://git.example.com:444"])).rejects.toThrow(
    "distinct Factory and Forgejo DNS hostnames",
  );
});

test("online upgrades retain renewed leaves and refuse lost or changed CA ownership", async () => {
  const generated = (await render()).filter(
    (resource) =>
      resource.kind === "Secret" && resource.metadata.name.startsWith("portable-ingress-"),
  );
  const saved = new Map(generated.map((resource) => [resource.metadata.name, resource]));
  const discovery: Record<string, Array<[string, string, boolean]>> = {
    v1: [
      ["Secret", "secrets", true],
      ["ServiceAccount", "serviceaccounts", true],
      ["ConfigMap", "configmaps", true],
      ["Service", "services", true],
      ["PersistentVolumeClaim", "persistentvolumeclaims", true],
    ],
    "apps/v1": [
      ["Deployment", "deployments", true],
      ["StatefulSet", "statefulsets", true],
    ],
    "batch/v1": [
      ["Job", "jobs", true],
      ["CronJob", "cronjobs", true],
    ],
    "networking.k8s.io/v1": [
      ["Ingress", "ingresses", true],
      ["NetworkPolicy", "networkpolicies", true],
    ],
    "rbac.authorization.k8s.io/v1": [
      ["Role", "roles", true],
      ["RoleBinding", "rolebindings", true],
      ["ClusterRole", "clusterroles", false],
      ["ClusterRoleBinding", "clusterrolebindings", false],
    ],
  };
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response("Unexpected write", { status: 405 });
      if (path === "/api")
        return Response.json({ kind: "APIVersions", apiVersion: "v1", versions: ["v1"] });
      if (path === "/apis")
        return Response.json({
          kind: "APIGroupList",
          apiVersion: "v1",
          groups: Object.keys(discovery)
            .filter((version) => version !== "v1")
            .map((groupVersion) => ({
              name: groupVersion.split("/")[0],
              versions: [{ groupVersion, version: "v1" }],
              preferredVersion: { groupVersion, version: "v1" },
            })),
        });
      if (path === "/version")
        return Response.json({ major: "1", minor: "35", gitVersion: "v1.35.0" });
      const version = path === "/api/v1" ? "v1" : path.slice("/apis/".length);
      if (discovery[version])
        return Response.json({
          kind: "APIResourceList",
          apiVersion: "v1",
          groupVersion: version,
          resources: discovery[version].map(([kind, name, namespaced]) => ({
            name,
            singularName: kind.toLowerCase(),
            namespaced,
            kind,
            verbs: ["get"],
          })),
        });
      const name = path.match(/^\/api\/v1\/namespaces\/factory-proof\/secrets\/([^/]+)$/)?.[1];
      const resource = name ? saved.get(name) : undefined;
      return resource
        ? Response.json({ apiVersion: "v1", ...resource })
        : Response.json(
            { kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404 },
            { status: 404 },
          );
    },
  });
  const extra = [
    "--is-upgrade",
    "--dry-run=server",
    "--disable-openapi-validation",
    "--kube-apiserver",
    api.url.origin,
    "--kubeconfig",
    "/dev/null",
    "--kube-token",
    "isolated-test-token",
    "--set",
    "existingSecrets.credentials=external-credentials",
    "--set",
    "existingSecrets.objects=external-objects",
    "--set",
    "existingSecrets.openbaoTLS=external-openbao",
  ];
  try {
    const upgraded = (await render(extra)).filter(
      (resource) => resource.kind === "Secret" && saved.has(resource.metadata.name),
    );
    expect(upgraded).toHaveLength(2);
    for (const resource of upgraded)
      expect(resource.data).toEqual(saved.get(resource.metadata.name)?.data);
    const ca = saved.get("portable-ingress-ca");
    if (!ca) throw new Error("Missing test CA");
    saved.delete("portable-ingress-ca");
    await expect(render(extra)).rejects.toThrow("retained managed Ingress TLS identity is missing");
    saved.set("portable-ingress-ca", ca);
    ca.metadata.labels = { ...ca.metadata.labels, "app.kubernetes.io/instance": "another-owner" };
    await expect(render(extra)).rejects.toThrow("owner or hostnames changed");
  } finally {
    await api.stop(true);
  }
}, 15_000);
