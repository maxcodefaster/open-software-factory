import { expect, test } from "bun:test";
import { publishRuntimeImage } from "./runtime-publication";

const artifact = {
  dockerfile: "deploy/runtime-host/Dockerfile",
  target: "runtime-host",
  repository: "registry.localhost:12345/open-factory/runtime-host",
  metadata: "/owned/runtime-metadata.json",
};

test("tool publication uses trusted Docker push without an insecure HTTP fallback", async () => {
  const calls: string[][] = [];
  await publishRuntimeImage(artifact, async (args) => {
    calls.push(args);
  });
  expect(calls).toEqual([
    [
      "docker",
      "buildx",
      "build",
      "--provenance=false",
      "--file",
      artifact.dockerfile,
      "--target",
      artifact.target,
      "--load",
      "--tag",
      `${artifact.repository}:local`,
      "--metadata-file",
      artifact.metadata,
      ".",
    ],
    ["docker", "push", `${artifact.repository}:local`],
  ]);
});

test("a failed image build never pushes a stale local publication tag", async () => {
  const calls: string[][] = [];
  await expect(
    publishRuntimeImage(artifact, async (args) => {
      calls.push(args);
      throw new Error("Build failed");
    }),
  ).rejects.toThrow("Build failed");
  expect(calls).toHaveLength(1);
});

test("prepared Starter publication selects the admitted worker platform explicitly", async () => {
  const calls: string[][] = [];
  await publishRuntimeImage(
    {
      ...artifact,
      target: undefined,
      platform: "linux/arm64",
      dockerfile: "templates/starter-app/.factory/images/work/Dockerfile",
    },
    async (args) => {
      calls.push(args);
    },
  );
  expect(calls[0]).toContain("--platform");
  expect(calls[0]?.[(calls[0]?.indexOf("--platform") ?? -1) + 1]).toBe("linux/arm64");
  expect(calls[0]).not.toContain("--target");
  expect(calls[1]).toEqual(["docker", "push", `${artifact.repository}:local`]);
});

test("publication does not accept a successful build as confirmation of a failed push", async () => {
  await expect(
    publishRuntimeImage(
      { ...artifact, target: undefined, dockerfile: "deploy/browser-tools/Dockerfile" },
      async (args) => {
        expect(args).not.toContain("--target");
        if (args[1] === "push") throw new Error("Push outcome unconfirmed");
      },
    ),
  ).rejects.toThrow("Push outcome unconfirmed");
});
