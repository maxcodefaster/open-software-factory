import { expect, test } from "bun:test";
import { validateWikiGeneration, wikiGenerationOutput, type WikiPageSnapshot } from "./generation";

const page: WikiPageSnapshot = {
  id: crypto.randomUUID(),
  slug: "guide",
  title: "Guide",
  body: "Human intent.",
  version: 1,
  revisionId: null,
  parentId: null,
  state: "active",
  citations: [],
};
const output = (value = {}) =>
  wikiGenerationOutput.parse({
    pages: [
      {
        id: page.id,
        slug: page.slug,
        title: page.title,
        body: "Human intent with verified behavior.",
        parentSlug: null,
        sources: ["src/main.ts"],
        ...value,
      },
    ],
  });
test("Wiki updates have exact page identity and actually read evidence", () => {
  expect(() => validateWikiGeneration(output(), [page], new Set(["src/main.ts"]))).not.toThrow();
  expect(() => validateWikiGeneration(output(), [page], new Set())).toThrow("actually read");
  expect(() =>
    validateWikiGeneration(output({ id: crypto.randomUUID() }), [page], new Set(["src/main.ts"])),
  ).toThrow("unavailable");
  expect(() =>
    validateWikiGeneration(output({ slug: "renamed" }), [page], new Set(["src/main.ts"])),
  ).toThrow("organization");
  expect(() =>
    validateWikiGeneration(output({ id: null }), [page], new Set(["src/main.ts"])),
  ).toThrow("duplicates");
  expect(wikiGenerationOutput.parse({ pages: [] })).toEqual({ pages: [] });
});
test("new Wiki hierarchy rejects cycles, missing parents and archived identity reuse", () => {
  const a = output({ id: null, slug: "a", parentSlug: "b" }).pages[0];
  if (!a) throw new Error("Missing generated page fixture");
  const b = { ...a, slug: "b", parentSlug: "a" };
  expect(() => validateWikiGeneration({ pages: [a, b] }, [], new Set(["src/main.ts"]))).toThrow(
    "cycle",
  );
  expect(() => validateWikiGeneration({ pages: [a] }, [], new Set(["src/main.ts"]))).toThrow(
    "parent",
  );
  expect(() =>
    validateWikiGeneration(output(), [{ ...page, state: "archived" }], new Set(["src/main.ts"])),
  ).toThrow("unavailable");
});
