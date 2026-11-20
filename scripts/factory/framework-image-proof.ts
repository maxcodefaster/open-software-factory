// Mounted read-only into the image. Every installed upstream transport must
// have the qualified version and pass the real transport regression.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function verifyFrameworkVersion(directory: string) {
  const bytes = await readFile(join(directory, "package.json"));
  const metadata = JSON.parse(bytes.toString());
  assert.equal(metadata.name, "@tanstack/start-server-core");
  assert.equal(metadata.version, "1.169.45", "Unqualified framework transport version");
  assert.equal(
    sha256(bytes),
    "8af90e300c231620563c81aa7ba3a9b06bad5b26810057329b7ba71e781757e5",
    "Missing or changed upstream request-scope export",
  );
  return metadata.version as string;
}

async function installedTransports(root: string) {
  const packages = new Set<string>();
  const visited = new Set<string>();
  async function visit(directory: string) {
    const actual = await realpath(directory);
    if (visited.has(actual)) return;
    visited.add(actual);
    if (actual.endsWith("/@tanstack/start-server-core")) {
      packages.add(actual);
      return;
    }
    for (const entry of await readdir(actual, { withFileTypes: true })) {
      const target = join(actual, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await stat(target)).isDirectory()))
        await visit(target);
    }
  }
  await visit(join(root, "node_modules"));
  assert.ok(packages.size > 0, "Factory has no installed server-function transport");
  return [...packages].sort();
}

if (import.meta.main) {
  const [imageRef, fixturePath] = process.argv.slice(2);
  assert.ok(
    imageRef && fixturePath,
    "Usage: framework-image-proof IMAGE@sha256:... TRANSPORT-FIXTURE",
  );
  assert.match(imageRef, /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/);
  const root = process.cwd();
  const packages = [];
  for (const directory of await installedTransports(root)) {
    const version = await verifyFrameworkVersion(directory);
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [process.execPath, "--no-env-file", resolve(fixturePath), join(directory, "package.json")],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr]: [number, string, string] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exitCode, 0, `Image transport regression failed: ${stderr}`);
    assert.equal(stderr, "");
    assert.ok(stdout.includes("discarded private middleware fields"));
    packages.push({ path: relative(root, directory), version, transportRegression: "passed" });
  }
  console.log(
    JSON.stringify(
      {
        imageRef,
        transportFixtureSHA256: sha256(await readFile(resolve(fixturePath))),
        packages,
      },
      null,
      2,
    ),
  );
}
