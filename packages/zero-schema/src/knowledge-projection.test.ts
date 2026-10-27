import { expect, test } from "bun:test";
import { zeroSchema } from "./schema";

test("shared Wiki projections contain no technical source provenance", () => {
  expect(zeroSchema.tables.knowledgePage.columns).not.toHaveProperty("sourceCommitSha");
  expect(zeroSchema.tables.knowledgePage.columns).not.toHaveProperty("citations");
  expect(zeroSchema.tables.knowledgePage.columns).not.toHaveProperty("generatedBody");
  expect(zeroSchema.tables.knowledgePage.columns).toHaveProperty("currentBody");
  expect(zeroSchema.tables.knowledgePageOutline.columns).not.toHaveProperty("currentBody");
  expect(zeroSchema.tables.knowledgePageOutline.columns).not.toHaveProperty("citations");
  expect(Object.keys(zeroSchema.tables.readVersion.columns).sort()).toEqual([
    "audience",
    "projectId",
    "resourceId",
    "revision",
    "scope",
  ]);
});
