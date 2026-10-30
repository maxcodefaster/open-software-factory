import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  factoryboxBuildCandidate,
  factoryboxBuildCommand,
  factoryboxBuildRequest,
  main,
} from "./factorybox-build";

const request = factoryboxBuildRequest.parse({
  repository: "/owned/factorybox",
  platform: "linux/arm64",
  nativeBaseBuild: `factorybox-build-native-base-${"a".repeat(32)}`,
  sysboxBuild: `factorybox-build-sysbox-${"b".repeat(32)}`,
  retainedCandidate: `factorybox-build-criu-retained-${"c".repeat(32)}`,
  nodeName: "orbstack",
  kernel: "owned-kernel",
});
const receipt = {
  schema: 1,
  passed: true,
  platform: request.platform,
  worker_build: `factorybox-build-worker-${"d".repeat(32)}`,
  image: `factorybox-worker-${"e".repeat(32)}@sha256:${"f".repeat(64)}`,
  executable_sha256: "1".repeat(64),
  native_lifecycle_qualified: false,
  production_qualified: false,
};

test("Factory builds either explicit target without publishing or selecting installed artifacts", () => {
  const { sysboxBuild, retainedCandidate } = request;
  if (!sysboxBuild || !retainedCandidate) throw new Error("Missing exact component fixtures");
  for (const platform of ["linux/arm64", "linux/amd64"] as const) {
    const input = { ...request, platform };
    const command = factoryboxBuildCommand(input);
    expect(command).toContain(platform);
    expect(command).toContain(request.nativeBaseBuild);
    expect(command).toContain(sysboxBuild);
    expect(command).toContain(retainedCandidate);
    expect(command).not.toContain("--push");
    const candidate = factoryboxBuildCandidate(input, { ...receipt, platform });
    expect(candidate.profile.architecture).toBe(platform === "linux/arm64" ? "arm64" : "amd64");
    expect(candidate.profile.image).toBe(receipt.image);
    expect(candidate.profile.executableSHA256).toBe(receipt.executable_sha256);
    expect(candidate.profile).toMatchObject({
      boundedBytes: 32 * 1024 ** 3,
      minimumBoundedBytes: 8 * 1024 ** 3,
      claimGiB: 64,
    });
  }
  expect(() => factoryboxBuildCandidate(request, { ...receipt, platform: "linux/amd64" })).toThrow(
    "differs",
  );
  for (const altered of [
    { passed: false },
    { native_lifecycle_qualified: true },
    { production_qualified: true },
    { image: "worker:latest" },
    { executable_sha256: "missing" },
  ])
    expect(() => factoryboxBuildCandidate(request, { ...receipt, ...altered })).toThrow();
  expect(() => factoryboxBuildRequest.parse({ ...request, repository: "../factorybox" })).toThrow();
  expect(() => factoryboxBuildRequest.parse({ ...request, platform: "darwin/arm64" })).toThrow();
});

async function fixture(
  overrides: {
    imageArchitecture?: string;
    hostArchitecture?: string;
    hash?: string;
    doctorCode?: number;
  } = {},
) {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "factorybox-build-test-"));
  const input = resolve(root, "request.json");
  await writeFile(input, JSON.stringify({ ...request, repository: root }));
  const calls: string[][] = [];
  let evidence: string | undefined;
  const run: NonNullable<Parameters<typeof main>[1]>["run"] = async (args) => {
    calls.push(args);
    if (args[0] === "mise") {
      const directories = new Bun.Glob("factorybox-build-*/intent.json");
      for await (const path of directories.scan(parent)) {
        const intent = await Bun.file(resolve(parent, path)).json();
        if (intent.request?.repository === root) evidence = resolve(parent, path, "..");
      }
      expect(evidence).toBeDefined();
      return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
    }
    if (args.includes("inspect"))
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { Os: "linux", Architecture: overrides.imageArchitecture ?? "arm64" },
        ]),
        stderr: "",
      };
    if (args.includes("info"))
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          OSType: "linux",
          Architecture: overrides.hostArchitecture ?? "aarch64",
        }),
        stderr: "",
      };
    if (args.includes("/usr/bin/sha256sum"))
      return {
        exitCode: 0,
        stdout: `${overrides.hash ?? receipt.executable_sha256}  /opt/factorybox/factorybox\n`,
        stderr: "",
      };
    expect(args.at(-1)).toBe("doctor");
    expect(args).toContain("--read-only");
    expect(args).toContain("--network=none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--pull=never");
    return {
      exitCode: overrides.doctorCode ?? 1,
      stdout: JSON.stringify({
        platform: { os: "linux", architecture: "arm64", page_size: 4096, kernel: request.kernel },
        matches_reference: overrides.doctorCode === 0,
        error: "ARM64 runtime is not qualified",
      }),
      stderr: "",
    };
  };
  return {
    input,
    calls,
    run,
    evidence: () => evidence,
    cleanup: async () => {
      if (evidence) await rm(evidence, { recursive: true });
      await rm(root, { recursive: true });
    },
  };
}

test("a real-target build records native refusal and leaves installed Factory state unchanged", async () => {
  const owned = await fixture();
  try {
    const result = await main([owned.input], { run: owned.run });
    expect(result.passed).toBe(true);
    expect(result.nativeHost).toBe(true);
    expect(result.platformMatches).toBe(false);
    expect(result.nativeLifecycleQualified).toBe(false);
    expect(result.installed).toBe(false);
    const profile = JSON.parse(
      await readFile(resolve(result.evidence, "profile.candidate.json"), "utf8"),
    );
    expect(profile.architecture).toBe("arm64");
    expect(profile.executableSHA256).toBe(receipt.executable_sha256);
    expect(owned.calls.filter((args) => args[0] === "mise")).toHaveLength(1);
    expect(owned.calls.some((args) => args.includes("push") || args.includes("apply"))).toBe(false);
  } finally {
    await owned.cleanup();
  }
});

test("even a matching doctor never promotes a build to native lifecycle qualification", async () => {
  const owned = await fixture({ doctorCode: 0 });
  try {
    const result = await main([owned.input], { run: owned.run });
    expect(result.platformMatches).toBe(true);
    expect(result.nativeLifecycleQualified).toBe(false);
    expect(result.installed).toBe(false);
  } finally {
    await owned.cleanup();
  }
});

test("emulation is not recorded as native qualification", async () => {
  const owned = await fixture({ hostArchitecture: "x86_64" });
  try {
    const result = await main([owned.input], { run: owned.run });
    expect(result.nativeHost).toBe(false);
    expect(result.platformMatches).toBe(false);
    expect(owned.calls.some((args) => args.at(-1) === "doctor")).toBe(false);
  } finally {
    await owned.cleanup();
  }
});

test("wrong image architecture or changed delivered bytes produce no candidate profile", async () => {
  for (const overrides of [{ imageArchitecture: "amd64" }, { hash: "0".repeat(64) }]) {
    const owned = await fixture(overrides);
    try {
      await expect(main([owned.input], { run: owned.run })).rejects.toThrow();
      const evidence = owned.evidence();
      if (!evidence) throw new Error("Missing owned build evidence");
      expect(await Bun.file(resolve(evidence, "profile.candidate.json")).exists()).toBe(false);
      expect(owned.calls.some((args) => args.at(-1) === "doctor")).toBe(false);
    } finally {
      await owned.cleanup();
    }
  }
});
