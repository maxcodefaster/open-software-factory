import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

test("Factory ships its Greenfield baseline and the concrete retained worker admission step", async () => {
  const directory = resolve(import.meta.dir, "../migrations");
  const files = (await readdir(directory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  expect(files).toEqual(["0001_baseline.sql", "0002_worker_admissions.sql"]);
});
