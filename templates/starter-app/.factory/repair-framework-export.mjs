import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// RC11 imports existing native scope helpers through an omitted package export.
// Repair only that metadata, never copy or modify the upstream implementation.
const require = createRequire(import.meta.url);
const start = createRequire(require.resolve("@tanstack/solid-start/package.json"));
const path = start.resolve("@tanstack/start-server-core/package.json");
const original = readFileSync(path, "utf8");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const repairedHash = "8af90e300c231620563c81aa7ba3a9b06bad5b26810057329b7ba71e781757e5";
if (sha256(original) !== repairedHash) {
  assert.equal(
    sha256(original),
    "837a71588cf2ddc8659f482443206fcfdf2eadd0dbf9d9bbc3a0783486467204",
    "Unknown TanStack package metadata; update its export repair",
  );
  const metadata = JSON.parse(original);
  assert.equal(metadata.version, "1.169.45");
  metadata.exports["./request-scope"] = {
    import: {
      types: "./dist/esm/internal-request-response.d.ts",
      default: "./dist/esm/internal-request-response.js",
    },
  };
  const content = JSON.stringify(metadata, null, 2) + (original.endsWith("\n") ? "\n" : "");
  assert.equal(sha256(content), repairedHash);
  const temporary = `${path}.exports-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: statSync(path).mode & 0o777 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
