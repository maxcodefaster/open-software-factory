import { z } from "zod";

const text = z.string().trim().min(1).max(12_000);
export const sourceCommitInput = z.string().regex(/^[a-f0-9]{40}$/);

// A deliberately small, self-contained diagram vocabulary. Rendering is a
// Factory adapter; sources must not load files, URLs, macros or other diagrams.
export const architectureDiagramInput = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_000),
    source: z.string().trim().min(1).max(16_000),
  })
  .superRefine(({ source }, context) => {
    if (
      !/^@startuml(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,80})?[ \t]*\r?\n/.test(source) ||
      !/\r?\n@enduml$/.test(source) ||
      (source.match(/@startuml/g) ?? []).length !== 1 ||
      (source.match(/@enduml/g) ?? []).length !== 1 ||
      /^\s*!/m.test(source) ||
      /%|:\/\/|\[\[|<(?:img|image|script|svg|iframe)\b/i.test(source) ||
      /@(?:start|end)(?!uml\b)/i.test(source)
    )
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Use one self-contained PlantUML diagram without includes, links or macros.",
      });
  });

export const technicalDesignContentInput = z.strictObject({
  context: text,
  proposedChanges: text,
  decisions: z.array(z.string().trim().min(1).max(2_000)).max(20),
  assumptions: z.array(z.string().trim().min(1).max(2_000)).max(20),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(20),
  validation: z
    .array(
      z.strictObject({
        criterion: z.number().int().min(1).max(100),
        check: z.string().trim().min(1).max(2_000),
      }),
    )
    .min(1)
    .max(100),
  diagrams: z.array(architectureDiagramInput).max(2),
});
export type TechnicalDesignContent = z.infer<typeof technicalDesignContentInput>;

export const technicalPlanningBaseInput = z.strictObject({
  requestId: z.uuid().optional(),
  requirementRevisionId: z.uuid(),
  documentId: z.uuid().nullable(),
  previousDesignId: z.uuid().nullable(),
  sourceCommit: sourceCommitInput,
});
export type TechnicalPlanningBase = z.infer<typeof technicalPlanningBaseInput>;

export const saveTechnicalDesignInput = z.strictObject({
  commandId: z.uuid(),
  expectedRevisionId: z.uuid(),
  content: technicalDesignContentInput,
});

export function validateTechnicalDesignCoverage(
  content: TechnicalDesignContent,
  acceptanceCriteria: readonly string[],
) {
  const covered = new Set(content.validation.map((item) => item.criterion));
  if (
    content.validation.some((item) => item.criterion > acceptanceCriteria.length) ||
    acceptanceCriteria.some((_, index) => !covered.has(index + 1))
  )
    throw new Error("Map every acceptance criterion to a concrete validation step.");
}
