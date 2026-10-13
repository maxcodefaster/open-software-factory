import { expect, test } from "bun:test";
import { createDocumentSearchCache } from "./document-search-cache";

const document = (body = "Useful explanation") => [
  { path: "docs/use.md", sha: "blob", title: "Use", body },
];

test("exact-commit search coalesces reads, separates commits and retries failures", async () => {
  const cache = createDocumentSearchCache();
  let reads = 0;
  const load = async () => {
    reads++;
    return document();
  };
  const first = cache.get("repo:commit-a", load);
  expect(cache.get("repo:commit-a", load)).toBe(first);
  await first;
  await cache.get("repo:commit-b", load);
  expect(reads).toBe(2);
  await expect(
    cache.get("failed", async () => {
      throw new Error("Unavailable");
    }),
  ).rejects.toThrow("Unavailable");
  expect(await cache.get("failed", load)).toEqual(document());
});

test("search cache bounds retained commits and UTF-8 corpus bytes", async () => {
  const cache = createDocumentSearchCache();
  const first = cache.get("first", async () => document());
  await first;
  for (let index = 0; index < 8; index++)
    await cache.get(`commit-${index}`, async () => document());
  expect(cache.get("first", async () => document())).not.toBe(first);
  await expect(
    cache.get("large", async () => document("é".repeat(8 * 1024 * 1024 + 1))),
  ).rejects.toThrow("size limit");
  expect(await cache.get("large", async () => document())).toEqual(document());
  const big = "x".repeat(12 * 1024 * 1024);
  const oldest = cache.get("big-a", async () => document(big));
  await oldest;
  await cache.get("big-b", async () => document(big));
  await cache.get("big-c", async () => document(big));
  expect(cache.get("big-a", async () => document())).not.toBe(oldest);
});
