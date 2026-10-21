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

test("publication is explicit and builds both architectures natively", async () => {
  const workflow = parse(
    await readFile(new URL("../../.github/workflows/images.yaml", import.meta.url), "utf8"),
  );
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  for (const job of ["roles", "factory"])
    expect(workflow.jobs[job].strategy.matrix.include).toEqual([
      { arch: "amd64", runner: "ubuntu-24.04" },
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
});
