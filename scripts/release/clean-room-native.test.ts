import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
import { cluster } from "./clean-room-cluster";
import {
  cleanRoomValues,
  createReceipt,
  namespaceManifest,
  serializeReceipt,
} from "./clean-room-model";
import {
  createNativeCleanRoomSecrets,
  prepareNativeCleanRoom,
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
