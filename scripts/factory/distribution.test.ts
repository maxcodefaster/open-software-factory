import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import upstream from "../../upstream.json";

test("Compose OpenBao preserves tmpfs mount options as one mount", async () => {
  const compose = parse(
    await readFile(new URL("../../deploy/local/compose.yaml", import.meta.url), "utf8"),
  );
  expect(compose.services.openbao.tmpfs).toEqual(["/tmp:rw,noexec,nosuid,size=16m"]);
  expect(compose.services.openbao.image).toBe(upstream.openbao.image);
  expect(compose.services.factory.network_mode).toBe("host");
  expect(compose.services.factory.profiles).toEqual(["factory"]);
  expect(compose.services.openbao.profiles).toEqual(["secrets"]);
});

test("application build tools match the upstream artifact pins", async () => {
  const dockerfile = await readFile(
    new URL("../../deploy/factory/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const image of [
    upstream.kubectl.image,
    upstream.openCodeServer.bunImage,
    upstream.docker.image,
    upstream.nodeDevelopment.image,
  ])
    expect(dockerfile).toContain(image);
  for (const checksum of Object.values(upstream.mkcert.sha256))
    expect(dockerfile).toContain(checksum);
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
