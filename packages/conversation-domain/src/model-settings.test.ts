import { expect, test } from "bun:test";
import { approvedModelCatalogue, modelDefaultsInput, modelRulesInput } from "./model-settings";
import { modelRoleConnectionInput } from "./model-connection";

test("model checks accept Coding reasoning only for the Coding role and enforce its floor", () => {
  const input = {
    commandID: crypto.randomUUID(),
    connectionID: crypto.randomUUID(),
    version: 1,
    settingsVersion: 0,
    role: "build",
    modelId: "gpt-6.1-sol",
    confirmInference: true,
  };
  expect(
    modelRoleConnectionInput.parse({ ...input, reasoningEffort: "high" }).reasoningEffort,
  ).toBe("high");
  for (const reasoningEffort of ["low", "none", "invalid"])
    expect(modelRoleConnectionInput.safeParse({ ...input, reasoningEffort }).success).toBe(false);
  expect(
    modelRoleConnectionInput.safeParse({ ...input, role: "planning", reasoningEffort: "high" })
      .success,
  ).toBe(false);
});

test("Coding reasoning defaults to medium and cannot be disabled or lowered", () => {
  const rules = {
    planning: { models: ["plan"], allowOverride: true },
    build: { models: ["build"], allowOverride: true },
  };
  expect(modelRulesInput.parse(rules).build).toHaveProperty("reasoningEffort", "medium");
  for (const reasoningEffort of ["medium", "high", "xhigh", "max"]) {
    expect(
      modelRulesInput.parse({ ...rules, build: { ...rules.build, reasoningEffort } }).build,
    ).toHaveProperty("reasoningEffort", reasoningEffort);
  }
  for (const reasoningEffort of ["none", "minimal", "low", "", null])
    expect(
      modelRulesInput.safeParse({ ...rules, build: { ...rules.build, reasoningEffort } }).success,
    ).toBe(false);
});

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
