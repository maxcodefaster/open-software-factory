import { expect, test } from "bun:test";
import { mergeDocumentText, withoutRepeatedTitle } from "./document-merge";

test("concurrent prose merges disjoint edits without relying on unique headings", () => {
  const base = "# Guide\n\n## Setup\nOne.\n\n## Setup\nTwo.\n";
  expect(
    mergeDocumentText(base, base.replace("One", "Local"), base.replace("Two", "Remote")),
  ).toEqual({ text: base.replace("One", "Local").replace("Two", "Remote"), conflict: false });
  expect(
    mergeDocumentText(base, base.replace("One", "Local"), base.replace("One", "Remote")),
  ).toEqual({ text: base.replace("One", "Local"), conflict: true });
  expect(mergeDocumentText("ab", "a1b", "a2b").conflict).toBe(true);
  expect(mergeDocumentText("ab", "1ab", "ab2")).toEqual({ text: "1ab2", conflict: false });
  expect(mergeDocumentText(base, base, "Updated").text).toBe("Updated");
  expect(withoutRepeatedTitle("# Guide\n\nBody", "Guide")).toBe("Body");
  expect(withoutRepeatedTitle("# Other\n\nBody", "Guide")).toBe("# Other\n\nBody");
});
