import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installRuntimeArtifacts,
  type RuntimeArtifacts,
  runtimeArtifactNames,
} from "../../scripts/factory/artifacts";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeInstallationFixture } from "../fixtures/native-installation";
import {
  nativeLiveArtifacts,
  nativeLiveConfiguration,
  saveNativeLiveConfiguration,
} from "../fixtures/native-live-configuration";
import { ownedRuntimeConfiguration } from "../fixtures/runtime-configuration";

const database = `owned_${"a".repeat(32)}`;
const forge = {
  FACTORY_FORGEJO_PUBLIC_URL: "https://git.example",
  FACTORY_FORGEJO_API_URL: "http://forge.internal:3000/api/v1",
};
test("live native inputs are scoped to a new owned database without rewriting the operator template", () => {
  const operator = nativeInstallationFixture();
  const before = structuredClone(operator);
  const result = nativeLiveConfiguration(operator, database, forge, {
    platform: "linux",
    uid: 1000,
  });
  expect(result).toEqual({ ...operator, database });
  expect(operator).toEqual(before);
  expect(
    Object.keys(ownedRuntimeConfiguration).some((name) => name.startsWith("FACTORY_FACTORYBOX_")),
  ).toBe(false);
});

test("unqualified host, runtime, credentials, database or Forge origin fail before live setup", () => {
  const original = nativeInstallationFixture();
  for (const [input, db, origin, host] of [
    [original, database, "https://git.example", { platform: "darwin", uid: 1000 }],
    [original, database, "https://git.example", { platform: "linux", uid: 0 }],
    [original, "factory", "https://git.example", { platform: "linux", uid: 1000 }],
    [
      { ...original, deployment: "owned-test" },
      database,
      "https://git.example",
      { platform: "linux", uid: 1000 },
    ],
    [
      { ...original, provisioner: original.connection },
      database,
      "https://git.example",
      { platform: "linux", uid: 1000 },
    ],
    [original, database, "http://127.0.0.1:33030", { platform: "linux", uid: 1000 }],
    [original, database, undefined, { platform: "linux", uid: 1000 }],
  ] as const)
    expect(() =>
      nativeLiveConfiguration(input, db, { ...forge, FACTORY_FORGEJO_PUBLIC_URL: origin }, host),
    ).toThrow();
  for (const architecture of [
    [],
    [{ key: "architecture", value: "riscv64" }],
    [
      { key: "architecture", value: "amd64" },
      { key: "architecture", value: "amd64" },
    ],
  ])
    expect(() =>
      nativeLiveConfiguration(
        {
          ...original,
          runtime: {
            ...original.runtime,
            version: {
              ...original.runtime.version,
              attributes: [
                ...original.runtime.version.attributes.filter(
                  (item) => item.key !== "architecture",
                ),
                ...architecture,
              ],
            },
          },
        },
        database,
        forge,
        { platform: "linux", uid: 1000 },
      ),
    ).toThrow();
});

test("missing live commissioning cannot allocate an owned database or pull an inherited artifact", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw Error("No live allocation is permitted");
  });
  try {
    await expect(
      factoryProcess({
        runtimeHostImage: `registry.test/tools@sha256:${"a".repeat(64)}`,
        forgejoToken: "owned",
      }),
    ).rejects.toThrow("explicit owned Substrate");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("live fixtures consume one explicitly selected complete artifact generation without rewriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-artifacts-"));
  const file = join(directory, "runtime-artifacts.json");
  const artifacts = Object.fromEntries(
    runtimeArtifactNames.map((role) => [role, `registry.example/${role}@sha256:${"a".repeat(64)}`]),
  ) as RuntimeArtifacts;
  const configuration = nativeLiveConfiguration(
    { ...nativeInstallationFixture(), workloadImage: artifacts["substrate-runtime"] },
    database,
    forge,
    { platform: "linux", uid: 1000 },
  );
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw Error("Artifact selection must not allocate resources");
  });
  try {
    await expect(
      nativeLiveArtifacts(configuration, artifacts["runtime-host"], directory),
    ).rejects.toThrow("complete runtime-artifacts.json");
    await installRuntimeArtifacts(directory, artifacts);
    const before = await readFile(file, "utf8");
    expect(await nativeLiveArtifacts(configuration, artifacts["runtime-host"], directory)).toEqual(
      artifacts,
    );
    await expect(
      nativeLiveArtifacts(
        { ...configuration, workloadImage: `registry.example/other@sha256:${"b".repeat(64)}` },
        artifacts["runtime-host"],
        directory,
      ),
    ).rejects.toThrow("workloadImage differs");
    await expect(
      nativeLiveArtifacts(
        configuration,
        `registry.example/other@sha256:${"b".repeat(64)}`,
        directory,
      ),
    ).rejects.toThrow("tools differ");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retained fixture configuration is read-only and a changed template requires a new fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-config-"));
  const file = join(directory, "configuration.json");
  const config = nativeLiveConfiguration(nativeInstallationFixture(), database, forge, {
    platform: "linux",
    uid: 1000,
  });
  try {
    await saveNativeLiveConfiguration(file, config, false);
    const before = await readFile(file, "utf8");
    await expect(saveNativeLiveConfiguration(file, config, false)).rejects.toThrow();
    expect(await saveNativeLiveConfiguration(file, config, true)).toBe(file);
    await expect(
      saveNativeLiveConfiguration(
        file,
        { ...config, workloadImage: `registry.test/other@sha256:${"b".repeat(64)}` },
        true,
      ),
    ).rejects.toThrow("differs");
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
