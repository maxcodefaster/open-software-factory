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
  expect(validate.env.RELEASE_TAG).toBe("${{ github.event.release.tag_name }}");
  expect(validate.run).toContain('version="${RELEASE_TAG#v}"');
  expect(validate.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  expect(workflow.jobs.roles.needs).toBe("release");
  expect(workflow.jobs.distribution.needs).toEqual(["release", "factory"]);
  for (const job of ["roles", "factory"])
    expect(workflow.jobs[job].strategy.matrix.include).toEqual([
      { arch: "amd64", runner: "ubuntu-24.04" },
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
  for (const job of ["roles", "manifests", "factory", "distribution"])
    expect(workflow.jobs[job].env.RELEASE).toBe("${{ needs.release.outputs.version }}");
  expect(JSON.stringify(workflow)).not.toContain("setup-qemu");
  expect(workflow.jobs.factory.needs).toContain("manifests");
  expect(workflow.jobs.manifests.needs).toContain("roles");
});
