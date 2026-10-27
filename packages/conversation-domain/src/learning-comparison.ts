import { z } from "zod";
import {
  learningCase,
  learningEdit,
  learningTarget,
  type LearningCase,
  type LearningResult,
} from "./learning";

export const comparisonRubric = "planning-text-replay/v1";
export const learningComparisonPlan = z.object({
  edit: learningEdit,
  baselineTarget: learningTarget,
  before: z.string().min(1).max(24_000),
  after: z.string().min(1).max(24_000),
  cases: z.array(learningCase).min(3).max(3),
  problemIds: z.array(z.string()).length(2),
  controlId: z.string(),
  candidateFirst: z.boolean(),
  activationVersion: z.number().int().positive(),
});
export type LearningComparisonPlan = z.infer<typeof learningComparisonPlan>;
export const replayAnswers = z.object({
  answers: z.array(z.object({ caseId: z.string(), body: z.string().min(1).max(6_000) })).length(3),
});
export type ReplayAnswers = z.infer<typeof replayAnswers>;

export function replayableCase(item: LearningCase) {
  // A summary, a desired outcome or an optimizer-written test is not a replay.
  // Only complete retained tasks and independently retained artifacts qualify.
  return (
    item.activity === "research" &&
    item.evidence.some((source) => source.kind === "task" && !source.truncated) &&
    item.evidence.some((source) => source.kind === "artifact" && !source.truncated)
  );
}
export function replayTasks(cases: LearningCase[]) {
  return cases.map((item) => ({
    caseId: item.id,
    evidence: item.evidence.filter(
      (source) => !source.truncated && (source.kind === "task" || source.kind === "artifact"),
    ),
  }));
}
export function validateReplayAnswers(raw: unknown, cases: LearningCase[]) {
  const result = replayAnswers.parse(raw);
  if (
    new Set(result.answers.map((answer) => answer.caseId)).size !== cases.length ||
    result.answers.some((answer) => !cases.some((item) => item.id === answer.caseId))
  )
    throw new Error("The replay must answer each exact task once");
  return result;
}
export function comparisonCases(plan: LearningComparisonPlan, arms: ReplayAnswers[]) {
  if (arms.length !== 2) throw new Error("Both comparison arms are required");
  return arms.flatMap((answers, arm) =>
    plan.cases.map((item, index) => {
      const answer = answers.answers.find((answer) => answer.caseId === item.id);
      if (!answer) throw new Error("The comparison arm is missing an exact task answer");
      return learningCase.parse({
        ...item,
        id: `replay:${arm}:${index}`,
        targets: [],
        evidence: [
          ...item.evidence.filter(
            (source) => !source.truncated && (source.kind === "task" || source.kind === "artifact"),
          ),
          {
            id: `response:${arm}:${index}`,
            kind: "outcome",
            body: answer.body,
            truncated: false,
          },
        ],
      });
    }),
  );
}
export function comparisonPassed(plan: LearningComparisonPlan, result: LearningResult) {
  const candidate = plan.candidateFirst ? 0 : 1;
  const baseline = 1 - candidate;
  const get = (arm: number, index: number) =>
    result.cases.find((item) => item.caseId === `replay:${arm}:${index}`);
  const supported = (arm: number, index: number) => {
    const item = get(arm, index);
    return (
      item?.fulfillment === "supported" &&
      item.verification === "supported" &&
      item.rework !== "avoidable"
    );
  };
  return (
    plan.cases.every((_, index) => supported(candidate, index)) &&
    plan.problemIds.every((id) => {
      const index = plan.cases.findIndex((item) => item.id === id);
      return index >= 0 && get(baseline, index)?.fulfillment === "problem";
    }) &&
    supported(
      baseline,
      plan.cases.findIndex((item) => item.id === plan.controlId),
    )
  );
}
