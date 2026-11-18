import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { serviceAccountConfiguration } from "../../packages/runtime-kubernetes/src/service-account";

type Execute = (
  args: readonly string[],
  input?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type RenewIngressTLSInput = {
  namespace: string;
  release: string;
  secretName: string;
  caFile?: string;
  caKeyFile?: string;
  stateDirectory?: string;
  hosts: string[];
  execute?: Execute;
  now?: Date;
};

const day = 24 * 60 * 60 * 1000;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function dnsName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    value.split(".").every((label) => dnsLabel.test(label))
  );
}
function tlsHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) return false;
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return dnsName(name) && isIP(name) === 0;
}
function canonicalHosts(hosts: unknown) {
  if (!Array.isArray(hosts) || !hosts.length || !hosts.every(tlsHost))
    throw new Error("Ingress TLS requires DNS hosts with wildcards only in a leading '*.' label");
  return [...new Set<string>(hosts)].sort();
}
function exactHosts(value: unknown, hosts: string[]) {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const canonical = canonicalHosts(parsed);
  return (
    Array.isArray(parsed) &&
    parsed.length === canonical.length &&
    JSON.stringify(canonical) === JSON.stringify(hosts)
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Ingress TLS Secret is malformed");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function secretData(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Ingress TLS Secret has invalid certificate data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("Ingress TLS Secret has invalid certificate data");
  return bytes;
}
function certificate(pem: Buffer) {
  // X509Certificate otherwise accepts the first certificate and ignores trailing
  // material. This installation owns exactly one retained root and one leaf.
  if (
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
      pem.toString("utf8").trim(),
    )
  )
    throw new Error("Ingress TLS requires a single PEM certificate");
  return new X509Certificate(pem);
}
function validAt(cert: X509Certificate, now: number) {
  return now >= Date.parse(cert.validFrom) && now < Date.parse(cert.validTo);
}
function validateLeaf(
  pem: Buffer,
  key: Buffer,
  root: X509Certificate,
  hosts: string[],
  now: number,
  allowExpired = false,
) {
  try {
    const leaf = certificate(pem);
    // Node quotes/escapes ambiguous SANs. Accept only plain DNS entries, not
    // quoted strings, other GeneralName types, CN fallback or partial wildcards.
    const sans = leaf.subjectAltName?.split(", ").map((entry) => {
      if (!entry.startsWith("DNS:") || !tlsHost(entry.slice(4))) throw new Error();
      return entry.slice(4);
    });
    if (
      leaf.ca ||
      now < Date.parse(leaf.validFrom) ||
      (!allowExpired && !validAt(leaf, now)) ||
      !leaf.checkIssued(root) ||
      !leaf.verify(root.publicKey) ||
      !leaf.checkPrivateKey(createPrivateKey(key)) ||
      !sans ||
      sans.length !== hosts.length ||
      JSON.stringify(sans.sort()) !== JSON.stringify(hosts)
    )
      throw new Error();
    return leaf;
  } catch {
    throw new Error(
      "Ingress TLS leaf must match its key, exact DNS hosts and retained CA, without a future start date",
    );
  }
}
function result(status: "current" | "renewed", cert: X509Certificate) {
  return {
    status,
    expiresAt: new Date(cert.validTo).toISOString(),
    fingerprint256: cert.fingerprint256,
  };
}

async function retainIdentity(
  input: RenewIngressTLSInput,
  hosts: string[],
  root: X509Certificate,
  rootKey: Buffer,
  data: Record<string, unknown>,
  now: number,
) {
  if (input.stateDirectory === undefined) return;
  try {
    if (!isAbsolute(input.stateDirectory)) throw new Error();
    const directory = resolve(input.stateDirectory);
    const parent = dirname(directory);
    const uid = process.getuid?.();
    const owner = await lstat(parent);
    if (
      uid === undefined ||
      !owner.isDirectory() ||
      owner.uid !== uid ||
      (owner.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent
    )
      throw new Error();
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error();
    }
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.uid !== uid ||
      (directoryStat.mode & 0o7777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error();
    const path = join(directory, "identity.json");
    const identity = {
      schema: 1,
      namespace: input.namespace,
      release: input.release,
      secretName: input.secretName,
      hosts,
      "ca.crt": secretData(data["ca.crt"]).toString("base64"),
      "ca.key": rootKey.toString("base64"),
      "tls.crt": secretData(data["tls.crt"]).toString("base64"),
      "tls.key": secretData(data["tls.key"]).toString("base64"),
    };
    try {
      const file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(`${JSON.stringify(identity)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error();
    }
    const fileStat = await lstat(path);
    if (
      !fileStat.isFile() ||
      fileStat.uid !== uid ||
      fileStat.nlink !== 1 ||
      (fileStat.mode & 0o7777) !== 0o600 ||
      (await realpath(path)) !== path
    )
      throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.ino !== fileStat.ino || opened.dev !== fileStat.dev || opened.size > 1024 * 1024)
        throw new Error();
      const saved = record(JSON.parse(await file.readFile("utf8")));
      if (
        JSON.stringify(Object.keys(saved).sort()) !==
          JSON.stringify(Object.keys(identity).sort()) ||
        saved["schema"] !== 1 ||
        saved["namespace"] !== input.namespace ||
        saved["release"] !== input.release ||
        saved["secretName"] !== input.secretName ||
        !exactHosts(saved["hosts"], hosts) ||
        saved["ca.crt"] !== identity["ca.crt"] ||
        saved["ca.key"] !== identity["ca.key"]
      )
        throw new Error();
      // The first saved leaf belongs to the backup identity. Rotation must not
      // rewrite it; an expired restored leaf is reissued by the init container.
      validateLeaf(
        secretData(saved["tls.crt"]),
        secretData(saved["tls.key"]),
        root,
        hosts,
        now,
        true,
      );
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(
      "Ingress TLS backup identity is unsafe or does not match the retained installation",
    );
  }
}

export async function renewIngressTLS(input: RenewIngressTLSInput) {
  if (
    !dnsName(input.namespace) ||
    input.namespace.length > 63 ||
    input.namespace.includes(".") ||
    !dnsName(input.release) ||
    input.release.length > 53 ||
    input.release.includes(".") ||
    !dnsName(input.secretName)
  )
    throw new Error("Ingress TLS requires an exact Namespace, Helm release and Secret name");
  const hosts = canonicalHosts(input.hosts);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new Error("Ingress TLS requires a valid observation time");
  const execute: Execute =
    input.execute ??
    ((args, body) => runCommand(args, body, { timeoutMS: 15_000, outputBytes: 1024 * 1024 }));
  async function command(args: string[], body: string | undefined, failure: string) {
    try {
      const observed = await execute(args, body);
      if (observed.exitCode !== 0) throw new Error();
      return observed.stdout;
    } catch {
      // Neither kubectl nor OpenSSL diagnostics may disclose Secret bodies or keys.
      throw new Error(failure);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "factory-ingress-tls-"));
  const privateFile = async (name: string, value: string | Buffer) => {
    const path = join(directory, name);
    await writeFile(path, value, { mode: 0o600, flag: "wx" });
    return path;
  };
  try {
    const kubeconfig = await privateFile(
      "kubeconfig.json",
      JSON.stringify(serviceAccountConfiguration()),
    );
    const kubectl = [
      "kubectl",
      "--kubeconfig",
      kubeconfig,
      "--context",
      "factory",
      "--request-timeout=10s",
      "--namespace",
      input.namespace,
    ];
    const observed = await command(
      [...kubectl, "get", "secret", input.secretName, "-o", "json"],
      undefined,
      "Ingress TLS Secret observation failed",
    );
    let secret: Record<string, unknown>;
    try {
      secret = record(JSON.parse(observed));
    } catch {
      throw new Error("Ingress TLS Secret observation is malformed");
    }
    const metadata = record(secret["metadata"]);
    const labels = record(metadata["labels"]);
    const annotations = record(metadata["annotations"]);
    let matchingHosts = false;
    try {
      matchingHosts =
        typeof annotations["factory.dev/tls-hosts"] === "string" &&
        exactHosts(annotations["factory.dev/tls-hosts"], hosts);
    } catch {
      // Invalid annotation JSON is an ownership mismatch, never a new host set.
    }
    if (
      secret["type"] !== "kubernetes.io/tls" ||
      metadata["name"] !== input.secretName ||
      metadata["namespace"] !== input.namespace ||
      !nonempty(metadata["uid"]) ||
      !nonempty(metadata["resourceVersion"]) ||
      metadata["deletionTimestamp"] != null ||
      labels["app.kubernetes.io/name"] !== "factory" ||
      labels["app.kubernetes.io/instance"] !== input.release ||
      labels["app.kubernetes.io/component"] !== "ingress-tls" ||
      !matchingHosts
    )
      throw new Error("Ingress TLS Secret does not match the retained installation ownership");
    const data = record(secret["data"]);
    let root: X509Certificate;
    let rootPEM: Buffer;
    let rootKey: Buffer;
    try {
      [rootPEM, rootKey] = await Promise.all([
        readFile(input.caFile ?? "/run/factory/ingress-ca/ca.crt"),
        readFile(input.caKeyFile ?? "/run/factory/ingress-ca/ca.key"),
      ]);
      root = certificate(rootPEM);
      if (
        !root.ca ||
        root.subject !== root.issuer ||
        !root.verify(root.publicKey) ||
        !root.checkPrivateKey(createPrivateKey(rootKey)) ||
        !validAt(root, now) ||
        !certificate(secretData(data["ca.crt"])).raw.equals(root.raw)
      )
        throw new Error();
    } catch {
      throw new Error(
        "Ingress TLS retained root CA, key and Secret trust do not match or are invalid",
      );
    }
    const leaf = validateLeaf(
      secretData(data["tls.crt"]),
      secretData(data["tls.key"]),
      root,
      hosts,
      now,
      true,
    );
    await retainIdentity(input, hosts, root, rootKey, data, now);
    if (Date.parse(leaf.validTo) - now > 30 * day) return result("current", leaf);
    if (Date.parse(root.validTo) - now < 100 * day)
      throw new Error(
        "Ingress TLS retained root CA has less than 100 days remaining; renewal refused",
      );

    // Snapshot the validated signer; a projected volume refresh must not change
    // the CA identity between validation and signing. Never update that CA.
    const caFile = await privateFile("ca.crt", rootPEM);
    const caKeyFile = await privateFile("ca.key", rootKey);
    const keyFile = await privateFile("tls.key", "");
    const csrFile = join(directory, "tls.csr");
    const certFile = join(directory, "tls.crt");
    const configFile = await privateFile(
      "request.cnf",
      "[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nCN = Factory ingress\n",
    );
    const extensionsFile = await privateFile(
      "leaf.cnf",
      [
        "[leaf]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature",
        "extendedKeyUsage = serverAuth",
        "subjectAltName = @hosts",
        "[hosts]",
        ...hosts.map((host, index) => `DNS.${index + 1} = ${host}`),
        "",
      ].join("\n"),
    );
    await command(
      [
        "openssl",
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
        configFile,
        "-keyout",
        keyFile,
        "-out",
        csrFile,
      ],
      undefined,
      "Ingress TLS leaf key and request generation failed",
    );
    const serial = randomBytes(16);
    serial[0] = (serial[0] ?? 0) | 0x80;
    await command(
      [
        "openssl",
        "x509",
        "-req",
        "-in",
        csrFile,
        "-CA",
        caFile,
        "-CAkey",
        caKeyFile,
        "-set_serial",
        `0x${serial.toString("hex")}`,
        "-days",
        "90",
        "-sha256",
        "-extfile",
        extensionsFile,
        "-extensions",
        "leaf",
        "-out",
        certFile,
      ],
      undefined,
      "Ingress TLS leaf signing failed",
    );
    const [nextPEM, nextKey] = await Promise.all([readFile(certFile), readFile(keyFile)]);
    // Signing can cross a certificate notBefore second. Validate the new leaf
    // at completion, not at the older observation used for renewal eligibility.
    const next = validateLeaf(nextPEM, nextKey, root, hosts, (input.now ?? new Date()).getTime());
    const patch = [
      { op: "test", path: "/metadata/uid", value: metadata["uid"] },
      { op: "test", path: "/metadata/resourceVersion", value: metadata["resourceVersion"] },
      { op: "replace", path: "/data/tls.crt", value: nextPEM.toString("base64") },
      { op: "replace", path: "/data/tls.key", value: nextKey.toString("base64") },
    ];
    // One dispatch only. A lost response is unconfirmed, not permission to retry;
    // the next scheduled invocation observes the current, exactly named Secret.
    // Pinned kubectl reads patch-file as a path, including a literal "-".
    // Linux cannot reopen Bun's stdin socketpair through /dev/stdin, so use a
    // private regular file, never Secret data in argv or command diagnostics.
    const patchFile = await privateFile("patch.json", JSON.stringify(patch));
    await command(
      [
        ...kubectl,
        "patch",
        "secret",
        input.secretName,
        "--type=json",
        `--patch-file=${patchFile}`,
        "-o",
        "name",
      ],
      undefined,
      "Ingress TLS patch was not confirmed; observe the Secret before another renewal",
    );
    return result("renewed", next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(
        await renewIngressTLS({
          namespace: process.env["FACTORY_NAMESPACE"] ?? "",
          release: process.env["FACTORY_HELM_RELEASE"] ?? "",
          secretName: process.env["FACTORY_INGRESS_TLS_SECRET"] ?? "",
          hosts: JSON.parse(process.env["FACTORY_INGRESS_TLS_HOSTS"] ?? "null"),
          ...(process.env["FACTORY_INGRESS_TLS_STATE_DIRECTORY"] !== undefined
            ? { stateDirectory: process.env["FACTORY_INGRESS_TLS_STATE_DIRECTORY"] }
            : {}),
        }),
      ),
    );
  } catch (cause) {
    // Only our bounded infrastructure messages are safe for Job diagnostics.
    // Parser, subprocess and filesystem errors must not echo caller input or keys.
    const detail =
      cause instanceof Error && cause.message.startsWith("Ingress TLS ")
        ? `: ${cause.message}`
        : "";
    console.error(
      `Ingress TLS renewal failed; verify the retained CA, Secret ownership and access${detail}`,
    );
    process.exitCode = 1;
  }
}
