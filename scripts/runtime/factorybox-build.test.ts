import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  factoryboxBuildCandidate,
  factoryboxBuildCommand,
  factoryboxBuildEnvironment,
  factoryboxBuildRequest,
  main,
} from "./factorybox-build";

const request = factoryboxBuildRequest.parse({
  repository: "/owned/factorybox",
  commit: "9".repeat(40),
  upstreamVersion: "1.2.3",
  dockerContext: "owned-context",
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
      filesystemLayout: 2,
      boundedBytes: 64 * 1024 ** 3,
      minimumBoundedBytes: 8 * 1024 ** 3,
      claimGiB: 128,
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
    head?: string;
    dirty?: boolean;
    headAfterBuild?: string;
  } = {},
) {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "factorybox-build-test-"));
  const input = resolve(root, "request.json");
  await writeFile(input, JSON.stringify({ ...request, repository: root }));
  const calls: string[][] = [];
  let evidence: string | undefined;
  let built = false;
  const run: NonNullable<Parameters<typeof main>[1]>["run"] = async (args) => {
    calls.push(args);
    if (!evidence) {
      const directories = new Bun.Glob("factorybox-build-*/intent.json");
      for await (const path of directories.scan(parent)) {
        const intent = await Bun.file(resolve(parent, path)).json();
        if (intent.request?.repository === root) evidence = resolve(parent, path, "..");
      }
      expect(evidence).toBeDefined();
    }
    if (args[0] === "git") {
      if (args.includes("--version"))
        return { exitCode: 0, stdout: "git version 2.50.0\n", stderr: "" };
      if (args.includes("rev-parse"))
        return {
          exitCode: 0,
          stdout: `${built ? (overrides.headAfterBuild ?? request.commit) : (overrides.head ?? request.commit)}\n`,
          stderr: "",
        };
      return { exitCode: 0, stdout: overrides.dirty ? " M tools/build.py\n" : "", stderr: "" };
    }
    if (args[0] === "mise" && !args.includes("tools/build_worker_pipeline.py"))
      return { exitCode: 0, stdout: "tool 1.0\n", stderr: "" };
    if (args.includes("version"))
      return { exitCode: 0, stdout: "client 28 server 28\n", stderr: "" };
    if (args[0] === "mise") {
      built = true;
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
    expect(
      owned.calls.filter((args) => args.includes("tools/build_worker_pipeline.py")),
    ).toHaveLength(1);
    expect(result.provenance).toMatchObject({
      commit: request.commit,
      treeClean: true,
      upstreamVersion: "1.2.3",
      tools: { git: "git version 2.50.0", python3: "tool 1.0" },
    });
    expect(Date.parse(result.provenance.startedAt)).toBeLessThanOrEqual(
      Date.parse(result.provenance.finishedAt),
    );
    expect(await Bun.file(resolve(result.evidence, "provenance.json")).exists()).toBe(true);
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

test("a build needs an exact commit, upstream version and Docker context", () => {
  for (const missing of ["commit", "upstreamVersion", "dockerContext"]) {
    const input: Record<string, unknown> = { ...request };
    delete input[missing];
    expect(() => factoryboxBuildRequest.parse(input)).toThrow();
  }
  for (const commit of ["main", "abc123", "9".repeat(39), "G".repeat(40)])
    expect(() => factoryboxBuildRequest.parse({ ...request, commit })).toThrow();
});

test("a repository at another commit or with local changes is refused before any build", async () => {
  for (const [overrides, message] of [
    [{ head: "8".repeat(40) }, "not the requested commit"],
    [{ dirty: true }, "uncommitted or untracked"],
  ] as const) {
    const owned = await fixture(overrides);
    try {
      await expect(main([owned.input], { run: owned.run })).rejects.toThrow(message);
      expect(owned.calls.some((args) => args.includes("tools/build_worker_pipeline.py"))).toBe(
        false,
      );
    } finally {
      await owned.cleanup();
    }
  }
});

test("a repository that moves during the build produces no candidate", async () => {
  const owned = await fixture({ headAfterBuild: "7".repeat(40) });
  try {
    await expect(main([owned.input], { run: owned.run })).rejects.toThrow("changed during");
  } finally {
    await owned.cleanup();
  }
});

test("the build tool receives an allowlisted environment, not ambient credentials", () => {
  const environment = factoryboxBuildEnvironment("owned-context", {
    PATH: "/bin",
    HOME: "/home/owned",
    MISE_DATA_DIR: "/data",
    GITHUB_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    FACTORYBOX_DOCKER_CONTEXT: "ambient",
  });
  expect(environment).toEqual({
    PATH: "/bin",
    HOME: "/home/owned",
    MISE_DATA_DIR: "/data",
    FACTORYBOX_DOCKER_CONTEXT: "owned-context",
    FACTORYBOX_DOCKER_ELEVATION: "",
  });
});
