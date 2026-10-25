import { expect, test } from "bun:test";
import { documentSlash, filterDocumentBlocks } from "./document-slash";
import { documentBlocks } from "./document-model";

test("keeps slash query open while typing and removes the entire command token", () => {
  expect(documentSlash("/t")).toEqual({ query: "t", length: 2 });
  expect(documentSlash("A paragraph /table")).toEqual({ query: "table", length: 6 });
  expect(documentSlash("https://example.com/t")).toBeUndefined();
  expect(documentSlash("a/b")).toBeUndefined();
  expect(documentSlash("/table ")).toBeUndefined();
  expect(filterDocumentBlocks(documentBlocks, "ta").map((block) => block.id)).toEqual(["table"]);
  expect(filterDocumentBlocks(documentBlocks, "t").map((block) => block.id)).toContain("paragraph");
  expect(filterDocumentBlocks(documentBlocks, "unmatched")).toEqual([]);
});
