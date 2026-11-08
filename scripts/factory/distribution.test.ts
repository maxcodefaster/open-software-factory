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

test("release images wait for the same non-live checks on native arm64", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.jobs.verify.needs).toBe("release");
  expect(workflow.jobs.verify.uses).toBe("./.github/workflows/checks.yaml");
  expect(workflow.jobs.verify["continue-on-error"]).not.toBe(true);
  expect(workflow.jobs.roles.needs).toContain("verify");
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

test("runtime publication compares config digests, not Docker's manifest ID", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  const command: string = workflow.jobs.roles.steps.find((step: { run?: string }) =>
    step.run?.includes("docker buildx build"),
  ).run;
  expect(command).toContain('--metadata-file "$RUNNER_TEMP/runtime-host-proven.json"');
  expect(command).toContain('proven_config="$(jq -er');
  expect(command).toContain(
    'test "$(docker image inspect --format \'{{.Id}}\' "$image")" = "$image_id"',
  );
  const comparison = command.split("\n").find((line) => line.includes('test "$(jq -r'));
  if (!comparison) throw new Error("Missing published config comparison");
  const directory = await mkdtemp(join(tmpdir(), "factory-release-identity-"));
  try {
    const configDigest = `sha256:${"a".repeat(64)}`;
    const manifestDigest = `sha256:${"b".repeat(64)}`;
    for (const [pushed, expected] of [
      [configDigest, 0],
      [manifestDigest, 1],
    ] as const) {
      await writeFile(
        join(directory, "runtime-host.json"),
        JSON.stringify({ "containerimage.config.digest": pushed }),
      );
      const child = Bun.spawn(["bash", "-c", comparison], {
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          proven_config: configDigest,
          image_id: manifestDigest,
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
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
