import { and, eq, isNull, sql as query } from "drizzle-orm";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation } from "#db/schema";
import { CommandError } from "../command-error";
import {
  actualAppObservation,
  hasCaseObservation,
  REVIEW_SCENARIO_KIND,
  type ReviewCall,
  type ReviewScenarioRow,
  type ReviewScope,
} from "./candidate-review-types";

type ScenarioStartArgs = Extract<ReviewCall, { name: "review_scenario" }>["arguments"];
type ScenarioResultArgs = Extract<ReviewCall, { name: "review_scenario_result" }>["arguments"];

export async function readActiveReviewScenarioIn(
  db: ReturnType<typeof drizzleTransaction>,
  reviewID: string,
) {
  const [scenario] = await db
    .select({ id: query<string>`${operation.payload}->>'id'` })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REVIEW_SCENARIO_KIND),
        eq(operation.scopeType, "candidate_review"),
        eq(operation.scopeId, reviewID),
        isNull(operation.completedAt),
      ),
    );
  return scenario;
}

export async function readReviewScenariosIn(
  db: ReturnType<typeof drizzleTransaction>,
  reviewID: string,
): Promise<ReviewScenarioRow[]> {
  return db
    .select({
      id: query<string>`${operation.payload}->>'id'`,
      criterion: query<number>`(${operation.payload}->>'criterion')::integer`,
      category: query<"normal" | "error" | "boundary">`${operation.payload}->>'category'`,
      status: query<"passed" | "failed" | "unverified" | null>`${operation.payload}->>'status'`,
      observationKind: query<"app" | "source" | null>`${operation.payload}->>'observationKind'`,
    })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REVIEW_SCENARIO_KIND),
        eq(operation.scopeType, "candidate_review"),
        eq(operation.scopeId, reviewID),
      ),
    );
}

export async function startReviewScenarioIn(
  sql: DatabaseTransaction,
  current: ReviewScope,
  args: ScenarioStartArgs,
) {
  const db = drizzleTransaction(sql);
  const active = await readActiveReviewScenarioIn(db, current.id);
  const [count] = await db
    .select({ count: query<number>`count(*)::int` })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REVIEW_SCENARIO_KIND),
        eq(operation.scopeType, "candidate_review"),
        eq(operation.scopeId, current.id),
      ),
    );
  if (active || (count?.count ?? 0) >= 64 || args.criterion > current.criteria) {
    throw new CommandError(
      "conflict",
      "Finish the current case; use an approved criterion and at most 64 cases",
    );
  }
  await sql`WITH ts AS (SELECT clock_timestamp() AS started)
    INSERT INTO factory.operation(
      id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_at,updated_at)
    SELECT ${crypto.randomUUID()},${REVIEW_SCENARIO_KIND},'candidate_review',${current.id},
      ${`review.scenario:${current.id}:${args.id}`},NULL,'active',
      jsonb_build_object(
        'reviewId',${current.id}::text,
        'id',${args.id}::text,
        'title',${args.title}::text,
        'category',${args.category}::text,
        'criterion',${args.criterion}::integer,
        'expected',${args.expected}::text,
        'startedAt',ts.started::text,
        'endedAt',NULL,
        'observed',NULL,
        'mediaStartedMs',NULL,
        'mediaSessionId',NULL,
        'status',NULL,
        'observationKind',${args.observationKind}::text
      ),
      ts.started,ts.started
    FROM ts`;
}

function extractScenarioMediaWindow(
  evidence: ReviewScope["evidence"],
  scenarioID: string,
  kind: "app" | "source",
) {
  const positions = evidence.flatMap((item) => {
    const context = item["context"];
    if (
      kind !== "app" ||
      item["scenarioId"] !== scenarioID ||
      !actualAppObservation(item) ||
      !context ||
      typeof context !== "object"
    ) {
      return [];
    }
    const value = context as Record<string, unknown>;
    return typeof value["recordingTimeMs"] === "number" &&
      Number.isSafeInteger(value["recordingTimeMs"]) &&
      value["recordingTimeMs"] >= 0 &&
      typeof value["sessionId"] === "string"
      ? [{ time: value["recordingTimeMs"], session: value["sessionId"] }]
      : [];
  });
  const mediaSession = positions.at(-1)?.session;
  const times = positions.filter((item) => item.session === mediaSession).map((item) => item.time);
  return {
    mediaStartedMs: times.length ? Math.min(...times) : null,
    mediaSessionId: mediaSession ?? null,
  };
}

export async function completeReviewScenarioIn(
  sql: DatabaseTransaction,
  current: ReviewScope,
  args: ScenarioResultArgs,
) {
  const db = drizzleTransaction(sql);
  const [scenario] = await db
    .select({
      id: operation.id,
      observationKind: query<"app" | "source" | null>`${operation.payload}->>'observationKind'`,
    })
    .from(operation)
    .where(
      and(
        eq(operation.kind, REVIEW_SCENARIO_KIND),
        eq(operation.scopeType, "candidate_review"),
        eq(operation.scopeId, current.id),
        eq(operation.idempotencyKey, `review.scenario:${current.id}:${args.id}`),
        isNull(operation.completedAt),
      ),
    )
    .for("update");
  if (!scenario) throw new CommandError("conflict", "Case is not currently active");
  const kind = scenario.observationKind ?? "app";
  if (args.status !== "unverified" && !hasCaseObservation(current.evidence, args.id, kind)) {
    throw new CommandError(
      "conflict",
      kind === "app"
        ? `App case ${args.id} needs its own actual App observation before its result. Keep this case active and inspect the App; do not replay an unconfirmed mutation.`
        : `Source case ${args.id} needs its own immutable candidate source read or diff before its result.`,
    );
  }
  const { mediaStartedMs, mediaSessionId } = extractScenarioMediaWindow(
    current.evidence,
    args.id,
    kind,
  );
  const updated = await sql<{ id: string }[]>`WITH ts AS (SELECT clock_timestamp() AS ended)
    UPDATE factory.operation
    SET state=${args.status},
      completed_at=ts.ended,
      updated_at=now(),
      payload=payload || jsonb_build_object(
        'endedAt',ts.ended::text,
        'status',${args.status}::text,
        'observed',${args.observed}::text,
        'mediaStartedMs',${mediaStartedMs}::bigint,
        'mediaSessionId',${mediaSessionId}::text
      )
    FROM ts
    WHERE factory.operation.id=${scenario.id}
      AND factory.operation.kind=${REVIEW_SCENARIO_KIND}
      AND factory.operation.completed_at IS NULL
    RETURNING factory.operation.payload->>'id' AS id`;
  if (!updated.length) throw new CommandError("conflict", "Case is not currently active");
}
