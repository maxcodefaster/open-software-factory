import { expect, test } from "bun:test";
import { movePageOrder, pageParentWouldCycle } from "./page-tree";

const pages = [
  { id: "a", parentId: null, sortOrder: 0, title: "A" },
  { id: "b", parentId: "a", sortOrder: 0, title: "B" },
  { id: "c", parentId: null, sortOrder: 1, title: "C" },
];
test("page movement keeps identity, sibling order and rejects cycles or foreign parents", () => {
  expect(movePageOrder(pages, "c", null, "a")).toEqual(["c", "a"]);
  expect(movePageOrder(pages, "b", null, "c")).toEqual(["a", "b", "c"]);
  expect(pageParentWouldCycle(pages, "a", "b")).toBe(true);
  expect(() => movePageOrder(pages, "a", "b", null)).toThrow("cycle");
  expect(() => movePageOrder(pages, "a", "foreign", null)).toThrow("Parent");
  expect(() => movePageOrder(pages, "c", null, "b")).toThrow("sibling");
});
