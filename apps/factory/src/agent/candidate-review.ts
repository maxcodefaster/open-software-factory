import { createHash } from "node:crypto";
import { eq, sql as query } from "drizzle-orm";
import type { BuildBrowserCall, BuildBrowserResult } from "#conversation-domain/browser-tools";
import { candidateReviewCallInput } from "#conversation-domain/candidate-review";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { candidateReview } from "#db/schema";
import { createForgejoClient } from "#forge/forge";
import { CommandError } from "../command-error";
import {
  completeReviewScenarioIn,
  readActiveReviewScenarioIn,
  startReviewScenarioIn,
} from "./candidate-review-scenarios";
import {
  computeReviewUiRequired,
  settleFindingCheckIn,
  settlePrimaryReviewIn,
} from "./candidate-review-settlement";
import { createReviewSourceReader, executeReviewSourceTool } from "./candidate-review-tools";
import {
  createBoundedReviewCache,
  type Database,
  deriveReviewPhase,
  formatReviewTextResult,
  isToolAllowedInPhase,
  type RawReviewScopeRow,
  type ReviewForgeClient,
  type ReviewScope,
  toolsForReviewPhase,
} from "./candidate-review-types";
import { createReviewExecutionReader } from "./review-execution";
import { createAgentTurnStore } from "./turn-store";

export function createCandidateReviewController(
  database: Database,
  forgeOverride?: ReviewForgeClient,
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
  const sourceReader = createReviewSourceReader(forge, binding, createBoundedReviewCache());

  // Exact immutable source only. No checkout file service, shell, test execution,
  // writes, ambient credentials or Project-chosen MCP tools are exposed here.
  async function scopeIn(sql: DatabaseTransaction, turnID: string): Promise<ReviewScope> {
    const [row] = await sql<RawReviewScopeRow[]>`
      SELECT review.id,review.change_id AS "changeID",review.commit_sha AS "commitSHA",
        review.base_sha AS "baseSHA",project.repository_url AS "repositoryURL",review.result,review.evidence,
        review.finding_source_id AS "findingSourceID",
        review.focus_review_id AS "focusReviewID",attempt.id AS "attemptID",
        source.result AS proposal,focus.commit_sha AS "previousSHA",
        (COALESCE(focus.result->>'ui'='unverified',false) OR EXISTS(
          SELECT 1 FROM factory.operation scenario
          WHERE scenario.kind='review.scenario'
            AND scenario.scope_type='candidate_review'
            AND scenario.scope_id=COALESCE(focus.finding_source_id,focus.id)::text
            AND scenario.payload->>'observationKind'='app'
            AND scenario.payload->>'status' IN ('failed','unverified')
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
    if (!row) throw new CommandError("conflict", "Independent review authority changed");
    const { findingSourceID, focusReviewID, ...rest } = row;
    return {
      ...rest,
      phase: deriveReviewPhase(findingSourceID, focusReviewID),
    };
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
    if (!allowed) {
      throw new CommandError("conflict", "Independent review no longer owns this candidate");
    }
    return result as T;
  }

  async function record(turnID: string, ownerToken: string, observation: Record<string, unknown>) {
    await authorized(turnID, ownerToken, async (sql, scope) => {
      if (scope.result) throw new CommandError("conflict", "Review report is already recorded");
      if (scope.evidence.some((item) => item["id"] === observation["id"])) return;
      if (scope.evidence.length >= 256) {
        throw new CommandError("conflict", "Review evidence limit reached");
      }
      const db = drizzleTransaction(sql);
      const scenario = await readActiveReviewScenarioIn(db, scope.id);
      const attributed = { ...observation, ...(scenario ? { scenarioId: scenario.id } : {}) };
      await db
        .update(candidateReview)
        .set({
          evidence: query`${candidateReview.evidence} || ${JSON.stringify([attributed])}::jsonb`,
        })
        .where(eq(candidateReview.id, scope.id));
    });
  }

  return {
    async tools(turnID: string) {
      const turn = await turns.get(turnID);
      if (turn?.command.kind !== "change-review") return [];
      const [review] = await database.db
        .select({
          findingSourceID: candidateReview.findingSourceId,
          focusReviewID: candidateReview.focusReviewId,
        })
        .from(candidateReview)
        .where(eq(candidateReview.turnId, turnID));
      return toolsForReviewPhase(deriveReviewPhase(review?.findingSourceID, review?.focusReviewID));
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
      ) {
        throw new CommandError(
          "conflict",
          "App observation does not match the clean reviewed commit. This review remains unverified.",
        );
      }
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
      if (text?.type === "text") {
        text.text = text.text.slice(0, 32_768 - reference.length) + reference;
      } else if (result.content.length < 16) {
        result.content.push({ type: "text", text: reference });
      }
    },

    async call(
      turnID: string,
      ownerToken: string,
      raw: unknown,
      requestID: string | number,
    ): Promise<BuildBrowserResult> {
      const call = candidateReviewCallInput.parse(raw);
      const scope = await authorized(turnID, ownerToken, async (_sql, current) => current);
      if (scope.result && !["review_report", "review_finding_report"].includes(call.name)) {
        throw new CommandError("conflict", "Review report is already recorded");
      }
      if (!isToolAllowedInPhase(scope.phase, call.name)) {
        throw new CommandError("conflict", "This tool does not belong to this review phase");
      }
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
        return formatReviewTextResult(`${JSON.stringify(result)}\nReview evidence ID: ${id}`);
      }
      if (call.name === "review_finding_report") {
        const message = await authorized(turnID, ownerToken, async (sql, current) => {
          if (current.phase.kind !== "finding-check") {
            throw new CommandError("conflict", "This tool does not belong to this review phase");
          }
          return settleFindingCheckIn(sql, current, current.phase, call.arguments);
        });
        return formatReviewTextResult(message);
      }
      if (call.name === "review_scenario" || call.name === "review_scenario_result") {
        await authorized(turnID, ownerToken, async (sql, current) => {
          if (current.result) {
            throw new CommandError("conflict", "Review report is already recorded");
          }
          if (call.name === "review_scenario") {
            await startReviewScenarioIn(sql, current, call.arguments);
          } else {
            await completeReviewScenarioIn(sql, current, call.arguments);
          }
        });
        return formatReviewTextResult(
          "Case recorded. Continue with the actual observations; do not replay App actions.",
        );
      }
      const inventory = await sourceReader.inventories(scope);
      if (call.name === "review_report") {
        const result = call.arguments;
        if (
          result.criteria.length !== scope.criteria ||
          result.criteria.some((item) => item.criterion > scope.criteria)
        ) {
          throw new CommandError(
            "conflict",
            "Review must cover every approved acceptance criterion exactly once",
          );
        }
        const before = scope.previousSHA
          ? (await sourceReader.revisionFiles(scope, inventory, "previous")).files
          : inventory.base;
        const uiRequired = computeReviewUiRequired(scope, before, inventory.candidate);
        await authorized(turnID, ownerToken, async (sql, current) => {
          await settlePrimaryReviewIn(sql, current, result, uiRequired);
        });
        return formatReviewTextResult(
          "Review report recorded. End with a brief ordinary summary. Factory still requires native settlement, exact checks and human Delivery approval.",
        );
      }
      const { output, observation } = await executeReviewSourceTool(
        scope,
        call,
        inventory,
        sourceReader,
      );
      await record(turnID, ownerToken, {
        ...observation,
        id: `source:${typeof requestID}:${requestID}`,
        commit: scope.commitSHA,
      });
      return formatReviewTextResult({
        evidenceId: `source:${typeof requestID}:${requestID}`,
        ...(typeof output === "object" && output ? output : { text: output }),
      });
    },
  };
}
