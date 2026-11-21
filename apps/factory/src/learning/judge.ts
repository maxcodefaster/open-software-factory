import type { WorkReviewInput } from "./judge-contract";
import { validateWorkReviewResult } from "./prior-proposals";

export async function reviewWork(input: WorkReviewInput) {
  const { reviewWorkWithModel } = await import("./judge-engine");
  const result = await reviewWorkWithModel(input);
  return validateWorkReviewResult(
    input.comparison ? { ...result, findings: [], proposals: [] } : result,
    input.cases,
  );
}
