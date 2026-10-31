import { expect, test } from "bun:test";
import { createRepositoryKnowledgeCache } from "./repository-cache";

test("coalesces exact-commit inventory reads and keeps repositories isolated", async () => {
  const cache = createRepositoryKnowledgeCache();
  let reads = 0;
  const load = async () => {
    reads += 1;
    return [{ path: "README.md", sha: "blob", size: 4 }];
  };
  await Promise.all([cache.inventory("a", "commit", load), cache.inventory("a", "commit", load)]);
  expect(reads).toBe(1);
  await cache.inventory("a", "new-commit", load);
  await cache.inventory("b", "commit", load);
  expect(reads).toBe(3);
});

test("reuses unchanged blobs across commits and retries failed reads", async () => {
  const cache = createRepositoryKnowledgeCache();
  let reads = 0;
  const load = async () => {
    reads += 1;
    return "body";
  };
  expect(await cache.content("a", "blob", load)).toBe("body");
  await cache.content("a", "blob", load);
  expect(reads).toBe(1);
  await expect(
    cache.content("a", "failed", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(await cache.content("a", "failed", load)).toBe("body");
  await cache.content("b", "blob", load);
  expect(reads).toBe(3);
});

test("bounds retained content and rejects oversized documents", async () => {
  const cache = createRepositoryKnowledgeCache();
  await expect(cache.content("a", "large", async () => "a".repeat(250_001))).rejects.toThrow(
    "size limit",
  );
  let reads = 0;
  const load = async () => {
    reads += 1;
    return "first";
  };
  await cache.content("a", "first", load);
  for (let index = 0; index < 513; index += 1)
    await cache.content("a", String(index), async () => "body");
  await cache.content("a", "first", load);
  expect(reads).toBe(2);
});

test("large paginated code reads never weaken document limits through the shared cache", async () => {
  const cache = createRepositoryKnowledgeCache();
  const body = "package: dependency\n".repeat(24000);
  let reads = 0;
  const load = async () => {
    reads++;
    return body;
  };
  await Promise.all([
    expect(cache.content("a", "lock", load)).rejects.toThrow("size limit"),
    expect(cache.content("a", "lock", load, Buffer.byteLength(body))).resolves.toBe(body),
  ]);
  expect(reads).toBe(2);
  expect(await cache.content("a", "lock", load, Buffer.byteLength(body))).toBe(body);
  expect(reads).toBe(2);
  await expect(cache.content("a", "lock", load)).rejects.toThrow("size limit");
  expect(reads).toBe(3);
  await expect(cache.content("a", "lock", load, Buffer.byteLength(body) - 1)).rejects.toThrow(
    "size limit",
  );
});
