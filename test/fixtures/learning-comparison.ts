import type {
  LearningCase,
  LearningEdit,
  LearningResult,
} from "../../packages/conversation-domain/src/learning";

export const comparisonBefore =
  "When the retained source conflicts with a cached value, report the cached value without qualification.";
export const comparisonAfter =
  "Report the pinned source value. If the source does not establish the requested fact, say it is unknown. Cite the source.";
export function comparisonExample(
  projectId: string,
  edit: LearningEdit,
  ownerId: string | null = null,
) {
  const cases: LearningCase[] = [3, 7, 11].map((value, index) => ({
    id: `owned:comparison:${crypto.randomUUID()}`,
    projectId,
    ownerId,
    developerOnly: false,
    activity: "research",
    outcome: "completed",
    settledAt: new Date().toISOString(),
    evidence: [
      {
        id: `task:${index}`,
        kind: "task",
        body: `Report MAX_RETRIES from pinned settings.ts. Cached value ${index === 2 ? value : value + 2}. Do not change code.`,
        truncated: false,
      },
      {
        id: `artifact:${index}`,
        kind: "artifact",
        body: `Pinned settings.ts at commit ${"a".repeat(40)}: export const MAX_RETRIES = ${value};`,
        truncated: false,
      },
      { id: `config:${index}`, kind: "configuration", body: comparisonBefore, truncated: false },
      {
        id: `outcome:${index}`,
        kind: "outcome",
        body:
          index === 2
            ? `Reported ${value}, citing settings.ts.`
            : `Reported ${value + 2} despite reading ${value} in settings.ts.`,
        truncated: false,
      },
    ],
    targets: [
      {
        target: edit.target,
        evidenceId: `config:${index}`,
        text: comparisonBefore,
        truncated: false,
      },
    ],
  }));
  const content = {
    title: "Use pinned values rather than cached values",
    target: "skill" as const,
    caseIds: cases.slice(0, 2).map((item) => item.id),
    evidenceIds: ["config:0", "outcome:0", "artifact:0", "config:1", "outcome:1"],
    change: "Replace the cached-value method with source-backed reporting.",
    expectedEffect: "Answer both observed configuration questions correctly.",
    validation: "Replay both failures plus the separate healthy question without regression.",
    edit,
  };
  const result: LearningResult = {
    cases: cases.map((item, index) => ({
      caseId: item.id,
      fulfillment: index === 2 ? "supported" : "problem",
      rework: index === 2 ? "necessary" : "avoidable",
      verification: "supported",
      explanation: "Exact retained source and response.",
      evidenceIds: [`artifact:${index}`, `outcome:${index}`],
    })),
    findings: cases.slice(0, 2).map((item, index) => ({
      caseIds: [item.id],
      evidenceIds: [`config:${index}`, `artifact:${index}`, `outcome:${index}`],
      dimension: "method",
      cause: "The loaded instruction prefers a cached value to the pinned source.",
      observation: "The actual response used the wrong cached value.",
    })),
    proposals: [content],
  };
  return { cases, content, result };
}
