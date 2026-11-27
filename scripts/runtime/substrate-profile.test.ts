import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  overlaySubstrateEgress,
  parseEnvoy,
  verifySubstrateLiveClusters,
} from "./substrate-egress";
import {
  flags,
  pins,
  planSubstrateRouterAdmission,
  renderSubstrateProfile,
  verifyNightly,
} from "./substrate-profile";
import { applySubstrateEgress, upstreamEgress } from "./substrate-profile-command";

const input = {
  architecture: "amd64",
  namespace: "profile-proof",
  pool: "profile-worker",
  node: "profile-node",
  workerImage: `registry.example/worker@sha256:${"a".repeat(64)}`,
  workloadImage: `registry.example/workload@sha256:${"b".repeat(64)}`,
  template: "profile-workload",
  command: ["sleep", "infinity"],
};

const nativeClientID = "spiffe://cluster.local/ns/ate-system/sa/atenet-client";
const factoryID = "spiffe://cluster.local/ns/factory-proof/sa/portable";
const allowlistFlag = "--ingress-allowed-spiffe-ids";

// Native v1.0.0 Envoy Router args; unrelated fields deliberately survive.
function routerFixture() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      namespace: "ate-system",
      name: "atenet-router",
      uid: "original-router-uid",
      resourceVersion: "42",
      annotations: { "operator.example/retained": "unchanged" },
    },
    spec: {
      replicas: 2,
      template: {
        spec: {
          volumes: [{ name: "podidentity", projected: { sources: [] } }],
          containers: [
            { name: "envoy", args: ["--config-path=/etc/envoy/envoy.yaml"] },
            {
              name: "atenet-router",
              args: [
                "router",
                "--mode=ingress",
                "--envoy-cert-path=/run/servicedns.podcert.ate.dev/credential-bundle.pem",
                "--ingress-client-ca-file=/run/podidentity.podcert.ate.dev/trust-bundle.pem",
                `${allowlistFlag}=${nativeClientID}`,
              ],
            },
          ],
        },
      },
    },
  };
}

describe("Substrate exact Router admission plan", () => {
  test("appends one native flag without revoking clients or changing any other field", () => {
    const deployment = routerFixture();
    const before = structuredClone(deployment);
    const originalArgs = before.spec.template.spec.containers[1]?.args;
    if (!originalArgs) throw new Error("Router fixture has no arguments");
    const plan = planSubstrateRouterAdmission(deployment, "factory-proof", "portable");
    const path = "/spec/template/spec/containers/1";
    expect(plan).toEqual({
      spiffeID: factoryID,
      allowedSPIFFEIDs: [nativeClientID],
      patch: [
        { op: "test", path: "/metadata/uid", value: "original-router-uid" },
        { op: "test", path: "/metadata/resourceVersion", value: "42" },
        { op: "test", path: `${path}/name`, value: "atenet-router" },
        { op: "test", path: `${path}/args`, value: originalArgs },
        { op: "add", path: `${path}/args/-`, value: `${allowlistFlag}=${factoryID}` },
      ],
    });
    expect(deployment).toEqual(before);
  });

  test("native local JSON patch preserves the object and refuses stale identity/version/argv", () => {
    const deployment = routerFixture();
    const { patch } = planSubstrateRouterAdmission(deployment, "factory-proof", "portable");
    // --local and stdin: no kubeconfig, discovery, network or Kubernetes mutation.
    const apply = (value: unknown) =>
      Bun.spawnSync(
        [
          "kubectl",
          "patch",
          "--local",
          "--type=json",
          "-f",
          "-",
          "-p",
          JSON.stringify(patch),
          "-o",
          "json",
        ],
        { stdin: Buffer.from(JSON.stringify(value)), stdout: "pipe", stderr: "pipe" },
      );
    const result = apply(deployment);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const expected = structuredClone(deployment);
    expected.spec.template.spec.containers[1]?.args.push(`${allowlistFlag}=${factoryID}`);
    const admitted = JSON.parse(result.stdout.toString());
    expect(admitted).toEqual(expected);
    expect(planSubstrateRouterAdmission(admitted, "factory-proof", "portable").patch).toEqual([]);
    for (const metadata of [
      { ...deployment.metadata, uid: "replacement-router" },
      { ...deployment.metadata, resourceVersion: "43" },
    ])
      expect(apply({ ...deployment, metadata }).exitCode).not.toBe(0);
    const changed = structuredClone(deployment);
    changed.spec.template.spec.containers.reverse();
    expect(apply(changed).exitCode).not.toBe(0);
    changed.spec.template.spec.containers.reverse();
    changed.spec.template.spec.containers[1]?.args.push("--log-level=debug");
    expect(apply(changed).exitCode).not.toBe(0);
  });

  test("retains comma-separated, repeated and split native flags and checks exact membership", () => {
    const deployment = routerFixture();
    const args = deployment.spec.template.spec.containers[1]?.args;
    if (!args) throw new Error("fixture");
    const other = "spiffe://cluster.local/ns/operations/sa/other.client";
    args.push(allowlistFlag, `${other},${factoryID}-other`);
    const before = structuredClone(deployment);
    const plan = planSubstrateRouterAdmission(deployment, "factory-proof", "portable");
    expect(plan.allowedSPIFFEIDs).toEqual([nativeClientID, other, `${factoryID}-other`]);
    expect(plan.patch.at(-1)?.value).toBe(`${allowlistFlag}=${factoryID}`);
    expect(deployment).toEqual(before);
    args.push(`${allowlistFlag}=${factoryID}`);
    expect(planSubstrateRouterAdmission(deployment, "factory-proof", "portable").patch).toEqual([]);
  });

  test("handles default deny and installer regeneration without inventing a default identity", () => {
    const deployment = routerFixture();
    deployment.spec.template.spec.containers[1]?.args.pop();
    for (const existing of [[], [`${allowlistFlag}=`]]) {
      const current = structuredClone(deployment);
      current.spec.template.spec.containers[1]?.args.push(...existing);
      const plan = planSubstrateRouterAdmission(current, "x", "factory.client");
      expect(plan.allowedSPIFFEIDs).toEqual([]);
      expect(plan.patch.at(-1)?.value).toBe(
        `${allowlistFlag}=spiffe://cluster.local/ns/x/sa/factory.client`,
      );
    }
    expect(
      planSubstrateRouterAdmission(routerFixture(), "factory-proof", "portable").patch,
    ).toHaveLength(5);
  });

  test.each([
    ["", "factory"],
    ["factory", ""],
    ["*", "factory"],
    ["factory", "*"],
    ["factory/ns/other", "factory"],
    ["factory", "factory?query"],
    ["Factory", "factory"],
    ["factory", "../atenet-client"],
    ["factory", "a".repeat(64)],
    ["a".repeat(64), "factory"],
  ])("rejects nonliteral installation identity %s/%s", (namespace, serviceAccount) => {
    expect(() =>
      planSubstrateRouterAdmission(routerFixture(), namespace, serviceAccount),
    ).toThrow();
  });

  test.each([
    { uid: undefined },
    { resourceVersion: undefined },
    { uid: "" },
    { name: "other-router" },
    { namespace: "other-installation" },
  ])("refuses an unbound or wrong Router %j", (change) => {
    const deployment = routerFixture();
    expect(() =>
      planSubstrateRouterAdmission(
        { ...deployment, metadata: { ...deployment.metadata, ...change } },
        "factory-proof",
        "portable",
      ),
    ).toThrow();
  });

  test.each([
    (args: string[]) => args.slice(1),
    (args: string[]) => [...args, "--"],
    (args: string[]) => [...args, "--mode=egress"],
    (args: string[]) => [...args, "--atenet-dataplane=agentgateway"],
    (args: string[]) => args.filter((arg) => !arg.startsWith("--ingress-client-ca-file=")),
    (args: string[]) => [...args, "--ingress-client-ca-file=/untrusted.pem"],
    (args: string[]) => [...args, "--envoy-cert-path="],
    (args: string[]) => [...args, `${allowlistFlag}=*`],
    (args: string[]) => [...args, `${allowlistFlag}=spiffe://cluster.local/ns/*/sa/*`],
    (args: string[]) => [...args, `${allowlistFlag}=${factoryID}/`],
    (args: string[]) => [...args, `${allowlistFlag}=${nativeClientID},`],
    (args: string[]) => [...args, allowlistFlag],
  ])("refuses unsupported argv, weakened trust and ambiguous allowlists %#", (change) => {
    const deployment = routerFixture();
    const router = deployment.spec.template.spec.containers[1];
    if (!router) throw new Error("fixture");
    router.args = change(router.args);
    expect(() => planSubstrateRouterAdmission(deployment, "factory-proof", "portable")).toThrow();
  });

  test("requires one named Router container, regardless of its index", () => {
    const deployment = routerFixture();
    deployment.spec.template.spec.containers.pop();
    expect(() => planSubstrateRouterAdmission(deployment, "factory-proof", "portable")).toThrow(
      "exactly one",
    );
    const duplicate = routerFixture();
    const router = duplicate.spec.template.spec.containers[1];
    if (!router) throw new Error("fixture");
    duplicate.spec.template.spec.containers.push({ ...router });
    expect(() => planSubstrateRouterAdmission(duplicate, "factory-proof", "portable")).toThrow(
      "exactly one",
    );
  });
});

// Focused fixture follows the two actual v1.0.0 origin TLS contexts, not the
// obsolete four-cluster workaround. check-upstream additionally uses the entire
// actual pinned upstream bootstrap and the exact native upstream wire schemas.
function fixture() {
  const cluster = (name: string) => ({
    name,
    cluster_type: {
      name: "envoy.clusters.dynamic_forward_proxy",
      typed_config: {
        "@type":
          "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig",
        dns_cache_config: { name: "egress_dns_cache", dns_lookup_family: "ALL" },
      },
    },
    typed_extension_protocol_options: {
      "envoy.extensions.upstreams.http.v3.HttpProtocolOptions": {
        "@type": "type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions",
        upstream_http_protocol_options: { auto_sni: true, auto_san_validation: true },
        auto_config: { http_protocol_options: {}, http2_protocol_options: {} },
      },
    },
    transport_socket: {
      name: "envoy.transport_sockets.tls",
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
        common_tls_context: {
          validation_context: { trusted_ca: { filename: "/etc/ssl/certs/ca-certificates.crt" } },
        },
      },
    },
  });
  const expected = {
    static_resources: {
      clusters: [cluster("egress_forward_proxy"), cluster("egress_forward_proxy_grpc")],
      // Seven locations total, including listener/filter DNS caches upstream.
      listeners: Array.from({ length: 5 }, (_, i) => ({
        name: `listener-${i}`,
        dns_lookup_family: "ALL",
      })),
      policy: { module: "envoy_substrate_egress_policy", enabled: true },
    },
  };
  const map = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "atenet-egress",
      namespace: "ate-system",
      uid: "unchanged-uid",
      resourceVersion: "42",
    },
    data: { "envoy.yaml": stringify(expected), "sds-cert.yaml": "unaltered SDS projection" },
  };
  return { map, expected };
}

// v1.0.1 shares one address-filtered DNS cache across seven uses, and one
// local-reply config across two HTTP listeners. stringify emits native aliases.
function aliasFixture() {
  const { map, expected: original } = fixture();
  const dns = {
    name: "egress_dns_cache",
    dns_lookup_family: "ALL",
    resolved_address_filter: { ranges: [{ address_prefix: "127.0.0.0", prefix_len: 8 }] },
  };
  const reply = { mappers: [{ status_code: 403 }] };
  for (const cluster of original.static_resources.clusters)
    cluster.cluster_type.typed_config.dns_cache_config = dns;
  const expected = {
    static_resources: {
      ...original.static_resources,
      listeners: Array.from({ length: 5 }, (_, i) => ({
        name: `listener-${i}`,
        dns_cache_config: dns,
        ...(i < 2 ? { local_reply_config: reply } : {}),
      })),
    },
  };
  map.data["envoy.yaml"] = stringify(expected);
  return { map, expected };
}

const unsafeAliases = [
  ["unresolved alias", "value: *missing\n", /Unresolved alias/],
  ["mapping cycle", "value: &cycle {self: *cycle}\n", /circular|cyclic/i],
  ["sequence cycle", "value: &cycle [*cycle]\n", /circular|cyclic/i],
  [
    "indirect cycle",
    "value: &outer {inner: &inner {parent: *outer}, again: *inner}\n",
    /circular|cyclic/i,
  ],
  [
    "too many references",
    `value: &value scalar\nreferences: [${Array(100).fill("*value").join(", ")}]\n`,
    /Excessive alias count/,
  ],
  [
    "exponential graph",
    `a: &a [scalar, scalar]\nb: &b [${Array(10).fill("*a").join(", ")}]\nc: [${Array(10).fill("*b").join(", ")}]\n`,
    /Excessive alias count/,
  ],
  ["duplicate key", "value: &value scalar\nvalue: *value\n", /Invalid.*YAML/],
] as const;

describe("Substrate bounded manifest aliases", () => {
  test("resolves the minimal v1.0.1 shared DNS cache", () => {
    const cache = { name: "egress_dns_cache", dns_lookup_family: "ALL" };
    expect(
      parseEnvoy(
        "first: &egress_dns_cache {name: egress_dns_cache, dns_lookup_family: ALL}\nsecond: *egress_dns_cache\n",
      ),
    ).toEqual({ first: cache, second: cache });
  });

  test("accepts references up to the native bound", () => {
    expect(
      parseEnvoy(`value: &value scalar\nreferences: [${Array(99).fill("*value").join(", ")}]\n`),
    ).toEqual({ value: "scalar", references: Array(99).fill("scalar") });
  });

  test.each(unsafeAliases)("Envoy rejects %s", (_, text, message) => {
    expect(() => parseEnvoy(text)).toThrow(message);
  });

  test("upstream reader resolves bounded aliases and retains source/ConfigMap checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-substrate-aliases-"));
    let head = pins.substrate.commit;
    let dirty = "";
    const spawn = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
      const command = args[0] as string[];
      expect(command.slice(0, 3)).toEqual(["git", "-C", directory]);
      expect(["rev-parse", "status"]).toContain(command[3] ?? "");
      return {
        stdout: new Response(command[3] === "rev-parse" ? `${head}\n` : dirty).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
      } as ReturnType<typeof Bun.spawn>;
    });
    try {
      await mkdir(join(directory, "manifests/ate-install"), { recursive: true });
      const path = join(directory, "manifests/ate-install/atenet-egress.yaml");
      const { map } = aliasFixture();
      const manifest = `${stringify(map)}\n---\nkind: Deployment\nmetadata: &metadata {name: atenet-egress}\nspec: {metadata: *metadata}\n`;
      await writeFile(path, manifest);
      expect(await upstreamEgress(directory)).toEqual(map.data);

      head = "0".repeat(40);
      await expect(upstreamEgress(directory)).rejects.toThrow("Wrong Substrate source commit");
      head = pins.substrate.commit;
      dirty = " M manifests/ate-install/atenet-egress.yaml\n";
      await expect(upstreamEgress(directory)).rejects.toThrow("tracked changes");
      dirty = "";
      for (const [_, text, message] of unsafeAliases) {
        await writeFile(path, `${manifest}\n---\n${text}`);
        await expect(upstreamEgress(directory)).rejects.toThrow(message);
      }
      for (const invalid of [
        `${manifest}\n---\n${stringify(map)}`,
        manifest.replace("name: atenet-egress", "name: wrong-map"),
      ]) {
        await writeFile(path, invalid);
        await expect(upstreamEgress(directory)).rejects.toThrow("Unexpected upstream egress");
      }
    } finally {
      spawn.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Substrate concrete profile", () => {
  test("native atelet health patch pins shared-node tolerance without changing endpoints, periods or runtime intent", async () => {
    const patch = parse(
      await readFile(
        new URL("../../deploy/substrate/atelet-health-patch.yaml", import.meta.url),
        "utf8",
      ),
    );
    expect(patch).toEqual({
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: "atelet" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "atelet",
                readinessProbe: {
                  httpGet: { path: "/readyz", port: "health" },
                  periodSeconds: 2,
                  timeoutSeconds: 5,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: "health" },
                  periodSeconds: 10,
                  timeoutSeconds: 10,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    });
  });

  test("shared-node native API reserves scheduling headroom without changing worker or lifecycle limits", async () => {
    expect(
      parse(
        await readFile(
          new URL("../../deploy/substrate/api-resources-patch.yaml", import.meta.url),
          "utf8",
        ),
      ),
    ).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "ate-api-server" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "ate-api-server",
                resources: { requests: { cpu: "50m", memory: "128Mi" } },
              },
            ],
          },
        },
      },
    });
  });

  test("native router recovers its drained Envoy through probes without exposing admin or changing runtime intent", async () => {
    const patch = parse(
      await readFile(
        new URL("../../deploy/substrate/router-health-patch.yaml", import.meta.url),
        "utf8",
      ),
    );
    const ready = { httpGet: { path: "/ready", port: "envoy-metrics" } };
    expect(patch).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "atenet-router" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "envoy",
                startupProbe: {
                  ...ready,
                  periodSeconds: 5,
                  timeoutSeconds: 5,
                  failureThreshold: 36,
                },
                livenessProbe: {
                  ...ready,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    });
  });

  test("ARM profile uses the official ARM archive and pins worker placement without changing amd64 assets", () => {
    const profile = renderSubstrateProfile({ ...input, architecture: "arm64" });
    expect(profile.sandboxConfig.spec.versions[0]?.assets.arm64.gvisor).toEqual({
      url: "gs://gvisor/releases/nightly/2026-11-09/aarch64/gvisor.tar.zstd",
      sha256: "92bfb81fecb71248a2ccebe78652cc0219c33c8fd62b708666c66c1bbac3c22d",
    });
    expect(profile.sandboxConfig.spec.versions[0]?.assets.amd64.gvisor.sha256).toBe(
      "1d9120e4aa42ff7d9653f3f265219b68bd1674a23cee389c6a935ce7357ba9b5",
    );
    expect(profile.workerPool.spec.template.nodeSelector).toEqual({
      "kubernetes.io/hostname": input.node,
      "kubernetes.io/os": "linux",
      "kubernetes.io/arch": "arm64",
    });
  });

  test("real render command repeats safely and never overwrites different output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factory-substrate-profile-"));
    try {
      const path = join(directory, "input.json");
      await writeFile(path, JSON.stringify(input));
      const run = async () => {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            new URL("./substrate-profile-command.ts", import.meta.url).pathname,
            "render",
            path,
            directory,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        await new Response(child.stderr).text();
        return child.exited;
      };
      expect(await run()).toBe(0);
      const before = await readFile(join(directory, "actorTemplate.json"), "utf8");
      expect(await run()).toBe(0);
      expect(await readFile(join(directory, "actorTemplate.json"), "utf8")).toBe(before);
      await writeFile(join(directory, "sandboxConfig.json"), "user-owned output\n");
      expect(await run()).not.toBe(0);
      expect(await readFile(join(directory, "sandboxConfig.json"), "utf8")).toBe(
        "user-owned output\n",
      );
      await unlink(join(directory, "sandboxConfig.json"));
      await symlink(join(directory, "actorTemplate.json"), join(directory, "sandboxConfig.json"));
      expect(await run()).not.toBe(0);
      expect(await readFile(join(directory, "actorTemplate.json"), "utf8")).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("renders native pinned manifests without changing a class default", () => {
    const profile = renderSubstrateProfile(input);
    expect(profile).toEqual(renderSubstrateProfile(input));
    expect(profile.sandboxConfig.spec.defaultVersion).toBe("nightly-20261109-975fb172241c");
    expect(profile.sandboxConfig.metadata).toEqual({ name: pins.gvisor.version });
    expect(profile.sandboxConfig.spec.versions[0]?.assets.amd64.gvisor).toEqual({
      url: "gs://gvisor/releases/nightly/2026-11-09/x86_64/gvisor.tar.zstd",
      sha256: "1d9120e4aa42ff7d9653f3f265219b68bd1674a23cee389c6a935ce7357ba9b5",
    });
    expect(profile.workerPool.spec.replicas).toBe(1);
    expect(profile.workerPool.spec.template.nodeSelector).toEqual({
      "kubernetes.io/hostname": input.node,
      "kubernetes.io/os": "linux",
      "kubernetes.io/arch": "amd64",
    });
    expect(profile.actorTemplate.workerSelector.matchLabels).toEqual(
      profile.workerPool.metadata.labels,
    );
    expect(profile.actorTemplate.snapshotConfig.preferredFidelity).toBe("SNAPSHOT_FIDELITY_MEMORY");
    const container = profile.actorTemplate.containers[0];
    expect(container?.image).toBe(input.workloadImage);
    expect(container?.securityContext).toEqual({ capabilities: { drop: ["ALL"] } });
    expect(container?.command).toEqual(input.command);
    expect(container).not.toHaveProperty("wakeupProbe");
    expect(container?.volumeMounts).toEqual([
      { name: "trust", mountPath: "/run/ate/egress-trust-bundle" },
    ]);
    expect(container?.env).toEqual(
      [
        "SSL_CERT_FILE",
        "GIT_SSL_CAINFO",
        "NODE_EXTRA_CA_CERTS",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
      ].map((name) => ({ name, value: "/run/ate/egress-trust-bundle/trust-bundle.pem" })),
    );
    expect(profile.actorTemplate.volumes).toHaveLength(1);
    expect(profile.actorTemplate.volumes[0]?.systemInfo?.dataSources[0]?.trustBundle.names).toEqual(
      ["egress-mitm.ate.dev", "system-roots.ate.dev"],
    );
    expect(JSON.stringify(profile)).not.toContain("/var/run/docker.sock");
    expect(JSON.stringify(profile)).not.toContain("hostPath");
    expect(JSON.stringify(profile)).not.toMatch(/rootless|factory-rootless|HTTP_PROXY|HTTPS_PROXY/);
    expect(JSON.stringify(profile.actorTemplate)).not.toMatch(
      /podidentity|substrate-control|substrate-provisioner|credential-bundle|atenet-client/,
    );
  });

  test("passes the exact native workload argv without inserting a bootstrap or shell", () => {
    const command = ["/usr/local/bin/project", "--message", "two words", "$NOT_EXPANDED"];
    expect(
      renderSubstrateProfile({ ...input, command }).actorTemplate.containers[0]?.command,
    ).toEqual(command);
  });

  test.each([
    { workerImage: "worker:latest" },
    { workloadImage: "workload:latest" },
    { namespace: "default/escape" },
    { node: "-wrong" },
    { node: "invalid..hostname" },
    { command: [] },
    { privileged: true },
    { architecture: "riscv64" },
    { architecture: undefined },
  ])("rejects unsupported, ambiguous or unsafe inputs %j", (change) => {
    expect(() => renderSubstrateProfile({ ...input, ...change })).toThrow();
  });

  test("accepts one-character Kubernetes names without inventing an additional restriction", () => {
    expect(
      renderSubstrateProfile({ ...input, namespace: "x", node: "a.b" }).workerPool.metadata
        .namespace,
    ).toBe("x");
  });

  test("pins official assets and unchanged release worker, never disguises nightly as v7", async () => {
    expect(pins.substrate.release).toBe("v1.0.0");
    expect(pins.substrate.commit).toBe("b34fbee742906494b5eb4f1f36987176bf8770a4");
    expect(pins.gvisor.commit).toBe("975fb172241c7946a9f67b4f52e0349d9240589a");
    expect(pins.gvisor.architectures.amd64.sha512).toBe(
      "02fb9b8b49fc2bdcb7ff9f2a8a4159219f416c0f670ffc54c401651e53081454d3fbce54d7783bd2c3d1bf246fd677d9ec04934e3c3f64605050b26dd433b114",
    );
    expect(pins.gvisor.architectures.amd64.runscSha256).toBe(
      "4b2be59adc0da986d3dbb2e081bbf73e986e943fe9c4fa1b1433c72fb18100f0",
    );
    for (const architecture of ["amd64", "arm64"] as const)
      expect(() => verifyNightly(new Uint8Array([0]), architecture)).toThrow("checksums");
    const worker = await readFile(
      new URL("../../deploy/substrate/Worker.Dockerfile", import.meta.url),
      "utf8",
    );
    expect(worker).toContain(`FROM ${pins.substrate.workerImage}\n`);
    expect(worker.match(/^COPY /gm)).toHaveLength(1);
    expect(worker).not.toContain("RUN ");
    expect(
      await Bun.file(
        new URL("../../deploy/substrate/rootless/Dockerfile", import.meta.url),
      ).exists(),
    ).toBe(false);
    expect(flags.globalFlags).toEqual([
      "-log-format",
      "json",
      "--alsologtostderr",
      "--allow-suid",
      "--host-settings=ignore",
      "--net-raw",
      "--allow-packet-socket-write",
      "--tar-timestamp-resolution=nanoseconds",
    ]);
    expect(flags.commands.restore.subcommandFlags).toEqual(["-background", "-detach"]);
  });
});

describe("Substrate Envoy operator overlay", () => {
  test("preserves v1.0.1 aliased address filters, TLS and identity through repeated overlays", () => {
    const { map, expected } = aliasFixture();
    expect(map.data["envoy.yaml"]).toMatch(/\*a\d/);
    const before = structuredClone(map);
    const once = overlaySubstrateEgress(map, expected);
    expect(map).toEqual(before);
    expect((once as typeof map).metadata).toEqual(map.metadata);
    expect(once.data["sds-cert.yaml"]).toBe(map.data["sds-cert.yaml"]);
    expect(overlaySubstrateEgress(once, expected)).toEqual(once);
    const patched = parseEnvoy(once.data["envoy.yaml"] ?? "");
    const wanted = JSON.parse(
      JSON.stringify(expected).replaceAll(
        '"dns_lookup_family":"ALL"',
        '"dns_lookup_family":"V4_ONLY"',
      ),
    );
    for (const cluster of wanted.static_resources.clusters)
      cluster.transport_socket.typed_config.max_session_keys = 0;
    expect(patched).toEqual(wanted);
    expect(
      verifySubstrateLiveClusters(
        { configs: wanted.static_resources.clusters.map((cluster: unknown) => ({ cluster })) },
        expected,
      ),
    ).toEqual(["egress_forward_proxy", "egress_forward_proxy_grpc"]);
    const weakened = JSON.parse(JSON.stringify(wanted));
    delete weakened.static_resources.listeners[0].dns_cache_config.resolved_address_filter;
    expect(() =>
      overlaySubstrateEgress(
        { ...map, data: { ...map.data, "envoy.yaml": stringify(weakened) } },
        expected,
      ),
    ).toThrow("drift");
  });

  test("operator path uses UID/resourceVersion, rolls out, live-verifies, repeats and repairs installer regeneration", async () => {
    const { map, expected } = fixture();
    let current = structuredClone(map);
    const events: string[][] = [];
    let verified = 0;
    const ports = {
      upstream: async () => map.data,
      run: async (args: string[], stdin?: string) => {
        events.push(args);
        const action = args.slice(7);
        if (action[0] === "get" && action[1] === "configmap") return JSON.stringify(current);
        if (action[0] === "replace") {
          const value = JSON.parse(stdin ?? "null");
          expect(value.metadata).toEqual(map.metadata);
          current = value;
          return "replaced";
        }
        if (action[0] === "get" && action[1] === "deployment")
          return JSON.stringify({
            metadata: { name: "atenet-egress", uid: "deployment-uid", resourceVersion: "56" },
          });
        if (action[0] === "patch") {
          expect(JSON.parse(action.at(-1) ?? "null").metadata).toEqual({
            uid: "deployment-uid",
            resourceVersion: "56",
          });
          return "patched";
        }
        if (action[0] === "rollout") return "rolled out";
        throw new Error(`Unexpected command ${JSON.stringify(args)}`);
      },
      live: async (k: string[], bootstrap: Record<string, unknown>, port: string) => {
        expect(k).toContain("explicit-context");
        expect(k).toContain("--kubeconfig");
        expect(port).toBe("18195");
        expect(bootstrap).toEqual(expected);
        verified++;
        return { verifiedReadyPods: ["egress-pod"], tlsSessionResumption: false };
      },
    };
    const apply = (enabled: boolean) =>
      applySubstrateEgress(
        "source",
        "/owned/kubeconfig",
        "explicit-context",
        "18195",
        enabled,
        ports,
      );
    await expect(apply(false)).rejects.toThrow("not applied");
    expect(events.some((event) => event.includes("replace"))).toBe(false);
    await apply(true);
    await apply(true);
    expect(events.filter((event) => event.includes("replace"))).toHaveLength(1);
    expect(events.filter((event) => event.includes("rollout"))).toHaveLength(2);
    current = structuredClone(map);
    await apply(true);
    await apply(false);
    expect(events.filter((event) => event.includes("replace"))).toHaveLength(2);
    expect(verified).toBe(4);
    current.data["envoy.yaml"] = current.data["envoy.yaml"].replaceAll(
      "auto_sni: true",
      "auto_sni: false",
    );
    const count = events.length;
    await expect(apply(true)).rejects.toThrow("drift");
    expect(events.slice(count).every((event) => event.includes("get"))).toBe(true);
  });
  test("sets both sibling max_session_keys and seven IPv4 fields; is idempotent and regeneration safe", () => {
    const { map, expected } = fixture();
    const before = structuredClone(map);
    const once = overlaySubstrateEgress(map, expected);
    expect(map).toEqual(before);
    expect(once).toEqual(overlaySubstrateEgress(once, expected));
    expect(once).toEqual(overlaySubstrateEgress(structuredClone(map), expected));
    expect((once as typeof map).metadata).toEqual(map.metadata);
    expect(once.data["sds-cert.yaml"]).toBe(map.data["sds-cert.yaml"]);
    const patched = parseEnvoy(once.data["envoy.yaml"] ?? "");
    const original = JSON.stringify(expected);
    expect(original).not.toContain("max_session_keys");
    expect(JSON.stringify(patched).match(/"max_session_keys":0/g)).toHaveLength(2);
    expect(JSON.stringify(patched).match(/"dns_lookup_family":"V4_ONLY"/g)).toHaveLength(7);
    const wanted = structuredClone(expected);
    for (const cluster of wanted.static_resources.clusters)
      Object.assign(cluster.transport_socket.typed_config, { max_session_keys: 0 });
    const ipv4 = JSON.parse(
      JSON.stringify(wanted).replaceAll(
        '"dns_lookup_family":"ALL"',
        '"dns_lookup_family":"V4_ONLY"',
      ),
    );
    expect(patched).toEqual(ipv4);
  });

  test.each([
    [
      "missing cluster",
      (text: string) => text.replace("egress_forward_proxy_grpc", "not-the-cluster"),
    ],
    [
      "wrong CA",
      (text: string) => text.replaceAll("/etc/ssl/certs/ca-certificates.crt", "/untrusted.pem"),
    ],
    [
      "disabled SAN",
      (text: string) => text.replaceAll("auto_san_validation: true", "auto_san_validation: false"),
    ],
    ["disabled SNI", (text: string) => text.replaceAll("auto_sni: true", "auto_sni: false")],
    [
      "pooling drift",
      (text: string) =>
        text.replaceAll(
          "http2_protocol_options: {}",
          "http2_protocol_options: {max_concurrent_streams: 1}",
        ),
    ],
    ["policy drift", (text: string) => text.replace("enabled: true", "enabled: false")],
    [
      "wrong DNS",
      (text: string) => text.replace("dns_lookup_family: ALL", "dns_lookup_family: V6_ONLY"),
    ],
    [
      "nested mitigation",
      (text: string) =>
        text.replaceAll(
          "common_tls_context:",
          "common_tls_context:\n            max_session_keys: 0",
        ),
    ],
    [
      "conflicting cache",
      (text: string) =>
        text.replaceAll("common_tls_context:", "max_session_keys: 10\n        common_tls_context:"),
    ],
    ["duplicate YAML", (text: string) => `${text}\nstatic_resources: {}\n`],
  ])("fails closed for %s", (_, change) => {
    const { map, expected } = fixture();
    map.data["envoy.yaml"] = change(map.data["envoy.yaml"]);
    expect(() => overlaySubstrateEgress(map, expected)).toThrow();
  });

  test("rejects duplicate clusters, extra TLS clusters, missing config and wrong ConfigMap identity", () => {
    const { map, expected } = fixture();
    for (const name of ["egress_forward_proxy", "extra-tls-cluster"]) {
      const bad = structuredClone(expected);
      const cluster = structuredClone(bad.static_resources.clusters[0]);
      if (!cluster) throw new Error("fixture");
      cluster.name = name;
      bad.static_resources.clusters.push(cluster);
      expect(() =>
        overlaySubstrateEgress({ ...map, data: { "envoy.yaml": stringify(bad) } }, expected),
      ).toThrow();
    }
    expect(() => overlaySubstrateEgress({ ...map, data: {} }, expected)).toThrow();
    expect(() =>
      overlaySubstrateEgress(
        { ...map, metadata: { name: "other", namespace: "ate-system" } },
        expected,
      ),
    ).toThrow();
  });

  test("a syntactically valid but nested max_session_keys fails closed", () => {
    const { map, expected } = fixture();
    const bad = structuredClone(expected);
    for (const cluster of bad.static_resources.clusters)
      Object.assign(cluster.transport_socket.typed_config.common_tls_context, {
        max_session_keys: 0,
      });
    expect(() =>
      overlaySubstrateEgress({ ...map, data: { "envoy.yaml": stringify(bad) } }, expected),
    ).toThrow("drift");
  });

  test("live verification rejects unmitigated, weakened, or partially loaded clusters", () => {
    const { map, expected } = fixture();
    const patched = parseEnvoy(
      overlaySubstrateEgress(map, expected).data["envoy.yaml"] ?? "",
    ) as typeof expected;
    const dump = { configs: patched.static_resources.clusters.map((cluster) => ({ cluster })) };
    expect(verifySubstrateLiveClusters(dump, expected)).toEqual([
      "egress_forward_proxy",
      "egress_forward_proxy_grpc",
    ]);
    expect(() =>
      verifySubstrateLiveClusters({ configs: dump.configs.slice(0, 1) }, expected),
    ).toThrow();
    expect(() =>
      verifySubstrateLiveClusters(
        { configs: expected.static_resources.clusters.map((cluster) => ({ cluster })) },
        expected,
      ),
    ).toThrow();
    const text = JSON.stringify(dump).replaceAll('"auto_sni":true', '"auto_sni":false');
    expect(() => verifySubstrateLiveClusters(JSON.parse(text), expected)).toThrow();
  });
});
