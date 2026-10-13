import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { projectModelConnection } from "./adapter";
import { projectAgentStructuredOutput, projectAgentStructuredOutputFor } from "./controller";

test("reports an unconfigured model instead of inventing an interview response", async () => {
  const previousKey = process.env["FACTORY_MODEL_API_KEY"];
  const previousPlanningKey = process.env["FACTORY_PLANNING_MODEL_API_KEY"];
  delete process.env["FACTORY_MODEL_API_KEY"];
  delete process.env["FACTORY_PLANNING_MODEL_API_KEY"];
  try {
    expect(projectModelConnection).toThrow("The Project Agent model is not configured");
    try {
      projectModelConnection();
    } catch (cause) {
      expect(cause).toMatchObject({ code: "unavailable", status: 503 });
    }
  } finally {
    if (previousKey === undefined) delete process.env["FACTORY_MODEL_API_KEY"];
    else process.env["FACTORY_MODEL_API_KEY"] = previousKey;
    if (previousPlanningKey === undefined) delete process.env["FACTORY_PLANNING_MODEL_API_KEY"];
    else process.env["FACTORY_PLANNING_MODEL_API_KEY"] = previousPlanningKey;
  }
});

describe("Project Agent structured output", () => {
  test("uses an object at the top level for OpenAI-compatible response formats", () => {
    const schema = z.toJSONSchema(projectAgentStructuredOutput);

    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("output");
  });

  test("keeps an investigate turn read-only when the model proposes planning work", () => {
    const schema = projectAgentStructuredOutputFor("investigate");
    expect(
      schema.safeParse({
        output: {
          kind: "question",
          message: "I found the relevant project context.",
          citations: [],
          question: {
            type: "free-text",
            prompt: "What should change?",
            placeholder: "Describe the change",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        output: {
          kind: "requirement",
          message: "I proposed a specification.",
          citations: [],
          ticket: { title: "Change the delivery flow", description: "" },
          requirement: {
            summary: "Change the delivery flow",
            acceptanceCriteria: ["Delivery remains explicit"],
            nonGoals: [],
          },
        },
      }).success,
    ).toBe(false);
    const providerSchema = z.toJSONSchema(schema);
    expect(providerSchema.properties?.["output"]).toMatchObject({
      type: "object",
      properties: { kind: { const: "answer" } },
    });
    expect(
      schema.safeParse({
        output: {
          kind: "answer",
          message: "I found the relevant project context.",
          citations: [],
        },
      }).success,
    ).toBe(true);
  });

  test("preserves planning output in Plan mode", () => {
    const output = {
      kind: "question" as const,
      message: "I need one decision.",
      citations: [],
      question: {
        type: "free-text" as const,
        prompt: "What should change?",
        placeholder: "Describe the change",
      },
    };

    expect(projectAgentStructuredOutputFor("plan").parse({ output }).output).toEqual(output);
  });
});
