import type { BuildBrowserResult } from "#conversation-domain/browser-tools";
import {
  type candidateReviewCallInput,
  candidateReviewToolCatalogue,
} from "#conversation-domain/candidate-review";
import type { createDatabase } from "#db/client";
import type { createForgejoClient } from "#forge/forge";
import type { createReviewExecutionReader } from "./review-execution";

export const REVIEW_SCENARIO_KIND = "review.scenario";

export type Database = ReturnType<typeof createDatabase>;
export type ReviewForgeClient = ReturnType<typeof createForgejoClient>;
export type ReviewExecutionReader = ReturnType<typeof createReviewExecutionReader>;
export type ReviewCall = ReturnType<typeof candidateReviewCallInput.parse>;
export type ReviewToolName = ReviewCall["name"];

export type ReviewPhase =
  | { kind: "primary" }
  | { kind: "finding-check"; findingSourceID: string; focusReviewID: string | null };

export type PrimaryReviewPhase = Extract<ReviewPhase, { kind: "primary" }>;
export type FindingCheckReviewPhase = Extract<ReviewPhase, { kind: "finding-check" }>;

export type RawReviewScopeRow = {
  id: string;
  changeID: string;
  commitSHA: string;
  baseSHA: string;
  repositoryURL: string;
  criteria: number;
  result: unknown;
  findingSourceID: string | null;
  focusReviewID?: string | null;
  proposal: unknown;
  previousSHA: string | null;
  focusNeedsApp: boolean;
  attemptID: string;
  evidence: Array<Record<string, unknown>>;
};

export type ReviewScope = Omit<RawReviewScopeRow, "findingSourceID" | "focusReviewID"> & {
  phase: ReviewPhase;
};

export type Inventory = Array<{ path: string; sha: string; size: number }>;

export type ReviewScenarioRow = {
  id: string;
  criterion: number;
  category: "normal" | "error" | "boundary";
  status: "passed" | "failed" | "unverified" | null;
  observationKind: "app" | "source" | null;
};

export type ReviewForgeBinding = {
  apiURL: string;
  publicURL: string | undefined;
  owner: string;
};

const PRIMARY_ONLY_TOOLS = new Set<string>([
  "review_report",
  "review_scenario",
  "review_scenario_result",
]);
const FINDING_CHECK_ONLY_TOOLS = new Set<string>(["review_finding_report"]);

export function deriveReviewPhase(
  findingSourceID: string | null | undefined,
  focusReviewID: string | null | undefined = null,
): ReviewPhase {
  return findingSourceID
    ? { kind: "finding-check", findingSourceID, focusReviewID: focusReviewID ?? null }
    : { kind: "primary" };
}

export function isToolAllowedInPhase(phase: ReviewPhase, toolName: string): boolean {
  switch (phase.kind) {
    case "primary":
      return !FINDING_CHECK_ONLY_TOOLS.has(toolName);
    case "finding-check":
      return !PRIMARY_ONLY_TOOLS.has(toolName);
  }
}

export function toolsForReviewPhase(phase: ReviewPhase) {
  return candidateReviewToolCatalogue.filter((tool) => isToolAllowedInPhase(phase, tool.name));
}

export function actualAppObservation(item: Record<string, unknown>) {
  return item["kind"] === "browser" && item["call"] !== "browser_http_observations";
}

export function isCandidateSourceObservation(item: Record<string, unknown>) {
  return item["kind"] === "source" && (item["revision"] === "candidate" || item["diff"] === true);
}

export function hasCaseObservation(
  evidence: ReviewScope["evidence"],
  id: string,
  kind: "app" | "source",
) {
  return evidence.some(
    (item) =>
      item["scenarioId"] === id &&
      (kind === "app" ? actualAppObservation(item) : isCandidateSourceObservation(item)),
  );
}

export function formatReviewTextResult(value: unknown): BuildBrowserResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.from(text);
  let end = 32_000;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    content: [
      {
        type: "text",
        text:
          bytes.length <= 32_000
            ? text
            : `${bytes.subarray(0, end).toString()}\n[Truncated. Read a smaller line range.]`,
      },
    ],
  };
}

// Revision-scoped caches hold source only, never authority or review verdicts.
// In-flight reads coalesce; rejected reads can be retried.
export function createBoundedReviewCache() {
  const cache = new Map<string, { promise: Promise<unknown>; bytes: number }>();
  let cacheBytes = 0;

  function forget(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }

  function forgetOldest() {
    const key = cache.keys().next().value;
    if (key === undefined) return false;
    forget(key);
    return true;
  }

  return async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const old = cache.get(key);
    if (old) return old.promise as Promise<T>;
    if (cache.size >= 256) forgetOldest();
    const entry = { promise: Promise.resolve<unknown>(undefined), bytes: 0 };
    entry.promise = load()
      .then((value) => {
        if (cache.get(key) === entry) {
          entry.bytes = Buffer.byteLength(
            typeof value === "string" ? value : JSON.stringify(value),
          );
          cacheBytes += entry.bytes;
          while (cacheBytes > 8 * 1_048_576) {
            if (!forgetOldest()) break;
          }
        }
        return value;
      })
      .catch((cause) => {
        if (cache.get(key) === entry) forget(key);
        throw cause;
      });
    cache.set(key, entry);
    return entry.promise as Promise<T>;
  };
}

export type ReviewCache = ReturnType<typeof createBoundedReviewCache>;
