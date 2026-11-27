import { and, eq, isNull, sql as query } from "drizzle-orm";
import {
  type CandidateReviewResult,
  candidateReviewResultInput,
  checkedReviewResult,
  type FindingCheckResult,
  reviewNeedsBrowser,
} from "#conversation-domain/candidate-review";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { candidateReview } from "#db/schema";
import { CommandError } from "../command-error";
import { readReviewScenariosIn } from "./candidate-review-scenarios";
import {
  actualAppObservation,
  type FindingCheckReviewPhase,
  hasCaseObservation,
  type Inventory,
  isCandidateSourceObservation,
  type ReviewScope,
} from "./candidate-review-types";

function validateFindingCheckEvidence(current: ReviewScope, check: FindingCheckResult) {
  for (const item of [...check.checks, ...check.criteria]) {
    if (item.status === "unresolved" || item.status === "unverified") continue;
    const observations = item.evidenceIds.map((id) =>
      current.evidence.find((observation) => observation["id"] === id),
    );
    const invalid = observations.findIndex(
      (observation) =>
        !observation ||
        !(
          observation["kind"] === "browser" ||
          (observation["kind"] === "execution" && observation["commit"] === current.commitSHA) ||
          isCandidateSourceObservation(observation)
        ),
    );
    if (!observations.length || invalid !== -1) {
      const observation = observations[invalid];
      const reason = !observation
        ? "was not recorded in this review"
        : observation["kind"] === "inventory"
          ? "is inventory from review_files"
          : "is not current-candidate evidence";
      const detail = observations.length
        ? `${JSON.stringify(item.evidenceIds[invalid])} ${reason}.`
        : "No evidence IDs were supplied.";
      throw new CommandError(
        "conflict",
        `Finding decisions need your own exact-candidate observations. ${detail} Cite your own candidate review_read, review_search or review_diff, permitted App observations, or exact-candidate review_execution evidence. Remove or replace ineligible references; already observed App actions need not be repeated.`,
      );
    }
  }
}

export async function settleFindingCheckIn(
  sql: DatabaseTransaction,
  current: ReviewScope,
  phase: FindingCheckReviewPhase,
  check: FindingCheckResult,
): Promise<string> {
  const db = drizzleTransaction(sql);
  if (current.result) {
    const [same] = await db
      .select({ id: candidateReview.id })
      .from(candidateReview)
      .where(
        and(
          eq(candidateReview.id, current.id),
          query`${candidateReview.findingChecks}=${JSON.stringify(check)}::jsonb`,
        ),
      );
    if (!same) throw new CommandError("conflict", "The immutable finding check changed");
    return "Finding check already recorded. Finish normally.";
  }
  const proposal = candidateReviewResultInput.parse(current.proposal);
  validateFindingCheckEvidence(current, check);
  let result = checkedReviewResult(proposal, check);
  if (result.verdict === "passed") {
    const [original] = await db
      .select({
        evidence: query<ReviewScope["evidence"]>`${candidateReview.evidence}`,
        uiRequired: candidateReview.uiRequired,
      })
      .from(candidateReview)
      .where(eq(candidateReview.id, phase.findingSourceID));
    const cases = await readReviewScenariosIn(db, phase.findingSourceID);
    const rechecked = (criterion: number, kind: "app" | "source") =>
      check.criteria.some(
        (item) =>
          item.criterion === criterion &&
          item.status === "passed" &&
          item.evidenceIds.some((id) =>
            current.evidence.some(
              (observation) =>
                observation["id"] === id &&
                (kind === "app"
                  ? actualAppObservation(observation)
                  : observation["kind"] === "source" || observation["kind"] === "browser"),
            ),
          ),
      );
    const accepted = cases.filter((item) => {
      const kind = item.observationKind ?? "app";
      return (
        hasCaseObservation(original?.evidence ?? [], item.id, kind) &&
        (item.status === "passed" || rechecked(item.criterion, kind))
      );
    });
    if (
      result.criteria.some(
        (criterion) => !accepted.some((item) => item.criterion === criterion.criterion),
      ) ||
      cases.some((item) => !accepted.includes(item)) ||
      !accepted.some((item) => item.category === "normal") ||
      !accepted.some((item) => ["error", "boundary"].includes(item.category)) ||
      (original?.uiRequired &&
        (!accepted.some(
          (item) => (item.observationKind ?? "app") === "app" && item.category === "normal",
        ) ||
          !accepted.some(
            (item) =>
              (item.observationKind ?? "app") === "app" &&
              ["error", "boundary"].includes(item.category),
          )))
    ) {
      result = {
        ...result,
        verdict: "incomplete",
        summary: `${check.summary}\nRequired candidate coverage remains incomplete.`.slice(
          0,
          2_000,
        ),
      };
    }
  }
  await db
    .update(candidateReview)
    .set({
      findingChecks: check,
      result,
      uiRequired: query`(${db
        .select({ uiRequired: candidateReview.uiRequired })
        .from(candidateReview)
        .where(eq(candidateReview.id, phase.findingSourceID))})`,
    })
    .where(and(eq(candidateReview.id, current.id), isNull(candidateReview.result)));
  return "Finding check recorded. Finish normally; only confirmed blockers can request correction.";
}

export function computeReviewUiRequired(
  scope: ReviewScope,
  before: Inventory,
  candidate: Inventory,
): boolean {
  const oldFiles = new Map(before.map((file) => [file.path, file.sha]));
  const newFiles = new Map(candidate.map((file) => [file.path, file.sha]));
  return (
    scope.focusNeedsApp ||
    reviewNeedsBrowser(
      [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(
        (path) => oldFiles.get(path) !== newFiles.get(path),
      ),
    )
  );
}

export async function settlePrimaryReviewIn(
  sql: DatabaseTransaction,
  current: ReviewScope,
  result: CandidateReviewResult,
  uiRequired: boolean,
) {
  const db = drizzleTransaction(sql);
  if (current.result) {
    if (JSON.stringify(current.result) !== JSON.stringify(result)) {
      // PostgreSQL jsonb changes key order, so compare in SQL instead.
      const [same] = await db
        .select({ id: candidateReview.id })
        .from(candidateReview)
        .where(
          and(
            eq(candidateReview.id, current.id),
            query`${candidateReview.result}=${JSON.stringify(result)}::jsonb`,
          ),
        );
      if (!same) throw new CommandError("conflict", "The immutable review report changed");
    }
    return;
  }
  if (result.verdict !== "incomplete") {
    if (!current.evidence.some(isCandidateSourceObservation)) {
      throw new CommandError("conflict", "Review needs observed source evidence");
    }
    if (result.verdict === "passed" && uiRequired && result.ui !== "checked") {
      throw new CommandError("conflict", "User-facing changes need actual App review");
    }
    if (result.ui === "checked" && !current.evidence.some((item) => item["screenshotSHA256"])) {
      throw new CommandError("conflict", "App review needs an exact-candidate screenshot");
    }
    if (result.verdict === "passed") {
      const cases = await readReviewScenariosIn(db, current.id);
      if (
        cases.some((item) => item.status !== "passed") ||
        result.criteria.some(
          (criterion) => !cases.some((item) => item.criterion === criterion.criterion),
        ) ||
        !cases.some((item) => item.category === "normal") ||
        !cases.some((item) => item.category === "error" || item.category === "boundary")
      ) {
        throw new CommandError(
          "conflict",
          "Passing review needs observed normal coverage, every approved criterion and a relevant adverse case",
        );
      }
      const unobserved = cases.filter(
        (item) =>
          !hasCaseObservation(
            current.evidence,
            item.id,
            item.observationKind ?? (uiRequired ? "app" : "source"),
          ),
      );
      if (unobserved.length) {
        throw new CommandError(
          "conflict",
          `Review cases need their own declared observations: ${unobserved.map((item) => item.id).join(", ")}`,
        );
      }
      if (
        uiRequired &&
        (!cases.some(
          (item) =>
            (item.observationKind ?? "app") === "app" &&
            item.category === "normal" &&
            hasCaseObservation(current.evidence, item.id, "app"),
        ) ||
          !cases.some(
            (item) =>
              (item.observationKind ?? "app") === "app" &&
              ["error", "boundary"].includes(item.category) &&
              hasCaseObservation(current.evidence, item.id, "app"),
          ))
      ) {
        throw new CommandError(
          "conflict",
          "User-facing changes need actual normal and adverse App cases; source checks cannot replace them",
        );
      }
    }
  }
  await db
    .update(candidateReview)
    .set({ result, uiRequired })
    .where(and(eq(candidateReview.id, current.id), isNull(candidateReview.result)));
}
