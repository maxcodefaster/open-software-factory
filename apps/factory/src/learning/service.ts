import { isDeepStrictEqual } from "node:util";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  notInArray,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  learningCase,
  learningDecisionCommand,
  learningPolicyCommand,
  learningProposal,
  learningReviewNowCommand,
  learningRollbackCommand,
  learningTarget,
  learningView,
  legacyWikiCallPattern,
  maxCalibrationGrades,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  administrator,
  learningCase as caseRecord,
  learningApplication,
  learningCommand,
  learningPolicy,
  learningReview,
  learningTrial,
  learningTrialStep,
  projectMembership,
  learningProposal as proposalRecord,
  ticketConversation,
  usageEntry,
  usageOperation,
} from "../../../../packages/db/src/schema";
import {
  canonicalRequirementContent,
  requirementDigest,
} from "../../../../packages/requirement-domain/src/requirement";
import { insertInitialTicketIn } from "../../../../packages/ticket-authoring/src/authoring";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { pendingReviewRequests } from "./requests";
import { createLearningTargets, learningActivation, learningEditDigest } from "./targets";

type Database = ReturnType<typeof createDatabase>;
export function createLearningService(database: Database) {
  const access = createAccessController(database);
  const targets = createLearningTargets(database);
  async function rights(userId: string, projectId: string | null, personal: boolean) {
    if (!projectId) {
      await access.requireSystemManager(userId);
      return { manager: true, developer: true, ownUsage: false };
    }
    const manager = await database.client.begin((sql) =>
      projectAuthorityIn(sql, userId, projectId),
    );
    return {
      manager,
      developer: await access.canDevelop(userId, projectId),
      ownUsage: personal || !manager,
    };
  }
  async function replay(sql: DatabaseTransaction, id: string, actorId: string, input: unknown) {
    const db = drizzleTransaction(sql);
    await db.execute(typedSQL`SELECT pg_advisory_xact_lock(hashtext(${`learning-command:${id}`}))`);
    const [existing] = await db
      .select({
        actorId: learningCommand.actorId,
        input: learningCommand.input,
        result: learningCommand.result,
      })
      .from(learningCommand)
      .where(eq(learningCommand.id, id));
    if (existing && (existing.actorId !== actorId || !isDeepStrictEqual(existing.input, input)))
      throw new CommandError("conflict", "Learning command identity was reused");
    return existing;
  }
  return {
    async get(userId: string, projectId: string | null, personal = false) {
      const db = drizzleTransaction(database.client);
      const permitted = await rights(userId, projectId, personal);
      const ownerId = personal ? userId : null;
      const reviewVisible = and(
        projectId ? eq(learningReview.projectId, projectId) : undefined,
        ownerId ? eq(learningReview.ownerId, ownerId) : isNull(learningReview.ownerId),
        permitted.developer ? undefined : eq(learningReview.developerOnly, false),
        permitted.manager
          ? undefined
          : typedSQL`NOT(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
      );
      const caseVisible = and(
        projectId ? eq(caseRecord.projectId, projectId) : undefined,
        ownerId ? eq(caseRecord.ownerId, ownerId) : isNull(caseRecord.ownerId),
        permitted.developer ? undefined : eq(caseRecord.developerOnly, false),
        permitted.manager ? undefined : ne(caseRecord.activity, "setup"),
        typedSQL`NOT(${caseRecord.activity}='wiki' AND ${caseRecord.id} ~ ${legacyWikiCallPattern})`,
      );
      const reviewFields = {
        id: learningReview.id,
        kind: learningReview.kind,
        state: learningReview.state,
        modelId: learningReview.modelId,
        rubric: learningReview.rubric,
        calibrated: learningReview.calibrated,
        reason: learningReview.reason,
        createdAt: learningReview.createdAt,
        completedAt: learningReview.completedAt,
        result: learningReview.result,
        cases: learningReview.input,
      };
      const policies = projectId
        ? await db
            .select({
              ownerId: learningPolicy.ownerId,
              enabled: learningPolicy.enabled,
              automaticSkills: learningPolicy.automaticSkills,
              version: learningPolicy.version,
            })
            .from(learningPolicy)
            .where(
              and(
                eq(learningPolicy.projectId, projectId),
                or(
                  isNull(learningPolicy.ownerId),
                  ownerId ? eq(learningPolicy.ownerId, ownerId) : undefined,
                ),
              ),
            )
        : [];
      const policy = policies.find((item) => item.ownerId === ownerId);
      const parentEnabled = policies.find((item) => item.ownerId === null)?.enabled ?? true;
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
                ownerId ? eq(learningReview.ownerId, ownerId) : isNull(learningReview.ownerId),
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
      let reviews: Array<Record<string, unknown>> = projectId
        ? await db
            .select(reviewFields)
            .from(learningReview)
            .where(reviewVisible)
            .orderBy(desc(learningReview.createdAt))
            .limit(12)
        : [];
      const proposals = projectId
        ? await db
            .select({
              id: proposalRecord.id,
              reviewId: proposalRecord.reviewId,
              content: proposalRecord.content,
              state: proposalRecord.state,
              ticketId: proposalRecord.ticketId,
              private: isNotNull(learningReview.ownerId),
            })
            .from(proposalRecord)
            .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
            .where(reviewVisible)
            .orderBy(desc(learningReview.createdAt), asc(proposalRecord.ordinal))
            .limit(24)
        : [];
      // Pending proposals can outlive the recent-history window. Always return
      // their exact supporting reviews, under the same visibility predicate.
      const missing = [...new Set(proposals.map((item) => String(item["reviewId"])))].filter(
        (id) => !reviews.some((review) => review["id"] === id),
      );
      if (projectId && missing.length) {
        const sources = await db
          .select(reviewFields)
          .from(learningReview)
          .where(and(inArray(learningReview.id, missing), reviewVisible))
          .orderBy(desc(learningReview.createdAt));
        reviews = [...reviews, ...sources];
      }
      const later = alias(learningReview, "later");
      const recent = db
        .select({
          id: caseRecord.id,
          snapshot: caseRecord.snapshot,
          settledAt: caseRecord.settledAt,
          reviewId: typedSQL<string | null>`${later.id}`.as("review_id"),
          verdict: typedSQL<unknown>`verdict.value`.as("verdict"),
          sampled: typedSQL<number>`count(*) OVER()`.as("sampled"),
          reviewed: typedSQL<number>`count(verdict.value) OVER()`.as("reviewed"),
          problems:
            typedSQL<number>`count(*) FILTER(WHERE verdict.value->>'fulfillment'='problem') OVER()`.as(
              "problems",
            ),
        })
        .from(caseRecord)
        .leftJoin(
          later,
          and(
            eq(later.id, caseRecord.batchId),
            eq(later.state, "completed"),
            eq(later.kind, "work"),
          ),
        )
        .leftJoin(
          typedSQL`LATERAL jsonb_array_elements(${later.result}->'cases') verdict(value)`,
          typedSQL`verdict.value->>'caseId'=${caseRecord.id}`,
        )
        .where(
          and(
            eq(caseRecord.projectId, learningReview.projectId),
            typedSQL`${caseRecord.ownerId} IS NOT DISTINCT FROM ${learningReview.ownerId}`,
            eq(caseRecord.developerOnly, learningReview.developerOnly),
            eq(caseRecord.selected, true),
            typedSQL`${caseRecord.snapshot}->'targets' @> jsonb_build_array(jsonb_build_object(
            'target',jsonb_build_object('kind',${learningApplication.target}->>'kind',
              'id',${learningApplication.target}->>'id','revisionId',${learningApplication.appliedRevisionId}::text)))`,
            permitted.manager ? undefined : ne(caseRecord.activity, "setup"),
          ),
        )
        .orderBy(desc(caseRecord.settledAt), asc(caseRecord.id))
        .limit(3)
        .as("recent");
      const subsequent = db
        .select({
          sampled: typedSQL<number>`max(${recent.sampled})::int`.as("sampled"),
          reviewed: typedSQL<number>`max(${recent.reviewed})::int`.as("reviewed"),
          problems: typedSQL<number>`max(${recent.problems})::int`.as("problems"),
          cases: typedSQL<unknown[]>`jsonb_agg(jsonb_build_object(
          'source',${recent.snapshot},'reviewId',${recent.reviewId},'verdict',${recent.verdict})
          ORDER BY ${recent.settledAt} DESC,${recent.id})`.as("cases"),
        })
        .from(recent)
        .as("subsequent");
      const applications = projectId
        ? await db
            .select({
              id: learningApplication.id,
              proposalId: learningApplication.proposalId,
              target: learningApplication.target,
              title: typedSQL<string>`${proposalRecord.content}->>'title'`,
              edit: typedSQL<unknown>`${proposalRecord.content}->'edit'`,
              appliedRevisionId: learningApplication.appliedRevisionId,
              appliedVersion: learningApplication.appliedVersion,
              state: learningApplication.state,
              createdAt: learningApplication.createdAt,
              revertedAt: learningApplication.revertedAt,
              automatic: isNotNull(learningApplication.comparisonId),
              automaticRecovery: isNotNull(learningApplication.revertedComparisonId),
              subsequent: typedSQL<unknown>`jsonb_build_object(
            'sampled',coalesce(${subsequent.sampled},0),'reviewed',coalesce(${subsequent.reviewed},0),
            'problems',coalesce(${subsequent.problems},0),'cases',coalesce(${subsequent.cases},'[]'::jsonb))`,
            })
            .from(learningApplication)
            .innerJoin(proposalRecord, eq(proposalRecord.id, learningApplication.proposalId))
            .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
            .leftJoinLateral(subsequent, typedSQL`true`)
            .where(reviewVisible)
            .orderBy(desc(learningApplication.createdAt))
            .limit(24)
        : [];
      const proposalViews: Array<Record<string, unknown>> = await Promise.all(
        proposals.map(async (row) => {
          const content = learningProposal.parse(row["content"]);
          let scope: "personal" | "project" | "system" | null = null,
            canApply = false,
            label: string | null = null,
            blocked: string | null = null;
          if (content.edit && projectId) {
            const edit = content.edit;
            try {
              const result = await database.client.begin((sql) =>
                targets.authorize(sql, edit.target, userId, projectId),
              );
              scope = result.scope;
              label = result.label;
              canApply = true;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
              blocked = cause.message;
            }
          }
          return {
            ...row,
            editDigest: content.edit ? learningEditDigest(content.edit) : null,
            canApply,
            applyBlockedReason: blocked,
            targetScope: scope,
            targetLabel: label,
            requiresPrivateRelease: Boolean(row["private"] && scope && scope !== "personal"),
          };
        }),
      );
      const applicationViews = await Promise.all(
        applications.map(async (row) => {
          let canRevert = false,
            targetLabel: string | null = null,
            targetScope: "personal" | "project" | "system" | null = null;
          if (projectId) {
            try {
              const scope = await database.client.begin((sql) =>
                targets.authorize(sql, learningTarget.parse(row["target"]), userId, projectId),
              );
              canRevert = row["state"] === "applied";
              targetLabel = scope.label;
              targetScope = scope.scope;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
            }
          }
          return {
            ...row,
            canRevert,
            targetLabel,
            targetScope,
            createdAt: new Date(row["createdAt"] as Date).toISOString(),
            revertedAt: row["revertedAt"]
              ? new Date(row["revertedAt"] as Date).toISOString()
              : null,
          };
        }),
      );
      const comparisons: Array<Record<string, unknown>> = projectId
        ? [
            ...(await db
              .select({
                id: learningTrial.id,
                proposalId: learningTrial.proposalId,
                phase: learningTrial.phase,
                title: typedSQL<string>`${proposalRecord.content}->>'title'`,
                state: learningTrial.state,
                reason: learningTrial.reason,
                modelId: learningTrial.modelId,
                rubric: learningTrial.rubric,
                createdAt: learningTrial.createdAt,
                result: learningTrial.result,
                candidateFirst: typedSQL<boolean>`(${learningTrial.input}->>'candidateFirst')::boolean`,
                evidence: typedSQL<unknown>`${learningTrial.input}->'cases'`,
                baselineTarget: typedSQL<unknown>`${learningTrial.input}->'baselineTarget'`,
                before: typedSQL<string>`${learningTrial.input}->>'before'`,
                after: typedSQL<string>`${learningTrial.input}->>'after'`,
                responses: typedSQL<unknown[]>`coalesce((${db
                  .select({
                    responses: typedSQL<
                      unknown[]
                    >`jsonb_agg(${learningTrialStep.result} ORDER BY ${learningTrialStep.stage})`,
                  })
                  .from(learningTrialStep)
                  .where(
                    and(
                      eq(learningTrialStep.trialId, learningTrial.id),
                      lt(learningTrialStep.stage, 2),
                      eq(learningTrialStep.state, "completed"),
                    ),
                  )}),'[]'::jsonb)`,
              })
              .from(learningTrial)
              .innerJoin(proposalRecord, eq(proposalRecord.id, learningTrial.proposalId))
              .innerJoin(learningReview, eq(learningReview.id, proposalRecord.reviewId))
              .where(reviewVisible)
              .orderBy(desc(learningTrial.createdAt))
              .limit(24)),
          ].map((row) => ({
            ...row,
            createdAt: new Date(row["createdAt"] as Date).toISOString(),
          }))
        : [];
      const fresh = await rights(userId, projectId, personal);
      if ((permitted.developer && !fresh.developer) || (permitted.manager && !fresh.manager))
        throw new CommandError(
          "conflict",
          "Project permissions changed while reading Monitoring. Refresh before continuing.",
        );
      return learningView.parse({
        projectId,
        scope: personal ? "personal" : "project",
        detailScope: !projectId ? "factory" : permitted.ownUsage ? "own" : "project",
        enabled: (policy?.enabled ?? true) && parentEnabled,
        automaticSkills: policy?.automaticSkills ?? false,
        parentEnabled,
        canManage: Boolean(projectId && (personal || permitted.manager)),
        version: policy?.version ?? 0,
        waiting: waiting?.count ?? 0,
        waitingSince: waiting ? new Date(waiting.since).toISOString() : null,
        waitingDeveloperOnly: waiting?.developerOnly ?? false,
        reviewRunning: Boolean(running),
        reviewRequestedAt: requested ? new Date(requested.requestedAt).toISOString() : null,
        calibration,
        days: [...days],
        reviews: reviews.map((row) => ({
          ...row,
          createdAt: new Date(row["createdAt"] as Date).toISOString(),
          completedAt: row["completedAt"]
            ? new Date(row["completedAt"] as Date).toISOString()
            : null,
        })),
        proposals: proposalViews.map((proposal) => {
          const trial = comparisons.find(
            (item) => item["proposalId"] === proposal["id"] && item["phase"] === "adopt",
          );
          return {
            ...proposal,
            comparisonState: !trial
              ? "untested"
              : trial["state"] === "running"
                ? "running"
                : trial["state"] === "completed"
                  ? "not-demonstrated"
                  : "unconfirmed",
          };
        }),
        applications: applicationViews,
        comparisons,
      });
    },
    async set(userId: string, raw: unknown) {
      const input = learningPolicyCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        await projectAuthorityIn(sql, userId, input.projectId, input.scope === "project");
        const existing = await replay(sql, input.commandId, userId, input);
        if (existing) return existing.result;
        const ownerId = input.scope === "personal" ? userId : null;
        const key = `${input.projectId}:${ownerId ?? "project"}`;
        await db.execute(
          typedSQL`SELECT pg_advisory_xact_lock(hashtext(${`learning-policy:${key}`}))`,
        );
        const [current] = await db
          .select({ version: learningPolicy.version })
          .from(learningPolicy)
          .where(eq(learningPolicy.scopeKey, key));
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "Learning settings changed. Reload before saving.");
        const values = {
          scopeKey: key,
          projectId: input.projectId,
          ownerId,
          enabled: input.enabled,
          automaticSkills: input.automaticSkills,
          version: input.expectedVersion + 1,
          updatedBy: userId,
        };
        await db
          .insert(learningPolicy)
          .values(values)
          .onConflictDoUpdate({
            target: learningPolicy.scopeKey,
            set: {
              enabled: values.enabled,
              automaticSkills: values.automaticSkills,
              version: values.version,
              updatedBy: userId,
              updatedAt: typedSQL`now()`,
            },
          });
        const result = { version: input.expectedVersion + 1 };
        await db
          .insert(learningCommand)
          .values({ id: input.commandId, actorId: userId, input, result });
        return result;
      });
    },
    async reviewNow(userId: string, raw: unknown) {
      const input = learningReviewNowCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const ownerId = input.scope === "personal" ? userId : null;
        const group = { projectId: input.projectId, ownerId, developerOnly: input.developerOnly };
        // Spending Planning-model calls on shared work needs the same current Project manager
        // as pausing it. Private work needs only its owner, plus Developer access when required.
        await learningAuthorityIn(sql, userId, {
          ...group,
          managerOnly: input.scope === "project",
        });
        const existing = await replay(sql, input.commandId, userId, input);
        if (existing) return existing.result;
        await db.execute(
          typedSQL`SELECT pg_advisory_xact_lock(hashtext(${`learning:${input.projectId}:${ownerId ?? "project"}:${input.developerOnly}`}))`,
        );
        if (!(await learningEnabledIn(sql, input.projectId, ownerId)))
          throw new CommandError("forbidden", "Learning is paused. Resume it to review now.");
        const [busy] = await db
          .select({ id: learningReview.id })
          .from(learningReview)
          .where(
            and(
              eq(learningReview.projectId, input.projectId),
              ownerId ? eq(learningReview.ownerId, ownerId) : isNull(learningReview.ownerId),
              eq(learningReview.developerOnly, input.developerOnly),
              eq(learningReview.state, "running"),
            ),
          );
        if (busy) throw new CommandError("conflict", "A review of this work is already running.");
        if (
          (await pendingReviewRequests(sql, { projectId: input.projectId, ownerId })).some(
            (item) => item.developerOnly === input.developerOnly,
          )
        )
          throw new CommandError("conflict", "A review of this work is already requested.");
        const limited = db
          .select({ id: caseRecord.id })
          .from(caseRecord)
          .where(
            and(
              eq(caseRecord.projectId, input.projectId),
              ownerId ? eq(caseRecord.ownerId, ownerId) : isNull(caseRecord.ownerId),
              eq(caseRecord.developerOnly, input.developerOnly),
              eq(caseRecord.selected, true),
              isNull(caseRecord.batchId),
              typedSQL`NOT(${caseRecord.activity}='wiki' AND ${caseRecord.id} ~ ${legacyWikiCallPattern})`,
              or(
                ne(caseRecord.activity, "setup"),
                exists(
                  db
                    .select({ userId: projectMembership.userId })
                    .from(projectMembership)
                    .where(
                      and(
                        eq(projectMembership.projectId, caseRecord.projectId),
                        eq(projectMembership.userId, caseRecord.reviewerId),
                        eq(projectMembership.manageProject, true),
                      ),
                    ),
                ),
                exists(
                  db
                    .select({ userId: administrator.userId })
                    .from(administrator)
                    .where(eq(administrator.userId, caseRecord.reviewerId)),
                ),
              ),
            ),
          )
          .limit(input.cases)
          .as("limited");
        const [eligible] = await db.select({ count: count() }).from(limited);
        if (!eligible?.count)
          throw new CommandError("conflict", "No selected case is waiting for a review.");
        const result = { cases: Math.min(eligible.count, input.cases) };
        await db
          .insert(learningCommand)
          .values({ id: input.commandId, actorId: userId, input, result });
        return result;
      });
    },
    async decide(userId: string, raw: unknown) {
      const input = learningDecisionCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const lockedProposal = alias(proposalRecord, "proposal");
        const [proposal] = await db
          .select({
            content: lockedProposal.content,
            state: lockedProposal.state,
            projectId: learningReview.projectId,
            ownerId: learningReview.ownerId,
            developerOnly: learningReview.developerOnly,
            cases: learningReview.input,
            managerOnly: typedSQL<boolean>`${learningReview.input} @> '[{"activity":"setup"}]'::jsonb`,
          })
          .from(lockedProposal)
          .innerJoin(learningReview, eq(learningReview.id, lockedProposal.reviewId))
          .where(eq(lockedProposal.id, input.proposalId))
          .for("update", { of: lockedProposal });
        if (!proposal) throw new CommandError("not-found", "Improvement not found");
        const content = learningProposal.parse(proposal.content);
        if (input.decision === "apply" && content.edit?.target.kind === "skill")
          await db.execute(typedSQL`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`);
        await learningAuthorityIn(sql, userId, proposal);
        if (!proposal.ownerId && input.decision !== "apply")
          await projectAuthorityIn(sql, userId, proposal.projectId, true);
        const scope =
          input.decision === "apply" && content.edit
            ? await targets.authorize(sql, content.edit.target, userId, proposal.projectId)
            : null;
        const existing = await replay(sql, input.commandId, userId, input);
        if (existing) return existing.result;
        if (proposal.state !== "proposed")
          throw new CommandError("conflict", "This improvement already has a decision");
        if (proposal.ownerId && input.decision === "create-ticket" && !input.releasePrivate)
          throw new CommandError(
            "forbidden",
            "Explicitly share the displayed private proposal before creating a shared Ticket",
          );
        if (
          input.decision === "create-ticket" &&
          content.edit &&
          input.editDigest !== learningEditDigest(content.edit)
        )
          throw new CommandError(
            "conflict",
            "Confirm the exact proposed edit before sharing it as a Ticket.",
          );
        if (input.decision === "apply") {
          if (!content.edit || !scope || input.editDigest !== learningEditDigest(content.edit))
            throw new CommandError(
              "conflict",
              "Confirm the exact proposed edit before applying it.",
            );
          if (proposal.ownerId && scope.scope !== "personal" && !input.releasePrivate)
            throw new CommandError(
              "forbidden",
              "Explicitly release this exact private edit before changing shared guidance.",
            );
          const cases = z.array(learningCase).parse(proposal.cases);
          validateLearningResult(
            {
              cases: cases.map((item) => ({
                caseId: item.id,
                fulfillment: "unknown",
                rework: "unknown",
                verification: "unknown",
                explanation: "Checking the proposed edit against retained evidence.",
                evidenceIds: [],
              })),
              findings: [],
              proposals: [content],
            },
            cases,
          );
          const [reverted] = await db
            .select({ id: learningApplication.id })
            .from(learningApplication)
            .innerJoin(proposalRecord, eq(proposalRecord.id, learningApplication.proposalId))
            .where(
              and(
                eq(learningApplication.state, "reverted"),
                eq(
                  typedSQL<string>`${learningApplication.target}->>'kind'`,
                  content.edit.target.kind,
                ),
                eq(typedSQL<string>`${learningApplication.target}->>'id'`, content.edit.target.id),
                eq(
                  typedSQL<string>`${learningApplication.target}->>'field'`,
                  content.edit.target.field,
                ),
                eq(
                  typedSQL<string>`${proposalRecord.content}->'edit'->>'after'`,
                  content.edit.after,
                ),
              ),
            )
            .limit(1);
          if (reverted)
            throw new CommandError(
              "conflict",
              "This edit was already rolled back. Reassess its cause rather than applying it again.",
            );
          const id = crypto.randomUUID(),
            revisionId = crypto.randomUUID();
          const saved = await targets.apply(sql, {
            edit: content.edit,
            userId,
            projectId: proposal.projectId,
            revisionId,
          });
          await db.insert(learningApplication).values({
            id,
            proposalId: input.proposalId,
            target: content.edit.target,
            editDigest: input.editDigest,
            activation: saved.activation,
            appliedRevisionId: saved.revisionId,
            appliedVersion: saved.version,
            appliedBy: userId,
          });
          await db
            .update(proposalRecord)
            .set({
              state: "applied",
              decisionId: input.commandId,
              decidedBy: userId,
              decidedAt: typedSQL`now()`,
            })
            .where(eq(proposalRecord.id, input.proposalId));
          const result = { applicationId: id, revisionId: saved.revisionId };
          await db
            .insert(learningCommand)
            .values({ id: input.commandId, actorId: userId, input, result });
          return result;
        }
        let ticketId: string | null = null;
        if (input.decision === "create-ticket") {
          ticketId = crypto.randomUUID();
          // Only this explicitly displayed proposal is shared, not its private
          // source packet, transcript, findings or personal configuration.
          const description = `AI work-review proposal. No implementation or Delivery is approved.\n\n${content.change}\n\nExpected effect\n${content.expectedEffect}\n\nValidation\n${content.validation}${
            content.edit
              ? `\n\nExact Settings edit request. Review it in the owning settings; this is not a repository implementation task.\nTarget ${JSON.stringify(content.edit.target)}\n\nBefore\n${content.edit.before}\n\nAfter\n${content.edit.after}`
              : ""
          }`;
          const canonical = canonicalRequirementContent({
            summary: content.change,
            acceptanceCriteria: [content.validation],
            nonGoals: [
              "Do not weaken security, confirmed requirements, independent review or protected Verification gates.",
              "Keep .forgejo/workflows/factory-verification.yml unchanged. Optimize project checks, tests or auxiliary CI instead.",
            ],
          });
          await insertInitialTicketIn(drizzleTransaction(sql), {
            id: ticketId,
            projectId: proposal.projectId,
            title: content.title,
            description,
            state: "ready",
            createdBy: userId,
            authoring: {
              requirement: { id: crypto.randomUUID(), canonicalContent: canonical },
              document: {
                id: crypto.randomUUID(),
                inputDigest: requirementDigest(canonical),
                authorKind: "ai",
              },
            },
          });
          await db.insert(ticketConversation).values({
            id: crypto.randomUUID(),
            projectId: proposal.projectId,
            ticketId,
            mode: "plan",
            createdBy: userId,
          });
        }
        await db
          .update(proposalRecord)
          .set({
            state: ticketId ? "ticket-created" : "dismissed",
            decisionId: input.commandId,
            decidedBy: userId,
            decidedAt: typedSQL`now()`,
            ticketId,
          })
          .where(eq(proposalRecord.id, input.proposalId));
        const result = { ticketId };
        await db
          .insert(learningCommand)
          .values({ id: input.commandId, actorId: userId, input, result });
        return result;
      });
    },
    async rollback(userId: string, raw: unknown) {
      const input = learningRollbackCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const lockedProposal = alias(proposalRecord, "proposal");
        const [identity] = await db
          .select({ proposalId: learningApplication.proposalId })
          .from(learningApplication)
          .where(eq(learningApplication.id, input.applicationId));
        if (!identity) throw new CommandError("not-found", "Applied improvement not found");
        const [source] = await db
          .select({
            projectId: learningReview.projectId,
            ownerId: learningReview.ownerId,
            developerOnly: learningReview.developerOnly,
            managerOnly: typedSQL<boolean>`${learningReview.input} @> '[{"activity":"setup"}]'::jsonb`,
          })
          .from(lockedProposal)
          .innerJoin(learningReview, eq(learningReview.id, lockedProposal.reviewId))
          .where(eq(lockedProposal.id, identity.proposalId))
          .for("update", { of: lockedProposal });
        const [application] = await db
          .select({
            target: learningApplication.target,
            state: learningApplication.state,
            revisionId: learningApplication.appliedRevisionId,
            version: learningApplication.appliedVersion,
            activation: learningApplication.activation,
          })
          .from(learningApplication)
          .where(eq(learningApplication.id, input.applicationId))
          .for("update");
        if (!source || !application)
          throw new CommandError("not-found", "Applied improvement not found");
        const target = learningTarget.parse(application.target);
        if (target.kind === "skill")
          await db.execute(typedSQL`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`);
        await learningAuthorityIn(sql, userId, source);
        await targets.authorize(sql, target, userId, source.projectId);
        const old = await replay(sql, input.commandId, userId, input);
        if (old) return old.result;
        if (application.state !== "applied" || application.revisionId !== input.expectedRevisionId)
          throw new CommandError("conflict", "This is not the current applied improvement.");
        const saved = await targets.revert(sql, {
          target,
          appliedRevisionId: application.revisionId,
          appliedVersion: application.version,
          activation: z.array(learningActivation).parse(application.activation),
          userId,
          projectId: source.projectId,
          revisionId: crypto.randomUUID(),
        });
        await db
          .update(learningApplication)
          .set({
            state: "reverted",
            revertedRevisionId: saved.revisionId,
            revertedVersion: saved.version,
            revertedBy: userId,
            revertedAt: typedSQL`now()`,
          })
          .where(eq(learningApplication.id, input.applicationId));
        const result = { revisionId: saved.revisionId, version: saved.version };
        await db
          .insert(learningCommand)
          .values({ id: input.commandId, actorId: userId, input, result });
        return result;
      });
    },
  };
}
