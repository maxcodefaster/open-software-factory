import { expect, test } from "bun:test";
import { mergeDocumentText, mergeGeneratedDocument, withoutRepeatedTitle } from "./document-merge";

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

test("generated publication keeps human appendices verbatim without adopting them into its baseline", () => {
  const note = "Manual acceptance note: use synthetic requests only.";
  for (const repeats of [false, true]) {
    let base = "Old generated description.";
    let human = `${base}\n\n${note}`;
    for (const next of ["Updated source description.", "A later verified source description."]) {
      const merged = mergeGeneratedDocument(base, human, repeats ? `${next}\n\n${note}` : next);
      expect(merged).toEqual({
        body: `${next}\n\n${note}`,
        generatedBody: next,
        conflict: false,
      });
      base = merged.generatedBody;
      human = merged.body;
    }
  }
});

test("generated publication keeps prefix notes and rebases disjoint inline human edits", () => {
  expect(mergeGeneratedDocument("Old.", "Human note.\n\nOld.", "New.")).toEqual({
    body: "Human note.\n\nNew.",
    generatedBody: "New.",
    conflict: false,
  });
  const base = "# Guide\n\nPurpose is original.\n\nSetup is original.";
  const human = base.replace("Purpose is original", "Purpose is human");
  const generated = base.replace("Setup is original", "Setup is current");
  expect(mergeGeneratedDocument(base, human, generated)).toEqual({
    body: human.replace("Setup is original", "Setup is current"),
    generatedBody: generated,
    conflict: false,
  });
  const includesHuman = human + "\n\nNew source facts.";
  expect(mergeGeneratedDocument(base, human, includesHuman)).toEqual({
    body: includesHuman,
    generatedBody: base + "\n\nNew source facts.",
    conflict: false,
  });
});

test("overlapping human changes and oversized merged pages retain the human text as a conflict", () => {
  expect(
    mergeGeneratedDocument("The color is blue.", "The color is green.", "The color is red."),
  ).toEqual({
    body: "The color is green.",
    generatedBody: "The color is blue.",
    conflict: true,
  });
  expect(mergeGeneratedDocument("Old.", "Old.\n\nManual note.", "x".repeat(120_000)).conflict).toBe(
    true,
  );
});
