import { expect, test } from "bun:test";
import { planningDesign, planningProduct } from "../../../test/fixtures/technical-planning";
import { technicalDesignContentInput, validateTechnicalDesignCoverage } from "./technical-design";

test("technical design validation covers the exact numbered product criteria", () => {
  const content = technicalDesignContentInput.parse(planningDesign);
  expect(() =>
    validateTechnicalDesignCoverage(content, planningProduct.acceptanceCriteria),
  ).not.toThrow();
  expect(() =>
    validateTechnicalDesignCoverage(
      { ...content, validation: content.validation.slice(1) },
      planningProduct.acceptanceCriteria,
    ),
  ).toThrow();
  expect(() =>
    validateTechnicalDesignCoverage(
      {
        ...content,
        validation: [...content.validation, { criterion: 4, check: "An invented criterion" }],
      },
      planningProduct.acceptanceCriteria,
    ),
  ).toThrow();
  expect(
    technicalDesignContentInput.safeParse({
      ...content,
      diagrams: [...content.diagrams, ...content.diagrams, ...content.diagrams],
    }).success,
  ).toBe(false);
});
