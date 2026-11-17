import { afterEach, beforeEach, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, createServer } from "node:tls";
import { runCommand, runEnvironmentCommand } from "../../packages/runtime-kubernetes/src/command";
import { serviceAccountConfiguration } from "../../packages/runtime-kubernetes/src/service-account";
import { renewIngressTLS } from "./ingress-tls";

const hosts = ["*.runtime.factory.example", "factory.example", "git.example"];
const day = 24 * 60 * 60 * 1000;
const environmentKeys = [
  "KUBERNETES_SERVICE_HOST",
  "KUBERNETES_SERVICE_PORT",
  "KUBECONFIG",
  "FACTORY_KUBERNETES_CONTEXT",
] as const;
let environment: Record<string, string | undefined>;
const fixtures: string[] = [];
beforeEach(() => {
  environment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env["KUBERNETES_SERVICE_HOST"] = "10.43.0.1";
  process.env["KUBERNETES_SERVICE_PORT"] = "443";
  process.env["KUBECONFIG"] = "/operator/config-must-not-be-used";
  process.env["FACTORY_KUBERNETES_CONTEXT"] = "operator-must-not-be-used";
});
afterEach(async () => {
  for (const key of environmentKeys) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function openssl(args: readonly string[], input?: string) {
  const result = await runCommand(["openssl", ...args], input, {
    timeoutMS: 5_000,
    outputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error("OpenSSL test fixture failed");
  return result;
}

type Authority = { certFile: string; keyFile: string; cert: string; key: string };

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "factory-ingress-fixture-")));
  fixtures.push(directory);
  let sequence = 0;
  const file = async (name: string, value: string) => {
    const path = join(directory, name);
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
    return path;
  };
  async function root(
    days = 400,
    options: { ca?: boolean; signer?: Authority } = {},
  ): Promise<Authority> {
    const id = ++sequence;
    const config = await file(
      `${id}-root.cnf`,
      [
        "[req]",
        "prompt = no",
        "distinguished_name = dn",
        "x509_extensions = root",
        "[dn]",
        `CN = Factory test root ${id}`,
        "[root]",
        `basicConstraints = critical,CA:${options.ca === false ? "FALSE" : "TRUE"}`,
        "keyUsage = critical,keyCertSign,cRLSign",
        "",
      ].join("\n"),
    );
    const keyFile = await file(`${id}-root.key`, "");
    const certFile = join(directory, `${id}-root.crt`);
    await openssl([
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-pkeyopt",
      "ec_param_enc:named_curve",
      "-nodes",
      "-sha256",
      "-config",
      config,
      "-days",
      String(days),
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ]);
    if (options.signer) {
      const request = join(directory, `${id}-root.csr`);
      await openssl(["x509", "-x509toreq", "-in", certFile, "-signkey", keyFile, "-out", request]);
      await openssl([
        "x509",
        "-req",
        "-in",
        request,
        "-CA",
        options.signer.certFile,
        "-CAkey",
        options.signer.keyFile,
        "-set_serial",
        String(id),
        "-days",
        String(days),
        "-extfile",
        config,
        "-extensions",
        "root",
        "-out",
        certFile,
      ]);
    }
    return {
      certFile,
      keyFile,
      cert: await readFile(certFile, "utf8"),
      key: await readFile(keyFile, "utf8"),
    };
  }
  const ca = await root();
  async function leaf(
    days: number,
    options: {
      signer?: Authority;
      sans?: string[];
      ca?: boolean;
      noSAN?: boolean;
    } = {},
  ) {
    const id = ++sequence;
    const signer = options.signer ?? ca;
    const requestConfig = await file(
      `${id}-request.cnf`,
      "[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nCN = factory.example\n",
    );
    const extensions = await file(
      `${id}-leaf.cnf`,
      [
        "[leaf]",
        `basicConstraints = critical,CA:${options.ca ? "TRUE" : "FALSE"}`,
        `keyUsage = critical,digitalSignature${options.ca ? ",keyCertSign" : ""}`,
        "extendedKeyUsage = serverAuth",
        ...(options.noSAN
          ? []
          : [`subjectAltName = ${(options.sans ?? hosts.map((host) => `DNS:${host}`)).join(",")}`]),
        "",
      ].join("\n"),
    );
    const keyFile = await file(`${id}-leaf.key`, "");
    const request = join(directory, `${id}-leaf.csr`);
    const certFile = join(directory, `${id}-leaf.crt`);
    await openssl([
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-pkeyopt",
      "ec_param_enc:named_curve",
      "-nodes",
      "-sha256",
      "-config",
      requestConfig,
      "-keyout",
      keyFile,
      "-out",
      request,
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      signer.certFile,
      "-CAkey",
      signer.keyFile,
      "-set_serial",
      String(id),
      "-days",
      String(days),
      "-sha256",
      "-extfile",
      extensions,
      "-extensions",
      "leaf",
      "-out",
      certFile,
    ]);
    return { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") };
  }
  const initial = await leaf(20);
  const encode = (value: string) => Buffer.from(value).toString("base64");
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/tls",
    metadata: {
      name: "factory-ingress-tls",
      namespace: "factory",
      uid: String(crypto.randomUUID()),
      resourceVersion: "17",
      labels: {
        "app.kubernetes.io/name": "factory",
        "app.kubernetes.io/instance": "factory",
        "app.kubernetes.io/component": "ingress-tls",
      } as Record<string, string>,
      annotations: {
        "factory.dev/tls-hosts": JSON.stringify(hosts),
        "helm.sh/resource-policy": "keep",
      } as Record<string, string>,
    },
    data: {
      "ca.crt": encode(ca.cert),
      "tls.crt": encode(initial.cert),
      "tls.key": encode(initial.key),
      unrelated: encode("must remain"),
    },
  };
  type Patch = { op: string; path: string; value: string }[];
  const calls: { args: string[]; input: string | undefined }[] = [];
  const privateDirectories = new Set<string>();
  const behavior = {
    getFails: false,
    getBody: undefined as string | undefined,
    opensslFails: undefined as string | undefined,
    beforePatch: () => {},
    patchFails: false,
    losePatchResponse: false,
  };
  async function execute(args: readonly string[], input?: string) {
    calls.push({ args: [...args], input });
    if (args[0] === "openssl") {
      const keyIndex = args.indexOf("-keyout");
      if (keyIndex >= 0)
        expect((await stat(args[keyIndex + 1] as string)).mode & 0o777).toBe(0o600);
      if (behavior.opensslFails === args[1])
        return { stdout: "", stderr: "private OpenSSL diagnostics", exitCode: 1 };
      return openssl(args.slice(1), input);
    }
    expect(args[0]).toBe("kubectl");
    const config = args[2] as string;
    privateDirectories.add(dirname(config));
    expect((await stat(dirname(config))).mode & 0o777).toBe(0o700);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(serviceAccountConfiguration());
    expect(args.slice(0, 8)).toEqual([
      "kubectl",
      "--kubeconfig",
      config,
      "--context",
      "factory",
      "--request-timeout=10s",
      "--namespace",
      "factory",
    ]);
    if (args[8] === "get") {
      expect(args.slice(8)).toEqual(["get", "secret", "factory-ingress-tls", "-o", "json"]);
      if (behavior.getFails)
        return { stdout: "", stderr: "private Secret diagnostics", exitCode: 1 };
      return { stdout: behavior.getBody ?? JSON.stringify(secret), stderr: "", exitCode: 0 };
    }
    expect(args.slice(8)).toEqual([
      "patch",
      "secret",
      secret.metadata.name,
      "--type=json",
      `--patch-file=${join(dirname(config), "patch.json")}`,
      "-o",
      "name",
    ]);
    expect(input).toBeUndefined();
    for (const name of ["ca.key", "tls.key", "patch.json"])
      expect((await stat(join(dirname(config), name))).mode & 0o777).toBe(0o600);
    const patch = JSON.parse(await readFile(join(dirname(config), "patch.json"), "utf8")) as Patch;
    expect(patch.map(({ op, path }) => ({ op, path }))).toEqual([
      { op: "test", path: "/metadata/uid" },
      { op: "test", path: "/metadata/resourceVersion" },
      { op: "replace", path: "/data/tls.crt" },
      { op: "replace", path: "/data/tls.key" },
    ]);
    await behavior.beforePatch();
    if (
      behavior.patchFails ||
      patch[0]?.value !== secret.metadata.uid ||
      patch[1]?.value !== secret.metadata.resourceVersion
    )
      return { stdout: "", stderr: "private conflicting Secret body", exitCode: 1 };
    secret.data["tls.crt"] = patch[2]?.value as string;
    secret.data["tls.key"] = patch[3]?.value as string;
    secret.metadata.resourceVersion = "18";
    if (behavior.losePatchResponse) throw new Error("private lost Secret response");
    return { stdout: `secret/${secret.metadata.name}`, stderr: "", exitCode: 0 };
  }
  const options = {
    namespace: "factory",
    release: "factory",
    secretName: secret.metadata.name,
    hosts: [...hosts],
    caFile: ca.certFile,
    caKeyFile: ca.keyFile,
    execute,
  };
  const useLeaf = (next: { cert: string; key: string }) => {
    secret.data["tls.crt"] = encode(next.cert);
    secret.data["tls.key"] = encode(next.key);
  };
  async function cleaned() {
    expect(privateDirectories.size).toBeGreaterThan(0);
    for (const path of privateDirectories) await expect(access(path)).rejects.toThrow();
  }
  return { directory, ca, root, leaf, secret, options, execute, calls, behavior, useLeaf, cleaned };
}

test("real kubectl local patch reads the module-produced private patch through runCommand", async () => {
  const f = await fixture();
  const source = join(f.directory, "observed-secret.json");
  await writeFile(source, JSON.stringify(f.secret), { mode: 0o600, flag: "wx" });
  const original = structuredClone(f.secret);
  let patched: typeof f.secret | undefined;
  let patchCalls = 0;
  const result = await renewIngressTLS({
    ...f.options,
    execute: async (args, input) => {
      if (args[0] !== "kubectl" || args[8] !== "patch") return f.execute(args, input);
      patchCalls++;
      const patchFile = args.find((arg) => arg.startsWith("--patch-file="));
      if (!patchFile) throw new Error("Missing module patch file");
      const path = patchFile.slice("--patch-file=".length);
      expect(path).toBe(join(dirname(args[2] as string), "patch.json"));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(input).toBeUndefined();
      // Only replace the server target with a private local Secret. Preserve the
      // module's patch-file choice and real command-runner stdin behavior.
      const observed = await runCommand(
        [
          ...args.slice(0, 8),
          "patch",
          "--local",
          "-f",
          source,
          "--type=json",
          patchFile,
          "-o",
          "json",
        ],
        input,
        { timeoutMS: 5_000, outputBytes: 1024 * 1024 },
      );
      // Never include stdout, stderr or a Secret body in a failed assertion.
      expect(observed.exitCode).toBe(0);
      patched = JSON.parse(observed.stdout) as typeof f.secret;
      return { ...observed, stdout: `secret/${f.secret.metadata.name}` };
    },
  });
  expect(result.status).toBe("renewed");
  expect(patchCalls).toBe(1);
  if (!patched) throw new Error("The real local patch did not return a Secret");
  expect(patched.data["ca.crt"] === original.data["ca.crt"]).toBe(true);
  expect(patched.data["tls.crt"] === original.data["tls.crt"]).toBe(false);
  expect(patched.data["tls.key"] === original.data["tls.key"]).toBe(false);
  expect(patched.data.unrelated === original.data.unrelated).toBe(true);
  expect(patched.metadata).toEqual(original.metadata);
  const leaf = new X509Certificate(Buffer.from(patched.data["tls.crt"], "base64"));
  expect(leaf.fingerprint256).toBe(result.fingerprint256);
  expect(
    leaf.checkPrivateKey(createPrivateKey(Buffer.from(patched.data["tls.key"], "base64"))),
  ).toBe(true);
  expect(leaf.verify(new X509Certificate(f.ca.cert).publicKey)).toBe(true);
  expect((await stat(source)).mode & 0o777).toBe(0o600);
  await f.cleaned();
});

async function handshakes(cert: string, key: string, ca: string, wrongCA: string) {
  const server = createServer({ cert, key }, (socket) => socket.end());
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS test listener unavailable");
    const port = address.port;
    async function handshake(servername: string, trust = ca) {
      return new Promise<void>((resolve, reject) => {
        const client = connect({
          host: "127.0.0.1",
          port,
          servername,
          ca: trust,
          rejectUnauthorized: true,
        });
        const timer = setTimeout(() => {
          client.destroy();
          reject(new Error("TLS test handshake timed out"));
        }, 2_000);
        client.once("secureConnect", () => {
          clearTimeout(timer);
          const authorized = client.authorized;
          client.destroy();
          if (authorized) resolve();
          else reject(new Error("TLS test handshake was not authorized"));
        });
        client.once("error", (error: Error) => {
          clearTimeout(timer);
          client.destroy();
          reject(error);
        });
      });
    }
    for (const host of ["factory.example", "git.example", "app.runtime.factory.example"])
      await handshake(host);
    await expect(handshake("wrong.example")).rejects.toThrow();
    await expect(handshake("nested.app.runtime.factory.example")).rejects.toThrow();
    await expect(handshake("factory.example", wrongCA)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error?: Error) => (error ? reject(error) : resolve())),
    );
  }
}

test("renews a real 90-day EC leaf under the fixed CA and rejects wrong trust/hosts over TLS", async () => {
  const f = await fixture();
  const retained = structuredClone(f.secret);
  const other = await f.root();
  const result = await renewIngressTLS({
    ...f.options,
    hosts: ["git.example", "factory.example", hosts[0] as string, "factory.example"],
  });
  expect(result.status).toBe("renewed");
  expect(f.calls.map(({ args }) => args[0])).toEqual(["kubectl", "openssl", "openssl", "kubectl"]);
  const cert = Buffer.from(f.secret.data["tls.crt"], "base64").toString();
  const key = Buffer.from(f.secret.data["tls.key"], "base64").toString();
  const leaf = new X509Certificate(cert);
  expect(leaf.fingerprint256).toBe(result.fingerprint256);
  expect(new Date(leaf.validTo).toISOString()).toBe(result.expiresAt);
  expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBe(90 * day);
  expect(leaf.ca).toBe(false);
  expect(leaf.publicKey.asymmetricKeyType).toBe("ec");
  expect(leaf.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  expect(leaf.checkPrivateKey(createPrivateKey(key))).toBe(true);
  expect(leaf.verify(new X509Certificate(f.ca.cert).publicKey)).toBe(true);
  expect(leaf.serialNumber).toMatch(/^[89A-F][0-9A-F]{31}$/);
  expect(leaf.subjectAltName).toBe(hosts.map((host) => `DNS:${host}`).join(", "));
  expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
  const text = (await openssl(["x509", "-text", "-noout"], cert)).stdout;
  expect(text).toContain("X509v3 Basic Constraints: critical");
  expect(text).toContain("CA:FALSE");
  expect(text).toContain("X509v3 Key Usage: critical");
  expect(text).toContain("Digital Signature");
  expect(text).not.toContain("Key Encipherment");
  expect(text).toMatch(/Signature Algorithm: ecdsa-with-SHA256/);
  expect(f.secret.data["tls.crt"] === retained.data["tls.crt"]).toBe(false);
  expect(f.secret.data["tls.key"] === retained.data["tls.key"]).toBe(false);
  expect(f.secret.data["ca.crt"] === retained.data["ca.crt"]).toBe(true);
  expect(f.secret.data.unrelated).toBe(retained.data.unrelated);
  expect(f.secret.metadata.labels).toEqual(retained.metadata.labels);
  expect(f.secret.metadata.annotations).toEqual(retained.metadata.annotations);
  expect((await readFile(f.ca.certFile, "utf8")) === f.ca.cert).toBe(true);
  expect((await readFile(f.ca.keyFile, "utf8")) === f.ca.key).toBe(true);
  expect(Object.keys(result).sort()).toEqual(["expiresAt", "fingerprint256", "status"]);
  await f.cleaned();
  await handshakes(cert, key, f.ca.cert, other.cert);
});

test("a current leaf is observed once without OpenSSL, patching or host configuration changes", async () => {
  const f = await fixture();
  f.useLeaf(await f.leaf(90));
  const retained = JSON.stringify(f.secret);
  const result = await renewIngressTLS(f.options);
  expect(result.status).toBe("current");
  expect(f.calls).toHaveLength(1);
  expect(JSON.stringify(f.secret) === retained).toBe(true);
  expect(process.env["KUBECONFIG"]).toBe("/operator/config-must-not-be-used");
  expect(process.env["FACTORY_KUBERNETES_CONTEXT"]).toBe("operator-must-not-be-used");
  await f.cleaned();
});

test("annotation JSON permits chart order and whitespace but still requires the exact DNS set", async () => {
  const f = await fixture();
  f.useLeaf(await f.leaf(90));
  f.secret.metadata.annotations["factory.dev/tls-hosts"] = JSON.stringify(
    ["factory.example", "git.example", "*.runtime.factory.example"],
    null,
    2,
  );
  expect((await renewIngressTLS(f.options)).status).toBe("current");
  await f.cleaned();
});

test("the 30-day renewal boundary is inclusive", async () => {
  const f = await fixture();
  f.useLeaf(await f.leaf(31));
  const cert = new X509Certificate(Buffer.from(f.secret.data["tls.crt"], "base64"));
  const boundary = Date.parse(cert.validTo) - 30 * day;
  expect((await renewIngressTLS({ ...f.options, now: new Date(boundary - 1) })).status).toBe(
    "current",
  );
  expect((await renewIngressTLS({ ...f.options, now: new Date(boundary) })).status).toBe("renewed");
  expect(f.calls.filter(({ args }) => args[8] === "get")).toHaveLength(2);
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(1);
  await f.cleaned();
});

test.each([
  "type",
  "name",
  "namespace",
  "uid",
  "resourceVersion",
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "app.kubernetes.io/component",
  "hosts missing",
  "hosts malformed",
  "hosts duplicate",
])("refuses a Secret with wrong ownership: %s", async (field) => {
  const f = await fixture();
  if (field === "type") f.secret.type = "Opaque";
  else if (field === "name" || field === "namespace") f.secret.metadata[field] = "other";
  else if (field === "uid" || field === "resourceVersion") f.secret.metadata[field] = "";
  else if (field.startsWith("app.")) f.secret.metadata.labels[field] = "other";
  else if (field === "hosts missing") delete f.secret.metadata.annotations["factory.dev/tls-hosts"];
  else if (field === "hosts malformed")
    f.secret.metadata.annotations["factory.dev/tls-hosts"] = "{invalid";
  else
    f.secret.metadata.annotations["factory.dev/tls-hosts"] = JSON.stringify([...hosts, hosts[0]]);
  await expect(renewIngressTLS(f.options)).rejects.toThrow("ownership");
  expect(f.calls).toHaveLength(1);
  await f.cleaned();
});

test.each(
  [
    [],
    ["https://factory.example"],
    ["factory.example\nDNS.2=other.example"],
    ["factory.example,other.example"],
    ["factory.example\0"],
    ["factory.example."],
    ["Factory.example"],
    ["bad_name.example"],
    ["-bad.example"],
    ["bad-.example"],
    ["a..example"],
    ["*"],
    ["*.*.example"],
    ["a*.example"],
    ["a.*.example"],
    ["127.0.0.1"],
    ["::1"],
    [`${"a".repeat(64)}.example`],
    [Array(5).fill("a".repeat(60)).join(".")],
  ].map((invalid) => ({ invalid })),
)("rejects unsafe input hosts before Kubernetes or OpenSSL: %j", async ({ invalid }) => {
  const calls: string[][] = [];
  await expect(
    renewIngressTLS({
      namespace: "factory",
      release: "factory",
      secretName: "factory-ingress-tls",
      hosts: invalid,
      execute: async (args) => {
        calls.push([...args]);
        throw new Error("must not execute");
      },
    }),
  ).rejects.toThrow("DNS hosts");
  expect(calls).toHaveLength(0);
});

test.each([
  ["namespace", "--all-namespaces"],
  ["namespace", "factory.other"],
  ["release", "factory\nother"],
  ["release", "x".repeat(54)],
  ["secretName", "factory/other"],
])("rejects unsafe installation identity %s=%s", async (field, value) => {
  const calls: string[][] = [];
  await expect(
    renewIngressTLS({
      namespace: "factory",
      release: "factory",
      secretName: "factory-ingress-tls",
      hosts,
      [field]: value,
      execute: async (args) => {
        calls.push([...args]);
        throw new Error("must not execute");
      },
    }),
  ).rejects.toThrow("exact Namespace");
  expect(calls).toHaveLength(0);
});

test.each([
  "mounted key",
  "Secret root",
  "leaf key",
  "leaf signer",
  "root is not CA",
  "root is not self-signed",
  "root expired",
  "leaf not yet valid",
  "leaf is CA",
  "leaf chain",
  "malformed root",
  "malformed leaf",
  "malformed base64",
])("refuses invalid retained TLS material: %s", async (failure) => {
  const f = await fixture();
  const other = await f.root();
  let now: Date | undefined;
  if (failure === "mounted key") f.options.caKeyFile = other.keyFile;
  if (failure === "Secret root")
    f.secret.data["ca.crt"] = Buffer.from(other.cert).toString("base64");
  if (failure === "leaf key") f.secret.data["tls.key"] = Buffer.from(other.key).toString("base64");
  if (failure === "leaf signer") f.useLeaf(await f.leaf(20, { signer: other }));
  if (failure === "root is not CA" || failure === "root is not self-signed") {
    const invalid = await f.root(400, {
      ...(failure === "root is not CA" ? { ca: false } : { signer: other }),
    });
    f.options.caFile = invalid.certFile;
    f.options.caKeyFile = invalid.keyFile;
    f.secret.data["ca.crt"] = Buffer.from(invalid.cert).toString("base64");
  }
  if (failure === "root expired")
    now = new Date(Date.parse(new X509Certificate(f.ca.cert).validTo));
  if (failure === "leaf not yet valid")
    now = new Date(
      Date.parse(new X509Certificate(Buffer.from(f.secret.data["tls.crt"], "base64")).validFrom) -
        1,
    );
  if (failure === "leaf is CA") f.useLeaf(await f.leaf(20, { ca: true }));
  if (failure === "leaf chain")
    f.secret.data["tls.crt"] = Buffer.from(
      Buffer.from(f.secret.data["tls.crt"], "base64").toString() + f.ca.cert,
    ).toString("base64");
  if (failure === "malformed root") await writeFile(f.ca.certFile, "not a certificate");
  if (failure === "malformed leaf")
    f.secret.data["tls.crt"] = Buffer.from("invalid").toString("base64");
  if (failure === "malformed base64") f.secret.data["tls.key"] = "not base64";
  await expect(renewIngressTLS({ ...f.options, ...(now ? { now } : {}) })).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  await f.cleaned();
});

test.each(
  [
    ["DNS:factory.example", "DNS:git.example"],
    [...hosts.map((host) => `DNS:${host}`), "DNS:other.example"],
    [...hosts.map((host) => `DNS:${host}`), "DNS:factory.example"],
    [...hosts.map((host) => `DNS:${host}`), "IP:127.0.0.1"],
    [...hosts.map((host) => `DNS:${host}`), "URI:https://factory.example"],
    ["DNS:*.*.factory.example", "DNS:factory.example", "DNS:git.example"],
    [
      "DNS:*.runtime.factory.example",
      "DNS:factory.example",
      "DNS:git.example, DNS:injected.example",
    ],
  ].map((sans) => ({ sans })),
)("rejects missing, extra, duplicate, non-DNS or malformed SANs: %j", async ({ sans }) => {
  const f = await fixture();
  f.useLeaf(await f.leaf(20, { sans }));
  await expect(renewIngressTLS(f.options)).rejects.toThrow("exact DNS hosts");
  expect(f.calls).toHaveLength(1);
  await f.cleaned();
});

test("rejects CN fallback without SANs", async () => {
  const f = await fixture();
  f.useLeaf(await f.leaf(20, { noSAN: true }));
  await expect(renewIngressTLS(f.options)).rejects.toThrow("exact DNS hosts");
  expect(f.calls).toHaveLength(1);
  await f.cleaned();
});

test("a retained root with less than 100 days cannot sign a replacement", async () => {
  const f = await fixture();
  const ca = await f.root(99);
  f.options.caFile = ca.certFile;
  f.options.caKeyFile = ca.keyFile;
  f.secret.data["ca.crt"] = Buffer.from(ca.cert).toString("base64");
  f.useLeaf(await f.leaf(20, { signer: ca }));
  await expect(renewIngressTLS(f.options)).rejects.toThrow("less than 100 days");
  expect(f.calls).toHaveLength(1);
  await f.cleaned();
});

test("an expired but otherwise correct leaf renews before application startup", async () => {
  const f = await fixture();
  f.useLeaf(await f.leaf(1));
  const expired = new X509Certificate(Buffer.from(f.secret.data["tls.crt"], "base64"));
  const now = new Date(Date.parse(expired.validTo) + day);
  expect((await renewIngressTLS({ ...f.options, now })).status).toBe("renewed");
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(1);
  await f.cleaned();
});

test("init persists a private complete identity before renewal and never overwrites the initial leaf", async () => {
  const f = await fixture();
  const stateDirectory = join(f.directory, "state");
  const path = join(stateDirectory, "identity.json");
  const initial = { ...f.secret.data };
  let witnessed = false;
  f.behavior.beforePatch = async () => {
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved["tls.crt"] === initial["tls.crt"]).toBe(true);
    expect(saved["tls.key"] === initial["tls.key"]).toBe(true);
    witnessed = true;
  };
  expect((await renewIngressTLS({ ...f.options, stateDirectory })).status).toBe("renewed");
  expect(witnessed).toBe(true);
  expect((await lstat(stateDirectory)).mode & 0o7777).toBe(0o700);
  expect((await lstat(path)).mode & 0o7777).toBe(0o600);
  expect((await lstat(path)).uid === process.getuid?.()).toBe(true);
  expect(await readdir(stateDirectory)).toEqual(["identity.json"]);
  const original = await readFile(path, "utf8");
  const saved = JSON.parse(original);
  expect(Object.keys(saved).sort()).toEqual(
    [
      "schema",
      "namespace",
      "release",
      "secretName",
      "hosts",
      "ca.crt",
      "ca.key",
      "tls.crt",
      "tls.key",
    ].sort(),
  );
  expect(saved.schema).toBe(1);
  expect(saved.namespace).toBe(f.options.namespace);
  expect(saved.release).toBe(f.options.release);
  expect(saved.secretName).toBe(f.options.secretName);
  expect(saved.hosts).toEqual(hosts);
  expect(Buffer.from(saved["ca.crt"], "base64").toString() === f.ca.cert).toBe(true);
  expect(Buffer.from(saved["ca.key"], "base64").toString() === f.ca.key).toBe(true);
  expect((await renewIngressTLS({ ...f.options, stateDirectory })).status).toBe("current");
  expect((await readFile(path, "utf8")) === original).toBe(true);
  await f.cleaned();
});

test("a current leaf is backed up too, and an expired restored initial leaf reissues under that CA", async () => {
  const f = await fixture();
  const stateDirectory = join(f.directory, "state");
  const path = join(stateDirectory, "identity.json");
  f.useLeaf(await f.leaf(31));
  const cert = new X509Certificate(Buffer.from(f.secret.data["tls.crt"], "base64"));
  expect((await renewIngressTLS({ ...f.options, stateDirectory })).status).toBe("current");
  const original = await readFile(path, "utf8");
  const saved = JSON.parse(original);
  // Restore exactly the saved CA and leaf. No new root is adopted after downtime.
  await writeFile(f.ca.certFile, Buffer.from(saved["ca.crt"], "base64"));
  await writeFile(f.ca.keyFile, Buffer.from(saved["ca.key"], "base64"));
  f.secret.data["ca.crt"] = saved["ca.crt"];
  f.secret.data["tls.crt"] = saved["tls.crt"];
  f.secret.data["tls.key"] = saved["tls.key"];
  const now = new Date(Date.parse(cert.validTo) + day);
  expect((await renewIngressTLS({ ...f.options, stateDirectory, now })).status).toBe("renewed");
  expect((await readFile(path, "utf8")) === original).toBe(true);
  const renewed = new X509Certificate(Buffer.from(f.secret.data["tls.crt"], "base64"));
  expect(renewed.verify(new X509Certificate(f.ca.cert).publicKey)).toBe(true);
  await f.cleaned();
});

test("a retained backup identity refuses a different otherwise valid mounted CA and Secret", async () => {
  const f = await fixture();
  const stateDirectory = join(f.directory, "state");
  f.useLeaf(await f.leaf(90));
  await renewIngressTLS({ ...f.options, stateDirectory });
  const original = await readFile(join(stateDirectory, "identity.json"), "utf8");
  const other = await f.root();
  f.secret.data["ca.crt"] = Buffer.from(other.cert).toString("base64");
  f.useLeaf(await f.leaf(90, { signer: other }));
  await expect(
    renewIngressTLS({
      ...f.options,
      caFile: other.certFile,
      caKeyFile: other.keyFile,
      stateDirectory,
    }),
  ).rejects.toThrow("backup identity");
  expect((await readFile(join(stateDirectory, "identity.json"), "utf8")) === original).toBe(true);
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(0);
  await f.cleaned();
});

test("a retained backup identity refuses a changed otherwise valid host set", async () => {
  const f = await fixture();
  const stateDirectory = join(f.directory, "state");
  f.useLeaf(await f.leaf(90));
  await renewIngressTLS({ ...f.options, stateDirectory });
  const changed = ["factory.example", "other.example"];
  f.secret.metadata.annotations["factory.dev/tls-hosts"] = JSON.stringify(changed);
  f.useLeaf(await f.leaf(90, { sans: changed.map((host) => `DNS:${host}`) }));
  await expect(renewIngressTLS({ ...f.options, hosts: changed, stateDirectory })).rejects.toThrow(
    "backup identity",
  );
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(0);
  await f.cleaned();
});

test.each(["namespace", "release", "secretName", "schema", "ca.key", "invalid JSON"])(
  "an existing backup identity cannot silently change %s",
  async (field) => {
    const f = await fixture();
    const stateDirectory = join(f.directory, "state");
    const path = join(stateDirectory, "identity.json");
    f.useLeaf(await f.leaf(90));
    await renewIngressTLS({ ...f.options, stateDirectory });
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved[field] = field === "schema" ? 2 : "other";
    const content = field === "invalid JSON" ? "{private backup contents" : JSON.stringify(saved);
    await writeFile(path, content);
    await expect(renewIngressTLS({ ...f.options, stateDirectory })).rejects.toThrow(
      "backup identity",
    );
    expect((await readFile(path, "utf8")) === content).toBe(true);
    expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(0);
    await f.cleaned();
  },
);

test.each([
  "directory mode",
  "file mode",
  "directory symlink",
  "file symlink",
  "file hardlink",
  "parent mode",
  "parent symlink",
])("backup identity rejects unsafe storage: %s", async (failure) => {
  const f = await fixture();
  const stateDirectory = join(f.directory, "state");
  const path = join(stateDirectory, "identity.json");
  f.useLeaf(await f.leaf(90));
  await renewIngressTLS({ ...f.options, stateDirectory });
  if (failure === "directory mode") await chmod(stateDirectory, 0o750);
  if (failure === "file mode") await chmod(path, 0o640);
  if (failure === "file hardlink") await link(path, join(f.directory, "linked-identity"));
  if (failure === "parent mode") await chmod(f.directory, 0o777);
  if (failure === "file symlink") {
    const target = join(f.directory, "identity-target");
    await writeFile(target, await readFile(path), { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
  }
  let selected = stateDirectory;
  if (failure === "directory symlink" || failure === "parent symlink") {
    selected = join(f.directory, "linked-state");
    await symlink(failure === "directory symlink" ? stateDirectory : f.directory, selected);
    if (failure === "parent symlink") selected = join(selected, "state");
  }
  await expect(renewIngressTLS({ ...f.options, stateDirectory: selected })).rejects.toThrow(
    "backup identity",
  );
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(0);
  await f.cleaned();
});

test.each(["uid", "resourceVersion"] as const)(
  "a concurrent %s change fences the JSON Patch without retry",
  async (field) => {
    const f = await fixture();
    const retained = { ...f.secret.data };
    f.behavior.beforePatch = () => {
      f.secret.metadata[field] = "replaced";
    };
    await expect(renewIngressTLS(f.options)).rejects.toThrow("not confirmed");
    expect(f.secret.data["tls.crt"] === retained["tls.crt"]).toBe(true);
    expect(f.secret.data["tls.key"] === retained["tls.key"]).toBe(true);
    expect(f.secret.data["ca.crt"] === retained["ca.crt"]).toBe(true);
    expect(f.calls.filter(({ args }) => args[8] === "get")).toHaveLength(1);
    expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(1);
    await f.cleaned();
  },
);

test("a lost patch response is not retried; the next invocation observes the renewed leaf", async () => {
  const f = await fixture();
  const retainedCA = f.secret.data["ca.crt"];
  f.behavior.losePatchResponse = true;
  await expect(renewIngressTLS(f.options)).rejects.toThrow("not confirmed");
  expect(f.calls.filter(({ args }) => args[8] === "patch")).toHaveLength(1);
  await f.cleaned();
  const count = f.calls.length;
  const renewed = f.secret.data["tls.crt"];
  const result = await renewIngressTLS(f.options);
  expect(result.status).toBe("current");
  expect(f.calls.slice(count).map(({ args }) => args[8])).toEqual(["get"]);
  expect(f.secret.data["tls.crt"] === renewed).toBe(true);
  expect(f.secret.data["ca.crt"] === retainedCA).toBe(true);
  await f.cleaned();
});

test.each(["observation", "malformed JSON", "request", "signing", "patch"])(
  "private temporary files are removed and command diagnostics redacted after %s failure",
  async (failure) => {
    const f = await fixture();
    if (failure === "observation") f.behavior.getFails = true;
    if (failure === "malformed JSON") f.behavior.getBody = "{private Secret body";
    if (failure === "request") f.behavior.opensslFails = "req";
    if (failure === "signing") f.behavior.opensslFails = "x509";
    if (failure === "patch") f.behavior.patchFails = true;
    let message = "";
    try {
      await renewIngressTLS(f.options);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("Ingress TLS");
    expect(message).not.toContain("private");
    expect(message).not.toContain("BEGIN");
    expect(message).not.toContain(f.secret.data["tls.key"]);
    await f.cleaned();
  },
);

test("a missing projected API address cannot fall back to an operator connection and cleans temp", async () => {
  const f = await fixture();
  delete process.env["KUBERNETES_SERVICE_HOST"];
  const before = (await readdir(tmpdir())).filter((name) =>
    name.startsWith("factory-ingress-tls-"),
  );
  await expect(renewIngressTLS(f.options)).rejects.toThrow("in-cluster API address");
  expect(f.calls).toHaveLength(0);
  expect(
    (await readdir(tmpdir())).filter((name) => name.startsWith("factory-ingress-tls-")),
  ).toEqual(before);
});

test("CLI exposes bounded ownership diagnostics without contacting a cluster", async () => {
  const child = await runCommand(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "ingress-tls.ts")],
    undefined,
    { timeoutMS: 5_000, outputBytes: 1024 * 1024 },
  );
  expect(child.exitCode).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    "Ingress TLS renewal failed; verify the retained CA, Secret ownership and access: Ingress TLS requires an exact Namespace, Helm release and Secret name\n",
  );
});

test("CLI does not echo malformed host configuration or parser input", async () => {
  const child = await runEnvironmentCommand(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "ingress-tls.ts")],
    {
      ...process.env,
      FACTORY_NAMESPACE: "factory",
      FACTORY_HELM_RELEASE: "factory",
      FACTORY_INGRESS_TLS_SECRET: "factory-ingress-tls",
      FACTORY_INGRESS_TLS_HOSTS: "private-configuration-must-not-appear-in-diagnostics",
    },
    { timeoutMS: 5_000, outputBytes: 1024 * 1024 },
  );
  expect(child.exitCode).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    "Ingress TLS renewal failed; verify the retained CA, Secret ownership and access\n",
  );
});
