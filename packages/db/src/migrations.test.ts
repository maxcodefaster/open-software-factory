import { describe, expect, test } from "bun:test";
import { migrationFiles, pendingMigrations, readMigration, shippedMigrations } from "./migrations";

describe("migration sequence", () => {
  test("shipped files are one contiguous sequence that registers its own version", async () => {
    const files = await shippedMigrations();
    expect(files[0]?.name).toBe("0001_baseline.sql");
    for (const file of files) {
      const sql = await readMigration(file);
      expect(sql).toMatch(
        new RegExp(
          `INSERT INTO factory\\.schema_migration\\(version\\)\\s*VALUES\\s*\\(${file.version}\\)`,
        ),
      );
      if (file.version > 1) {
        expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
        expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
      }
    }
  });

  test("applies only newer files and refuses unknown history or downgrades", () => {
    const files = migrationFiles(["0001_a.sql", "0002_b.sql", "0003_c.sql", "notes.txt"]);
    expect(pendingMigrations(files, [1]).map((file) => file.version)).toEqual([2, 3]);
    expect(pendingMigrations(files, [1, 2, 3])).toEqual([]);
    expect(() => pendingMigrations(files, [1, 3])).toThrow("Greenfield baseline");
    expect(() => pendingMigrations(files, [2])).toThrow("Greenfield baseline");
    expect(() => pendingMigrations(files, [1, 2, 3, 4])).toThrow("downgrade");
  });

  test("a gap in the shipped files is a build error", () => {
    expect(() => migrationFiles(["0001_a.sql", "0003_c.sql"])).toThrow("contiguous");
  });
});
