import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
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
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";
import { type AgentTurnTransaction, createAgentTurnStore } from "./turn-store";

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
  async function scopeIn(sql: AgentTurnTransaction, turnID: string) {
    const [scope] = await sql<ReviewScope[]>`
      SELECT review.id,review.change_id AS "changeID",review.commit_sha AS "commitSHA",
        review.base_sha AS "baseSHA",project.repository_url AS "repositoryURL",review.result,review.evidence,
        review.coverage_version AS "coverageVersion",review.finding_source_id AS "findingSourceID",
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
      if (turn?.command.kind !== "change-review") return [];
      const [review] = await database.client<{ checking: boolean }[]>`
        SELECT finding_source_id IS NOT NULL AS checking FROM factory.candidate_review WHERE turn_id=${turnID}`;
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
      if (
        (scope.findingSourceID &&
          ["review_report", "review_scenario", "review_scenario_result"].includes(call.name)) ||
        (!scope.findingSourceID && call.name === "review_finding_report")
      )
        throw new CommandError("conflict", "This tool does not belong to this review phase");
      if (call.name === "review_finding_report") {
        return authorized(turnID, ownerToken, async (sql, current) => {
          const check = call.arguments;
          if (current.result) {
            const [same] = await sql`SELECT id FROM factory.candidate_review
              WHERE id=${current.id} AND finding_checks=${JSON.stringify(check)}::jsonb`;
            if (!same) throw new CommandError("conflict", "The immutable finding check changed");
            return textResult("Finding check already recorded. Finish normally.");
          }
          const proposal = candidateReviewResultInput.parse(current.proposal);
          for (const item of [...check.checks, ...check.criteria]) {
            if (item.status === "unresolved" || item.status === "unverified") continue;
            const observations = item.evidenceIds.map((id) =>
              current.evidence.find((observation) => observation["id"] === id),
            );
            if (
              !observations.length ||
              observations.some(
                (observation) =>
                  !observation ||
                  !(
                    observation["kind"] === "browser" ||
                    (observation["kind"] === "source" &&
                      (observation["revision"] === "candidate" || observation["diff"] === true))
                  ),
              )
            )
              throw new CommandError(
                "conflict",
                "Finding decisions need your own exact-candidate observations",
              );
          }
          let result = checkedReviewResult(proposal, check);
          if (result.verdict === "passed") {
            const [original] = await sql<
              { evidence: ReviewScope["evidence"]; uiRequired: boolean }[]
            >`
              SELECT evidence,ui_required AS "uiRequired" FROM factory.candidate_review WHERE id=${current.findingSourceID}`;
            const cases = await sql<
              {
                id: string;
                criterion: number;
                category: string;
                status: string;
                observationKind: "app" | "source";
              }[]
            >`SELECT id,criterion,category,status,COALESCE(observation_kind,'app') AS "observationKind"
              FROM factory.review_scenario WHERE review_id=${current.findingSourceID}`;
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
                          ? observation["kind"] === "browser"
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
          await sql`UPDATE factory.candidate_review SET finding_checks=${JSON.stringify(check)}::jsonb,
            result=${JSON.stringify(result)}::jsonb,
            ui_required=(SELECT ui_required FROM factory.candidate_review WHERE id=${current.findingSourceID})
            WHERE id=${current.id} AND result IS NULL`;
          return textResult(
            "Finding check recorded. Finish normally; only confirmed blockers can request correction.",
          );
        });
      }
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
