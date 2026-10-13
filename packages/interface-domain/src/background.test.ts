import { describe, expect, test } from "bun:test";
import {
  defaultDesktopBackgroundKey,
  desktopBackgroundKeys,
  isDesktopBackgroundKey,
} from "./background";

describe("Desktop Background", () => {
  test("has one stable default in the curated catalogue", () => {
    expect(desktopBackgroundKeys).toContain(defaultDesktopBackgroundKey);
  });

  test("rejects external URLs and unknown keys", () => {
    expect(isDesktopBackgroundKey("the-harvesters")).toBe(true);
    expect(isDesktopBackgroundKey("https://example.com/image.jpg")).toBe(false);
    expect(isDesktopBackgroundKey("custom-theme")).toBe(false);
  });
});
