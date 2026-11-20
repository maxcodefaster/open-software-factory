import { expect, test } from "bun:test";
import type { TableSchema } from "@rocicorp/zero";
import { createZeroTableBuilder } from "drizzle-zero";
import {
  epic,
  knowledgePage,
  knowledgePageOutline,
  project,
  projectMembership,
  readVersion,
  ticket,
  ticketDependency,
} from "../../db/src/schema";
import { zeroSchema } from "./schema";

test("Zero includes exactly the eight planning tables with Drizzle column identities and keys", () => {
  const models = {
    project,
    projectMembership,
    ticket,
    epic,
    ticketDependency,
    knowledgePage,
    knowledgePageOutline,
    readVersion,
  };
  expect(Object.keys(zeroSchema.tables).sort()).toEqual(Object.keys(models).sort());
  for (const [name, model] of Object.entries(models)) {
    const generated: TableSchema = zeroSchema.tables[name as keyof typeof models];
    const native = createZeroTableBuilder(name, model, undefined, false, undefined, true)
      .schema as TableSchema;
    expect(generated.serverName).toBe(native.serverName);
    expect(generated.primaryKey).toEqual(native.primaryKey);
    for (const [name, column] of Object.entries(generated.columns)) {
      const source = native.columns[name];
      if (!source) throw new Error(`Projected column is absent from Drizzle: ${name}`);
      expect(column.type).toBe(source.type);
      expect(column.serverName ?? name).toBe(source.serverName ?? name);
    }
  }
});

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
