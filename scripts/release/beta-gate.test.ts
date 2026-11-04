import { expect, test } from "bun:test";
import { findForbidden, forbiddenTermPattern, gateSteps, parseForbiddenTerms } from "./beta-gate";

test("terms come from a plain list and ignore comments", () => {
  expect(parseForbiddenTerms("# why\nacme-secret\n\n  other \n")).toEqual(["acme-secret", "other"]);
});

test("a term is a whole word, so longer words that contain it do not match", () => {
  const terms = ["acme"];
  expect(findForbidden(terms, "readAccount and 51ec7abc08af40adac669837530e8c23")).toEqual([]);
  expect(findForbidden(terms, "Owned ACME Preview, acme-astro and /owned/acme.git")).toEqual([
    "acme",
    "acme",
    "acme",
  ]);
  expect(forbiddenTermPattern(["a.c"]).test("abc")).toBe(false);
});

test("the gate runs every lane, ending with the owned browser lane", () => {
  const names = gateSteps().map((step) => step.name);
  expect(names).toEqual([
    "docs",
    "format",
    "lint",
    "typecheck",
    "unit",
    "connector",
    "controllers",
    "browser",
  ]);
});
