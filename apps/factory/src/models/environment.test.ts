import { expect, test } from "bun:test";
import { modelEnvironment } from "./controller";

test("an unconfigured deployment with blank model variables can open Factory for provider setup", () => {
  const keys = [
    "FACTORY_PROJECT_AGENT_MODEL",
    "FACTORY_AGENT_MODEL_ID",
    "FACTORY_MODEL_BASE_URL",
    "FACTORY_MODEL_API_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const value of ["", "   "]) {
      for (const key of keys) process.env[key] = value;
      const configuration = modelEnvironment();
      expect(configuration.planningModelId).toBe("factory-planning-model");
      expect(configuration.buildModelId).toBe("factory-coding-model");
      expect(configuration.baseURL).toBeUndefined();
      expect(configuration.apiKey).toBeUndefined();
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
