import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";

const patch = JSON.parse(readFileSync(new URL("./framework-security.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const start = createRequire(require.resolve("@tanstack/solid-start/package.json"));
const packagePath = start.resolve("@tanstack/start-server-core/package.json");
const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
assert.equal(metadata.version, patch.version, "Update the framework security patch when changing its version");
const directory = dirname(packagePath);
const hash = (value) => createHash("sha256").update(value).digest("hex");
// Validate every preimage before writing. A retry accepts only original or
// fully patched files; it never guesses how to patch an unknown package.
const writes = patch.files.flatMap((file) => {
  const target = resolve(directory, file.path);
  assert.ok(target.startsWith(directory + sep), "Invalid framework patch path");
  const original = readFileSync(target, "utf8");
  const digest = hash(original);
  if (digest === file.afterSHA256) return [];
  assert.equal(digest, file.beforeSHA256, `Framework file changed: ${file.path}`);
  const lines = original.split("\n");
  for (const edit of [...file.edits].reverse())
    lines.splice(edit.start, edit.end - edit.start, ...edit.lines);
  const content = lines.join("\n");
  assert.equal(hash(content), file.afterSHA256, `Invalid framework patch: ${file.path}`);
  return [{ target, content, mode: statSync(target).mode & 0o777 }];
});
for (const { target, content, mode } of writes) {
  const temporary = `${target}.security-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
console.log(`Framework security backport applied: ${patch.advisory}`);
