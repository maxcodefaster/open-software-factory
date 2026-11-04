import { expect, test } from "bun:test";
import { modelProbeExplanation } from "./probe-explanation";

test("an unreachable custom endpoint names its origin and the operator remedy", () => {
  const text = modelProbeExplanation("unavailable", "https://llm.example.com/v1/openai");
  expect(text).toContain("https://llm.example.com");
  expect(text).not.toContain("/v1/openai");
  expect(text).toContain("modelAllowedOrigins");
});

test("an unreachable native provider does not blame the operator allow-list", () => {
  expect(modelProbeExplanation("unavailable", null)).not.toContain("modelAllowedOrigins");
  expect(modelProbeExplanation("unavailable", null)).toContain("outbound network");
});

test.each([
  "invalid-credentials",
  "model-denied",
  "rate-limited",
  "unsupported",
  "timeout",
  "stopped",
  "superseded",
] as const)("%s has a plain sentence", (status) => {
  const text = modelProbeExplanation(status);
  expect(text).not.toMatch(/[a-z]+-[a-z]+/);
  expect(text.endsWith(".")).toBe(true);
});
