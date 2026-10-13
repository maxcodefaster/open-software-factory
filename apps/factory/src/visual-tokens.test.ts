import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const directory = fileURLToPath(new URL("./", import.meta.url));
const stylesheets = [...new Bun.Glob("**/*.css").scanSync(directory)]
  .filter((path) => path !== "tokens.css")
  .map((path) => ({ path, content: readFileSync(new URL(path, import.meta.url), "utf8") }));

test("shared interface spacing comes from the visual token system", () => {
  const declarations = stylesheets.flatMap(({ path, content }) =>
    [...content.matchAll(/^\s*((?:gap|padding|margin)(?:-[a-z-]+)?):\s*([^;]+);/gm)].map(
      (match) => ({ path, property: match[1], value: match[2] }),
    ),
  );
  const literalSpacing = declarations
    .filter(({ property, value }) => {
      // The screen-reader clipping offset is structural, not visual spacing.
      if (property === "margin" && value === "-1px") return false;
      return /\d(?:px|rem|vw|vh)/.test(value ?? "");
    })
    .map(({ path, property, value }) => `${path}: ${property}: ${value}`);

  expect(declarations.length).toBeGreaterThan(100);
  expect(literalSpacing).toEqual([]);
  expect(stylesheets.length).toBeGreaterThan(5);
});
