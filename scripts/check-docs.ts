import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const generated = new Set([
  ".factory",
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

function requireValid(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

function documents(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return generated.has(entry.name) ? [] : documents(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function headings(document: string) {
  const used = new Map<string, number>();
  const result = new Set<string>();
  for (const [, heading] of document.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = (heading ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  return result;
}

const root = resolve(import.meta.dir, "..");
const paths = documents(root).sort();
let links = 0;
for (const path of paths) {
  const name = relative(root, path);
  requireValid(
    basename(path) === "README.md" ||
      basename(path) === "AGENTS.md" ||
      name === "apps/factory/PRODUCT.md" ||
      /^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/.test(name),
    `${name}: use a README, AGENTS.md, numbered ADR or apps/factory/PRODUCT.md`,
  );
  const document = readFileSync(path, "utf8");
  requireValid((document.match(/^```/gm) ?? []).length % 2 === 0, `${name}: unbalanced fences`);
  for (const [, raw] of document.matchAll(/\]\(([^)\n]+)\)/g)) {
    const target = (raw ?? "").replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [file, fragment] = target.split("#");
    const destination = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
    requireValid(existsSync(destination), `${name}: missing ${target}`);
    if (fragment) {
      requireValid(
        statSync(destination).isFile() &&
          headings(readFileSync(destination, "utf8")).has(decodeURIComponent(fragment)),
        `${name}: missing anchor ${target}`,
      );
    }
    links += 1;
  }
}
for (const expected of ["README.md", "AGENTS.md", "docs/README.md"])
  requireValid(paths.includes(resolve(root, expected)), `Missing ${expected}`);
console.log({ documents: paths.length, links, result: "passed" });
