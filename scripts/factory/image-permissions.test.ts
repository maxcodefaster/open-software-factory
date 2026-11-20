import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("the Factory image makes packaged code readable without exposing private state or writable source", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-image-permissions-"));
  const content = "owned public Factory code\n";
  const sources = [
    "apps/factory/src/agent/opencode-client.ts",
    "apps/factory/public/art.txt",
    "apps/factory/dist/server/entry.js",
    "packages/db/src/client.ts",
    "scripts/factory/native-installation.ts",
    "scripts/kubernetes/start.ts",
    "templates/starter/README.md",
    "deploy/substrate/pins.json",
    "deploy/helm/factory/image-pins.json",
    "package.json",
    "upstream.json",
    "LICENSE",
  ];
  const privateState = join(root, "state/ingress-tls/identity.json");
  try {
    for (const path of sources) {
      await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(root, path), content, { mode: 0o600 });
    }
    // A permissive checkout must not give the runtime user writable code.
    await chmod(join(root, "packages/db/src/client.ts"), 0o666);
    await chmod(join(root, "apps/factory/public"), 0o777);
    const executable = join(root, "scripts/kubernetes/owned-tool.sh");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await mkdir(dirname(privateState), { recursive: true, mode: 0o700 });
    await writeFile(privateState, "owned private installation state", { mode: 0o600 });
    await symlink(
      "../../../state/ingress-tls/identity.json",
      join(root, "apps/factory/src/state-link"),
    );

    // Execute the actual final-stage permission instructions, not a second
    // implementation. With no normalization, private COPY inputs stay 0600.
    const dockerfile = await readFile(
      resolve(import.meta.dir, "../../deploy/factory/Dockerfile"),
      "utf8",
    );
    const stage = dockerfile.split("FROM tools AS factory\n").at(-1) ?? "";
    const instructions = stage
      .split("\n")
      .filter((line) => line.startsWith("RUN chmod -R "))
      .map((line) => line.slice(4));
    const command = Bun.spawn(["sh", "-eu", "-c", instructions.join("\n") || ":"], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, output] = await Promise.all([command.exited, new Response(command.stderr).text()]);
    expect({ exit, output }).toEqual({ exit: 0, output: "" });
    for (const path of sources) {
      expect((await stat(join(root, path))).mode & 0o777).toBe(0o644);
      expect(await readFile(join(root, path), "utf8")).toBe(content);
    }
    for (const path of [
      "apps",
      "apps/factory/src",
      "packages/db/src",
      "scripts/kubernetes",
      "templates",
      "deploy",
    ]) {
      expect((await stat(join(root, path))).mode & 0o777).toBe(0o755);
    }
    expect((await stat(executable)).mode & 0o777).toBe(0o755);
    expect((await stat(privateState)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(privateState))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "apps/factory/src/state-link"))).isSymbolicLink()).toBe(true);
    expect(await readFile(privateState, "utf8")).toBe("owned private installation state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the runtime pruning command removes Factory tests and generators, keeping install sources and Starter tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-image-pruning-"));
  const removed = [
    "apps/factory/src/nested/owner.test.ts",
    "packages/domain/src/owner.test.ts",
    "scripts/kubernetes/owner.spec.ts",
    "packages/db/src/generate.ts",
    "packages/zero-schema/src/generate.ts",
    "packages/zero-schema/src/projection.ts",
    "packages/db/native/invariant.sql",
  ];
  const retained = [
    "apps/factory/src/nested/owner.ts",
    "packages/db/src/client.ts",
    "packages/db/src/schema/runtime.ts",
    "packages/db/migrations/0001_baseline.sql",
    "packages/zero-schema/src/schema.generated.ts",
    "scripts/kubernetes/start.ts",
    "templates/starter-app/src/owner.test.ts",
  ];
  try {
    for (const file of [...removed, ...retained]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), file);
    }
    const dockerfile = await readFile(
      resolve(import.meta.dir, "../../deploy/factory/Dockerfile"),
      "utf8",
    );
    const command = dockerfile
      .match(/^RUN find apps\/factory\/src[\s\S]*?(?=\n# COPY)/m)?.[0]
      .replace(/^RUN /, "")
      .replaceAll("\\\n", "");
    if (!command) throw new Error("Runtime pruning command is missing");
    const child = Bun.spawn(["sh", "-eu", "-c", command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    for (const file of removed) expect(await Bun.file(join(root, file)).exists()).toBe(false);
    for (const file of retained) expect(await readFile(join(root, file), "utf8")).toBe(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
