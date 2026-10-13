import { expect, test } from "bun:test";
import { resolveRoleModel } from "./model-inheritance";

const input = {
  systemModelId: "system",
  catalogue: ["system", "project", "personal"],
  systemRule: { models: ["system", "project", "personal"], allowOverride: true },
  project: { modelId: null, models: null, allowOverride: null },
  personalModelId: null,
};

test("models inherit through System, Project and permitted personal selection", () => {
  expect(resolveRoleModel(input).source).toBe("system");
  expect(
    resolveRoleModel({ ...input, project: { ...input.project, modelId: "project" } }).source,
  ).toBe("project");
  const personal = resolveRoleModel({ ...input, personalModelId: "personal" });
  expect(personal.modelId).toBe("personal");
  expect(personal.source).toBe("personal");
  expect(personal.lockedReason).toBeNull();
});

test("System locks cannot be widened or unlocked by stored lower settings", () => {
  const locked = resolveRoleModel({
    ...input,
    systemRule: { models: ["system"], allowOverride: false },
    project: { modelId: "project", models: ["system", "project"], allowOverride: true },
    personalModelId: "personal",
  });
  expect(locked.modelId).toBe("system");
  expect(locked.models).toEqual(["system"]);
  expect(locked.allowOverride).toBe(false);
  expect(locked.lockedReason).toBe("Locked by System Manager");
  expect(locked.ignoredReason).not.toBeNull();
});

test("Project locks retain their approved default and invalid personal selections inherit", () => {
  const result = resolveRoleModel({
    ...input,
    project: { modelId: "project", models: ["project"], allowOverride: false },
    personalModelId: "personal",
  });
  expect(result.modelId).toBe("project");
  expect(result.source).toBe("project");
  expect(result.lockedReason).toBe("Locked by Project Manager");
  expect(result.available).toBe(true);
});

test("withdrawn defaults or empty intersections are unavailable, never arbitrary replacements", () => {
  expect(resolveRoleModel({ ...input, catalogue: ["personal"] }).available).toBe(false);
  expect(
    resolveRoleModel({ ...input, project: { ...input.project, models: ["withdrawn"] } }).models,
  ).toEqual([]);
});
