import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { and, eq, isNull, sql as query } from "drizzle-orm";
import type {
  BuildBrowserCall,
  BuildBrowserResult,
} from "../../../../packages/conversation-domain/src/browser-tools";
import {
  candidateReviewCallInput,
  candidateReviewResultInput,
  candidateReviewToolCatalogue,
  checkedReviewResult,
  reviewNeedsBrowser,
} from "../../../../packages/conversation-domain/src/candidate-review";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import { candidateReview, reviewScenario } from "../../../../packages/db/src/schema";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import { boundForgeRepositoryFromURL } from "../../../../packages/forge/src/repository";
import { CommandError } from "../command-error";
import { createReviewExecutionReader } from "./review-execution";
import { createAgentTurnStore } from "./turn-store";

type Database = ReturnType<typeof createDatabase>;
type ReviewScope = {
  id: string;
  changeID: string;
  commitSHA: string;
  baseSHA: string;
  repositoryURL: string;
  criteria: number;
  coverageVersion: number;
  result: unknown;
  findingSourceID: string | null;
  proposal: unknown;
  previousSHA: string | null;
  focusNeedsApp: boolean;
  attemptID: string;
  evidence: Array<Record<string, unknown>>;
};
type Inventory = Array<{ path: string; sha: string; size: number }>;

function actualAppObservation(item: Record<string, unknown>) {
  return item["kind"] === "browser" && item["call"] !== "browser_http_observations";
}

function hasCaseObservation(evidence: ReviewScope["evidence"], id: string, kind: "app" | "source") {
  return evidence.some(
    (item) =>
      item["scenarioId"] === id &&
      (kind === "app"
        ? actualAppObservation(item)
        : item["kind"] === "source" && (item["revision"] === "candidate" || item["diff"] === true)),
  );
}

export function createCandidateReviewController(
  database: Database,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
  execution = createReviewExecutionReader(database),
) {
  const turns = createAgentTurnStore(database);
  const binding = {
    apiURL: process.env["FACTORY_FORGEJO_API_URL"] ?? "",
    publicURL: process.env["FACTORY_FORGEJO_PUBLIC_URL"],
    owner: process.env["FACTORY_FORGEJO_OWNER"] ?? "",
  };
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: binding.apiURL,
      token: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
    });
  // Revision-scoped caches hold source only, never authority or review verdicts.
  // In-flight reads coalesce; rejected reads can be retried.
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
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
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
  }
  // Exact immutable source only. No checkout file service, shell, test execution,
  // writes, ambient credentials or Project-chosen MCP tools are exposed here.
  async function scopeIn(sql: DatabaseTransaction, turnID: string) {
    const [scope] = await sql<ReviewScope[]>`
      SELECT review.id,review.change_id AS "changeID",review.commit_sha AS "commitSHA",
        review.base_sha AS "baseSHA",project.repository_url AS "repositoryURL",review.result,review.evidence,
        review.coverage_version AS "coverageVersion",review.finding_source_id AS "findingSourceID",
        attempt.id AS "attemptID",
        source.result AS proposal,focus.commit_sha AS "previousSHA",
        (COALESCE(focus.result->>'ui'='unverified',false) OR EXISTS(
          SELECT 1 FROM factory.review_scenario scenario
          WHERE scenario.review_id=COALESCE(focus.finding_source_id,focus.id)
            AND scenario.observation_kind='app' AND scenario.status IN ('failed','unverified')
        )) AS "focusNeedsApp",
        jsonb_array_length(revision.canonical_content::jsonb->'acceptanceCriteria') AS criteria
      FROM factory.candidate_review review
      JOIN factory.change change ON change.id=review.change_id
      LEFT JOIN factory.candidate_review source ON source.id=review.finding_source_id
      LEFT JOIN factory.candidate_review focus ON focus.id=review.focus_review_id AND focus.change_id=change.id
      JOIN factory.project project ON project.id=change.project_id
      JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
      JOIN factory.requirement_revision revision ON revision.id=approval.requirement_revision_id
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id=review.turn_id
      JOIN factory.change_agent_session session ON session.active_turn_id=review.turn_id AND session.change_id=change.id
      JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
      WHERE review.turn_id=${turnID} AND review.state IN ('pending','running')
        AND session.runtime_attempt_id=attempt.id AND change.runtime_attempt_id=attempt.id
        AND session.opencode_session_id=intent.session_id AND attempt.state='ready'
        AND NOT session.stop_pending AND session.state IN ('starting','working')
      FOR UPDATE OF review`;
    if (!scope) throw new CommandError("conflict", "Independent review authority changed");
    return scope;
  }
  async function authorized<T>(
    turnID: string,
    ownerToken: string,
    use: (sql: DatabaseTransaction, scope: ReviewScope) => Promise<T>,
  ) {
    let result: T | undefined;
    const allowed = await turns.validateExecution(turnID, ownerToken, async (sql) => {
      result = await use(sql, await scopeIn(sql, turnID));
    });
    if (!allowed)
      throw new CommandError("conflict", "Independent review no longer owns this candidate");
    return result as T;
  }
  function repository(scope: ReviewScope) {
    return boundForgeRepositoryFromURL(
      scope.repositoryURL,
      binding,
      () => new Error("Review repository is not the configured Project forge"),
    );
  }
  async function inventories(scope: ReviewScope) {
    const repo = repository(scope);
    const [base, candidate] = await Promise.all([
      cached(`inventory:${scope.repositoryURL}:${scope.baseSHA}`, () =>
        forge.listFiles(repo, scope.baseSHA),
      ),
      cached(`inventory:${scope.repositoryURL}:${scope.commitSHA}`, () =>
        forge.listFiles(repo, scope.commitSHA),
      ),
    ]);
    return { base, candidate };
  }
  async function source(scope: ReviewScope, files: Inventory, path: string, ref: string) {
    const file = files.find((file) => file.path === path);
    if (!file) throw new CommandError("not-found", "File is absent from this exact revision");
    if (file.size > 1_048_576)
      throw new CommandError("conflict", "Review file exceeds the 1 MiB text limit");
    const content = await cached(`file:${scope.repositoryURL}:${ref}:${path}`, () =>
      forge.getFile(repository(scope), path, ref),
    );
    if (Buffer.byteLength(content) > 1_048_576 || content.includes("\0"))
      throw new CommandError("conflict", "Review requires a bounded text file");
    return content;
  }
  async function record(turnID: string, ownerToken: string, observation: Record<string, unknown>) {
    await authorized(turnID, ownerToken, async (sql, scope) => {
      if (scope.result) throw new CommandError("conflict", "Review report is already recorded");
      if (scope.evidence.some((item) => item["id"] === observation["id"])) return;
      if (scope.evidence.length >= 256)
        throw new CommandError("conflict", "Review evidence limit reached");
      const db = drizzleTransaction(sql);
      const [scenario] = await db
        .select({ id: reviewScenario.id })
        .from(reviewScenario)
        .where(and(eq(reviewScenario.reviewId, scope.id), isNull(reviewScenario.endedAt)));
      const attributed = { ...observation, ...(scenario ? { scenarioId: scenario.id } : {}) };
      await db
        .update(candidateReview)
        .set({
          evidence: query`${candidateReview.evidence} || ${JSON.stringify([attributed])}::jsonb`,
        })
        .where(eq(candidateReview.id, scope.id));
    });
  }
  function textResult(value: unknown): BuildBrowserResult {
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
  return {
    async tools(turnID: string) {
      const turn = await turns.get(turnID);
      if (turn?.command.kind !== "change-review") return [];
      const [review] = await database.db
        .select({
          checking: query<boolean>`${candidateReview.findingSourceId} IS NOT NULL`,
        })
        .from(candidateReview)
        .where(eq(candidateReview.turnId, turnID));
      return candidateReviewToolCatalogue.filter((tool) =>
        review?.checking
          ? !["review_report", "review_scenario", "review_scenario_result"].includes(tool.name)
          : tool.name !== "review_finding_report",
      );
    },
    async observeBrowser(
      turnID: string,
      ownerToken: string,
      call: BuildBrowserCall,
      requestID: string | number,
      result: BuildBrowserResult,
    ) {
      const turn = await turns.get(turnID);
      if (turn?.authority.mode !== "build" || !turn.authority.review || result.isError) return;
      const context = result.structuredContent;
      if (
        !context ||
        context.headCommit !== turn.authority.review.commitSha ||
        context.workingTreeModified
      )
        throw new CommandError(
          "conflict",
          "App observation does not match the clean reviewed commit. This review remains unverified.",
        );
      const image = result.content.find((part) => part.type === "image");
      await record(turnID, ownerToken, {
        id: `browser:${typeof requestID}:${requestID}`,
        kind: "browser",
        call: call.name,
        context,
        ...(image?.type === "image"
          ? {
              screenshotSHA256: createHash("sha256")
                .update(Buffer.from(image.data, "base64"))
                .digest("hex"),
            }
          : {}),
      });
      const reference = `\nReview evidence ID: browser:${typeof requestID}:${requestID}`;
      const text = result.content.find((part) => part.type === "text");
      if (text?.type === "text")
        text.text = text.text.slice(0, 32_768 - reference.length) + reference;
      else if (result.content.length < 16) result.content.push({ type: "text", text: reference });
    },
    async call(
      turnID: string,
      ownerToken: string,
      raw: unknown,
      requestID: string | number,
    ): Promise<BuildBrowserResult> {
      const call = candidateReviewCallInput.parse(raw);
      const scope = await authorized(turnID, ownerToken, async (_sql, scope) => scope);
      if (scope.result && !["review_report", "review_finding_report"].includes(call.name))
        throw new CommandError("conflict", "Review report is already recorded");
      if (call.name === "review_execution") {
        const result = await execution(scope, call.arguments);
        const id = `execution:${typeof requestID}:${requestID}`;
        await record(turnID, ownerToken, {
          id,
          kind: "execution",
          commit: scope.commitSHA,
          section: call.arguments.section,
          responseSHA256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
        });
        return textResult(`${JSON.stringify(result)}\nReview evidence ID: ${id}`);
      }
      if (
        (scope.findingSourceID &&
          ["review_report", "review_scenario", "review_scenario_result"].includes(call.name)) ||
        (!scope.findingSourceID && call.name === "review_finding_report")
      )
        throw new CommandError("conflict", "This tool does not belong to this review phase");
      if (call.name === "review_finding_report") {
        return authorized(turnID, ownerToken, async (sql, current) => {
          const db = drizzleTransaction(sql);
          const check = call.arguments;
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
            return textResult("Finding check already recorded. Finish normally.");
          }
          const proposal = candidateReviewResultInput.parse(current.proposal);
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
                  (observation["kind"] === "execution" &&
                    observation["commit"] === current.commitSHA) ||
                  (observation["kind"] === "source" &&
                    (observation["revision"] === "candidate" || observation["diff"] === true))
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
          let result = checkedReviewResult(proposal, check);
          if (result.verdict === "passed") {
            const [original] = await db
              .select({
                evidence: query<ReviewScope["evidence"]>`${candidateReview.evidence}`,
                uiRequired: candidateReview.uiRequired,
              })
              .from(candidateReview)
              .where(eq(candidateReview.id, query`${current.findingSourceID}::uuid`));
            const cases = await db
              .select({
                id: reviewScenario.id,
                criterion: reviewScenario.criterion,
                category: reviewScenario.category,
                status: reviewScenario.status,
                observationKind: query<
                  "app" | "source"
                >`COALESCE(${reviewScenario.observationKind},'app')`,
              })
              .from(reviewScenario)
              .where(eq(reviewScenario.reviewId, query`${current.findingSourceID}::uuid`));
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
            const accepted = cases.filter(
              (item) =>
                hasCaseObservation(original?.evidence ?? [], item.id, item.observationKind) &&
                (item.status === "passed" || rechecked(item.criterion, item.observationKind)),
            );
            if (
              result.criteria.some(
                (criterion) => !accepted.some((item) => item.criterion === criterion.criterion),
              ) ||
              cases.some((item) => !accepted.includes(item)) ||
              !accepted.some((item) => item.category === "normal") ||
              !accepted.some((item) => ["error", "boundary"].includes(item.category)) ||
              (original?.uiRequired &&
                (!accepted.some(
                  (item) => item.observationKind === "app" && item.category === "normal",
                ) ||
                  !accepted.some(
                    (item) =>
                      item.observationKind === "app" &&
                      ["error", "boundary"].includes(item.category),
                  )))
            )
              result = {
                ...result,
                verdict: "incomplete",
                summary: `${check.summary}\nRequired candidate coverage remains incomplete.`.slice(
                  0,
                  2_000,
                ),
              };
          }
          await db
            .update(candidateReview)
            .set({
              findingChecks: check,
              result,
              uiRequired: query`(${db
                .select({ uiRequired: candidateReview.uiRequired })
                .from(candidateReview)
                .where(eq(candidateReview.id, query`${current.findingSourceID}::uuid`))})`,
            })
            .where(and(eq(candidateReview.id, current.id), isNull(candidateReview.result)));
          return textResult(
            "Finding check recorded. Finish normally; only confirmed blockers can request correction.",
          );
        });
      }
      if (call.name === "review_scenario" || call.name === "review_scenario_result") {
        return authorized(turnID, ownerToken, async (sql, current) => {
          const db = drizzleTransaction(sql);
          if (current.result)
            throw new CommandError("conflict", "Review report is already recorded");
          if (call.name === "review_scenario") {
            const args = call.arguments;
            const [active] = await db
              .select({ id: reviewScenario.id })
              .from(reviewScenario)
              .where(and(eq(reviewScenario.reviewId, scope.id), isNull(reviewScenario.endedAt)));
            const [count] = await db
              .select({ count: query<number>`count(*)::int` })
              .from(reviewScenario)
              .where(eq(reviewScenario.reviewId, scope.id));
            if (active || (count?.count ?? 0) >= 64 || args.criterion > current.criteria)
              throw new CommandError(
                "conflict",
                "Finish the current case; use an approved criterion and at most 64 cases",
              );
            await db.insert(reviewScenario).values({
              reviewId: scope.id,
              id: args.id,
              title: args.title,
              category: args.category,
              observationKind: args.observationKind,
              criterion: args.criterion,
              expected: args.expected,
            });
          } else {
            const args = call.arguments;
            const [scenario] = await db
              .select({
                observationKind: query<"app" | "source" | null>`${reviewScenario.observationKind}`,
              })
              .from(reviewScenario)
              .where(
                and(
                  eq(reviewScenario.reviewId, scope.id),
                  eq(reviewScenario.id, args.id),
                  isNull(reviewScenario.endedAt),
                ),
              )
              .for("update");
            if (!scenario) throw new CommandError("conflict", "Case is not currently active");
            const kind = scenario.observationKind ?? "app";
            if (
              args.status !== "unverified" &&
              !hasCaseObservation(current.evidence, args.id, kind)
            )
              throw new CommandError(
                "conflict",
                kind === "app"
                  ? `App case ${args.id} needs its own actual App observation before its result. Keep this case active and inspect the App; do not replay an unconfirmed mutation.`
                  : `Source case ${args.id} needs its own immutable candidate source read or diff before its result.`,
              );
            const positions = current.evidence.flatMap((item) => {
              const context = item["context"];
              if (
                kind !== "app" ||
                item["scenarioId"] !== args.id ||
                !actualAppObservation(item) ||
                !context ||
                typeof context !== "object"
              )
                return [];
              const value = context as Record<string, unknown>;
              return typeof value["recordingTimeMs"] === "number" &&
                Number.isSafeInteger(value["recordingTimeMs"]) &&
                value["recordingTimeMs"] >= 0 &&
                typeof value["sessionId"] === "string"
                ? [{ time: value["recordingTimeMs"], session: value["sessionId"] }]
                : [];
            });
            const mediaSession = positions.at(-1)?.session;
            const times = positions
              .filter((item) => item.session === mediaSession)
              .map((item) => item.time);
            const updated = await db
              .update(reviewScenario)
              .set({
                endedAt: query`clock_timestamp()`,
                status: args.status,
                observed: args.observed,
                mediaStartedMs: times.length ? Math.min(...times) : null,
                mediaSessionId: mediaSession ?? null,
              })
              .where(
                and(
                  eq(reviewScenario.reviewId, scope.id),
                  eq(reviewScenario.id, args.id),
                  isNull(reviewScenario.endedAt),
                ),
              )
              .returning({ id: reviewScenario.id });
            if (!updated.length) throw new CommandError("conflict", "Case is not currently active");
          }
          return textResult(
            "Case recorded. Continue with the actual observations; do not replay App actions.",
          );
        });
      }
      const inventory = await inventories(scope);
      async function revisionFiles(revision: string) {
        if (revision === "candidate" || revision === "base")
          return {
            files: inventory[revision],
            sha: revision === "base" ? scope.baseSHA : scope.commitSHA,
          };
        const sha = revision === "previous" ? scope.previousSHA : revision;
        if (!sha) throw new CommandError("conflict", "This review has no previous candidate");
        return {
          sha,
          files: await cached(`inventory:${scope.repositoryURL}:${sha}`, () =>
            forge.listFiles(repository(scope), sha),
          ),
        };
      }
      if (call.name === "review_report") {
        const result = call.arguments;
        if (
          result.criteria.length !== scope.criteria ||
          result.criteria.some((item) => item.criterion > scope.criteria)
        )
          throw new CommandError(
            "conflict",
            "Review must cover every approved acceptance criterion exactly once",
          );
        const before = scope.previousSHA ? (await revisionFiles("previous")).files : inventory.base;
        const oldFiles = new Map(before.map((file) => [file.path, file.sha]));
        const newFiles = new Map(inventory.candidate.map((file) => [file.path, file.sha]));
        const uiRequired =
          scope.focusNeedsApp ||
          reviewNeedsBrowser(
            [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(
              (path) => oldFiles.get(path) !== newFiles.get(path),
            ),
          );
        await authorized(turnID, ownerToken, async (sql, current) => {
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
            if (
              !current.evidence.some(
                (item) =>
                  item["kind"] === "source" &&
                  (item["diff"] === true || item["revision"] === "candidate"),
              )
            )
              throw new CommandError("conflict", "Review needs observed source evidence");
            if (result.verdict === "passed" && uiRequired && result.ui !== "checked")
              throw new CommandError("conflict", "User-facing changes need actual App review");
            if (
              result.ui === "checked" &&
              !current.evidence.some((item) => item["screenshotSHA256"])
            )
              throw new CommandError("conflict", "App review needs an exact-candidate screenshot");
            if (current.coverageVersion >= 1 && result.verdict === "passed") {
              const cases = await db
                .select({
                  id: reviewScenario.id,
                  criterion: reviewScenario.criterion,
                  category: reviewScenario.category,
                  status: reviewScenario.status,
                  observationKind: query<
                    "app" | "source" | null
                  >`${reviewScenario.observationKind}`,
                })
                .from(reviewScenario)
                .where(eq(reviewScenario.reviewId, scope.id));
              if (
                cases.some((item) => item.status !== "passed") ||
                result.criteria.some(
                  (criterion) => !cases.some((item) => item.criterion === criterion.criterion),
                ) ||
                !cases.some((item) => item.category === "normal") ||
                !cases.some((item) => item.category === "error" || item.category === "boundary")
              )
                throw new CommandError(
                  "conflict",
                  "Passing review needs observed normal coverage, every approved criterion and a relevant adverse case",
                );
              const unobserved = cases.filter(
                (item) =>
                  !hasCaseObservation(
                    current.evidence,
                    item.id,
                    item.observationKind ?? (uiRequired ? "app" : "source"),
                  ),
              );
              if (unobserved.length)
                throw new CommandError(
                  "conflict",
                  `Review cases need their own declared observations: ${unobserved.map((item) => item.id).join(", ")}`,
                );
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
              )
                throw new CommandError(
                  "conflict",
                  "User-facing changes need actual normal and adverse App cases; source checks cannot replace them",
                );
            }
          }
          await db
            .update(candidateReview)
            .set({ result, uiRequired })
            .where(and(eq(candidateReview.id, current.id), isNull(candidateReview.result)));
        });
        return textResult(
          "Review report recorded. End with a brief ordinary summary. Factory still requires native settlement, exact checks and human Delivery approval.",
        );
      }
      let output: unknown;
      let observation: Record<string, unknown>;
      if (call.name === "review_files") {
        const comparison = await revisionFiles(call.arguments.comparison);
        const before = new Map(comparison.files.map((file) => [file.path, file]));
        const after = new Map(inventory.candidate.map((file) => [file.path, file]));
        const files = [...new Set([...before.keys(), ...after.keys()])]
          .sort()
          .map((path) => ({
            path,
            base: before.get(path) ?? null,
            candidate: after.get(path) ?? null,
            changed: before.get(path)?.sha !== after.get(path)?.sha,
          }))
          .filter((file) => !call.arguments.changedOnly || file.changed);
        const page: typeof files = [];
        let bytes = 256;
        for (const file of files.slice(call.arguments.offset, call.arguments.offset + 200)) {
          const size = Buffer.byteLength(JSON.stringify(file)) + 1;
          if (bytes + size > 30_000) {
            if (!page.length)
              throw new CommandError("conflict", "Review inventory contains an oversized path");
            break;
          }
          page.push(file);
          bytes += size;
        }
        output = {
          commit: scope.commitSHA,
          base: comparison.sha,
          files: page,
          nextOffset:
            call.arguments.offset + page.length < files.length
              ? call.arguments.offset + page.length
              : null,
        };
        observation = {
          kind: "inventory",
          changedOnly: call.arguments.changedOnly,
          offset: call.arguments.offset,
        };
      } else if (call.name === "review_search") {
        const { query, revision, pathPrefix, offset, startLine } = call.arguments;
        const selected = await revisionFiles(revision);
        const files = selected.files
          .filter((file) => file.path.startsWith(pathPrefix))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const matches: Array<{ path: string; line: number; text: string }> = [];
        const skipped: string[] = [];
        let nextOffset: number | null = null;
        let nextLine = 1;
        let bytes = 0;
        let readBytes = 0;
        let index = offset;
        function skip(path: string) {
          const size = Buffer.byteLength(JSON.stringify(path));
          if (bytes + size > 24_000) {
            if (!bytes) throw new CommandError("conflict", "Search contains an oversized path");
            return false;
          }
          skipped.push(path);
          bytes += size;
          return true;
        }
        outer: for (; index < Math.min(files.length, offset + 200); index++) {
          const file = files[index];
          if (!file) break;
          if (file.size > 1_048_576) {
            if (!skip(file.path)) break;
            continue;
          }
          if (readBytes + file.size > 1_048_576 && index > offset) break;
          const content = await cached(
            `file:${scope.repositoryURL}:${selected.sha}:${file.path}`,
            () => forge.getFile(repository(scope), file.path, selected.sha),
          );
          readBytes += Buffer.byteLength(content);
          if (content.includes("\0") || Buffer.byteLength(content) > 1_048_576) {
            if (!skip(file.path)) break;
            continue;
          }
          const lines = content.split("\n");
          for (let line = index === offset ? startLine - 1 : 0; line < lines.length; line++) {
            const text = lines[line];
            if (text === undefined) continue;
            const position = text.indexOf(query);
            if (position < 0) continue;
            const start = Math.max(0, position - 200);
            const match = {
              path: file.path,
              line: line + 1,
              text: text.slice(start, start + 1_000),
            };
            const size = Buffer.byteLength(JSON.stringify(match));
            if (bytes + size > 24_000) {
              if (!bytes) throw new CommandError("conflict", "Search contains an oversized path");
              nextOffset = index;
              nextLine = line + 1;
              break outer;
            }
            matches.push(match);
            bytes += size;
          }
        }
        if (nextOffset === null && index < files.length) nextOffset = index;
        output = { revision, commit: selected.sha, matches, skipped, nextOffset, nextLine };
        observation = {
          kind: matches.length ? "source" : "search",
          revision: selected.sha === scope.commitSHA ? "candidate" : revision,
          sourceCommit: selected.sha,
          search: query,
          pathPrefix,
          offset,
          startLine,
          paths: matches.map((match) => match.path),
        };
      } else if (call.name === "review_read") {
        const { path, revision, startLine, lines } = call.arguments;
        const selected = await revisionFiles(revision);
        const content = await source(scope, selected.files, path, selected.sha);
        const all = content.split("\n");
        output = {
          path,
          revision,
          commit: selected.sha,
          totalLines: all.length,
          text: all
            .slice(startLine - 1, startLine - 1 + lines)
            .map((line, index) => `${startLine + index}: ${line}`)
            .join("\n"),
        };
        observation = {
          kind: "source",
          path,
          revision: selected.sha === scope.commitSHA ? "candidate" : revision,
          sourceCommit: selected.sha,
          startLine,
          lines,
        };
      } else {
        const { path, comparison } = call.arguments;
        const beforeRevision = await revisionFiles(comparison);
        const beforeFile = beforeRevision.files.find((file) => file.path === path);
        const candidateFile = inventory.candidate.find((file) => file.path === path);
        if (!beforeFile && !candidateFile)
          throw new CommandError("not-found", "File is absent from the review");
        const before = beforeFile
          ? await source(scope, beforeRevision.files, path, beforeRevision.sha)
          : "";
        const after = candidateFile
          ? await source(scope, inventory.candidate, path, scope.commitSHA)
          : "";
        output = createTwoFilesPatch(
          `base/${path}`,
          `candidate/${path}`,
          before,
          after,
          beforeRevision.sha,
          scope.commitSHA,
          { context: 4 },
        );
        observation = { kind: "source", path, diff: true, comparison };
      }
      await record(turnID, ownerToken, {
        ...observation,
        id: `source:${typeof requestID}:${requestID}`,
        commit: scope.commitSHA,
      });
      return textResult({
        evidenceId: `source:${typeof requestID}:${requestID}`,
        ...(typeof output === "object" && output ? output : { text: output }),
      });
    },
  };
}
