import { expect, test } from "bun:test";
import { approvedModelCatalogue, modelDefaultsInput } from "./model-settings";

test("catalogue includes environment defaults and deduplicates explicit choices", () => {
  expect(
    approvedModelCatalogue({
      planningModelId: "plan",
      buildModelId: "build",
      additionalIds: " plan, other, ,other ",
    }),
  ).toEqual(["plan", "build", "other"]);
});

test("model input rejects arbitrary endpoints, credentials and invalid versions", () => {
  for (const id of ["https://evil.invalid", "Bearer secret", "", "a".repeat(201)])
    expect(
      modelDefaultsInput.safeParse({ planningModelId: id, buildModelId: "build", version: 0 })
        .success,
    ).toBe(false);
  expect(
    modelDefaultsInput.safeParse({
      planningModelId: "valid/model-v2",
      buildModelId: "build",
      version: -1,
    }).success,
  ).toBe(false);
  expect(
    modelDefaultsInput.safeParse({
      planningModelId: "plan",
      buildModelId: "build",
      version: 0,
      apiKey: "secret",
    }).success,
  ).toBe(false);
});
