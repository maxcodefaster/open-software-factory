import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRuntimeArtifacts,
  publishedRuntimeArtifacts,
  runtimeArtifactNames,
  runtimeArtifactsSchema,
} from "./artifacts";

test("only a complete exact artifact set can bypass first-install publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-artifacts-"));
  try {
    expect(await publishedRuntimeArtifacts(directory)).toBeNull();
    for (const name of runtimeArtifactNames)
      await writeFile(
        join(directory, `${name}-image`),
        `registry.example/${name}@sha256:${"a".repeat(64)}`,
      );
    expect(Object.keys((await publishedRuntimeArtifacts(directory))!)).toEqual([
      ...runtimeArtifactNames,
    ]);
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
