import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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

test("only published releases build and publish both architectures natively", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(workflow.on).toEqual({ release: { types: ["published"] } });
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  const validate = workflow.jobs.release.steps.find(
    (step: { id?: string }) => step.id === "version",
  );
  expect(validate.env.RELEASE_TAG).toBe(`\${{ github.event.release.tag_name }}`);
  expect(validate.run).toContain(`version="\${RELEASE_TAG#v}"`);
  expect(validate.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(workflow.jobs.roles.needs).toEqual(["release", "verify"]);
  expect(workflow.jobs.distribution.needs).toEqual(["release", "factory"]);
  for (const job of ["roles", "factory"])
    expect(workflow.jobs[job].strategy.matrix.include).toEqual([
      { arch: "amd64", runner: "ubuntu-24.04" },
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
  for (const job of ["roles", "factory"]) {
    const build = workflow.jobs[job].steps.find((step: { run?: string }) =>
      step.run?.includes("docker buildx build"),
    );
    expect(build.run).toContain(
      '--label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY"',
    );
    expect(build.run).toContain(
      '--label "org.opencontainers.image.revision=$(git rev-parse HEAD)"',
    );
    expect(build.run).toContain('--label "org.opencontainers.image.version=$RELEASE"');
  }
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].env.RELEASE).toBe(`\${{ needs.release.outputs.version }}`);
  expect(JSON.stringify(workflow)).not.toContain("setup-qemu");
  expect(workflow.jobs.factory.needs).toContain("manifests");
  expect(workflow.jobs.manifests.needs).toContain("roles");
});

test("release images wait for the same non-live checks on both native architectures", async () => {
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
  expect(checks.on).toEqual({
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
    workflow_call: null,
  });
  expect(checks.permissions).toEqual({ contents: "read" });
  const verify = checks.jobs.verify;
  expect(verify.strategy["fail-fast"]).toBe(false);
  expect(verify.strategy.matrix.include).toEqual([
    { arch: "amd64", runner: "ubuntu-24.04" },
    { arch: "arm64", runner: "ubuntu-24.04-arm" },
  ]);
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
