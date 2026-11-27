import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql as typedSQL,
} from "drizzle-orm";
import {
  LearningResultRejected,
  learningBatchDue,
  learningBatchSize,
  learningCase,
  learningRubric,
  legacyWikiCallPattern,
  maxCalibrationGrades,
} from "#conversation-domain/learning";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  administrator,
  learningCase as caseTable,
  learningProposal,
  learningReview,
  projectMembership,
} from "#db/schema";
import { CommandError } from "../command-error";
import {
  createModelConnections,
  createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import { knownModelRejection } from "../models/execution-policy";
import { installationPlanningConnection } from "../models/resolver";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { createLearningAutomation } from "./automation";
import { calibrationCases, calibrationPassed } from "./calibration";
import { reviewWork } from "./judge";
import { workReviewInstructions } from "./judge-contract";
import {
  type PriorProposal,
  priorProposalEvidence,
  validateWorkReviewResult,
} from "./prior-proposals";
import { learningRejectionReason } from "./rejection-reason";
import type { replayPlanning } from "./replay";
import { pendingReviewRequests, type ReviewRequest } from "./requests";
import { collectLearningCases, type LearningSourceCursor } from "./sources";

type Database = ReturnType<typeof createDatabase>;
type Group = { projectId: string; ownerId: string | null; developerOnly: boolean };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createLearningWorker(
  database: Database,
  input: {
    signingKey: string;
    review?: typeof reviewWork;
    replay?: typeof replayPlanning;
  },
) {
  const models = createModelSettingsController(database);
  const connections = createModelConnections(
    database,
    createOpenBaoModelSecrets(),
    input.signingKey,
    process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [],
  );
  const running = new Set<AbortController>();
  let sweeping = false;
  let closed = false;
  let groupCursor = "";
  let sourceCursor: LearningSourceCursor | null = null;
  const automation = createLearningAutomation(database, {
    async modelIn(sql, scope, actorId) {
      const modelId = await models.resolve("planning", sql, {
        projectID: scope.projectId,
        userID: actorId,
        personal: false,
      });
      const reference = await connections.reference("planning", sql);
      const fallback = reference ? null : installationPlanningConnection();
      return {
        modelId,
        reference: reference ?? null,
        fallback,
        judgeKey: hash({
          modelId,
          reference,
          endpoint: fallback?.baseURL ?? null,
          rubric: learningRubric,
          instructions: workReviewInstructions,
          calibration: calibrationCases,
        }),
      };
    },
    connect: async (model) => {
      if (model.reference)
        return connections.resolve(model.reference.connectionID, model.reference.version);
      if (!model.fallback)
        throw new CommandError("unavailable", "The admitted review model is unavailable");
      return model.fallback;
    },
    ...(input.review ? { review: input.review } : {}),
    ...(input.replay ? { replay: input.replay } : {}),
  });

  // An explicit request keeps every rule of the automatic batch: current authority, pause,
  // calibration, input bound and one running review per group. It only waives the batch trigger,
  // and it can never admit more cases than the requester was shown.
  async function admit(scope: Group, request?: ReviewRequest) {
    return database.client.begin(async (sql) => {
      const key = `${scope.projectId}:${scope.ownerId ?? "project"}:${scope.developerOnly}`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning:${key}`}))`;
      const db = drizzleTransaction(sql);
      if (!(await learningEnabledIn(sql, scope.projectId, scope.ownerId))) return null;
      const [busy] = await db
        .select({ id: learningReview.id })
        .from(learningReview)
        .where(
          and(
            eq(learningReview.projectId, scope.projectId),
            scope.ownerId === null
              ? isNull(learningReview.ownerId)
              : eq(learningReview.ownerId, scope.ownerId),
            eq(learningReview.developerOnly, scope.developerOnly),
            eq(learningReview.state, "running"),
          ),
        );
      if (busy) return null;
      const rows = await db
        .select({ snapshot: caseTable.snapshot, reviewerId: caseTable.reviewerId })
        .from(caseTable)
        .where(
          and(
            eq(caseTable.projectId, scope.projectId),
            scope.ownerId === null
              ? isNull(caseTable.ownerId)
              : eq(caseTable.ownerId, scope.ownerId),
            eq(caseTable.developerOnly, scope.developerOnly),
            eq(caseTable.selected, true),
            isNull(caseTable.batchId),
            or(
              ne(caseTable.activity, "wiki"),
              typedSQL<boolean>`${caseTable.id} !~ ${legacyWikiCallPattern}`,
            ),
            or(
              ne(caseTable.activity, "setup"),
              exists(
                db
                  .select({ userId: projectMembership.userId })
                  .from(projectMembership)
                  .where(
                    and(
                      eq(projectMembership.projectId, caseTable.projectId),
                      eq(projectMembership.userId, caseTable.reviewerId),
                      eq(projectMembership.manageProject, true),
                    ),
                  ),
              ),
              exists(
                db
                  .select({ userId: administrator.userId })
                  .from(administrator)
                  .where(eq(administrator.userId, caseTable.reviewerId)),
              ),
            ),
          ),
        )
        .orderBy(caseTable.settledAt, caseTable.id)
        .limit(request?.cases ?? learningBatchSize);
      const cases = rows.map((row) => learningCase.parse(row.snapshot));
      if (request ? !cases.length : !learningBatchDue(cases)) return null;
      // Split an unusually escape-heavy packet instead of admitting a call
      // that the native input guard would reject before inference.
      while (cases.length > 1 && Buffer.byteLength(JSON.stringify(cases)) > 128 * 1024) cases.pop();
      const managerOnly = cases.some((item) => item.activity === "setup");
      // Spending on shared work needs the same current Project manager as pausing it.
      const manager = managerOnly || Boolean(request && scope.ownerId === null);
      // Use an actual commissioner's current authority, never an installation
      // service identity to evade private or Developer-only evidence boundaries.
      let actorId: string | undefined;
      const candidates = request
        ? [request.actorId]
        : [...new Set(rows.map((row) => row.reviewerId))];
      for (const candidate of candidates) {
        try {
          await learningAuthorityIn(sql, candidate, {
            ...scope,
            managerOnly: manager,
          });
          actorId = candidate;
          break;
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
      if (!actorId) return null;
      const modelId = await models.resolve("planning", sql, {
        projectID: scope.projectId,
        userID: actorId,
        personal: false,
      });
      const reference = await connections.reference("planning", sql);
      // Missing configuration is not an uncertain paid attempt. Keep the
      // source pending until an actual model connection is available.
      const fallback = reference ? null : installationPlanningConnection();
      const judgeKey = hash({
        modelId,
        reference,
        endpoint: fallback?.baseURL ?? null,
        rubric: learningRubric,
        instructions: workReviewInstructions,
        calibration: calibrationCases,
      });
      // Expired or unknown calibration never authorizes another paid call.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-judge:${judgeKey}`}))`;
      const calibrations = await db
        .select({ state: learningReview.state, calibrated: learningReview.calibrated })
        .from(learningReview)
        .where(and(eq(learningReview.judgeKey, judgeKey), eq(learningReview.kind, "calibration")))
        .orderBy(desc(learningReview.createdAt));
      const calibration = calibrations[0];
      // A model can grade the fixed cases wrongly once and rightly the next time. Repeat a
      // completed failing grade a bounded number of times so one unlucky answer does not
      // disable learning for this exact judge. Unknown or rejected calls never repeat.
      const wrongGrades = calibrations.filter(
        (item) => item.state === "completed" && !item.calibrated,
      ).length;
      if (
        calibration &&
        (calibration.state !== "completed" ||
          (!calibration.calibrated && wrongGrades >= maxCalibrationGrades))
      )
        return null;
      const kind = calibration?.calibrated ? "work" : "calibration";
      const admittedCases = kind === "work" ? cases : calibrationCases;
      if (kind === "work" && admittedCases[0] && admittedCases[0].evidence.length < 24) {
        const previous: PriorProposal[] = await db
          .select({
            id: learningProposal.id,
            state: learningProposal.state,
            content: typedSQL<PriorProposal["content"]>`${learningProposal.content}`,
            applicationState: typedSQL<
              "applied" | "reverted" | null
            >`${learningProposal.application}->>'state'`,
          })
          .from(learningProposal)
          .innerJoin(learningReview, eq(learningReview.id, learningProposal.reviewId))
          .where(
            and(
              eq(learningReview.projectId, scope.projectId),
              scope.ownerId === null
                ? isNull(learningReview.ownerId)
                : eq(learningReview.ownerId, scope.ownerId),
              eq(learningReview.developerOnly, scope.developerOnly),
              managerOnly
                ? undefined
                : typedSQL<boolean>`not(${learningReview.input} @> '[{"activity":"setup"}]'::jsonb)`,
            ),
          )
          .orderBy(desc(learningReview.createdAt), learningProposal.ordinal)
          .limit(12);
        if (previous.length)
          admittedCases[0].evidence.push(priorProposalEvidence(previous, judgeKey));
      }
      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      await db.insert(learningReview).values({
        id,
        projectId: scope.projectId,
        ownerId: scope.ownerId,
        developerOnly: scope.developerOnly,
        reviewerId: actorId,
        kind,
        rubric: learningRubric,
        modelId,
        modelConnection: reference ?? null,
        judgeKey,
        state: "running",
        input: admittedCases,
        inputDigest: hash(admittedCases),
        ownerToken: token,
        ownerExpiresAt: typedSQL`now()+interval '2 minutes'`,
      });
      if (kind === "work")
        await db
          .update(caseTable)
          .set({ batchId: id })
          .where(
            and(
              inArray(
                caseTable.id,
                cases.map((item) => item.id),
              ),
              isNull(caseTable.batchId),
            ),
          );
      return {
        ...scope,
        managerOnly: manager,
        id,
        token,
        actorId,
        kind,
        modelId,
        reference,
        fallback,
        cases: admittedCases,
      };
    });
  }

  async function execute(admitted: NonNullable<Awaited<ReturnType<typeof admit>>>) {
    const controller = new AbortController();
    running.add(controller);
    const authorize = async () => {
      controller.signal.throwIfAborted();
      await database.client.begin(async (sql) => {
        await learningAuthorityIn(sql, admitted.actorId, admitted);
        if (!(await learningEnabledIn(sql, admitted.projectId, admitted.ownerId)))
          throw new CommandError("forbidden", "Learning is paused");
        const [owned] = await drizzleTransaction(sql)
          .update(learningReview)
          .set({ ownerExpiresAt: typedSQL`now()+interval '2 minutes'` })
          .where(
            and(
              eq(learningReview.id, admitted.id),
              eq(learningReview.ownerToken, admitted.token),
              eq(learningReview.state, "running"),
              gt(learningReview.ownerExpiresAt, typedSQL`now()`),
            ),
          )
          .returning({ id: learningReview.id });
        if (!owned) throw new CommandError("conflict", "Work review ownership expired");
      });
    };
    let renewal: Promise<unknown> | undefined;
    const renewalTimer = setInterval(() => {
      if (renewal) return;
      renewal = authorize()
        .catch(() => controller.abort())
        .finally(() => {
          renewal = undefined;
        });
    }, 15_000);
    renewalTimer.unref();
    try {
      await authorize();
      const connection = admitted.reference
        ? await connections.resolve(admitted.reference.connectionID, admitted.reference.version)
        : admitted.fallback;
      if (!connection)
        throw new CommandError("unavailable", "The admitted review model is unavailable");
      const result = validateWorkReviewResult(
        await (input.review ?? reviewWork)({
          cases: admitted.cases,
          modelId: admitted.modelId,
          connection,
          signal: controller.signal,
          authorize,
          usage: recordedMastraUsage(database, {
            id: `learning:${admitted.id}`,
            projectID: admitted.projectId,
            userID: admitted.actorId,
            purpose: "learning",
            provider: connection.provider ?? "openai",
            model: admitted.modelId,
          }),
        }),
        admitted.cases,
      );
      await database.client.begin(async (sql) => {
        await learningAuthorityIn(sql, admitted.actorId, admitted);
        if (!(await learningEnabledIn(sql, admitted.projectId, admitted.ownerId)))
          throw new CommandError("forbidden", "Learning is paused");
        const db = drizzleTransaction(sql);
        const [owned] = await db
          .update(learningReview)
          .set({
            state: "completed",
            result,
            calibrated: admitted.kind === "calibration" ? calibrationPassed(result) : null,
            completedAt: typedSQL`now()`,
          })
          .where(
            and(
              eq(learningReview.id, admitted.id),
              eq(learningReview.ownerToken, admitted.token),
              eq(learningReview.state, "running"),
              gt(learningReview.ownerExpiresAt, typedSQL`now()`),
            ),
          )
          .returning({ id: learningReview.id });
        if (!owned)
          throw new CommandError("conflict", "Work review lost ownership before settlement");
        if (admitted.kind === "work")
          for (const [ordinal, proposal] of result.proposals.entries())
            await db.insert(learningProposal).values({
              id: crypto.randomUUID(),
              reviewId: admitted.id,
              ordinal,
              content: proposal,
            });
      });
    } catch (cause) {
      // The lease is not proof no inference happened. Uncertain calls are
      // retained, never silently returned to the pending work queue.
      const rejected = cause instanceof LearningResultRejected;
      const state = knownModelRejection(cause) || rejected ? "failed" : "uncertain";
      await database.db
        .update(learningReview)
        .set({
          state,
          reason: rejected
            ? learningRejectionReason(
                cause,
                "The model's review did not match the evidence it was given, so it was discarded. It will not be repeated automatically.",
              )
            : state === "failed"
              ? "The model rejected this review."
              : "Review outcome is unconfirmed. It will not be repeated automatically.",
          completedAt: typedSQL`now()`,
        })
        .where(
          and(
            eq(learningReview.id, admitted.id),
            eq(learningReview.state, "running"),
            eq(learningReview.ownerToken, admitted.token),
          ),
        );
      await createUsageJournal(database).abandon(`learning:${admitted.id}`);
    } finally {
      clearInterval(renewalTimer);
      await renewal;
      running.delete(controller);
    }
  }

  async function sweep() {
    if (closed || sweeping) return;
    sweeping = true;
    try {
      const expired = await database.db
        .update(learningReview)
        .set({
          state: "uncertain",
          completedAt: typedSQL`now()`,
          reason: "Review ownership expired. The paid call will not be repeated automatically.",
        })
        .where(
          and(
            eq(learningReview.state, "running"),
            lt(learningReview.ownerExpiresAt, typedSQL`now()`),
          ),
        )
        .returning({ id: learningReview.id });
      for (const row of expired) await createUsageJournal(database).abandon(`learning:${row.id}`);
      // Deferred source settlement cannot hide later completed work forever.
      // The scan position is ephemeral; case identity/deduplication is durable.
      sourceCursor = await collectLearningCases(database, sourceCursor);
      // One bounded comparison or one review per sweep, never parallel fan-out.
      if (await automation.sweep()) return;
      for (const request of await pendingReviewRequests(database.client)) {
        if (closed) break;
        try {
          const admitted = await admit(
            {
              projectId: request.projectId,
              ownerId: request.ownerId,
              developerOnly: request.developerOnly,
            },
            request,
          );
          if (admitted) {
            await execute(admitted);
            return;
          }
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
      const groupKey = typedSQL<string>`${caseTable.projectId}::text||':'||coalesce(${caseTable.ownerId}::text,'project')||':'||${caseTable.developerOnly}::text`;
      const pendingGroups = () =>
        database.db
          .select({
            projectId: caseTable.projectId,
            ownerId: caseTable.ownerId,
            developerOnly: caseTable.developerOnly,
            key: groupKey,
          })
          .from(caseTable)
          .where(
            and(
              eq(caseTable.selected, true),
              isNull(caseTable.batchId),
              or(
                ne(caseTable.activity, "wiki"),
                typedSQL<boolean>`${caseTable.id} !~ ${legacyWikiCallPattern}`,
              ),
              gt(groupKey, groupCursor),
            ),
          )
          .groupBy(caseTable.projectId, caseTable.ownerId, caseTable.developerOnly)
          .orderBy(groupKey)
          .limit(32);
      let groups = await pendingGroups();
      if (!groups.length && groupCursor) {
        groupCursor = "";
        groups = await pendingGroups();
      }
      for (const group of groups) {
        if (closed) break;
        groupCursor = group.key;
        try {
          const admitted = await admit(group);
          if (admitted) {
            await execute(admitted);
            break; // One active model call, not a fan-out after every Turn.
          }
        } catch (cause) {
          if (!(cause instanceof CommandError)) throw cause;
        }
      }
    } finally {
      sweeping = false;
    }
  }
  return {
    sweep,
    close() {
      closed = true;
      automation.close();
      for (const controller of running) controller.abort();
    },
  };
}
