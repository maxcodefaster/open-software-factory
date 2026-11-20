import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import { images } from "../kubernetes/restore-rehearsal";
import { requireComposePins, requirePinnedImage } from "./preflight";

test("one nonsecret service image owner supplies development, Helm and offline restore", async () => {
  expect(Object.keys(imagePins).sort()).toEqual([
    "forgejo",
    "garage",
    "openbao",
    "postgres",
    "rclone",
    "zero",
  ]);
  for (const image of Object.values(imagePins))
    expect(() => requirePinnedImage(image)).not.toThrow();
  for (const role of ["postgres", "forgejo", "garage", "openbao", "rclone"] as const)
    expect(images[role]).toBe(imagePins[role]);
  const launcher = await readFile("scripts/factory/index.ts", "utf8");
  expect(launcher).toContain("FACTORY_POSTGRES_IMAGE: imagePins.postgres");
  expect(launcher).toContain("FACTORY_FORGEJO_IMAGE: imagePins.forgejo");
  expect(launcher).toContain("FACTORY_ZERO_IMAGE: imagePins.zero");
  for (const owner of [
    "scripts/factory/openbao.ts",
    "scripts/kubernetes/restore-rehearsal.ts",
    "scripts/kubernetes/restore-application-check.ts",
  ])
    expect(await readFile(owner, "utf8")).toContain(
      'from "../../deploy/helm/factory/image-pins.json"',
    );
  expect(await readFile("deploy/factory/Dockerfile", "utf8")).toContain(
    "COPY deploy/helm/factory/image-pins.json ./deploy/helm/factory/image-pins.json",
  );
});

test("real Compose configuration consumes the service pins without daemon access or credential input", async () => {
  const child = Bun.spawn(
    [
      "docker",
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      resolve("deploy/local/compose.yaml"),
      "config",
      "--format",
      "json",
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        FACTORY_POSTGRES_IMAGE: imagePins.postgres,
        FACTORY_FORGEJO_IMAGE: imagePins.forgejo,
        FACTORY_ZERO_IMAGE: imagePins.zero,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  const config = JSON.parse(stdout);
  expect(() => requireComposePins(config)).not.toThrow();
  expect(config.services.postgres.image).toBe(imagePins.postgres);
  expect(config.services.forgejo.image).toBe(imagePins.forgejo);
  expect(config.services["zero-cache"].image).toBe(imagePins.zero);
  const other = structuredClone(config);
  other.services.postgres.image = `registry.example/postgres@sha256:${"a".repeat(64)}`;
  expect(() => requireComposePins(other)).toThrow("postgres image differs");
});

test("development startup and proof consumers never read or write legacy per-role image files", async () => {
  const sources = [
    "scripts/factory/artifacts.ts",
    "scripts/factory/index.ts",
    "test/fixtures/factory-process.ts",
    "test/fixtures/pinned-opencode.ts",
    "test/fixtures/publication-runtime.ts",
    "test/integration/opencode-coding-questions.test.ts",
    "test/integration/project-environments.live.test.ts",
  ];
  for (const path of sources) {
    const source = await readFile(path, "utf8");
    for (const obsolete of [
      "runtime-host-image",
      "build-runtime-host-image",
      "browser-tools-image",
      "developer-ide-image",
    ])
      expect(source).not.toContain(obsolete);
    expect(source).not.toMatch(/readFile\([^)]*\$\{name\}-image/);
  }
});
