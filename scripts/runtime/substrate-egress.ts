import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const configMap = z.object({
  apiVersion: z.literal("v1"),
  kind: z.literal("ConfigMap"),
  metadata: z.object({ name: z.literal("atenet-egress"), namespace: z.literal("ate-system") }),
  data: z.record(z.string(), z.string()),
});
export const tlsClusters = ["egress_forward_proxy", "egress_forward_proxy_grpc"];
const tlsType = "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext";
const httpType = "envoy.extensions.upstreams.http.v3.HttpProtocolOptions";

function record(value: unknown) {
  object.parse(value);
  return value as Record<string, unknown>;
}

export function parseEnvoy(text: string): Record<string, unknown> {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid or duplicate-key Envoy YAML");
  return object.parse(document.toJS({ maxAliasCount: 0 }));
}

function clusters(bootstrap: Record<string, unknown>) {
  return z.array(z.unknown()).parse(record(bootstrap["static_resources"])["clusters"]).map(record);
}

function contexts(items: Record<string, unknown>[]) {
  const names = items.map((item) => item["name"]);
  if (new Set(names).size !== names.length) throw new Error("Duplicate Envoy cluster");
  const upstreams = items.filter(
    (item) =>
      object.safeParse(item["transport_socket"]).success &&
      record(record(item["transport_socket"])["typed_config"])["@type"] === tlsType,
  );
  if (
    upstreams.length !== 2 ||
    !tlsClusters.every((name) => upstreams.some((item) => item["name"] === name))
  )
    throw new Error("Expected exactly the two pinned egress origin TLS clusters");
  return upstreams.map((cluster) => ({
    cluster,
    tls: record(record(cluster["transport_socket"])["typed_config"]),
  }));
}

function normalize(bootstrap: Record<string, unknown>, apply: boolean) {
  for (const { tls } of contexts(clusters(bootstrap))) {
    if ("max_session_keys" in tls && tls["max_session_keys"] !== 0)
      throw new Error("Unexpected existing TLS session cache setting");
    // Nested max_session_keys or weakened validation is rejected by the full
    // semantic comparison with the exact upstream bootstrap below.
    if (apply) tls["max_session_keys"] = 0;
    else delete tls["max_session_keys"];
  }
  let dns = 0;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "dns_lookup_family") {
        if (child !== "ALL" && child !== "V4_ONLY") throw new Error("Unexpected DNS family");
        (value as Record<string, unknown>)[key] = apply ? "V4_ONLY" : "ALL";
        dns++;
      } else visit(child);
    }
  };
  visit(bootstrap);
  if (dns !== 7) throw new Error("Expected exactly seven pinned IPv4 DNS overlay locations");
  return bootstrap;
}

// expected is read from the verified v1.0.0 checkout, never supplied by the CM.
// Comparing the ENTIRE bootstrap preserves policy filters and HTTP pooling, not
// just the two TLS snippets. Only the declared nine scalar edits are accepted.
export function overlaySubstrateEgress(value: unknown, expected: Record<string, unknown>) {
  const input = configMap.parse(value);
  const text = input.data["envoy.yaml"];
  if (!text) throw new Error("Missing envoy.yaml");
  const bootstrap = parseEnvoy(text);
  if (
    !isDeepStrictEqual(
      normalize(structuredClone(bootstrap), false),
      normalize(structuredClone(expected), false),
    )
  )
    throw new Error("Envoy configuration drift from pinned upstream; refusing to apply");
  const result = normalize(bootstrap, true);
  // Avoid rewriting a second time; preserve metadata/resourceVersion, SDS and
  // every other ConfigMap key, including any public-root certificate projection.
  const output = structuredClone(value) as { data: Record<string, string> };
  if (!isDeepStrictEqual(parseEnvoy(text), result)) output.data["envoy.yaml"] = stringify(result);
  return output;
}

// config_dump?resource=static_clusters only: never request SDS secrets.
export function verifySubstrateLiveClusters(value: unknown, expected: Record<string, unknown>) {
  const dump = z.object({ configs: z.array(z.object({ cluster: object })) }).parse(value);
  const actual = contexts(dump.configs.map((entry) => entry.cluster));
  const wanted = contexts(clusters(normalize(structuredClone(expected), true)));
  for (const { cluster, tls } of actual) {
    const pinned = wanted.find((item) => item.cluster["name"] === cluster["name"]);
    if (!pinned || !isDeepStrictEqual(tls, pinned.tls))
      throw new Error("Live TLS validation/session-cache drift");
    if (
      !isDeepStrictEqual(
        object.parse(cluster["typed_extension_protocol_options"])[httpType],
        object.parse(pinned.cluster["typed_extension_protocol_options"])[httpType],
      ) ||
      !isDeepStrictEqual(cluster["cluster_type"], pinned.cluster["cluster_type"])
    )
      throw new Error("Live SNI/SAN/HTTP pooling/DNS drift");
  }
  return tlsClusters;
}
