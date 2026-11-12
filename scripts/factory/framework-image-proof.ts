// Mounted read-only into the image. No VEX is emitted until every installed
// transport copy matches the trusted backport and passes the real transport test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type SecurityPatch = {
  version: string;
  cve: string;
  patchSHA256: string;
  files: { path: string; afterSHA256: string }[];
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function verifyFrameworkFiles(directory: string, patch: SecurityPatch) {
  const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(metadata.name, "@tanstack/start-server-core");
  assert.equal(metadata.version, patch.version);
  const files = [];
  for (const file of patch.files) {
    const digest = sha256(await readFile(join(directory, file.path)));
    assert.equal(digest, file.afterSHA256, `Unpatched framework file: ${file.path}`);
    files.push({ path: file.path, sha256: digest });
  }
  return files;
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

export function frameworkVex(imageRef: string, patch: SecurityPatch) {
  const match = /^([a-z0-9][a-z0-9.:/_-]*)@(sha256:[a-f0-9]{64})$/.exec(imageRef);
  assert.ok(match, "VEX requires an immutable image reference");
  const [, repository, digest] = match;
  assert.ok(repository && digest);
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `https://github.com/maxcodefaster/open-software-factory/vex/${digest}/${patch.patchSHA256}`,
    author: "Open Software Factory",
    timestamp: new Date().toISOString(),
    version: 1,
    statements: [
      {
        vulnerability: { name: patch.cve },
        products: [
          {
            "@id": `pkg:oci/${repository.split("/").at(-1)}@${digest}?repository_url=${encodeURIComponent(repository)}`,
            subcomponents: [{ "@id": `pkg:npm/%40tanstack/start-server-core@${patch.version}` }],
          },
        ],
        status: "fixed",
        status_notes: `Security backport ${patch.patchSHA256}. All installed runtime/source files match the backport hashes. GET/POST private middleware field rejection and synchronous/asynchronous response-boundary rejection passed inside this exact image. Upstream package version is retained for Solid 2 compatibility.`,
      },
    ],
  };
}

if (import.meta.main) {
  const [imageRef, patchPath, fixturePath] = process.argv.slice(2);
  assert.ok(
    imageRef && patchPath && fixturePath,
    "Usage: framework-image-proof IMAGE@sha256:... PATCH-JSON TRANSPORT-FIXTURE",
  );
  const root = process.cwd();
  const trusted = await readFile(resolve(patchPath));
  const embedded = await readFile(
    join(root, "templates/starter-app/.factory/framework-security.json"),
  );
  assert.equal(
    sha256(embedded),
    sha256(trusted),
    "The Starter carries a different security backport",
  );
  const patch = JSON.parse(trusted.toString()) as SecurityPatch;
  assert.equal(patch.cve, "CVE-2026-102989");
  assert.equal(patch.version, "1.169.26");
  assert.deepEqual(patch.files.map((file) => file.path).sort(), [
    "dist/esm/request-response.js",
    "dist/esm/server-functions-handler.js",
    "src/request-response.ts",
    "src/server-functions-handler.ts",
  ]);
  assert.match(patch.patchSHA256, /^[a-f0-9]{64}$/);
  const packages = [];
  for (const directory of await installedTransports(root)) {
    const files = await verifyFrameworkFiles(directory, patch);
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
    packages.push({ path: relative(root, directory), files, transportRegression: "passed" });
  }
  console.log(
    JSON.stringify(
      {
        imageRef,
        transportFixtureSHA256: sha256(await readFile(resolve(fixturePath))),
        packages,
        vex: frameworkVex(imageRef, patch),
      },
      null,
      2,
    ),
  );
}
