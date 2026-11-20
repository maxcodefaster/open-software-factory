import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { z } from "zod";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { nativeRuntimeArchitecture } from "../../packages/runtime-kubernetes/src/substrate-profile";
import { requireNativeForgeOrigin } from "../factory/native-installation";
import type { Cluster } from "./clean-room-cluster";
import {
  chartName,
  cleanRoomIDFromNamespace,
  managedBy,
  ownerLabel,
  verifyOwnedNamespace,
} from "./clean-room-model";

const file = z.string().refine((value) => isAbsolute(value) && !/[\0\r\n]/.test(value));
const inputSchema = z
  .strictObject({
    schema: z.literal(1),
    factoryOrigin: z.string(),
    forgejoOrigin: z.string(),
    ingressClass: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    ingressNamespaceLabels: z
      .record(z.string(), z.string())
      .refine((value) => Object.keys(value).length > 0),
    configuration: z.record(z.string(), z.unknown()),
    provisionerTokenFile: file,
    tlsMode: z.enum(["managed", "external"]).default("external"),
    factoryCAFile: file.optional(),
    ingressCertificateFile: file.optional(),
    ingressKeyFile: file.optional(),
  })
  .refine((input) => {
    const files = [input.factoryCAFile, input.ingressCertificateFile, input.ingressKeyFile];
    return input.tlsMode === "external"
      ? files.every((value) => value !== undefined)
      : files.every((value) => value === undefined);
  });

export type NativeCleanRoomValues = {
  factoryOrigin: string;
  forgejoOrigin: string;
  ingressClass: string;
  ingressNamespaceLabels: Record<string, string>;
  configurationSecret: string;
  provisionerSecret: string;
  tlsSecret: string;
};

function origin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Native fixture origins must be HTTPS DNS origins on port 443");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    isIP(url.hostname) ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  )
    throw Error("Native fixture origins must be HTTPS DNS origins on port 443");
  return url.origin;
}

async function privateFile(path: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())
    )
      throw Error("Private file required");
    return await handle.readFile("utf8");
  } catch {
    throw Error("Native fixture token and TLS key must be readable, owned private regular files");
  } finally {
    await handle?.close();
  }
}

function publicCertificates(pem: string) {
  const certificates = pem.match(
    /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g,
  );
  if (!certificates?.length || certificates.join("").replace(/\s/g, "") !== pem.replace(/\s/g, ""))
    throw Error("Native public trust must contain only PEM certificates");
  try {
    return certificates.map((value) => new X509Certificate(value));
  } catch {
    throw Error("Native public trust contains an invalid certificate");
  }
}

// Standard TLS verification against the supplied Actor trust bundle. This is
// an owned loopback probe, not proof of DNS, Ingress or a Substrate connection.
async function verifyTLS(
  cert: string,
  key: string,
  ca: string,
  names: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const sockets = new Set<TLSSocket>();
  const server = createServer({ cert, key }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.end();
  });
  server.on("tlsClientError", () => {});
  const abort = () => {
    for (const socket of sockets) socket.destroy(new Error("Native TLS probe cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Owned TLS listener unavailable");
    for (const servername of names) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const socket = connect({
          host: "127.0.0.1",
          port: address.port,
          servername,
          ca,
          rejectUnauthorized: true,
        });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("error", reject);
        socket.setTimeout(5000, () => socket.destroy(new Error("Native TLS probe timed out")));
        socket.once("secureConnect", () => {
          if (!socket.authorized) return reject(Error("Native TLS trust was not confirmed"));
          socket.end();
          resolve();
        });
      });
    }
  } catch {
    throw Error(
      "Native TLS certificate chain does not validate for all origins with the Factory trust bundle",
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Explicit fresh-install inputs only. Never copy a retained installation's identity or Secrets. */
export async function prepareNativeCleanRoom(
  path: string,
  namespace: string,
  release: string,
  options: { signal?: AbortSignal; now?: Date } = {},
) {
  options.signal?.throwIfAborted();
  const id = cleanRoomIDFromNamespace(namespace);
  if (!id) throw Error("Native commissioning requires its exactly owned clean-room Namespace");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(release))
    throw Error("Native commissioning requires an exact Helm release name");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Error("Native fixture JSON could not be read");
  }
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw Error("Native fixture input has invalid or unexpected fields");
  const input = parsed.data;
  const factoryOrigin = origin(input.factoryOrigin);
  const forgejoOrigin = origin(input.forgejoOrigin);
  if (factoryOrigin === forgejoOrigin) throw Error("Native Factory and Forge origins must differ");
  for (const field of [
    "deployment",
    "database",
    "editorPrincipal",
    "connectorURL",
    "factoryCAFile",
    "connection",
    "provisioner",
    "projectID",
    "workspaceID",
    "generation",
  ])
    if (field in input.configuration)
      throw Error(
        "Native fixture configuration must omit installer-owned identities and credential paths",
      );
  const name = chartName(release);
  const connection = {
    bridge: "/usr/local/bin/factory-substrate-control",
    endpoint: "api.ate-system.svc:443",
    serverName: "api.ate-system.svc",
    caFile: "/run/factory/substrate-control/ca.pem",
    tokenFile: "/run/factory/substrate-control/token",
  };
  let configuration: ReturnType<typeof substrateInstallationConfiguration>;
  try {
    configuration = substrateInstallationConfiguration({
      ...input.configuration,
      deployment: "fresh-workspaces",
      database: "factory",
      editorPrincipal: `user:system:serviceaccount:${namespace}:${name}`,
      connectorURL: `${factoryOrigin.replace("https:", "wss:")}/internal/runtime-connect`,
      factoryCAFile: "/run/factory/substrate-configuration/factory-ca.pem",
      connection,
      provisioner: { ...connection, tokenFile: "/run/factory/substrate-provisioner/token" },
    });
  } catch {
    throw Error("Native fixture runtime configuration is invalid");
  }
  nativeRuntimeArchitecture(configuration.runtime);
  requireNativeForgeOrigin(
    {
      FACTORY_FORGEJO_PUBLIC_URL: forgejoOrigin,
      FACTORY_FORGEJO_API_URL: `http://${name}-forgejo.${namespace}.svc:3000/api/v1/`,
    },
    configuration,
  );
  const token = (await privateFile(input.provisionerTokenFile)).trim();
  if (!token || /[\s\0]/.test(token))
    throw Error("Native provisioner token must be one opaque nonempty token");
  let external: { ca: string; cert: string; key: string; certificate: X509Certificate } | undefined;
  if (input.tlsMode === "external") {
    // The schema requires all three paths only for this explicit opt-out.
    const [ca, cert, key] = await Promise.all([
      readFile(input.factoryCAFile ?? "", "utf8"),
      readFile(input.ingressCertificateFile ?? "", "utf8"),
      privateFile(input.ingressKeyFile ?? ""),
    ]);
    publicCertificates(ca);
    publicCertificates(cert);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(cert);
      if (!certificate.checkPrivateKey(createPrivateKey(key))) throw Error("Mismatched key");
    } catch {
      throw Error("Native Ingress certificate and private key do not match");
    }
    const now = (options.now ?? new Date()).getTime();
    if (
      certificate.ca ||
      !Number.isFinite(now) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo)
    )
      throw Error("Native Ingress requires a currently valid leaf certificate");
    const factoryHost = new URL(factoryOrigin).hostname;
    const forgeHost = new URL(forgejoOrigin).hostname;
    const runtimeHost = `${id}-app.runtime.${factoryHost}`;
    if (
      !certificate.checkHost(factoryHost) ||
      !certificate.checkHost(forgeHost) ||
      certificate.checkHost(runtimeHost)?.toLowerCase() !== `*.runtime.${factoryHost}`
    )
      throw Error(
        "Native Ingress certificate must cover Factory, Forge and the complete runtime wildcard",
      );
    await verifyTLS(cert, key, ca, [factoryHost, forgeHost, runtimeHost], options.signal);
    external = { ca, cert, key, certificate };
  }
  options.signal?.throwIfAborted();
  const values: NativeCleanRoomValues = {
    factoryOrigin,
    forgejoOrigin,
    ingressClass: input.ingressClass,
    ingressNamespaceLabels: input.ingressNamespaceLabels,
    configurationSecret: `${name}-native-configuration`,
    provisionerSecret: `${name}-native-provisioner`,
    tlsSecret: external ? `${name}-ingress-tls` : "",
  };
  const secret = (secretName: string, stringData: Record<string, string>, type = "Opaque") => ({
    apiVersion: "v1",
    kind: "Secret",
    type,
    metadata: {
      name: secretName,
      namespace,
      labels: { [ownerLabel]: id, "app.kubernetes.io/managed-by": managedBy },
    },
    stringData,
  });
  const configurationJSON = JSON.stringify(configuration);
  return {
    namespace,
    release,
    values,
    configuration,
    ca: external?.ca,
    metadata: {
      tlsMode: input.tlsMode,
      configurationSHA256: createHash("sha256").update(configurationJSON).digest("hex"),
      ...(external ? { certificateSHA256: external.certificate.fingerprint256 } : {}),
      editorPrincipal: configuration.editorPrincipal,
      factoryOrigin,
      forgejoOrigin,
      secretNames: [
        values.configurationSecret,
        values.provisionerSecret,
        ...(external ? [values.tlsSecret] : []),
      ],
    },
    redactions: [
      ...new Set(
        [token, ...(external ? [external.key] : [])].flatMap((value) => [
          value,
          JSON.stringify(value).slice(1, -1),
          Buffer.from(value).toString("base64"),
        ]),
      ),
    ],
    manifests: [
      secret(values.configurationSecret, {
        "configuration.json": configurationJSON,
        ...(external ? { "factory-ca.pem": external.ca } : {}),
      }),
      secret(values.provisionerSecret, { token }),
      ...(external
        ? [
            secret(
              values.tlsSecret,
              { "tls.crt": external.cert, "tls.key": external.key },
              "kubernetes.io/tls",
            ),
          ]
        : []),
    ],
  };
}

// kubectl filters the API response before it reaches this process. Do not fetch
// a Secret as JSON: the managed CA Secret also contains its signing authority.
const managedCAProjection = [
  ".metadata.name",
  ".metadata.namespace",
  ".metadata.uid",
  ".metadata.resourceVersion",
  ".metadata.labels.app\\.kubernetes\\.io/name",
  ".metadata.labels.app\\.kubernetes\\.io/instance",
  ".metadata.labels.app\\.kubernetes\\.io/managed-by",
  ".metadata.labels.app\\.kubernetes\\.io/component",
  ".metadata.annotations.meta\\.helm\\.sh/release-name",
  ".metadata.annotations.meta\\.helm\\.sh/release-namespace",
  ".metadata.annotations.factory\\.dev/tls-hosts",
  ".metadata.deletionTimestamp",
  ".immutable",
  ".type",
  ".data.ca\\.crt",
]
  .map((field) => `{${field}}`)
  .join('{"\\n"}');

/** Read public trust only after an acknowledged install in the original owned Namespace. */
export async function readManagedCleanRoomCA(
  cl: Pick<Cluster, "json" | "kubectl">,
  prepared: Awaited<ReturnType<typeof prepareNativeCleanRoom>>,
  namespaceUID: string,
  options: { signal?: AbortSignal; now?: Date } = {},
) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const id = cleanRoomIDFromNamespace(prepared.namespace);
  if (!id || !namespaceUID || prepared.metadata.tlsMode !== "managed" || prepared.values.tlsSecret)
    throw Error("Managed public trust requires the original managed clean-room identity");
  const secretName = `${chartName(prepared.release)}-ingress-ca`;
  try {
    const namespace = async () => {
      signal?.throwIfAborted();
      const observed = await cl.json(["get", "namespace", prepared.namespace], { signal });
      if (observed.metadata?.deletionTimestamp != null) throw Error();
      verifyOwnedNamespace(observed, id, namespaceUID);
      signal?.throwIfAborted();
    };
    const observe = async () => {
      signal?.throwIfAborted();
      const observed = await cl.kubectl(
        [
          "--namespace",
          prepared.namespace,
          "get",
          "secret",
          secretName,
          "-o",
          `jsonpath=${managedCAProjection}`,
        ],
        { signal, allowFailure: true },
      );
      signal?.throwIfAborted();
      if (observed.code !== 0 || observed.stdout.length > 128 * 1024) throw Error();
      return observed.stdout;
    };
    await namespace();
    const observed = await observe();
    const fields = observed.split("\n");
    const [
      name,
      namespaceName,
      uid,
      resourceVersion,
      application,
      instance,
      manager,
      component,
      helmRelease,
      helmNamespace,
      hosts,
      deletionTimestamp,
      immutable,
      type,
      encoded,
    ] = fields;
    const factoryHost = new URL(prepared.values.factoryOrigin).hostname;
    if (
      fields.length !== 15 ||
      name !== secretName ||
      namespaceName !== prepared.namespace ||
      !uid?.trim() ||
      !resourceVersion?.trim() ||
      application !== "factory" ||
      instance !== prepared.release ||
      manager !== "Helm" ||
      component !== "ingress-tls" ||
      helmRelease !== prepared.release ||
      helmNamespace !== prepared.namespace ||
      hosts !==
        JSON.stringify([
          factoryHost,
          new URL(prepared.values.forgejoOrigin).hostname,
          `*.runtime.${factoryHost}`,
        ]) ||
      deletionTimestamp !== "" ||
      immutable !== "true" ||
      type !== "Opaque" ||
      !encoded ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw Error();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw Error();
    const ca = bytes.toString("utf8");
    const certificates = publicCertificates(ca);
    const certificate = certificates[0];
    const now = (options.now ?? new Date()).getTime();
    if (
      certificates.length !== 1 ||
      !certificate?.ca ||
      certificate.subject !== certificate.issuer ||
      !certificate.verify(certificate.publicKey) ||
      !Number.isFinite(now) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo)
    )
      throw Error();
    // Detect replacement or mutation during extraction, including a same-name
    // Namespace replacement. This is a bounded observation, not a global lock.
    if ((await observe()) !== observed) throw Error();
    await namespace();
    return {
      ca,
      metadata: {
        caSecretName: secretName,
        caSecretUID: uid,
        caSecretResourceVersion: resourceVersion,
        caFingerprint256: certificate.fingerprint256,
        caExpiresAt: new Date(certificate.validTo).toISOString(),
      },
    };
  } catch {
    signal?.throwIfAborted();
    throw Error("Managed Ingress public CA observation failed or ownership changed");
  }
}

export async function readNativeCleanRoomReadiness(
  origin: string,
  ca: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (new URL(origin).protocol !== "https:") throw Error("Native public readiness requires HTTPS");
  publicCertificates(ca);
  return fetch(`${origin}/health/ready?installation=complete`, {
    tls: { ca, rejectUnauthorized: true },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    redirect: "error",
  });
}

export function requireFreshNativeIngress(value: unknown, values: NativeCleanRoomValues) {
  const inventory = z
    .object({
      items: z.array(
        z.object({
          spec: z
            .object({ rules: z.array(z.object({ host: z.string().optional() })).optional() })
            .optional(),
        }),
      ),
    })
    .safeParse(value);
  if (!inventory.success)
    throw Error("Native public Ingress inventory is unavailable; nothing created");
  const intended = [
    new URL(values.factoryOrigin).hostname,
    new URL(values.forgejoOrigin).hostname,
    `*.runtime.${new URL(values.factoryOrigin).hostname}`,
  ];
  const matches = (pattern: string, host: string) =>
    pattern.startsWith("*.") &&
    !host.startsWith("*.") &&
    host.endsWith(pattern.slice(1)) &&
    host.split(".").length === pattern.split(".").length;
  for (const ingress of inventory.data.items)
    for (const rule of ingress.spec?.rules ?? [])
      if (
        rule.host &&
        intended.some(
          (host) =>
            host === rule.host || matches(rule.host ?? "", host) || matches(host, rule.host ?? ""),
        )
      )
        throw Error(
          "A native fixture public hostname overlaps an existing Ingress; nothing created",
        );
}

export async function createNativeCleanRoomSecrets(
  cl: Pick<Cluster, "json" | "kubectl">,
  prepared: Awaited<ReturnType<typeof prepareNativeCleanRoom>>,
  namespaceUID: string,
  signal?: AbortSignal,
) {
  if (!namespaceUID)
    throw Error("Original clean-room Namespace UID is unavailable; nothing created");
  const id = cleanRoomIDFromNamespace(prepared.namespace);
  if (!id) throw Error("Owned clean-room Namespace is missing");
  for (const manifest of prepared.manifests) {
    signal?.throwIfAborted();
    verifyOwnedNamespace(
      await cl.json(["get", "namespace", prepared.namespace], { signal }),
      id,
      namespaceUID,
    );
    const result = await cl.kubectl(["create", "-f", "-", "-o", "name"], {
      input: JSON.stringify(manifest),
      allowFailure: true,
      signal,
    });
    if (result.code !== 0)
      throw Error(
        "Native fixture Secret creation outcome is unconfirmed; original Namespace and names retained",
      );
  }
}
