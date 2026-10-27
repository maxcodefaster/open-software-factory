import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

test("Factory ships one Greenfield baseline rather than historical upgrade migrations", async () => {
  const directory = resolve(import.meta.dir, "../migrations");
  const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  expect(files).toEqual(["0001_baseline.sql"]);
});
