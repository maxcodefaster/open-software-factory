import { describe, expect, test } from "bun:test";
import { defaultExpandedKeys } from "./page-tree-state";

describe("defaultExpandedKeys", () => {
  test("expands root Wiki pages with children while leaving grandchildren collapsed", () => {
    const keys = defaultExpandedKeys([
      { id: "root", parentId: null },
      { id: "guide-a", parentId: "root" },
      { id: "guide-b", parentId: "root" },
      { id: "deep-child", parentId: "guide-a" },
    ]);
    expect(keys).toEqual(["wiki", "root"]);
  });

  test("does not expand root pages without children", () => {
    const keys = defaultExpandedKeys([
      { id: "root-a", parentId: null },
      { id: "root-b", parentId: null },
    ]);
    expect(keys).toEqual(["wiki"]);
  });
});
