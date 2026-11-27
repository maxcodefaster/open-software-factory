import { expect, test } from "bun:test";
import {
  nativeStarterImages,
  requireStarterImageConfiguration,
  starterImageManifest,
  starterImagesSchema,
} from "./starter-images";

const published = {
  platform: "linux/arm64",
  development: `registry.example.test/starter-work@sha256:${"a".repeat(64)}`,
  postgres: `registry.example.test/starter-postgres@sha256:${"b".repeat(64)}`,
};

test("publication observes the exact Starter platform and prepared non-root image user", () => {
  const image = {
    Id: `sha256:${"a".repeat(64)}`,
    Os: "linux",
    Architecture: "arm64",
    Config: { User: "1000:1000" },
  };
  expect(requireStarterImageConfiguration(image, "starter-work", "linux/arm64")).toBe(image.Id);
  expect(
    requireStarterImageConfiguration(
      { ...image, Config: { User: "postgres" } },
      "starter-postgres",
      "linux/arm64",
    ),
  ).toBe(image.Id);
  expect(() => requireStarterImageConfiguration(image, "starter-work", "linux/amd64")).toThrow(
    "platform",
  );
  for (const User of ["", "root", "0:0", "node"])
    expect(() =>
      requireStarterImageConfiguration(
        { ...image, Config: { User } },
        "starter-work",
        "linux/arm64",
      ),
    ).toThrow("non-root");
  expect(() => requireStarterImageConfiguration(image, "starter-postgres", "linux/arm64")).toThrow(
    "non-root",
  );
});

test.each(["linux/arm64", "linux/amd64"])(
  "Starter uses the explicitly selected native platform %s, not the host architecture",
  (platform) => {
    const images = { ...published, platform };
    expect(nativeStarterImages(platform, images)).toEqual(images);
    expect(starterImagesSchema.safeParse(images).success).toBe(true);
    expect(
      nativeStarterImages(platform, {
        ...images,
        development: `registry.example.test/other-work@sha256:${"c".repeat(64)}`,
      }).development,
    ).toContain("/other-work@sha256:");
  },
);

test("Starter refuses missing publication, platform mismatches, mutable references and legacy catalogs", () => {
  expect(() => nativeStarterImages("linux/arm64", undefined)).toThrow("Publish");
  expect(() => nativeStarterImages("linux/amd64", published)).toThrow("selected native runtime");
  for (const input of [
    { ...published, development: "node:latest" },
    { ...published, postgres: "postgres:16" },
    { ...published, development: "registry.example.test/work@sha256:abc" },
    { ...published, platform: "darwin/arm64" },
    { ...published, platform: "linux/arm/v7" },
    { ...published, support: published.development },
    { platform: published.platform, development: published.development },
  ])
    expect(starterImagesSchema.safeParse(input).success).toBe(false);
  expect(() => nativeStarterImages("linux/arm64/v8", published)).toThrow();
});

test("Starter publication selects one exact native platform manifest, ignoring attestations", () => {
  const arm = {
    digest: `sha256:${"a".repeat(64)}`,
    platform: { os: "linux", architecture: "arm64" },
  };
  const amd = {
    digest: `sha256:${"b".repeat(64)}`,
    platform: { os: "linux", architecture: "amd64" },
  };
  const index = {
    manifests: [arm, amd, { ...arm, platform: { os: "unknown", architecture: "unknown" } }],
  };
  expect(starterImageManifest(index, "linux/arm64")).toBe(arm.digest);
  expect(starterImageManifest(index, "linux/amd64")).toBe(amd.digest);
  expect(() => starterImageManifest({ manifests: [arm] }, "linux/amd64")).toThrow("unique");
  expect(() => starterImageManifest({ manifests: [arm, arm] }, "linux/arm64")).toThrow("unique");
  expect(() => starterImageManifest(index, "linux/arm64/extra")).toThrow();
});
