import { expect, test } from "bun:test";
import { generateBaseline } from "./generate";
import { baselineDigest } from "./migrations";

test("Drizzle and native sources generate one reproducible sealed baseline", async () => {
  const first = await generateBaseline();
  expect(await generateBaseline()).toBe(first);
  expect(baselineDigest(first)).toMatch(/^[a-f0-9]{64}$/);
  expect(first.indexOf("CREATE SCHEMA")).toBeLessThan(first.indexOf("CREATE EXTENSION"));
  expect(first.indexOf("CREATE TYPE")).toBeLessThan(first.indexOf("CREATE FUNCTION"));
  expect(first.indexOf("CREATE FUNCTION")).toBeLessThan(first.indexOf("CREATE TABLE"));
  expect(first.indexOf("CREATE TABLE")).toBeLessThan(first.indexOf("CREATE TRIGGER"));
  expect(first).toContain("UNIQUE NULLS NOT DISTINCT");
  expect(first).toContain("ALTER CONSTRAINT knowledge_page_parent_project DEFERRABLE");
});
