import { describe, expect, test } from "bun:test";
import {
  defaultDesktopBackgroundKey,
  desktopBackgroundKeys,
  isDesktopBackgroundKey,
} from "./background";

describe("Desktop Background", () => {
  test("offers six distinct stable artwork keys", () => {
    expect(desktopBackgroundKeys).toHaveLength(6);
    expect(new Set(desktopBackgroundKeys).size).toBe(6);
    for (const key of desktopBackgroundKeys) expect(isDesktopBackgroundKey(key)).toBe(true);
  });

  test("has one stable default in the curated catalogue", () => {
    expect(desktopBackgroundKeys).toContain(defaultDesktopBackgroundKey);
  });

  test("rejects external URLs and unknown keys", () => {
    expect(isDesktopBackgroundKey("the-harvesters")).toBe(true);
    expect(isDesktopBackgroundKey("https://example.com/image.jpg")).toBe(false);
    expect(isDesktopBackgroundKey("custom-theme")).toBe(false);
  });
});
