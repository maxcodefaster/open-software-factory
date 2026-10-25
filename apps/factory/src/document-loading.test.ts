import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

test("the Board's static module graph does not load the document editor engine", () => {
  const seen = new Set<string>();
  const engines = new Set<string>();
  function visit(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const scanner = new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" });
    for (const dependency of scanner.scanImports(readFileSync(path, "utf8"))) {
      if (dependency.kind === "dynamic-import") continue;
      if (dependency.path.startsWith("@tiptap/")) engines.add(dependency.path);
      if (!dependency.path.startsWith(".")) continue;
      const base = resolve(dirname(path), dependency.path);
      const next = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
        (file) => /\.[cm]?tsx?$/.test(file) && existsSync(file),
      );
      if (next) visit(next);
    }
  }
  visit(resolve(import.meta.dir, "factory.tsx"));
  expect([...engines]).toEqual([]);
});
