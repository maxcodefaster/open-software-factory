import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desktopBackgroundKeys } from "../../../packages/interface-domain/src/background";
import { desktopBackgrounds, orderedDesktopBackgrounds } from "./artworks";

test("the selected background comes first without changing the catalog or remaining order", () => {
  for (const key of desktopBackgroundKeys) {
    const ordered = orderedDesktopBackgrounds(key);
    expect(ordered[0]?.key).toBe(key);
    expect(ordered.slice(1).map((background) => background.key)).toEqual(
      desktopBackgroundKeys.filter((other) => other !== key),
    );
    expect(ordered).toHaveLength(6);
  }
  expect(desktopBackgrounds.map((background) => background.key)).toEqual([
    ...desktopBackgroundKeys,
  ]);
});

test("each curated Project background has bundled artwork, a thumbnail and theme tokens", async () => {
  expect(desktopBackgrounds.map((background) => background.key)).toEqual([
    ...desktopBackgroundKeys,
  ]);
  const tokens = await readFile(resolve(import.meta.dir, "tokens.css"), "utf8");
  const css = await readFile(resolve(import.meta.dir, "style.css"), "utf8");
  for (const background of desktopBackgrounds) {
    expect(background.artist).not.toBe("");
    expect(background.museum).not.toBe("");
    expect(background.image).toBe(`/art/${background.key}.jpg`);
    for (const suffix of [".jpg", "-thumb.jpg"]) {
      const image = Bun.file(resolve(import.meta.dir, `../public/art/${background.key}${suffix}`));
      expect(await image.exists()).toBe(true);
      expect(image.size).toBeGreaterThan(1000);
    }
    expect(tokens).toContain(`[data-background="${background.key}"]`);
    expect(css).toContain(`/art/${background.key}-thumb.jpg`);
  }
});
