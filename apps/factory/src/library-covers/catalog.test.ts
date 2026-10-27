import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { libraryCoverCatalog } from "../../../../packages/conversation-domain/src/library-covers";
import { libraryCoverURL } from "./catalog";
import { skillCover } from "../skills/cover";

test("thirty shipped illustrations have distinct optimized portrait and landscape renditions", async () => {
  for (const kind of ["skill", "mcp"] as const) {
    const hashes = new Set<string>();
    for (const cover of libraryCoverCatalog) {
      const path = resolve(
        import.meta.dir,
        "../../public",
        libraryCoverURL(cover.key, kind).slice(1),
      );
      const bytes = await readFile(path);
      const image = await loadImage(bytes);
      expect([image.width, image.height]).toEqual([kind === "skill" ? 384 : 768, 512]);
      expect(bytes.byteLength).toBeLessThan(200_000);
      hashes.add(createHash("sha256").update(bytes).digest("hex"));
      const metadata = JSON.parse(await readFile(`${path}.json`, "utf8"));
      expect(metadata.name).toBe(cover.name);
      expect(metadata.prompt).toContain("style references only");
    }
    expect(hashes.size).toBe(30);
  }
});

test("a chosen cover overrides presentation without replacing starter identity or instructions", () => {
  const id = "faca0001-0000-4000-8000-000000000001";
  expect(skillCover(id)).toBe("/art/skills/requirements-interview.webp");
  expect(skillCover(id, { key: "woven-ribbons", version: 1 })).toBe(
    "/art/library/woven-ribbons-skill.webp",
  );
});
