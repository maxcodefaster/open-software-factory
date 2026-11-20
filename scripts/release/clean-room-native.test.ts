import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
import { cluster, type RunOptions } from "./clean-room-cluster";
import {
  cleanRoomValues,
  createReceipt,
  namespaceManifest,
  readinessVerdict,
  serializeReceipt,
} from "./clean-room-model";
import {
  createNativeCleanRoomSecrets,
  prepareNativeCleanRoom,
  readManagedCleanRoomCA,
  readNativeCleanRoomReadiness,
  requireFreshNativeIngress,
} from "./clean-room-native";

const namespace = "factory-cleanroom-1234abcd";
const release = "factory";
const image = `registry.example.invalid/factory@sha256:${"a".repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-commissioning-"));
  const caDirectory = join(directory, "ca");
  const cert = join(directory, "ingress.pem");
  const key = join(directory, "ingress-key.pem");
  async function certificate(path: string, keyPath: string, hosts: string[], ca = caDirectory) {
    const child = Bun.spawn(["mkcert", "-cert-file", path, "-key-file", keyPath, ...hosts], {
      env: { ...process.env, CAROOT: ca },
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await child.exited) throw Error("Owned commissioning certificate generation failed");
    await chmod(keyPath, 0o600);
  }
  try {
    await certificate(cert, key, [
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
      "*.runtime.factory.owned-cleanroom.invalid",
    ]);
    const token = join(directory, "provisioner-token");
    await writeFile(token, "owned-native-provisioner-token", { mode: 0o600 });
    const base = nativeInstallationFixture();
    const input = {
      schema: 1,
      factoryOrigin: "https://factory.owned-cleanroom.invalid",
      forgejoOrigin: "https://git.owned-cleanroom.invalid",
      ingressClass: "owned-ingress",
      ingressNamespaceLabels: { "kubernetes.io/metadata.name": "owned-ingress" },
      configuration: {
        profile: base.profile,
        runtime: base.runtime,
        workloadImage: base.workloadImage,
        workerSelector: base.workerSelector,
        resources: base.resources,
        egressHosts: ["git.owned-cleanroom.invalid"],
      },
      factoryCAFile: join(caDirectory, "rootCA.pem"),
      provisionerTokenFile: token,
      ingressCertificateFile: cert,
      ingressKeyFile: key,
    };
    const path = join(directory, "native.json");
    const save = async (value: unknown = input) =>
      writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await save();
    return {
      directory,
      path,
      input,
      save,
      certificate,
      prepare: () => prepareNativeCleanRoom(path, namespace, release),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}

test.each(["trusted", "wrong CA", "wrong hostname", "cancelled"] as const)(
  "public readiness uses only the supplied native CA with normal TLS checks: %s",
  async (scenario) => {
    const f = await fixture();
    let other: Awaited<ReturnType<typeof fixture>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let requests = 0;
    try {
      if (scenario !== "wrong hostname")
        await f.certificate(f.input.ingressCertificateFile, f.input.ingressKeyFile, [
          "factory.owned-cleanroom.invalid",
          "git.owned-cleanroom.invalid",
          "*.runtime.factory.owned-cleanroom.invalid",
          "127.0.0.1",
        ]);
      const native = await f.prepare();
      expect(native.ca).toBe(await readFile(f.input.factoryCAFile, "utf8"));
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: {
          cert: await readFile(f.input.ingressCertificateFile),
          key: await readFile(f.input.ingressKeyFile),
        },
        fetch(request) {
          requests++;
          expect(new URL(request.url).pathname).toBe("/health/ready");
          expect(new URL(request.url).search).toBe("?installation=complete");
          expect(request.headers.has("authorization")).toBe(false);
          return Response.json(
            { ready: true },
            {
              headers: {
                "x-open-factory": "ready",
                "x-open-factory-startup": "owned-startup",
                connection: "close",
              },
            },
          );
        },
      });
      let ca = native.ca ?? "";
      if (scenario === "wrong CA") {
        other = await fixture();
        ca = await readFile(other.input.factoryCAFile, "utf8");
      }
      const abort = new AbortController();
      if (scenario === "cancelled") abort.abort(new Error("Owned readiness cancelled"));
      const request = readNativeCleanRoomReadiness(
        `https://127.0.0.1:${server.port}`,
        ca,
        abort.signal,
      );
      if (scenario === "trusted") {
        const response = await request;
        expect(readinessVerdict(response).ready).toBe(true);
        expect(await response.json()).toEqual({ ready: true });
        expect(requests).toBe(1);
      } else {
        await expect(request).rejects.toThrow();
        expect(requests).toBe(0);
      }
    } finally {
      await server?.stop(true);
      await other?.close();
      await f.close();
    }
  },
  15_000,
);

function managedInput(input: Record<string, unknown>) {
  return {
    ...Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          !["tlsMode", "factoryCAFile", "ingressCertificateFile", "ingressKeyFile"].includes(key),
      ),
    ),
    tlsMode: "managed",
  };
}

test("explicit managed TLS renders the issuer without any certificate-file input", async () => {
  const f = await fixture();
  try {
    await f.save(managedInput(f.input));
    await rm(f.input.ingressCertificateFile);
    await rm(f.input.ingressKeyFile);
    const native = await f.prepare();
    expect(native.metadata.tlsMode).toBe("managed");
    expect(native.ca).toBeUndefined();
    expect(native.values.tlsSecret).toBe("");
    expect(native.manifests.map((secret) => secret.metadata.name)).toEqual([
      "factory-native-configuration",
      "factory-native-provisioner",
    ]);
    expect(Object.keys(native.manifests[0]?.stringData ?? {})).toEqual(["configuration.json"]);
    expect(native.metadata.certificateSHA256).toBeUndefined();
    expect(native.redactions).not.toContain("undefined");
    const generated = cleanRoomValues({ node: "owned-node", image, native: native.values });
    const valuesPath = join(f.directory, "values.yaml");
    await writeFile(valuesPath, Bun.YAML.stringify(generated.values), { mode: 0o600 });
    const child = Bun.spawn(
      ["helm", "template", release, "deploy/helm/factory", "-n", namespace, "-f", valuesPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [text, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit) throw Error(`Owned managed chart render failed: ${error}`);
    const documents = parseAllDocuments(text).map((document) => document.toJSON());
    expect(
      documents.filter(
        (doc) => doc?.kind === "Secret" && doc.metadata?.name.startsWith("factory-ingress-"),
      ),
    ).toHaveLength(2);
    expect(
      documents.some(
        (doc) => doc?.kind === "CronJob" && doc.metadata?.name === "factory-ingress-tls",
      ),
    ).toBe(true);
    const pod = documents.find((doc) => doc?.kind === "Deployment")?.spec.template.spec;
    expect(
      pod.initContainers.some(
        (container: { name: string }) => container.name === "ensure-ingress-tls",
      ),
    ).toBe(true);
    const projection = pod.volumes.find(
      (volume: { name: string }) => volume.name === "substrate-configuration",
    );
    expect(projection.projected.sources[0].secret.items).toEqual([
      { key: "configuration.json", path: "configuration.json" },
    ]);
    expect(projection.projected.sources[1].secret.items).toEqual([
      { key: "ca.crt", path: "factory-ca.pem" },
    ]);
  } finally {
    await f.close();
  }
});

test("complete external fixtures retain their default without a tlsMode field", async () => {
  const f = await fixture();
  try {
    expect("tlsMode" in f.input).toBe(false);
    const implicit = await f.prepare();
    expect(implicit.metadata.tlsMode).toBe("external");
    expect(implicit.values.tlsSecret).toBe("factory-ingress-tls");
    expect(implicit.ca).toBe(await readFile(f.input.factoryCAFile, "utf8"));
    await f.save({ ...f.input, tlsMode: "external" });
    const explicit = await f.prepare();
    expect(explicit.metadata).toEqual(implicit.metadata);
    expect(explicit.values).toEqual(implicit.values);
  } finally {
    await f.close();
  }
});

test("external TLS requires the complete bundle and managed TLS requires explicit mode without TLS files", async () => {
  const f = await fixture();
  try {
    for (const tlsMode of ["managed", "unknown"]) {
      await f.save({ ...f.input, tlsMode });
      await expect(f.prepare()).rejects.toThrow("invalid or unexpected fields");
    }
    for (const missing of ["factoryCAFile", "ingressCertificateFile", "ingressKeyFile"]) {
      await f.save({ ...f.input, [missing]: undefined });
      await expect(f.prepare()).rejects.toThrow("invalid or unexpected fields");
    }
    await f.save({ ...managedInput(f.input), tlsMode: "external" });
    await expect(f.prepare()).rejects.toThrow("invalid or unexpected fields");
    await f.save({ ...managedInput(f.input), tlsMode: undefined });
    await expect(f.prepare()).rejects.toThrow("invalid or unexpected fields");
  } finally {
    await f.close();
  }
});

async function managedTrustFixture() {
  const f = await fixture();
  await f.save(managedInput(f.input));
  const prepared = await f.prepare();
  const ca = await readFile(f.input.factoryCAFile, "utf8");
  const namespaceObject = {
    metadata: {
      ...namespaceManifest("1234abcd", new Date()).metadata,
      uid: "original-namespace",
    },
  };
  const fields = [
    "factory-ingress-ca",
    namespace,
    "original-ca",
    "123",
    "factory",
    release,
    "Helm",
    "ingress-tls",
    release,
    namespace,
    JSON.stringify([
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
      "*.runtime.factory.owned-cleanroom.invalid",
    ]),
    "",
    "true",
    "Opaque",
    Buffer.from(ca).toString("base64"),
  ];
  const state = {
    fields,
    namespaceObject,
    reads: 0,
    namespaceReads: 0,
    failure: false,
    beforeRead: () => {},
    beforeNamespace: () => {},
  };
  const calls: { args: string[]; signal: AbortSignal | undefined }[] = [];
  const cl = {
    async json(args: string[], options?: RunOptions) {
      calls.push({ args, signal: options?.signal });
      state.namespaceReads++;
      state.beforeNamespace();
      return structuredClone(state.namespaceObject);
    },
    async kubectl(args: string[], options?: RunOptions) {
      calls.push({ args, signal: options?.signal });
      state.reads++;
      state.beforeRead();
      return {
        code: state.failure ? 1 : 0,
        stdout: state.fields.join("\n"),
        stderr: "untrusted diagnostic must never be shown",
      };
    },
  };
  return { ...f, prepared, ca, state, calls, cl };
}

test("managed public trust extraction fences ownership and uses a real public-only kubectl projection", async () => {
  const f = await managedTrustFixture();
  try {
    const controller = new AbortController();
    const result = await readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace", {
      signal: controller.signal,
    });
    expect(result.ca).toBe(f.ca);
    expect(result.metadata).toMatchObject({
      caSecretName: "factory-ingress-ca",
      caSecretUID: "original-ca",
      caSecretResourceVersion: "123",
      caFingerprint256: new X509Certificate(f.ca).fingerprint256,
    });
    expect(f.state.reads).toBe(2);
    expect(f.state.namespaceReads).toBe(2);
    expect(f.calls.every((call) => call.signal === controller.signal)).toBe(true);
    const secretCalls = f.calls.filter((call) => call.args.includes("secret"));
    expect(secretCalls.every((call) => !call.args.includes("json"))).toBe(true);
    const output = secretCalls[0]?.args.at(-1) ?? "";
    expect(output).toContain(".data.ca\\.crt");
    expect(output).not.toContain("ca.key");
    expect(output).not.toContain("tls.key");
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      immutable: true,
      metadata: {
        name: "factory-ingress-ca",
        namespace,
        uid: "original-ca",
        resourceVersion: "123",
        labels: {
          "app.kubernetes.io/name": "factory",
          "app.kubernetes.io/instance": release,
          "app.kubernetes.io/managed-by": "Helm",
          "app.kubernetes.io/component": "ingress-tls",
        },
        annotations: {
          "meta.helm.sh/release-name": release,
          "meta.helm.sh/release-namespace": namespace,
          "factory.dev/tls-hosts": f.state.fields[10],
        },
      },
      data: { "ca.crt": f.state.fields[14], "ca.key": "synthetic-signing-key-must-not-leak" },
    };
    const child = Bun.spawn(
      [
        "kubectl",
        "--kubeconfig",
        "/dev/null",
        "patch",
        "--local",
        "-f",
        "-",
        "--type=json",
        "--patch=[]",
        "-o",
        output,
      ],
      { stdin: Buffer.from(JSON.stringify(secret)), stdout: "pipe", stderr: "pipe" },
    );
    const [printed, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit) throw Error(`Owned public-only local printer failed: ${error}`);
    expect(printed).toBe(f.state.fields.join("\n"));
    expect(printed).not.toContain("synthetic-signing-key");
  } finally {
    await f.close();
  }
});

test("the extracted managed CA verifies real HTTPS readiness without ambient trust", async () => {
  const f = await managedTrustFixture();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await f.certificate(f.input.ingressCertificateFile, f.input.ingressKeyFile, [
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
      "*.runtime.factory.owned-cleanroom.invalid",
      "127.0.0.1",
    ]);
    const trust = await readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        cert: await readFile(f.input.ingressCertificateFile),
        key: await readFile(f.input.ingressKeyFile),
      },
      fetch() {
        return new Response("ready", {
          headers: { "x-open-factory": "ready", "x-open-factory-startup": "managed-startup" },
        });
      },
    });
    const response = await readNativeCleanRoomReadiness(
      `https://127.0.0.1:${server.port}`,
      trust.ca,
      new AbortController().signal,
    );
    expect(readinessVerdict(response)).toEqual({ ready: true, startupID: "managed-startup" });
    await response.body?.cancel();
  } finally {
    await server?.stop(true);
    await f.close();
  }
});

test("managed public trust refuses wrong Secret identities, hosts, types and malformed certificate data", async () => {
  const f = await managedTrustFixture();
  try {
    const original = [...f.state.fields];
    for (const index of Array.from({ length: 15 }, (_, index) => index)) {
      f.state.fields = [...original];
      f.state.fields[index] =
        index === 2 || index === 3 ? "" : index === 11 ? "2026-11-20T00:00:00Z" : "changed";
      f.state.reads = 0;
      await expect(readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace")).rejects.toThrow(
        "public CA observation failed or ownership changed",
      );
      expect(f.state.reads).toBe(1);
    }
    for (const value of [
      "",
      "PRIVATE KEY",
      `${f.ca}\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----`,
      f.ca + f.ca,
      await readFile(f.input.ingressCertificateFile, "utf8"),
    ]) {
      f.state.fields = [...original];
      f.state.fields[14] = Buffer.from(value).toString("base64");
      await expect(readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace")).rejects.toThrow(
        "public CA observation failed or ownership changed",
      );
    }
    f.state.fields = [...original];
    for (const now of [new Date("2000-01-01"), new Date("2100-01-01"), new Date("invalid")])
      await expect(
        readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace", { now }),
      ).rejects.toThrow("public CA observation failed or ownership changed");
  } finally {
    await f.close();
  }
});

test("public readiness refuses absent or non-public trust before any request", async () => {
  const controller = new AbortController();
  for (const ca of ["", "not a certificate", "-----BEGIN PRIVATE KEY-----\nprivate"])
    await expect(
      readNativeCleanRoomReadiness("https://127.0.0.1:1", ca, controller.signal),
    ).rejects.toThrow("public trust");
  await expect(
    readNativeCleanRoomReadiness("http://127.0.0.1:1", "", controller.signal),
  ).rejects.toThrow("requires HTTPS");
});

test.each(["managed", "external", "disabled"] as const)(
  "Helm install notes explain TLS ownership without exposing certificates or keys: %s",
  async (mode) => {
    const child = Bun.spawn(
      [
        "helm",
        "install",
        "owned-notes",
        "deploy/helm/factory",
        "--namespace",
        namespace,
        "--kubeconfig",
        "/dev/null",
        "--kube-apiserver",
        "http://127.0.0.1:1",
        "--dry-run=client",
        "--hide-secret",
        "--set-string",
        `image=${image}`,
        "--set",
        "publicURL=https://factory.owned-cleanroom.invalid",
        "--set",
        "forgejoPublicURL=https://git.owned-cleanroom.invalid",
        "--set",
        "substrate.workspaceConfigurationSecret=owned-configuration",
        "--set",
        "substrate.provisionerTokenSecret=owned-provisioner",
        "--set",
        `ingress.enabled=${mode !== "disabled"}`,
        ...(mode === "external" ? ["--set", "ingress.tlsSecret=owned-enterprise-tls"] : []),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit) throw Error(`Owned notes client-only render failed: ${stderr}`);
    const notes = stdout.split("NOTES:")[1] ?? "";
    expect(notes).toContain(`Factory release owned-notes in Namespace ${namespace}`);
    expect(notes).not.toContain("BEGIN CERTIFICATE");
    expect(notes).not.toContain("PRIVATE KEY");
    expect(notes).not.toContain(".data.ca\\.key");
    if (mode === "managed") {
      expect(notes).toContain('get secret "owned-notes-ingress-ca"');
      expect(notes).toContain(`--namespace "${namespace}"`);
      expect(notes).toContain("-o jsonpath='{.data.ca\\.crt}'");
      expect(notes).toContain("openssl x509 -in factory-ca.pem -noout -fingerprint -sha256 -dates");
      expect(notes).toContain("Verify the fingerprint");
      expect(notes).toContain("does not enroll client trust");
    } else {
      expect(notes).not.toContain("get secret");
      expect(notes).toContain(
        mode === "external" ? "operator-owned TLS Secret" : "Ingress is disabled",
      );
    }
  },
  15_000,
);

test("managed public trust refuses replacement, unavailable observations and cancellation without writes or retries", async () => {
  const f = await managedTrustFixture();
  try {
    for (const field of [2, 3, 14]) {
      f.state.reads = 0;
      const original = [...f.state.fields];
      f.state.beforeRead = () => {
        if (f.state.reads === 2) f.state.fields[field] = "replacement";
      };
      await expect(readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace")).rejects.toThrow(
        "ownership changed",
      );
      expect(f.state.reads).toBe(2);
      f.state.fields = original;
    }
    f.state.beforeRead = () => {};
    for (const boundary of ["before", "after"]) {
      f.state.namespaceReads = 0;
      f.state.beforeNamespace = () => {
        if (boundary === "before" || f.state.namespaceReads === 2)
          f.state.namespaceObject.metadata.uid = "replacement";
      };
      await expect(readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace")).rejects.toThrow(
        "ownership changed",
      );
      f.state.namespaceObject.metadata.uid = "original-namespace";
    }
    f.state.beforeNamespace = () => {};
    f.state.failure = true;
    f.state.reads = 0;
    await expect(readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace")).rejects.toThrow(
      "public CA observation failed or ownership changed",
    );
    expect(f.state.reads).toBe(1);
    f.state.failure = false;
    const controller = new AbortController();
    f.state.beforeRead = () => controller.abort(new Error("Owned public trust cancelled"));
    await expect(
      readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("Owned public trust cancelled");
    expect(f.calls.every((call) => call.args.includes("get"))).toBe(true);
    const count = f.calls.length;
    await expect(
      readManagedCleanRoomCA(f.cl, f.prepared, "original-namespace", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(f.calls).toHaveLength(count);
    await expect(readManagedCleanRoomCA(f.cl, f.prepared, "")).rejects.toThrow(
      "original managed clean-room identity",
    );
    expect(f.calls).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test("native commissioning renders the real chart with separate fresh Secrets and no retained identities", async () => {
  const f = await fixture();
  try {
    const native = await f.prepare();
    expect(native.configuration).toMatchObject({
      deployment: "fresh-workspaces",
      database: "factory",
      editorPrincipal: `user:system:serviceaccount:${namespace}:factory`,
      connectorURL: "wss://factory.owned-cleanroom.invalid/internal/runtime-connect",
    });
    expect(native.configuration.connection.tokenFile).not.toBe(
      native.configuration.provisioner.tokenFile,
    );
    expect(
      native.manifests.map((secret) => [secret.metadata.name, secret.metadata.namespace]),
    ).toEqual(native.metadata.secretNames.map((name) => [name, namespace]));
    const privateKey = await readFile(f.input.ingressKeyFile, "utf8");
    const token = await readFile(f.input.provisionerTokenFile, "utf8");
    expect(JSON.stringify(native.configuration).includes(privateKey)).toBe(false);
    expect(JSON.stringify(native.configuration).includes(token)).toBe(false);
    expect(
      native.manifests.map((secret) =>
        Object.values(secret.stringData).some((value) => value.includes(privateKey)),
      ),
    ).toEqual([false, false, true]);
    expect(native.manifests.map((secret) => JSON.stringify(secret).includes(token))).toEqual([
      false,
      true,
      false,
    ]);
    const generated = cleanRoomValues({ node: "owned-node", image, native: native.values });
    const valuesPath = join(f.directory, "values.yaml");
    await writeFile(valuesPath, Bun.YAML.stringify(generated.values), { mode: 0o600 });
    const child = Bun.spawn(
      [
        "helm",
        "template",
        release,
        resolve(import.meta.dir, "../../deploy/helm/factory"),
        "--namespace",
        namespace,
        "--values",
        valuesPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [text, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit) throw Error(`Owned native chart render failed: ${error}`);
    const documents = parseAllDocuments(text).map((document) => document.toJSON());
    const config = documents.find(
      (doc) => doc?.kind === "ConfigMap" && doc.metadata?.name === "factory-config",
    );
    expect(config?.data).toMatchObject({
      NODE_ENV: "production",
      FACTORY_BASE_URL: f.input.factoryOrigin,
      FACTORY_FORGEJO_PUBLIC_URL: f.input.forgejoOrigin,
      FACTORY_ZERO_CACHE_PUBLIC_URL: `${f.input.factoryOrigin}/zero`,
    });
    const ingress = documents.find((doc) => doc?.kind === "Ingress");
    expect(ingress?.spec.tls[0].secretName).toBe(native.values.tlsSecret);
    expect(ingress?.spec.rules.map((rule: { host: string }) => rule.host)).toEqual([
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
      "*.runtime.factory.owned-cleanroom.invalid",
    ]);
    expect(JSON.stringify(generated.values).includes(privateKey)).toBe(false);
    expect(JSON.stringify(generated.values).includes(token)).toBe(false);
    const receipt = createReceipt({
      id: "1234abcd",
      context: "owned-context",
      startedAt: new Date(),
      options: { keep: true, withSandbox: false, smallRequests: false, extraValues: false },
    });
    receipt.native = native.metadata;
    expect(serializeReceipt(receipt, native.redactions).includes("PRIVATE KEY")).toBe(false);
    const leaked = { ...receipt, native: { ...native.metadata, accidentalPrivateKey: privateKey } };
    expect(() => serializeReceipt(leaked, native.redactions)).toThrow(
      "receipt would contain a secret",
    );
  } finally {
    await f.close();
  }
});

test("native fixture hostnames never take over an existing Factory, Forge or runtime Ingress", async () => {
  const f = await fixture();
  try {
    const native = await f.prepare();
    for (const host of [
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
      "*.runtime.factory.owned-cleanroom.invalid",
      "other-app.runtime.factory.owned-cleanroom.invalid",
      "*.owned-cleanroom.invalid",
    ])
      expect(() =>
        requireFreshNativeIngress({ items: [{ spec: { rules: [{ host }] } }] }, native.values),
      ).toThrow("overlaps an existing Ingress");
    expect(() =>
      requireFreshNativeIngress(
        { items: [{ spec: { rules: [{ host: "retained.example.invalid" }] } }] },
        native.values,
      ),
    ).not.toThrow();
    expect(() => requireFreshNativeIngress({}, native.values)).toThrow("inventory is unavailable");
  } finally {
    await f.close();
  }
});

test("native commissioning rejects inherited identities, unadmitted egress and the wrong worker before creates", async () => {
  const f = await fixture();
  try {
    for (const field of [
      "database",
      "deployment",
      "editorPrincipal",
      "connectorURL",
      "connection",
      "projectID",
    ]) {
      await f.save({
        ...f.input,
        configuration: { ...f.input.configuration, [field]: "retained" },
      });
      await expect(f.prepare()).rejects.toThrow("omit installer-owned identities");
    }
    await f.save({ ...f.input, configuration: { ...f.input.configuration, egressHosts: [] } });
    await expect(f.prepare()).rejects.toThrow("admitted Forge TLS origin");
    const runtime = structuredClone(f.input.configuration.runtime);
    runtime.version.attributes = [{ key: "architecture", value: "riscv64" }];
    await f.save({ ...f.input, configuration: { ...f.input.configuration, runtime } });
    await expect(f.prepare()).rejects.toThrow();
    for (const factoryOrigin of [
      "http://factory.owned-cleanroom.invalid",
      "https://127.0.0.1",
      "https://factory.owned-cleanroom.invalid/path",
    ]) {
      await f.save({ ...f.input, factoryOrigin });
      await expect(f.prepare()).rejects.toThrow("HTTPS DNS origins");
    }
    await f.save({ ...f.input, forgejoOrigin: f.input.factoryOrigin });
    await expect(f.prepare()).rejects.toThrow("must differ");
  } finally {
    await f.close();
  }
});

// Two independent real CAs can exceed the default unit-test deadline on a busy host.
test("native TLS commissioning rejects a mismatched key, missing wildcard and wrong trust without a TLS bypass", async () => {
  const f = await fixture();
  try {
    const cert = join(f.directory, "other-cert.pem");
    const key = join(f.directory, "other-key.pem");
    await f.certificate(cert, key, [
      "factory.owned-cleanroom.invalid",
      "git.owned-cleanroom.invalid",
    ]);
    await f.save({ ...f.input, ingressKeyFile: key });
    await expect(f.prepare()).rejects.toThrow("do not match");
    await f.save({ ...f.input, ingressCertificateFile: cert, ingressKeyFile: key });
    await expect(f.prepare()).rejects.toThrow("complete runtime wildcard");
    const otherCA = join(f.directory, "other-ca");
    await f.certificate(cert, key, ["unrelated.invalid"], otherCA);
    await f.save({ ...f.input, factoryCAFile: join(otherCA, "rootCA.pem") });
    await expect(f.prepare()).rejects.toThrow("does not validate");
    await f.save();
    await expect(
      prepareNativeCleanRoom(f.path, namespace, release, {
        now: new Date("2040-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow("currently valid leaf");
  } finally {
    await f.close();
  }
}, 30_000);

test("native private files reject group access and symlinks before their bytes are commissioned", async () => {
  const f = await fixture();
  try {
    await chmod(f.input.provisionerTokenFile, 0o644);
    await expect(f.prepare()).rejects.toThrow("owned private regular files");
    await chmod(f.input.provisionerTokenFile, 0o600);
    const link = join(f.directory, "linked-token");
    await symlink(f.input.provisionerTokenFile, link);
    await f.save({ ...f.input, provisionerTokenFile: link });
    await expect(f.prepare()).rejects.toThrow("owned private regular files");
    await f.save();
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareNativeCleanRoom(f.path, namespace, release, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("native Secrets use create-only stdin under the original Namespace UID and never replay lost writes", async () => {
  const f = await fixture();
  try {
    const native = await f.prepare();
    const manifest = namespaceManifest("1234abcd", new Date());
    const calls: { args: string[]; name: string; namespace: string }[] = [];
    let uid = "original-namespace";
    let fail = false;
    const cl = {
      ...cluster("owned-context"),
      async json() {
        return { metadata: { ...manifest.metadata, uid } };
      },
      async kubectl(args: string[], options?: { input?: string | Uint8Array | Blob }) {
        const body = JSON.parse(String(options?.input)) as {
          metadata: { name: string; namespace: string };
        };
        calls.push({ args, ...body.metadata });
        return { code: fail ? 1 : 0, stdout: "", stderr: "untrusted diagnostic omitted" };
      },
    };
    await createNativeCleanRoomSecrets(cl, native, uid);
    expect(calls.map((call) => call.name)).toEqual(native.metadata.secretNames);
    expect(
      calls.every(
        (call) => call.namespace === namespace && call.args.join(" ") === "create -f - -o name",
      ),
    ).toBe(true);
    uid = "replacement-namespace";
    calls.length = 0;
    await expect(createNativeCleanRoomSecrets(cl, native, "original-namespace")).rejects.toThrow(
      "original Namespace UID",
    );
    expect(calls).toHaveLength(0);
    uid = "original-namespace";
    fail = true;
    await expect(createNativeCleanRoomSecrets(cl, native, uid)).rejects.toThrow("unconfirmed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(native.values.configurationSecret);
  } finally {
    await f.close();
  }
});
