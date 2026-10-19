import { expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireSafeRegistryStorage } from "./registry-storage";

test("the Registry manifest uses retained storage and preserves its upstream image pin", async () => {
  const documents = parseAllDocuments(
    await Bun.file(new URL("../../deploy/runtime-smoke/registry.yaml", import.meta.url)).text(),
  ).map((document) => document.toJSON());
  const claim = documents.find((document) => document.kind === "PersistentVolumeClaim");
  const registry = documents.find((document) => document.kind === "Deployment");
  expect(claim?.metadata.name).toBe("registry-data");
  expect(claim?.spec.accessModes).toEqual(["ReadWriteOnce"]);
  expect(
    registry.spec.template.spec.volumes.find((volume: { name: string }) => volume.name === "data"),
  ).toEqual({ name: "data", persistentVolumeClaim: { claimName: "registry-data" } });
  expect(registry.spec.strategy).toEqual({ type: "Recreate" });
  expect(registry.spec.template.spec.containers[0].image).toBe(
    "docker.io/library/registry:3@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33",
  );
});

test("publication refuses destructive temporary-storage conversion before restarting the Registry", () => {
  const labels = { "app.kubernetes.io/name": "open-factory-registry" };
  const current = {
    metadata: { name: "registry", uid: "owned-registry", labels },
    spec: { template: { spec: { volumes: [{ name: "data", emptyDir: {} }] } } },
  };
  expect(() => requireSafeRegistryStorage(current, null)).toThrow("Preserve its existing data");
});

test("new Registry setup and retained owned storage are accepted, but missing or foreign claims are not", () => {
  const labels = {
    "app.kubernetes.io/name": "open-factory-registry",
    "app.kubernetes.io/managed-by": "open-software-factory",
  };
  const pvc = { metadata: { name: "registry-data", uid: "owned-claim", labels } };
  const current = {
    metadata: { name: "registry", uid: "owned-registry", labels },
    spec: {
      template: {
        spec: {
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "registry-data" } }],
        },
      },
    },
  };
  expect(() => requireSafeRegistryStorage(null, null)).not.toThrow();
  expect(() => requireSafeRegistryStorage(current, pvc)).not.toThrow();
  expect(() => requireSafeRegistryStorage(current, null)).toThrow("missing");
  expect(() =>
    requireSafeRegistryStorage(current, { metadata: { ...pvc.metadata, labels: {} } }),
  ).toThrow("foreign");
});

test("the documented publish command rejects temporary Registry storage before build, TLS or port-forward work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-publish-storage-"));
  const calls = join(directory, "calls");
  const deployment = JSON.stringify({
    metadata: {
      name: "registry",
      uid: "owned-registry",
      labels: { "app.kubernetes.io/name": "open-factory-registry" },
    },
    spec: { template: { spec: { volumes: [{ name: "data", emptyDir: {} }] } } },
  });
  try {
    await writeFile(
      join(directory, "kubectl"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *"get deployment/registry"*) printf '%s' '${deployment}' ;;
  *"get persistentvolumeclaim/registry-data"*) exit 0 ;;
  *"get service/registry"*) printf '%s' '{"metadata":{"name":"registry"}}' ;;
  *) exit 88 ;;
esac
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(directory, "mkcert"),
      `#!/bin/sh
printf 'mkcert %s\\n' "$*" >> ${JSON.stringify(calls)}
printf '%s' ${JSON.stringify(directory)}
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(directory, "docker"),
      `#!/bin/sh
printf 'docker %s\\n' "$*" >> ${JSON.stringify(calls)}
exit 89
`,
      { mode: 0o700 },
    );
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/factory/index.ts", "publish-runtime"],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          FACTORY_STATE_DIRECTORY: join(directory, "state"),
          FACTORY_KUBERNETES_CONTEXT: "owned-fixture",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status).not.toBe(0);
    expect(output + error).toContain("Registry uses temporary storage");
    const commands = await readFile(calls, "utf8");
    expect(commands).toContain("get deployment/registry");
    expect(commands).toContain("get persistentvolumeclaim/registry-data");
    expect(commands).not.toContain("port-forward");
    expect(commands).not.toContain("mkcert");
    expect(commands).not.toContain("docker");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
