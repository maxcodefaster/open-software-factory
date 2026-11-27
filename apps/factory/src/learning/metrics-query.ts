import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNull,
  ne,
  not,
  notInArray,
  type SQL,
  sql as typedSQL,
} from "drizzle-orm";
import { maxCalibrationGrades } from "#conversation-domain/learning";
import { drizzleTransaction } from "#db/client";
import { learningCase as caseRecord, learningReview, usageEntry, usageOperation } from "#db/schema";
import { type LearningDatabase, type LearningRights, ownerPredicate } from "./command-ledger";
import { pendingReviewRequests } from "./requests";

export async function loadLearningMetrics(
  database: LearningDatabase,
  params: {
    userId: string;
    projectId: string | null;
    ownerId: string | null;
    permitted: LearningRights;
    caseVisible: SQL | undefined;
  },
) {
  const { userId, projectId, ownerId, permitted, caseVisible } = params;
  const db = drizzleTransaction(database.client);
  // Native expressions retain UTC bucketing, filtered aggregates and JSON verdict expansion.
  const start = typedSQL`((now() AT TIME ZONE 'UTC')::date-27) AT TIME ZONE 'UTC'`;
  const operationDay = typedSQL<string>`(${usageOperation.settledAt} AT TIME ZONE 'UTC')::date`;
  const costDay = typedSQL<string>`(${usageEntry.occurredAt} AT TIME ZONE 'UTC')::date`;
  const caseDay = typedSQL<string>`(${caseRecord.settledAt} AT TIME ZONE 'UTC')::date`;
  const dates = db.$with("dates").as(
    db
      .select({
        day: typedSQL<string>`date_series.day::date`.as("day"),
      })
      .from(typedSQL`generate_series(
        (now() AT TIME ZONE 'UTC')::date-27,(now() AT TIME ZONE 'UTC')::date,interval '1 day') date_series(day)`),
  );
  const missingUsage = not(
    exists(
      db
        .select({ id: usageEntry.eventId })
        .from(usageEntry)
        .where(eq(usageEntry.operationId, usageOperation.id)),
    ),
  );
  const operations = db.$with("operations").as(
    db
      .select({
        day: operationDay.as("day"),
        operations: typedSQL<number>`count(*)::int`.as("operations"),
        completed:
          typedSQL<number>`count(*) FILTER(WHERE ${usageOperation.outcome}='completed')::int`.as(
            "completed",
          ),
        failed:
          typedSQL<number>`count(*) FILTER(WHERE ${usageOperation.outcome} IN ('failed','interrupted'))::int`.as(
            "failed",
          ),
        unknown:
          typedSQL<number>`count(*) FILTER(WHERE ${usageOperation.outcome}='unknown')::int`.as(
            "unknown",
          ),
        missingUsage: typedSQL<boolean>`bool_or(${missingUsage})`.as("missing_usage"),
        elapsed: typedSQL<number | null>`percentile_cont(0.5) WITHIN GROUP(
        ORDER BY extract(epoch FROM ${usageOperation.settledAt}-${usageOperation.createdAt}))::float8`.as(
          "elapsed",
        ),
      })
      .from(usageOperation)
      .where(
        and(
          gte(usageOperation.settledAt, start),
          projectId ? eq(usageOperation.projectId, projectId) : undefined,
          permitted.ownUsage ? eq(usageOperation.userId, userId) : undefined,
          notInArray(usageOperation.purpose, ["probe", "learning"]),
        ),
      )
      .groupBy(operationDay),
  );
  const costs = db.$with("costs").as(
    db
      .select({
        day: costDay.as("day"),
        cost: typedSQL<string>`sum(${usageEntry.knownNanoUsd})::text`.as("cost"),
        incomplete: typedSQL<boolean>`bool_or(${usageEntry.nanoUsd} IS NULL)`.as("incomplete"),
      })
      .from(usageEntry)
      .innerJoin(usageOperation, eq(usageOperation.id, usageEntry.operationId))
      .where(
        and(
          gte(usageEntry.occurredAt, start),
          projectId ? eq(usageOperation.projectId, projectId) : undefined,
          permitted.ownUsage ? eq(usageOperation.userId, userId) : undefined,
          ne(usageOperation.purpose, "probe"),
        ),
      )
      .groupBy(costDay),
  );
  const covered = db.$with("covered").as(
    db
      .select({
        day: caseDay.as("day"),
        observed: typedSQL<number>`count(*)::int`.as("observed"),
        selected: typedSQL<number>`count(*) FILTER(WHERE ${caseRecord.selected})::int`.as(
          "selected",
        ),
        reviewed: typedSQL<number>`count(verdict.value)::int`.as("reviewed"),
        supported:
          typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'fulfillment'='supported')::int`.as(
            "supported",
          ),
        problems:
          typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'fulfillment'='problem')::int`.as(
            "problems",
          ),
        avoidable:
          typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'rework'='avoidable')::int`.as(
            "avoidable",
          ),
        reworkKnown:
          typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'rework' IN ('avoidable','necessary'))::int`.as(
            "rework_known",
          ),
      })
      .from(caseRecord)
      .leftJoin(
        learningReview,
        and(
          eq(learningReview.id, caseRecord.batchId),
          eq(learningReview.state, "completed"),
          eq(learningReview.kind, "work"),
        ),
      )
      .leftJoin(
        typedSQL`LATERAL jsonb_array_elements(${learningReview.result}->'cases') verdict(value)`,
        typedSQL`verdict.value->>'caseId'=${caseRecord.id}`,
      )
      .where(and(gte(caseRecord.settledAt, start), caseVisible))
      .groupBy(caseDay),
  );
  const days = await db
    .with(dates, operations, costs, covered)
    .select({
      date: typedSQL<string>`${dates}.${dates.day}::text`,
      operations: typedSQL<number>`coalesce(${operations}.${operations.operations},0)`,
      completed: typedSQL<number>`coalesce(${operations}.${operations.completed},0)`,
      failed: typedSQL<number>`coalesce(${operations}.${operations.failed},0)`,
      unknown: typedSQL<number>`coalesce(${operations}.${operations.unknown},0)`,
      knownNanoUSD: typedSQL<string>`coalesce(${costs}.${costs.cost},'0')`,
      incomplete: typedSQL<boolean>`coalesce(${costs}.${costs.incomplete},false) OR coalesce(${operations}.${operations.missingUsage},false)`,
      elapsedSeconds: operations.elapsed,
      observed: typedSQL<number>`coalesce(${covered}.${covered.observed},0)`,
      selected: typedSQL<number>`coalesce(${covered}.${covered.selected},0)`,
      reviewed: typedSQL<number>`coalesce(${covered}.${covered.reviewed},0)`,
      supported: typedSQL<number>`coalesce(${covered}.${covered.supported},0)`,
      problems: typedSQL<number>`coalesce(${covered}.${covered.problems},0)`,
      avoidable: typedSQL<number>`coalesce(${covered}.${covered.avoidable},0)`,
      reworkKnown: typedSQL<number>`coalesce(${covered}.${covered.reworkKnown},0)`,
    })
    .from(dates)
    .leftJoin(operations, typedSQL`${operations}.${operations.day} = ${dates}.${dates.day}`)
    .leftJoin(costs, typedSQL`${costs}.${costs.day} = ${dates}.${dates.day}`)
    .leftJoin(covered, typedSQL`${covered}.${covered.day} = ${dates}.${dates.day}`)
    .orderBy(asc(typedSQL`${dates}.${dates.day}`));
  // Cases batch within one visibility group, so report the group closest to starting.
  const [waiting] = projectId
    ? await db
        .select({
          count: count(),
          since: typedSQL`min(${caseRecord.settledAt})`.mapWith(caseRecord.settledAt),
          developerOnly: caseRecord.developerOnly,
        })
        .from(caseRecord)
        .where(and(caseVisible, eq(caseRecord.selected, true), isNull(caseRecord.batchId)))
        .groupBy(caseRecord.developerOnly)
        .orderBy(desc(count()), typedSQL`min(${caseRecord.settledAt})`)
        .limit(1)
    : [];
  const [running] = projectId
    ? await db
        .select({ id: learningReview.id })
        .from(learningReview)
        .where(
          and(
            eq(learningReview.projectId, projectId),
            ownerPredicate(learningReview.ownerId, ownerId),
            eq(learningReview.state, "running"),
            eq(learningReview.kind, "work"),
            permitted.developer ? undefined : eq(learningReview.developerOnly, false),
          ),
        )
        .limit(1)
    : [];
  const [requested] = projectId
    ? (await pendingReviewRequests(database.client, { projectId, ownerId })).filter(
        (item) => !item.developerOnly || permitted.developer,
      )
    : [];
  // Calibration is shared by every Project that uses the same judge, so describe the latest
  // judge without exposing its cases. A model change starts a new judge with its own record.
  const [latestCalibration] = projectId
    ? await db
        .select({
          judgeKey: learningReview.judgeKey,
          state: learningReview.state,
          calibrated: learningReview.calibrated,
          modelId: learningReview.modelId,
        })
        .from(learningReview)
        .where(eq(learningReview.kind, "calibration"))
        .orderBy(desc(learningReview.createdAt))
        .limit(1)
    : [];
  const [wrongGrades] = latestCalibration
    ? await db
        .select({ count: count() })
        .from(learningReview)
        .where(
          and(
            eq(learningReview.kind, "calibration"),
            eq(learningReview.judgeKey, latestCalibration.judgeKey),
            eq(learningReview.state, "completed"),
            eq(learningReview.calibrated, false),
          ),
        )
    : [];
  const calibration = !latestCalibration
    ? { state: "none" as const, attempts: 0, modelId: null }
    : {
        state:
          latestCalibration.state === "running"
            ? ("running" as const)
            : latestCalibration.state !== "completed"
              ? ("unconfirmed" as const)
              : latestCalibration.calibrated
                ? ("passed" as const)
                : (wrongGrades?.count ?? 0) >= maxCalibrationGrades
                  ? ("closed" as const)
                  : ("retrying" as const),
        attempts: wrongGrades?.count ?? 0,
        modelId: latestCalibration.modelId,
      };
  return {
    days: [...days],
    waiting: waiting?.count ?? 0,
    waitingSince: waiting ? new Date(waiting.since).toISOString() : null,
    waitingDeveloperOnly: waiting?.developerOnly ?? false,
    reviewRunning: Boolean(running),
    reviewRequestedAt: requested ? new Date(requested.requestedAt).toISOString() : null,
    calibration,
  };
}
