import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  overlaySubstrateEgress,
  parseEnvoy,
  verifySubstrateLiveClusters,
} from "./substrate-egress";
import { flags, pins, renderSubstrateProfile, verifyNightly } from "./substrate-profile";
import { applySubstrateEgress } from "./substrate-profile-command";

const input = {
  namespace: "profile-proof",
  pool: "profile-worker",
  node: "profile-node",
  workerImage: `registry.example/worker@sha256:${"a".repeat(64)}`,
  workloadImage: `registry.example/workload@sha256:${"b".repeat(64)}`,
  template: "profile-workload",
  command: ["sleep", "infinity"],
};

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

describe("Substrate concrete profile", () => {
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
    });
    expect(profile.actorTemplate.workerSelector.matchLabels).toEqual(
      profile.workerPool.metadata.labels,
    );
    expect(profile.actorTemplate.snapshotConfig.preferredFidelity).toBe("SNAPSHOT_FIDELITY_ROOTFS");
    const container = profile.actorTemplate.containers[0];
    expect(container?.securityContext).toEqual({ capabilities: { add: ["SETUID", "SETGID"] } });
    expect(container?.command).toEqual(["/opt/factory-rootless/start.sh", "sleep", "infinity"]);
    expect(container?.wakeupProbe.httpGet).toEqual({ path: "/readyz", port: 18081 });
    expect(profile.actorTemplate.volumes[1]?.systemInfo?.dataSources[0]?.trustBundle.names).toEqual(
      ["egress-mitm.ate.dev", "system-roots.ate.dev"],
    );
    expect(JSON.stringify(profile)).not.toContain("/var/run/docker.sock");
    expect(JSON.stringify(profile)).not.toContain("hostPath");
  });

  test.each([
    { workerImage: "worker:latest" },
    { workloadImage: "workload:latest" },
    { namespace: "default/escape" },
    { node: "-wrong" },
    { node: "invalid..hostname" },
    { command: [] },
    { privileged: true },
    { architecture: "arm64" },
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
    expect(pins.gvisor.sha512).toBe(
      "02fb9b8b49fc2bdcb7ff9f2a8a4159219f416c0f670ffc54c401651e53081454d3fbce54d7783bd2c3d1bf246fd677d9ec04934e3c3f64605050b26dd433b114",
    );
    expect(pins.gvisor.runscSha256).toBe(
      "4b2be59adc0da986d3dbb2e081bbf73e986e943fe9c4fa1b1433c72fb18100f0",
    );
    expect(() => verifyNightly(new Uint8Array([0]))).toThrow("checksums");
    const worker = await readFile(
      new URL("../../deploy/substrate/Worker.Dockerfile", import.meta.url),
      "utf8",
    );
    expect(worker).toContain(`FROM ${pins.substrate.workerImage}\n`);
    expect(worker.match(/^COPY /gm)).toHaveLength(1);
    expect(worker).not.toContain("RUN ");
    const rootless = await readFile(
      new URL("../../deploy/substrate/rootless/Dockerfile", import.meta.url),
      "utf8",
    );
    expect(rootless).toContain("setcap -r /usr/bin/newuidmap -r /usr/bin/newgidmap");
    expect(rootless).toContain("chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap");
    expect(rootless).not.toContain("--privileged");
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
