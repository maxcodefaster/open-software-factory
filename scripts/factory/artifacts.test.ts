import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRuntimeArtifacts,
  localRuntimeDefaults,
  publishedRuntimeArtifacts,
  runtimeArtifactNames,
  runtimeArtifactsSchema,
} from "./artifacts";
import { fixtureValue } from "../../test/fixtures/value";

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

test("only a complete exact artifact set can bypass first-install publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-artifacts-"));
  try {
    expect(await publishedRuntimeArtifacts(directory)).toBeNull();
    for (const name of runtimeArtifactNames)
      await writeFile(
        join(directory, `${name}-image`),
        `registry.example/${name}@sha256:${"a".repeat(64)}`,
      );
    expect(
      Object.keys(
        fixtureValue(
          await publishedRuntimeArtifacts(directory),
          "(await publishedRuntimeArtifacts(directory))",
        ),
      ),
    ).toEqual([...runtimeArtifactNames]);
    await writeFile(
      join(directory, "browser-tools-image"),
      "registry.example/browser-tools:latest",
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
