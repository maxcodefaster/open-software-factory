import { expect, test } from "bun:test";
import { listDirectory, repositoryMap } from "./repository-map";

const files = [
  { path: "README.md", size: 100 },
  { path: "package.json", size: 200 },
  { path: "apps/web/package.json", size: 200 },
  { path: "apps/web/src/pages/index.astro", size: 900 },
  { path: "apps/web/src/pages/about.astro", size: 800 },
  { path: "packages/forms-core/src/model.ts", size: 3000 },
  { path: "docs/guide.md", size: 500 },
];

test("the map orients without listing every file", () => {
  const map = repositoryMap(files);
  expect(map.files).toBe(7);
  expect(map.directories[0]).toBe("apps/ (3 files)");
  expect(map.directories).toContain("  web/ (3 files)");
  expect(map.manifests).toEqual(["package.json", "apps/web/package.json"]);
  expect(map.documents).toEqual(["README.md", "docs/guide.md"]);
  expect(JSON.stringify(map)).not.toContain("model.ts");
});

test("the map stays small for a large repository", () => {
  const large = Array.from({ length: 5000 }, (_, index) => ({
    path: `apps/app-${index % 50}/src/feature-${index % 40}/file-${index}.ts`,
    size: 1000,
  }));
  expect(JSON.stringify(repositoryMap(large)).length).toBeLessThan(12_000);
});

test("directories list one level and page deterministically", () => {
  const root = listDirectory(files, "");
  expect(root.entries).toEqual([
    "apps/ (3 files)",
    "docs/ (1 files)",
    "packages/ (1 files)",
    "package.json (200 bytes)",
    "README.md (100 bytes)",
  ]);
  const pages = listDirectory(files, "apps/web/src/pages/", 1, 1);
  expect(pages.entries).toEqual(["apps/web/src/pages/index.astro (900 bytes)"]);
  expect(pages.nextOffset).toBeNull();
  expect(listDirectory(files, "apps/web/src/pages", 0, 1).nextOffset).toBe(1);
  expect(listDirectory(files, "missing").entries).toEqual([]);
});
