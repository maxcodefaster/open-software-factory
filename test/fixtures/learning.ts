import { calibrationCases } from "../../apps/factory/src/learning/calibration";
import type { LearningResult, LearningView } from "../../packages/conversation-domain/src/learning";
export function calibratedResult(): LearningResult {
  return {
    cases: calibrationCases.map((item) => ({
      caseId: item.id,
      fulfillment: item.id.endsWith("defect")
        ? ("problem" as const)
        : item.id.endsWith("missing")
          ? ("unknown" as const)
          : ("supported" as const),
      rework: "unknown",
      verification: "unknown",
      explanation: "Fixed calibration observation.",
      evidenceIds: item.evidence.map((source) => source.id),
    })),
    findings: [],
    proposals: [],
  };
}
export function learningFixture(empty = false): LearningView {
  const projectId = "10000000-0000-4000-8000-000000000001";
  const reviewId = "10000000-0000-4000-8000-000000000002";
  return {
    applications: [],
    comparisons: [],
    automaticSkills: false,
    projectId,
    scope: "project",
    detailScope: "project",
    enabled: true,
    parentEnabled: true,
    canManage: true,
    version: 0,
    days: Array.from({ length: 28 }, (_, index) => {
      const operations = empty ? 0 : index % 7 === 6 ? 2 : 5 + (index % 6);
      const failed = operations ? (index % 5 === 0 ? 2 : 1) : 0;
      const reviewed = empty ? 0 : index < 7 ? 0 : 2 + (index % 3);
      return {
        date: `2026-10-${String(index + 1).padStart(2, "0")}`,
        operations,
        completed: operations - failed,
        failed,
        unknown: 0,
        knownNanoUSD: String(operations * 650_000_000),
        incomplete: !empty && index % 9 === 0,
        elapsedSeconds: operations ? 50 + index * 3 : null,
        observed: operations,
        selected: reviewed,
        reviewed,
        supported: reviewed ? reviewed - 1 : 0,
        problems: reviewed ? 1 : 0,
        avoidable: reviewed && index % 3 === 0 ? 1 : 0,
        reworkKnown: reviewed ? reviewed - 1 : 0,
      };
    }),
    reviews: empty
      ? []
      : [
          {
            id: reviewId,
            kind: "work",
            state: "completed",
            modelId: "configured-project-model",
            rubric: "work-review/v1",
            calibrated: null,
            reason: null,
            createdAt: "2026-10-26T09:00:00Z",
            completedAt: "2026-10-26T09:00:15Z",
            cases: calibrationCases.map((item) => ({ ...item, projectId })),
            result: calibratedResult(),
          },
        ],
    proposals: empty
      ? []
      : [
          {
            id: "10000000-0000-4000-8000-000000000003",
            reviewId,
            state: "proposed",
            ticketId: null,
            private: false,
            comparisonState: "untested",
            content: {
              title: "Stop rebuilding the app for documentation-only changes",
              target: "ci",
              caseIds: ["calibration:defect"],
              evidenceIds: ["defect:check"],
              change:
                "Add an explicit docs-only path check to the Project CI. Keep full checks for runtime instructions, scripts, dependencies and mixed changes.",
              expectedEffect:
                "Avoid repeated application builds when only documentation changed. Savings are not measured yet.",
              validation:
                "Compare docs-only, mixed, runtime-instruction and source changes against the current workflow. Unexpected skipped jobs must still fail the final check.",
            },
          },
        ],
  };
}
