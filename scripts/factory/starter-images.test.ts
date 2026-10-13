import { expect, test } from "bun:test";
import upstream from "../../upstream.json";
import { localStarterCompose, starterImageManifest } from "./starter-images";

test("Starter locality selects only the exact native manifest and leaves unrelated image inputs alone", () => {
  const manifest = {
    digest: `sha256:${"a".repeat(64)}`,
    platform: { os: "linux", architecture: "arm64" },
  };
  const index = {
    manifests: [manifest, { ...manifest, platform: { os: "unknown", architecture: "unknown" } }],
  };
  expect(starterImageManifest(index, "linux/arm64")).toBe(manifest.digest);
  expect(() => starterImageManifest(index, "linux/amd64")).toThrow("unique");
  expect(() => starterImageManifest({ manifests: [manifest, manifest] }, "linux/arm64")).toThrow(
    "unique",
  );
  const images = {
    platform: "linux/arm64" as const,
    development: `registry.invalid/starter@${manifest.digest}`,
    support: `registry.invalid/support@${manifest.digest}`,
  };
  expect(
    localStarterCompose(
      `${upstream.nodeDevelopment.image}\n${upstream.node.image}\ncustom:image`,
      images,
    ),
  ).toBe(`${images.development}\n${images.support}\ncustom:image`);
  expect(() => localStarterCompose("compose", { ...images, development: "node:latest" })).toThrow();
});
