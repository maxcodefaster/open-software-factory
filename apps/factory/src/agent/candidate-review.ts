import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import {
  candidateReviewCallInput,
  candidateReviewToolCatalogue,
  reviewNeedsBrowser,
} from "../../../../packages/conversation-domain/src/candidate-review";
import type {
  BuildBrowserCall,
  BuildBrowserResult,
} from "../../../../packages/conversation-domain/src/browser-tools";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";
import { createAgentTurnStore, type AgentTurnTransaction } from "./turn-store";

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
  evidence: Array<Record<string, unknown>>;
};
type Inventory = Array<{ path: string; sha: string; size: number }>;

function hasCaseObservation(evidence: ReviewScope["evidence"], id: string, kind: "app" | "source") {
  return evidence.some(
    (item) =>
      item["scenarioId"] === id &&
      (kind === "app"
        ? item["kind"] === "browser"
        : item["kind"] === "source" && (item["revision"] === "candidate" || item["diff"] === true)),
  );
}

export function createCandidateReviewController(
  database: Database,
  forgeOverride?: ReturnType<typeof createForgejoClient>,
) {
  const turns = createAgentTurnStore(database);
  const allowedOwner = forgeOverride ? undefined : process.env["FACTORY_FORGEJO_OWNER"];
  const forge =
    forgeOverride ??
    createForgejoClient({
      apiURL: process.env["FACTORY_FORGEJO_API_URL"] ?? "",
      token: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
    });
  // Exact immutable source only. No checkout file service, shell, test execution,
  // writes, ambient credentials or Project-chosen MCP tools are exposed here.
  async function scopeIn(sql: AgentTurnTransaction, turnID: string) {
    const [scope] = await sql<ReviewScope[]>`
      SELECT review.id,review.change_id AS "changeID",review.commit_sha AS "commitSHA",
        review.base_sha AS "baseSHA",project.repository_url AS "repositoryURL",review.result,review.evidence,
        review.coverage_version AS "coverageVersion",
        jsonb_array_length(revision.canonical_content::jsonb->'acceptanceCriteria') AS criteria
      FROM factory.candidate_review review
      JOIN factory.change change ON change.id=review.change_id
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
    use: (sql: AgentTurnTransaction, scope: ReviewScope) => Promise<T>,
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
    const url = new URL(scope.repositoryURL);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    const name = parts.at(-1);
    const owner = parts.at(-2);
    if (!name || !owner || (allowedOwner && owner !== allowedOwner))
      throw new Error("Review repository is not the configured Project forge");
    return { owner, name };
  }
  async function inventories(scope: ReviewScope) {
    const repo = repository(scope);
    const [base, candidate] = await Promise.all([
      forge.listFiles(repo, scope.baseSHA),
      forge.listFiles(repo, scope.commitSHA),
    ]);
    const before = new Map(base.map((file) => [file.path, file]));
    const after = new Map(candidate.map((file) => [file.path, file]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return {
      base,
      candidate,
      files: paths.map((path) => ({
        path,
        base: before.get(path) ?? null,
        candidate: after.get(path) ?? null,
        changed: before.get(path)?.sha !== after.get(path)?.sha,
      })),
    };
  }
  async function source(scope: ReviewScope, files: Inventory, path: string, ref: string) {
    const file = files.find((file) => file.path === path);
    if (!file) throw new CommandError("not-found", "File is absent from this exact revision");
    if (file.size > 1_048_576)
      throw new CommandError("conflict", "Review file exceeds the 1 MiB text limit");
    const content = await forge.getFile(repository(scope), path, ref);
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
      const [scenario] = await sql<{ id: string }[]>`SELECT id FROM factory.review_scenario
        WHERE review_id=${scope.id} AND ended_at IS NULL`;
      const attributed = { ...observation, ...(scenario ? { scenarioId: scenario.id } : {}) };
      await sql`UPDATE factory.candidate_review SET evidence=evidence || ${JSON.stringify([attributed])}::jsonb
        WHERE id=${scope.id}`;
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
      return turn?.command.kind === "change-review" ? candidateReviewToolCatalogue : [];
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
    },
    async call(
      turnID: string,
      ownerToken: string,
      raw: unknown,
      requestID: string | number,
    ): Promise<BuildBrowserResult> {
      const call = candidateReviewCallInput.parse(raw);
      const scope = await authorized(turnID, ownerToken, async (_sql, scope) => scope);
      if (scope.result && call.name !== "review_report")
        throw new CommandError("conflict", "Review report is already recorded");
      if (call.name === "review_scenario" || call.name === "review_scenario_result") {
        return authorized(turnID, ownerToken, async (sql, current) => {
          if (current.result)
            throw new CommandError("conflict", "Review report is already recorded");
          if (call.name === "review_scenario") {
            const args = call.arguments;
            const [active] = await sql`SELECT id FROM factory.review_scenario
              WHERE review_id=${scope.id} AND ended_at IS NULL`;
            const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count
              FROM factory.review_scenario WHERE review_id=${scope.id}`;
            if (active || (count?.count ?? 0) >= 64 || args.criterion > current.criteria)
              throw new CommandError(
                "conflict",
                "Finish the current case; use an approved criterion and at most 64 cases",
              );
            await sql`INSERT INTO factory.review_scenario(review_id,id,title,category,observation_kind,criterion,expected)
              VALUES(${scope.id},${args.id},${args.title},${args.category},${args.observationKind},${args.criterion},${args.expected})`;
          } else {
            const args = call.arguments;
            const [scenario] = await sql<
              { observationKind: "app" | "source" | null }[]
            >`SELECT observation_kind AS "observationKind" FROM factory.review_scenario
              WHERE review_id=${scope.id} AND id=${args.id} AND ended_at IS NULL FOR UPDATE`;
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
                item["kind"] !== "browser" ||
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
            const updated = await sql`UPDATE factory.review_scenario SET ended_at=clock_timestamp(),
              status=${args.status},observed=${args.observed},
              media_started_ms=${times.length ? Math.min(...times) : null},media_session_id=${mediaSession ?? null}
              WHERE review_id=${scope.id} AND id=${args.id} AND ended_at IS NULL RETURNING id`;
            if (!updated.length) throw new CommandError("conflict", "Case is not currently active");
          }
          return textResult(
            "Case recorded. Continue with the actual observations; do not replay App actions.",
          );
        });
      }
      const inventory = await inventories(scope);
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
        const uiRequired = reviewNeedsBrowser(
          inventory.files.filter((file) => file.changed).map((file) => file.path),
        );
        await authorized(turnID, ownerToken, async (sql, current) => {
          if (current.result) {
            if (JSON.stringify(current.result) !== JSON.stringify(result)) {
              // PostgreSQL jsonb changes key order, so compare in SQL instead.
              const [same] = await sql`SELECT id FROM factory.candidate_review
                WHERE id=${current.id} AND result=${JSON.stringify(result)}::jsonb`;
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
              const cases = await sql<
                {
                  id: string;
                  criterion: number;
                  category: string;
                  status: string | null;
                  observationKind: "app" | "source" | null;
                }[]
              >`
                SELECT id,criterion,category,status,observation_kind AS "observationKind"
                FROM factory.review_scenario WHERE review_id=${scope.id}`;
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
          await sql`UPDATE factory.candidate_review SET result=${JSON.stringify(result)}::jsonb,
            ui_required=${uiRequired} WHERE id=${current.id} AND result IS NULL`;
        });
        return textResult(
          "Review report recorded. End with a brief ordinary summary. Factory still requires native settlement, exact checks and human Delivery approval.",
        );
      }
      let output: unknown;
      let observation: Record<string, unknown>;
      if (call.name === "review_files") {
        const files = inventory.files.filter((file) => !call.arguments.changedOnly || file.changed);
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
          base: scope.baseSHA,
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
      } else if (call.name === "review_read") {
        const { path, revision, startLine, lines } = call.arguments;
        const content = await source(
          scope,
          inventory[revision],
          path,
          revision === "base" ? scope.baseSHA : scope.commitSHA,
        );
        const all = content.split("\n");
        output = {
          path,
          revision,
          commit: revision === "base" ? scope.baseSHA : scope.commitSHA,
          totalLines: all.length,
          text: all
            .slice(startLine - 1, startLine - 1 + lines)
            .map((line, index) => `${startLine + index}: ${line}`)
            .join("\n"),
        };
        observation = { kind: "source", path, revision, startLine, lines };
      } else {
        const { path } = call.arguments;
        const change = inventory.files.find((file) => file.path === path);
        if (!change) throw new CommandError("not-found", "File is absent from the review");
        const before = change.base ? await source(scope, inventory.base, path, scope.baseSHA) : "";
        const after = change.candidate
          ? await source(scope, inventory.candidate, path, scope.commitSHA)
          : "";
        output = createTwoFilesPatch(
          `base/${path}`,
          `candidate/${path}`,
          before,
          after,
          scope.baseSHA,
          scope.commitSHA,
          { context: 4 },
        );
        observation = { kind: "source", path, diff: true };
      }
      await record(turnID, ownerToken, {
        ...observation,
        id: `source:${typeof requestID}:${requestID}`,
        commit: scope.commitSHA,
      });
      return textResult(output);
    },
  };
}
