import type { TechnicalDesignRevision } from "../change/contracts";

export function isActiveTurnState(state: string | undefined): boolean {
  return state === "pending" || state === "dispatching" || state === "running";
}

export function effectiveOpenReviewThreads(
  liveCount: number | undefined,
  deliveryCount: number | undefined,
): number | undefined {
  return liveCount ?? deliveryCount;
}

export function technicalDesignStale(
  technical: Pick<TechnicalDesignRevision, "requirementRevisionId"> | undefined,
  latestRevisionID: string | undefined,
): boolean {
  return Boolean(technical && technical.requirementRevisionId !== latestRevisionID);
}
