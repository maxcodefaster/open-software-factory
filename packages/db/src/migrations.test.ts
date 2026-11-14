import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  baselineDigest,
  migrationFiles,
  pendingMigrations,
  readMigration,
  shippedMigrations,
} from "./migrations";

describe("native Greenfield baseline", () => {
  test("ships exactly one transactional baseline with its exact SQL fingerprint", async () => {
    const files = await shippedMigrations();
    expect(files).toEqual([{ name: "0001_baseline.sql", version: 1 }]);
    const file = files[0];
    if (!file) throw new Error("Missing native baseline");
    const sql = await readMigration(file);
    expect(sql).toContain("\nBEGIN;\n");
    expect(sql.endsWith("\nCOMMIT;\n")).toBe(true);
    expect(baselineDigest(sql)).toMatch(/^[a-f0-9]{64}$/);
    expect(sql.includes("protect_substrate_source_preservation")).toBe(false);
    expect(/\bpreservation\b/.test(sql)).toBe(false);
    expect(pendingMigrations(files, [1])).toEqual([]);
  });

  test("refuses historical sequences, unknown files and versions", () => {
    const files = migrationFiles(["0001_baseline.sql", "notes.txt"]);
    for (const names of [
      [],
      ["0001_a.sql"],
      ["0001_baseline.sql", "0002_more.sql"],
      ["0001_baseline.sql", "0001_duplicate.sql"],
      ["0002_baseline.sql"],
    ])
      expect(() => migrationFiles(names)).toThrow("one Greenfield baseline");
    for (const applied of [[], [0], [2], [1, 2], [1, 1]])
      expect(() => pendingMigrations(files, applied)).toThrow("Greenfield baseline");
    expect(() => pendingMigrations([{ name: "0002_baseline.sql", version: 2 }], [1])).toThrow(
      "Greenfield baseline",
    );
  });

  test("detects edited SQL, missing or duplicate registration and unverified trailing commands", () => {
    const prefix = "BEGIN;\nSELECT 1;\n";
    const hash = createHash("sha256").update(prefix).digest("hex");
    const registration = `-- Baseline registration.\nINSERT INTO factory.schema_migration(version,source_digest) VALUES(1,'${hash}');\nCOMMIT;\n`;
    const sql = prefix + registration;
    expect(baselineDigest(sql)).toBe(hash);
    for (const altered of [
      sql.replace("SELECT 1", "SELECT 2"),
      prefix,
      sql + registration,
      `${sql}DROP SCHEMA factory CASCADE;\n`,
      sql.replace(hash, "0".repeat(64)),
      sql.replace("VALUES(1,", "VALUES(2,"),
    ])
      expect(() => baselineDigest(altered)).toThrow("exact SQL source");
  });
});
