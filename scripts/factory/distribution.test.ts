import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import upstream from "../../upstream.json";

test("source-development Compose does not offer a second product installation", async () => {
  const compose = parse(
    await readFile(new URL("../../deploy/local/compose.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(compose.services)).toEqual(["postgres", "forgejo", "zero-cache"]);
  expect(JSON.stringify(compose)).not.toContain("docker.sock");
  expect(JSON.stringify(compose)).not.toContain("KUBECONFIG");
});

test("application build tools match the upstream artifact pins", async () => {
  const toolVersions = await readFile(new URL("../../mise.toml", import.meta.url), "utf8");
  expect(toolVersions).toContain(`kubectl = "${upstream.kubectl.version}"`);
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const image of [
    upstream.kubectl.image,
    upstream.openCodeServer.bunImage,
    upstream.nodeDevelopment.image,
  ])
    expect(dockerfile).toContain(image);
  expect(dockerfile).not.toContain("mkcert");
  expect(dockerfile).not.toContain("COPY --from=docker");
  expect(dockerfile).not.toContain("COPY deploy/local");
  expect(dockerfile).toContain('"/var/lib/factory/bootstrap.lock"');
  expect(dockerfile).toContain('"scripts/kubernetes/start.ts"');
});

test("only published releases build and publish arm64 and amd64 natively", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(workflow.on).sort()).toEqual(["release", "workflow_dispatch"]);
  expect(workflow.on.release).toEqual({ types: ["published"] });
  expect(workflow.on.workflow_dispatch.inputs.release_tag.required).toBe(true);
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const validate = workflow.jobs.release.steps.find(
    (step: { id?: string }) => step.id === "version",
  );
  expect(validate.env.RELEASE_TAG).toBe(
    "${{ github.event.release.tag_name || inputs.release_tag }}",
  );
  expect(workflow.jobs.verify.with.source_ref).toBe(validate.env.RELEASE_TAG);
  for (const job of ["release", "roles", "manifests", "factory", "distribution", "chart"])
    expect(workflow.jobs[job].steps[0].with.ref).toBe(validate.env.RELEASE_TAG);
  expect(validate.run).toContain(`version="\${RELEASE_TAG#v}"`);
  expect(validate.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(workflow.jobs.roles.needs).toEqual(["release", "verify"]);
  expect(workflow.jobs.distribution.needs).toEqual(["release", "factory"]);
  for (const job of ["roles", "factory"])
    expect(workflow.jobs[job].strategy.matrix.include).toEqual([
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
      { arch: "amd64", runner: "ubuntu-24.04" },
    ]);
  for (const job of ["roles", "factory"]) {
    const build = workflow.jobs[job].steps.find((step: { run?: string }) =>
      step.run?.includes("docker buildx build"),
    );
    expect(build.run).toContain(
      '--label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY"',
    );
    expect(build.run).toContain('--label "org.opencontainers.image.revision=$REVISION"');
    expect(build.run).toContain('--label "org.opencontainers.image.version=$RELEASE"');
  }
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].env.RELEASE).toBe(`\${{ needs.release.outputs.version }}`);
  expect(JSON.stringify(workflow)).not.toContain("setup-qemu");
  expect(workflow.jobs.factory.needs).toContain("manifests");
  expect(workflow.jobs.manifests.needs).toContain("roles");
});

test("release images require full source checks or a validated exact-commit local gate", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.jobs.verify.needs).toBe("release");
  expect(workflow.jobs.verify.if).toBe(`\${{ needs.release.outputs.local_gate_passed != 'true' }}`);
  expect(workflow.jobs.verify.uses).toBe("./.github/workflows/checks.yaml");
  expect(workflow.jobs.verify["continue-on-error"]).not.toBe(true);
  expect(workflow.jobs.roles.needs).toContain("verify");
  expect(workflow.jobs.roles.if).toBe(
    `\${{ !cancelled() && needs.release.result == 'success' && (needs.verify.result == 'success' || needs.release.outputs.local_gate_passed == 'true') }}`,
  );
  const checks = parse(
    await readFile(new URL("../../.github/workflows/checks.yaml", import.meta.url), "utf8"),
  );
  // Releases call these lanes; nothing runs per push. `bun run beta:gate` judges each commit locally.
  expect(Object.keys(checks.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  expect(checks.permissions).toEqual({ contents: "read" });
  const verify = checks.jobs.verify;
  expect(verify.strategy["fail-fast"]).toBe(false);
  expect(verify.strategy.matrix.include).toEqual([{ arch: "arm64", runner: "ubuntu-24.04-arm" }]);
  expect(verify["runs-on"]).toBe(`\${{ matrix.runner }}`);
  expect(verify["continue-on-error"]).not.toBe(true);
  const steps = verify.steps as {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    if?: string;
    "continue-on-error"?: boolean;
  }[];
  for (const step of steps) {
    if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
    expect(step["continue-on-error"]).not.toBe(true);
    expect(step.if).toBeUndefined();
  }
  expect(steps.find((step) => step.uses?.startsWith("jdx/mise-action@"))?.with).toEqual({
    version: "2026.10.3",
  });
  expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual({
    "persist-credentials": false,
    ref: "${{ inputs.source_ref || github.ref }}",
  });
  const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
  expect(commands).toContain("mise exec -- bun install --frozen-lockfile");
  expect(commands).toContain(
    "mise exec -- bun --bun ./node_modules/@playwright/test/cli.js install --with-deps chromium",
  );
  expect(commands).toContain("mise exec -- mkcert -install");
  expect(commands).toContain(
    "mise exec -- bun run test:controllers /planning-cache-network.test.ts",
  );
  expect(commands).toContain("mise exec -- bun run check:integration");
  expect(commands).toContain("mise exec -- bun run test:browser");
  expect(commands.some((command) => command.includes("upstream.json"))).toBe(true);
  expect(steps.find((step) => step.uses?.startsWith("actions/setup-go@"))?.with).toEqual({
    "go-version": `\${{ steps.tools.outputs.go }}`,
    "cache-dependency-path": "services/runtime-connector/go.sum",
  });
  expect(JSON.stringify(checks)).not.toMatch(/secrets\.|test:(?:live|native|browser:paid)/);
});

test("local gate reuse rejects another commit, incomplete checks and failed receipts", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.on.workflow_dispatch.inputs.use_local_gate).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(workflow.jobs.release.outputs.local_gate_passed).toBe(
    `\${{ steps.local-gate.outputs.passed }}`,
  );
  const gate = workflow.jobs.release.steps.find(
    (step: { id?: string }) => step.id === "local-gate",
  );
  const revision = "a".repeat(40);
  const complete = {
    schema: 1,
    commit: revision,
    passed: true,
    steps: [
      "clean-tree",
      "forbidden-terms",
      "secrets",
      "docs",
      "format",
      "lint",
      "typecheck",
      "unit",
      "connector",
      "controllers",
      "browser",
    ].map((name) => ({ name, passed: true })),
  };
  const incomplete = structuredClone(complete);
  incomplete.steps.pop();
  const failed = structuredClone(complete);
  failed.steps[0]!.passed = false;
  const duplicate = structuredClone(complete);
  duplicate.steps[0]!.name = "browser";
  const directory = await mkdtemp(join(tmpdir(), "factory-local-release-gate-"));
  try {
    for (const [receipt, enabled, expected] of [
      [complete, "true", 0],
      [{ ...complete, commit: "b".repeat(40) }, "true", 1],
      [{ ...complete, passed: false }, "true", 1],
      [{ ...complete, schema: 2 }, "true", 1],
      [incomplete, "true", 1],
      [failed, "true", 1],
      [duplicate, "true", 1],
      [complete, "false", 0],
    ] as const) {
      const fixture = join(directory, "fixture.json");
      const output = join(directory, "output.txt");
      await writeFile(fixture, JSON.stringify(receipt));
      await writeFile(output, "");
      const child = Bun.spawn(
        [
          "bash",
          "-c",
          `
        git() { printf '%s\\n' "$EXPECTED_REVISION"; }
        curl() { test "$USE_LOCAL_GATE" = true; cp "$RECEIPT_FIXTURE" "\${!#}"; }
        ${gate.run}
      `,
        ],
        {
          env: {
            ...process.env,
            USE_LOCAL_GATE: enabled,
            EXPECTED_REVISION: revision,
            RECEIPT_FIXTURE: fixture,
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: directory,
            GITHUB_REPOSITORY: "maxcodefaster/open-software-factory",
            RELEASE_TAG: "v0.1.0-beta.1",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(expected);
      expect(await readFile(output, "utf8")).toBe(expected === 0 ? `passed=${enabled}\n` : "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime publication compares config digests, not Docker's manifest ID", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  expect(command).toContain('--metadata-file "$RUNNER_TEMP/runtime-host-proven.json"');
  expect(command).toContain('docker image save --output "$proof_archive" "$image_id"');
  expect(command).toContain('tar -xOf "$proof_archive" -- "$config_file" | sha256sum');
  expect(command).not.toContain("containerimage.config.digest");
  expect(command).toContain('docker buildx imagetools inspect "$image@$native_child" --raw');
  expect(command).toContain(
    'test "$(docker image inspect --format \'{{.Id}}\' "$image")" = "$image_id"',
  );
  const comparison = command.split("\n").find((line) => line.includes('test "$published_config"'));
  if (!comparison) throw new Error("Missing published config comparison");
  const configDigest = `sha256:${"a".repeat(64)}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  for (const [pushed, expected] of [
    [configDigest, 0],
    [manifestDigest, 1],
  ] as const) {
    const child = Bun.spawn(["bash", "-c", comparison], {
      env: {
        ...process.env,
        proven_config: configDigest,
        published_config: pushed,
        image_id: manifestDigest,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(expected);
  }
});

test("published config lookup selects one native child and ignores attestations", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  const filter = /native_child=.*jq -er --arg arch "\$ARCH" '([^']+)'/.exec(command)?.[1];
  expect(filter).toBeDefined();
  const arm = {
    digest: `sha256:${"a".repeat(64)}`,
    platform: { os: "linux", architecture: "arm64" },
  };
  const amd = {
    digest: `sha256:${"b".repeat(64)}`,
    platform: { os: "linux", architecture: "amd64" },
  };
  const attestation = {
    digest: `sha256:${"c".repeat(64)}`,
    platform: { os: "unknown", architecture: "unknown" },
  };
  for (const [manifests, architecture, expected, digest] of [
    [[arm, amd, attestation], "arm64", 0, arm.digest],
    [[arm, amd, attestation], "amd64", 0, amd.digest],
    [[arm, attestation], "amd64", 5, ""],
    [[arm, arm, attestation], "arm64", 5, ""],
  ] as const) {
    const child = Bun.spawn(["jq", "-er", "--arg", "arch", architecture, filter ?? ""], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ manifests }));
    child.stdin.end();
    expect(await child.exited).toBe(expected);
    expect((await new Response(child.stdout).text()).trim()).toBe(digest);
  }
});

test("release publication is attested, signed and scoped to the jobs that need credentials", async () => {
  const text = await readFile(
    new URL("../../.github/workflows/images.yaml", import.meta.url),
    "utf8",
  );
  const workflow = parse(text);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
  for (const job of ["release", "verify"])
    expect(workflow.jobs[job].permissions?.packages).toBeUndefined();
  expect(text).not.toContain('--provenance=false"');
  expect(text).toContain("--provenance=mode=max");
  expect(text).toContain("--sbom=generator=$SBOM_GENERATOR");
  expect(workflow.env.BUILDKIT_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(text).toContain('--driver-opt "image=$BUILDKIT_IMAGE"');
  expect(text).not.toMatch(/docker buildx create --use$/m);
  for (const job of Object.values(workflow.jobs) as {
    steps?: { uses?: string; with?: Record<string, unknown> }[];
  }[])
    for (const step of job.steps ?? []) {
      if (step.uses) expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@"))
        expect(step.with?.["persist-credentials"]).toBe(false);
    }
  const factory = workflow.jobs.factory.steps as {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  }[];
  const scan = factory.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  expect(scan?.with).toMatchObject({
    severity: "CRITICAL",
    "ignore-unfixed": true,
    "exit-code": 1,
  });
  expect(factory.findIndex((step) => step.run?.includes("image-smoke.ts"))).toBeGreaterThan(
    factory.findIndex((step) => step.run?.includes("docker buildx build")),
  );
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain("GITHUB_STEP_SUMMARY");
  expect(workflow.jobs.distribution.outputs.factory).toBe("${{ steps.publish.outputs.factory }}");
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain("printf 'factory=%s@%s\\n'");
  expect(workflow.jobs.distribution.steps.at(-1).run).toContain('>> "$GITHUB_OUTPUT"');
  expect(workflow.jobs.chart.env.FACTORY_IMAGE).toBe("${{ needs.distribution.outputs.factory }}");
  const library = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");
  expect(library).toContain("Choose a new release version.");
  expect(library).toContain("cosign sign --yes");
});

test("every publication job installs the same digest-pinned Cosign binary", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.env.COSIGN_IMAGE).toMatch(/:v2\.5\.3@sha256:[a-f0-9]{64}$/);
  const scripts = ["roles", "manifests", "factory", "distribution", "chart"].map(
    (job) =>
      workflow.jobs[job].steps.find(
        (step: { name?: string }) => step.name === "Install pinned Cosign",
      ).run,
  );
  expect(new Set(scripts).size).toBe(1);
  expect(scripts[0]).toContain('docker pull "$COSIGN_IMAGE"');
  expect(scripts[0]).toContain('docker create --network=none "$COSIGN_IMAGE"');
  expect(scripts[0]).toContain(".Config.Entrypoint");
  expect(scripts[0]).toContain('.gitVersion == "v2.5.3"');
  expect(scripts[0]).toContain("GITHUB_PATH");
  const syntax = Bun.spawn(["bash", "-n"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  syntax.stdin.write(scripts[0]);
  syntax.stdin.end();
  expect(await syntax.exited).toBe(0);
});

test("security exceptions follow exact-image backport proof and precede signing", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs.factory.steps;
  const proof = steps.findIndex((step: { run?: string }) =>
    step.run?.includes("/proof/framework-image-proof.ts"),
  );
  const scan = steps.findIndex((step: { uses?: string }) =>
    step.uses?.startsWith("aquasecurity/trivy-action@"),
  );
  const sign = steps.findIndex((step: { run?: string }) =>
    step.run?.includes('release_sign "$IMAGE_REF"'),
  );
  expect(proof).toBeGreaterThan(0);
  expect(scan).toBeGreaterThan(proof);
  expect(sign).toBeGreaterThan(scan);
  expect(steps[proof].env.IMAGE_REF).toBe(`\${{ steps.build.outputs.ref }}`);
  expect(steps[proof].run).toContain("--network=none --read-only --cap-drop=ALL --user 1000:1000");
  expect(steps[proof].run).toContain('> "$RUNNER_TEMP/framework-security-proof.json"');
  expect(steps[scan].env.TRIVY_VEX).toBe(`\${{ runner.temp }}/framework-security.vex.json`);
  expect(steps[scan].env.TRIVY_PLATFORM).toBe(`linux/\${{ matrix.arch }}`);
  expect(steps[scan].with["exit-code"]).toBe(1);
  expect(steps[scan]["continue-on-error"]).not.toBe(true);
  expect(steps[sign].run).toContain("cosign attest --yes --type https://openvex.dev/ns/v0.2.0");
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const stage of ["build", "dependencies"]) {
    const commands = dockerfile.split(`FROM tools AS ${stage}\n`)[1]?.split("\nFROM ")[0];
    expect(commands).toBeDefined();
    expect(commands?.indexOf("COPY patches ./patches")).toBeLessThan(
      commands?.indexOf("RUN bun install") ?? -1,
    );
  }
});

test("only explicit owner-authorized beta.1 correction can overwrite published tags", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.on.workflow_dispatch.inputs.overwrite_existing).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(workflow.env.RELEASE_OVERWRITE).toBe(`\${{ inputs.overwrite_existing || 'false' }}`);
  expect(
    workflow.jobs.release.steps.find((step: { id?: string }) => step.id === "version").run,
  ).toContain('test "$RELEASE_TAG" = v0.1.0-beta.1');
  const library = new URL("./release-lib.sh", import.meta.url).pathname;
  for (const [version, flag, expected] of [
    ["0.1.0-beta.1", "false", 1],
    ["0.1.0-beta.1", "true", 0],
    ["0.1.0-beta.2", "true", 1],
    ["0.1.0", "true", 1],
    ["0.1.0-beta.1", "1", 1],
  ] as const) {
    const child = Bun.spawn(["bash", "-c", 'source "$1"; release_overwrite', "proof", library], {
      env: { ...process.env, RELEASE: version, RELEASE_OVERWRITE: flag },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(expected);
  }
  for (const job of ["roles", "factory"]) {
    const command = workflow.jobs[job].steps.find((step: { run?: string }) =>
      step.run?.includes("docker buildx build"),
    ).run;
    expect(command).toContain(
      'release_exists "$IMAGE_ROOT/factory:$RELEASE" && ! release_overwrite',
    );
    expect(command).toContain('if [[ "$reuse" == true ]]');
    expect(command).toContain("cosign verify --certificate-identity-regexp");
  }
});

test("chart signing authenticates Cosign as well as Helm", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.chart.steps.at(-1).run as string;
  expect(command).toContain(
    'helm registry login ghcr.io --username "$GITHUB_ACTOR" --password-stdin',
  );
  expect(command).toContain('docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin');
  expect(command.indexOf("docker login")).toBeLessThan(command.indexOf("cosign sign"));
});

test("cached Factory images must carry the exact released runtime references", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.factory.steps.find((step: { id?: string }) => step.id === "build")
    .run as string;
  const script = /'(const ordered=.*?)'; then/.exec(command)?.[1];
  expect(script).toBeDefined();
  const directory = await mkdtemp(join(tmpdir(), "factory-runtime-references-"));
  const artifacts = { "runtime-host": "host-image", "developer-ide": "ide-image" };
  try {
    await writeFile(join(directory, "runtime-artifacts.json"), JSON.stringify(artifacts));
    for (const [expected, exitCode] of [
      [{ "developer-ide": "ide-image", "runtime-host": "host-image" }, 0],
      [{ ...artifacts, "runtime-host": "changed-image" }, 1],
      [{ "runtime-host": "host-image" }, 1],
    ] as const) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script ?? ""], {
        cwd: directory,
        env: { ...process.env, EXPECTED_RUNTIME_ARTIFACTS: JSON.stringify(expected) },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(exitCode);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("published image jobs survive a locally satisfied verification dependency but not failures", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  for (const [job, dependency] of [
    ["manifests", "roles"],
    ["factory", "manifests"],
    ["distribution", "factory"],
    ["chart", "distribution"],
  ] as const) {
    expect(workflow.jobs[job].needs).toEqual(["release", dependency]);
    expect(workflow.jobs[job].if).toBe(
      `\${{ !cancelled() && needs.release.result == 'success' && needs.${dependency}.result == 'success' }}`,
    );
  }
});

test("an overwrite reuses only signed runtime images from the exact release commit", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run as string;
  const start = command.indexOf("reuse=false");
  const end = command.indexOf('if [[ "$reuse" == true ]]', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const block = command.slice(start, end);
  for (const [found, signed, overwrite, expectedCode, expectedReuse] of [
    ["release-commit", "true", "true", 0, "true"],
    ["release-commit", "false", "true", 0, "false"],
    ["other-commit", "true", "true", 0, "false"],
    ["release-commit", "false", "false", 0, "true"],
    ["other-commit", "true", "false", 1, ""],
  ] as const) {
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `
      set -euo pipefail
      release_exists() { return 0; }
      release_overwrite() { test "$OVERWRITE" = true; }
      release_revision() { printf '%s' "$FOUND"; }
      release_require_revision() { test "$FOUND" = "$REVISION"; }
      release_digest() { printf 'sha256:%064d' 0; }
      cosign() { test "$SIGNED" = true; }
      ${block}
      printf '%s' "$reuse"
    `,
      ],
      {
        env: {
          ...process.env,
          FOUND: found,
          SIGNED: signed,
          OVERWRITE: overwrite,
          REVISION: "release-commit",
          GITHUB_REPOSITORY: "maxcodefaster/open-software-factory",
          IMAGE_ROOT: "ghcr.io/maxcodefaster/open-software-factory",
          role: "runtime-host",
          image: "fixture:release",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(expectedCode);
    expect(await new Response(child.stdout).text()).toBe(expectedReuse);
  }
});

test("the native lane is a separate manual workflow that never runs for pull requests", async () => {
  const native = parse(
    await readFile(new URL("../../.github/workflows/native.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(native.on)).toEqual(["workflow_dispatch"]);
  expect(native.jobs.native["runs-on"]).toEqual(["self-hosted", "sysbox"]);
  const commands = native.jobs.native.steps.flatMap((step: { run?: string }) =>
    step.run ? [step.run] : [],
  );
  expect(commands).toContain("mise exec -- bun run test:native");
  expect(commands).toContain("mise exec -- bun run runtime:conformance");
  const images = await readFile(
    new URL("../../.github/workflows/images.yaml", import.meta.url),
    "utf8",
  );
  expect(images).not.toMatch(/test:(?:live|native|browser:paid)|runtime:conformance/);
});

test("the pull request checks build the Factory image so a broken COPY fails before release", async () => {
  const checks = parse(
    await readFile(new URL("../../.github/workflows/checks.yaml", import.meta.url), "utf8"),
  );
  const commands = checks.jobs["factory-image"].steps.flatMap((step: { run?: string }) =>
    step.run ? [step.run] : [],
  );
  expect(commands[0]).toContain("docker build --file deploy/factory/Dockerfile");
  expect(commands[0]).not.toContain("--push");
  expect(commands[1]).toContain("image-smoke.ts");
});

test("native Compose prebuild and required hooks gate runtime publication on both architectures", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const build = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  );
  expect(build.run).toContain(
    'bash scripts/runtime/project-compose-prebuild-proof.sh "$image_id" "$NODE_PROOF_IMAGE" "$registry_proof_image"',
  );
  expect(build.run.indexOf("project-compose-prebuild-proof.sh")).toBeLessThan(
    build.run.indexOf("--push --metadata-file"),
  );
  expect(
    workflow.jobs.roles.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/setup-go@"),
    ).with,
  ).toEqual({
    "go-version": `\${{ steps.proof-tools.outputs.go }}`,
    "cache-dependency-path": "services/runtime-connector/go.sum",
  });
  const proof = await readFile(
    new URL("../runtime/project-compose-prebuild-proof.sh", import.meta.url),
    "utf8",
  );
  expect(proof).toContain("--network=none --cpus=3 --memory=3g");
  expect(proof).toContain('"nativeFactoryboxProof":false');
  const start = proof.indexOf("docker create");
  const create = proof.slice(start, proof.indexOf("docker cp", start));
  expect(create).toContain("--network=none");
  // The fixture has its own Unix socket. It must not bind-mount the host's.
  expect(create).not.toMatch(/--mount|--volume\b|\s-v\b/);
});
