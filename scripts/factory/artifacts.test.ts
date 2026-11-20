import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRuntimeArtifacts,
  localRuntimeDefaults,
  publishedRuntimeArtifacts,
  requirePublishedRuntimeArtifacts,
  runtimeArtifactEnvironment,
  runtimeArtifactNames,
  runtimeArtifactsSchema,
} from "./artifacts";
import { createInstallation, loadInstallation } from "./installation";

test("native installations require four artifacts and no separate Source image", async () => {
  const names = ["runtime-host", "browser-tools", "developer-ide", "substrate-runtime"] as const;
  const bundle = Object.fromEntries(
    names.map((name) => [name, `registry.example/${name}@sha256:${"a".repeat(64)}`]),
  );
  expect(runtimeArtifactsSchema.safeParse(bundle).success).toBe(true);
  const native = runtimeArtifactsSchema.parse(bundle);
  expect([...runtimeArtifactNames]).toEqual([...names]);
  expect(runtimeArtifactEnvironment(native)).toEqual({
    FACTORY_RUNTIME_HOST_IMAGE: native["runtime-host"],
    FACTORY_BROWSER_TOOLS_IMAGE: native["browser-tools"],
    FACTORY_DEVELOPER_IDE_IMAGE: native["developer-ide"],
  });
  expect(
    runtimeArtifactsSchema.safeParse({
      ...bundle,
      "workspace-files": `registry.example/workspace-files@sha256:${"a".repeat(64)}`,
    }).success,
  ).toBe(false);
  const directory = await mkdtemp(join(tmpdir(), "factory-native-artifacts-"));
  try {
    await installRuntimeArtifacts(directory, native);
    expect(await publishedRuntimeArtifacts(directory)).toEqual(native);
    expect(await readdir(directory)).toEqual(["runtime-artifacts.json"]);
    expect(await Bun.file(join(directory, "workspace-files-image")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact publication rejects consumer references runtime admission cannot accept", () => {
  const bundle = Object.fromEntries(
    runtimeArtifactNames.map((name) => [name, `registry.example/${name}@sha256:${"a".repeat(64)}`]),
  );
  for (const reference of [
    `runtime-host@sha256:${"a".repeat(64)}`,
    `registry.example/team/../runtime-host@sha256:${"a".repeat(64)}`,
  ])
    expect(runtimeArtifactsSchema.safeParse({ ...bundle, "runtime-host": reference }).success).toBe(
      false,
    );
  const { "substrate-runtime": _native, ...toolsOnly } = bundle;
  expect(runtimeArtifactsSchema.safeParse(toolsOnly).success).toBe(false);
  expect(
    runtimeArtifactsSchema.safeParse({ ...bundle, factorybox: bundle["runtime-host"] }).success,
  ).toBe(false);
});

test("published defaults supersede installation bootstrap pins without changing retained identities", () => {
  const bootstrap = {
    runtimeImage: `registry.example/runtime-host@sha256:${"a".repeat(64)}`,
    browserImage: `registry.example/browser-tools@sha256:${"a".repeat(64)}`,
  };
  const published = runtimeArtifactsSchema.parse(
    Object.fromEntries(
      runtimeArtifactNames.map((name) => [
        name,
        `registry.example/${name}@sha256:${"b".repeat(64)}`,
      ]),
    ),
  );
  const original = structuredClone(bootstrap);
  expect(localRuntimeDefaults(published, bootstrap)).toEqual({
    runtimeImage: published["runtime-host"],
    browserImage: published["browser-tools"],
  });
  expect(bootstrap).toEqual(original);
  expect(localRuntimeDefaults(null, bootstrap)).toEqual(original);
  expect(localRuntimeDefaults(published, null).runtimeImage).toBe(published["runtime-host"]);
  expect(localRuntimeDefaults(null, null).runtimeImage).toBeUndefined();
});

test("only the complete bundle can bypass publication; per-role files are never adopted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-artifacts-"));
  try {
    expect(await publishedRuntimeArtifacts(directory)).toBeNull();
    for (const name of runtimeArtifactNames)
      await writeFile(
        join(directory, `${name}-image`),
        `registry.example/${name}@sha256:${"a".repeat(64)}`,
      );
    expect(await publishedRuntimeArtifacts(directory)).toBeNull();
    await expect(requirePublishedRuntimeArtifacts(directory)).rejects.toThrow(
      "complete runtime-artifacts.json",
    );
    await writeFile(join(directory, "runtime-artifacts.json"), "invalid-json");
    await expect(publishedRuntimeArtifacts(directory)).rejects.toThrow();
    await writeFile(
      join(directory, "runtime-artifacts.json"),
      JSON.stringify({ "runtime-host": `registry.example/runtime-host@sha256:${"a".repeat(64)}` }),
    );
    await expect(publishedRuntimeArtifacts(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release bundles validate completely and replace future defaults as one generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-release-"));
  const bundle = runtimeArtifactsSchema.parse(
    Object.fromEntries(
      runtimeArtifactNames.map((name) => [
        name,
        `registry.example/${name}@sha256:${"a".repeat(64)}`,
      ]),
    ),
  );
  try {
    await expect(
      installRuntimeArtifacts(directory, { ...bundle, extra: "untrusted" }),
    ).rejects.toThrow();
    await expect(
      installRuntimeArtifacts(directory, { ...bundle, "developer-ide": undefined }),
    ).rejects.toThrow();
    expect(await publishedRuntimeArtifacts(directory)).toBeNull();
    await writeFile(join(directory, "runtime-host-image"), `${bundle["runtime-host"]}\n`);
    await installRuntimeArtifacts(directory, bundle);
    expect(await publishedRuntimeArtifacts(directory)).toEqual(bundle);
    await writeFile(join(directory, "runtime-host-image"), "untrusted:latest");
    expect(await requirePublishedRuntimeArtifacts(directory)).toEqual(bundle);
    const next = {
      ...bundle,
      "browser-tools": `registry.example/browser-tools@sha256:${"b".repeat(64)}`,
    };
    await installRuntimeArtifacts(directory, next);
    expect(await publishedRuntimeArtifacts(directory)).toEqual(next);
    await expect(
      installRuntimeArtifacts(directory, { ...next, "runtime-host": "invalid" }),
    ).rejects.toThrow();
    expect(await publishedRuntimeArtifacts(directory)).toEqual(next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle replacement leaves retained installation image identities byte-for-byte unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-retained-artifacts-"));
  const original = runtimeArtifactsSchema.parse(
    Object.fromEntries(
      runtimeArtifactNames.map((name) => [
        name,
        `registry.example/${name}@sha256:${"a".repeat(64)}`,
      ]),
    ),
  );
  try {
    const retained = await createInstallation(directory, "owned-artifacts", {
      runtimeImage: original["runtime-host"],
      browserImage: original["browser-tools"],
    });
    const identity = join(directory, ".factory/installations/owned-artifacts/installation.json");
    const bytes = await readFile(identity);
    const next = runtimeArtifactsSchema.parse(
      Object.fromEntries(
        runtimeArtifactNames.map((name) => [
          name,
          `registry.example/${name}@sha256:${"b".repeat(64)}`,
        ]),
      ),
    );
    await installRuntimeArtifacts(directory, next);
    expect(await requirePublishedRuntimeArtifacts(directory)).toEqual(next);
    expect(await loadInstallation(directory, "owned-artifacts")).toEqual(retained);
    expect(await readFile(identity)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
