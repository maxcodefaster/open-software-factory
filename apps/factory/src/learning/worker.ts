import { createHash } from "node:crypto";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  learningBatchDue,
  learningCase,
  learningRubric,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import { createModelSettingsController } from "../models/controller";
import { createModelConnections } from "../models/connections";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { projectModelConnection } from "../project-agent/adapter";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import { knownModelRejection } from "../models/execution-policy";
import { CommandError } from "../command-error";
import { learningAuthorityIn, learningEnabledIn } from "./authority";
import { calibrationCases, calibrationPassed } from "./calibration";
import { collectLearningCases, type LearningSourceCursor } from "./sources";
import { reviewWork, workReviewInstructions } from "./judge";
import { createLearningAutomation } from "./automation";
import type { replayPlanning } from "./replay";

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
        personal: scope.ownerId !== null,
      });
      const reference = await connections.reference("planning", sql);
      const fallback = reference ? null : projectModelConnection();
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

  async function admit(scope: Group) {
    return database.client.begin(async (sql) => {
      const key = `${scope.projectId}:${scope.ownerId ?? "project"}:${scope.developerOnly}`;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning:${key}`}))`;
      if (!(await learningEnabledIn(sql, scope.projectId, scope.ownerId))) return null;
      const [busy] =
        await sql`SELECT id FROM factory.learning_review WHERE project_id=${scope.projectId}
        AND owner_id IS NOT DISTINCT FROM ${scope.ownerId}::uuid AND developer_only=${scope.developerOnly} AND state='running'`;
      if (busy) return null;
      const rows = await sql<{ snapshot: unknown; reviewerId: string }[]>`
        SELECT source.snapshot,source.reviewer_id AS "reviewerId" FROM factory.learning_case source
        WHERE source.project_id=${scope.projectId} AND source.owner_id IS NOT DISTINCT FROM ${scope.ownerId}::uuid
          AND source.developer_only=${scope.developerOnly} AND source.selected AND source.batch_id IS NULL
          AND (source.activity<>'setup' OR EXISTS(SELECT 1 FROM factory.project_membership membership
            WHERE membership.project_id=source.project_id AND membership.user_id=source.reviewer_id AND membership.manage_project)
            OR EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=source.reviewer_id))
        ORDER BY source.settled_at,source.id LIMIT 6`;
      const cases = rows.map((row) => learningCase.parse(row.snapshot));
      if (!learningBatchDue(cases)) return null;
      // Split an unusually escape-heavy packet instead of admitting a call
      // that the native input guard would reject before inference.
      while (cases.length > 1 && Buffer.byteLength(JSON.stringify(cases)) > 128 * 1024) cases.pop();
      const managerOnly = cases.some((item) => item.activity === "setup");
      // Use an actual commissioner's current authority, never an installation
      // service identity to evade private or Developer-only evidence boundaries.
      let actorId: string | undefined;
      for (const candidate of [...new Set(rows.map((row) => row.reviewerId))]) {
        try {
          await learningAuthorityIn(sql, candidate, { ...scope, managerOnly });
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
        personal: scope.ownerId !== null,
      });
      const reference = await connections.reference("planning", sql);
      // Missing configuration is not an uncertain paid attempt. Keep the
      // source pending until an actual model connection is available.
      const fallback = reference ? null : projectModelConnection();
      const judgeKey = hash({
        modelId,
        reference,
        endpoint: fallback?.baseURL ?? null,
        rubric: learningRubric,
        instructions: workReviewInstructions,
        calibration: calibrationCases,
      });
      // Only one calibration per exact judge configuration. Expired/unknown
      // calibration does not authorize another paid call.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-judge:${judgeKey}`}))`;
      const [calibration] = await sql<{ state: string; calibrated: boolean | null }[]>`
        SELECT state,calibrated FROM factory.learning_review WHERE judge_key=${judgeKey} AND kind='calibration'
        ORDER BY created_at DESC LIMIT 1`;
      if (calibration && (calibration.state !== "completed" || !calibration.calibrated))
        return null;
      const kind = calibration ? "work" : "calibration";
      const admittedCases = kind === "work" ? cases : calibrationCases;
      if (kind === "work" && admittedCases[0] && admittedCases[0].evidence.length < 24) {
        const previous = await sql<
          {
            id: string;
            state: string;
            content: { title: string; change: string; target: string };
            applicationState: string | null;
          }[]
        >`
          SELECT proposal.id,proposal.state,proposal.content,application.state AS "applicationState" FROM factory.learning_proposal proposal
          JOIN factory.learning_review review ON review.id=proposal.review_id
          LEFT JOIN factory.learning_application application ON application.proposal_id=proposal.id
          WHERE review.project_id=${scope.projectId} AND review.owner_id IS NOT DISTINCT FROM ${scope.ownerId}::uuid
            AND review.developer_only=${scope.developerOnly}
            AND (${managerOnly} OR NOT(review.input @> '[{"activity":"setup"}]'::jsonb))
          ORDER BY review.created_at DESC,proposal.ordinal LIMIT 12`;
        if (previous.length)
          admittedCases[0].evidence.push({
            id: `learning:prior-proposals:${judgeKey}`,
            kind: "configuration",
            truncated: true,
            body: JSON.stringify(
              previous.map((item) => ({
                id: item.id,
                state: item.state,
                applicationState: item.applicationState,
                title: item.content.title,
                target: item.content.target,
                change: item.content.change.slice(0, 400),
              })),
            ),
          });
      }
      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      await sql`INSERT INTO factory.learning_review(id,project_id,owner_id,developer_only,reviewer_id,kind,rubric,
        model_id,model_connection,judge_key,state,input,input_digest,owner_token,owner_expires_at)
        VALUES(${id},${scope.projectId},${scope.ownerId},${scope.developerOnly},${actorId},${kind},${learningRubric},
          ${modelId},${reference ? JSON.stringify(reference) : null}::jsonb,${judgeKey},'running',
          ${JSON.stringify(admittedCases)}::jsonb,${hash(admittedCases)},${token},now()+interval '2 minutes')`;
      if (kind === "work")
        await sql`UPDATE factory.learning_case SET batch_id=${id} WHERE id=ANY(${cases.map((item) => item.id)}::text[]) AND batch_id IS NULL`;
      return {
        ...scope,
        managerOnly,
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
        const [owned] =
          await sql`UPDATE factory.learning_review SET owner_expires_at=now()+interval '2 minutes'
          WHERE id=${admitted.id} AND owner_token=${admitted.token} AND state='running' AND owner_expires_at>now() RETURNING id`;
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
      const result = validateLearningResult(
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
        const [owned] =
          await sql`UPDATE factory.learning_review SET state='completed',result=${JSON.stringify(result)}::jsonb,
          calibrated=${admitted.kind === "calibration" ? calibrationPassed(result) : null},completed_at=now()
          WHERE id=${admitted.id} AND owner_token=${admitted.token} AND state='running' AND owner_expires_at>now() RETURNING id`;
        if (!owned)
          throw new CommandError("conflict", "Work review lost ownership before settlement");
        if (admitted.kind === "work")
          for (const [ordinal, proposal] of result.proposals.entries())
            await sql`INSERT INTO factory.learning_proposal(id,review_id,ordinal,content)
              VALUES(${crypto.randomUUID()},${admitted.id},${ordinal},${JSON.stringify(proposal)}::jsonb)`;
      });
    } catch (cause) {
      // The lease is not proof no inference happened. Uncertain calls are
      // retained, never silently returned to the pending work queue.
      const state = knownModelRejection(cause) ? "failed" : "uncertain";
      await database.client`UPDATE factory.learning_review SET state=${state},
        reason=${state === "failed" ? "The model rejected this review." : "Review outcome is unconfirmed. It will not be repeated automatically."},
        completed_at=now() WHERE id=${admitted.id} AND state='running' AND owner_token=${admitted.token}`;
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
      const expired = await database.client<{ id: string }[]>`
        UPDATE factory.learning_review SET state='uncertain',completed_at=now(),
          reason='Review ownership expired. The paid call will not be repeated automatically.'
        WHERE state='running' AND owner_expires_at<now() RETURNING id`;
      for (const row of expired) await createUsageJournal(database).abandon(`learning:${row.id}`);
      // Deferred source settlement cannot hide later completed work forever.
      // The scan position is ephemeral; case identity/deduplication is durable.
      sourceCursor = await collectLearningCases(database, sourceCursor);
      // One bounded comparison or one review per sweep, never parallel fan-out.
      if (await automation.sweep()) return;
      const pendingGroups = () => database.client<(Group & { key: string })[]>`
        SELECT project_id AS "projectId",owner_id AS "ownerId",developer_only AS "developerOnly",
          project_id::text||':'||coalesce(owner_id::text,'project')||':'||developer_only::text AS key
        FROM factory.learning_case WHERE selected AND batch_id IS NULL
          AND project_id::text||':'||coalesce(owner_id::text,'project')||':'||developer_only::text > ${groupCursor}
        GROUP BY project_id,owner_id,developer_only ORDER BY key LIMIT 32`;
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
