import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
import {
  requireNativeForgeOrigin,
  requireNativeInstallation,
  requireNativeRuntimeArtifact,
  requireNativeBrowserImage,
} from "./native-installation";
import { runtimeArtifactNames, runtimeArtifactsSchema } from "./artifacts";

test("startup accepts an observed official ARM runtime without substituting its immutable version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-arm-installation-"));
  const file = join(directory, "configuration.json");
  const config = nativeInstallationFixture();
  for (const attribute of config.runtime.version.attributes)
    if (attribute.key === "architecture") attribute.value = "arm64";
  try {
    await writeFile(file, JSON.stringify(config));
    expect(requireNativeInstallation({ FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: file })).toEqual(
      config,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installation accepts only its exact released Actor artifact, never the tools image", () => {
  const config = nativeInstallationFixture();
  const artifacts = runtimeArtifactsSchema.parse(
    Object.fromEntries(
      runtimeArtifactNames.map((name) => [
        name,
        `registry.example/${name}@sha256:${"b".repeat(64)}`,
      ]),
    ),
  );
  expect(() => requireNativeRuntimeArtifact(config, artifacts)).toThrow("Actor image");
  artifacts["substrate-runtime"] = config.workloadImage;
  expect(() => requireNativeRuntimeArtifact(config, artifacts)).not.toThrow();
  expect(() =>
    requireNativeRuntimeArtifact(
      { ...config, workloadImage: artifacts["runtime-host"] },
      artifacts,
    ),
  ).toThrow("Actor image");
});

test("source publication cannot substitute a host-built port-5000 browser image for native tools", () => {
  const image = `registry.example/browser-tools@sha256:${"a".repeat(64)}`;
  expect(requireNativeBrowserImage({ FACTORY_BROWSER_TOOLS_IMAGE: image })).toBe(image);
  expect(() => requireNativeBrowserImage({})).toThrow("released");
  for (const host of ["registry.example:5000", "127.0.0.1", "localhost"])
    expect(() =>
      requireNativeBrowserImage({
        FACTORY_BROWSER_TOOLS_IMAGE: `${host}/browser-tools@sha256:${"a".repeat(64)}`,
      }),
    ).toThrow();
});

test("normal startup requires native configuration, supported identity and the exact database/editor without Factorybox inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-installation-"));
  const file = join(directory, "configuration.json");
  const configuration = nativeInstallationFixture();
  const env = {
    FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: file,
    DATABASE_URL: "postgresql://factory:fixture@postgres/factory",
    FACTORY_FORGEJO_PUBLIC_URL: "https://git.example",
    FACTORY_FORGEJO_API_URL: "http://forgejo.factory.svc:3000/api/v1/",
  };
  try {
    expect(() => requireNativeInstallation({})).toThrow("FACTORY_SUBSTRATE");
    await writeFile(file, JSON.stringify(configuration));
    expect(
      requireNativeInstallation(env, { editorPrincipal: configuration.editorPrincipal }),
    ).toEqual(configuration);
    expect(requireNativeForgeOrigin(env, configuration)).toBe("https://git.example");
    expect(() => requireNativeInstallation(env, { database: "other" })).toThrow(
      "different Factory database",
    );
    expect(() =>
      requireNativeInstallation(env, {
        editorPrincipal: "user:system:serviceaccount:other:factory",
      }),
    ).toThrow("ServiceAccount");
    for (const value of [
      { ...configuration, deployment: "owned-test" },
      {
        ...configuration,
        runtime: {
          ...configuration.runtime,
          version: {
            ...configuration.runtime.version,
            attributes: [{ key: "architecture", value: "riscv64" }],
          },
        },
      },
      { ...configuration, projectID: crypto.randomUUID() },
    ]) {
      await writeFile(file, JSON.stringify(value));
      expect(() => requireNativeInstallation(env)).toThrow();
    }
    for (const origin of [
      "http://git.example",
      "https://not-admitted.example",
      "https://git.example:8443",
      "https://user:secret@git.example",
      "https://git.example/path",
    ])
      expect(() =>
        requireNativeForgeOrigin({ ...env, FACTORY_FORGEJO_PUBLIC_URL: origin }, configuration),
      ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
