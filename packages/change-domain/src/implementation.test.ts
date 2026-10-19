import { expect, test } from "bun:test";
import { implementationInput } from "./implementation";

test("Implement accepts an optional Coding reasoning choice without permitting low or unapproved input", () => {
  const base = { commandId: crypto.randomUUID(), revisionId: crypto.randomUUID() };
  expect(implementationInput.parse(base)).toEqual(base);
  for (const codingReasoning of ["medium", "high", "xhigh", "max"] as const)
    expect(implementationInput.parse({ ...base, codingReasoning })).toEqual({
      ...base,
      codingReasoning,
    });
  for (const codingReasoning of ["none", "low", "", null])
    expect(implementationInput.safeParse({ ...base, codingReasoning }).success).toBe(false);
  expect(implementationInput.safeParse({ ...base, modelId: "unapproved" }).success).toBe(false);
});
