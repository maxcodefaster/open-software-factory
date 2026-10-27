import type { createDatabase } from "../../../../packages/db/src/client";
import { isDeepStrictEqual } from "node:util";
import {
  learningDecisionCommand,
  learningPolicyCommand,
  learningProposal,
  learningView,
  learningCase,
  learningRollbackCommand,
  learningTarget,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import { createRequirementRevision } from "../../../../packages/requirement-domain/src/requirement";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { learningAuthorityIn } from "./authority";
import { createLearningTargets, learningActivation, learningEditDigest } from "./targets";
import { z } from "zod";

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
  async function replay(sql: AgentTurnTransaction, id: string, actorId: string, input: unknown) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-command:${id}`}))`;
    const [existing] = await sql<{ actorId: string; input: unknown; result: unknown }[]>`
      SELECT actor_id AS "actorId",input,result FROM factory.learning_command WHERE id=${id}`;
    if (existing && (existing.actorId !== actorId || !isDeepStrictEqual(existing.input, input)))
      throw new CommandError("conflict", "Learning command identity was reused");
    return existing;
  }
  return {
    async get(userId: string, projectId: string | null, personal = false) {
      const permitted = await rights(userId, projectId, personal);
      const ownerId = personal ? userId : null;
      const policies = projectId
        ? await database.client<
            {
              ownerId: string | null;
              enabled: boolean;
              automaticSkills: boolean;
              version: number;
            }[]
          >`
        SELECT owner_id AS "ownerId",enabled,automatic_skills AS "automaticSkills",version FROM factory.learning_policy WHERE project_id=${projectId}
          AND (owner_id IS NULL OR owner_id=${ownerId})`
        : [];
      const policy = policies.find((item) => item.ownerId === ownerId);
      const parentEnabled = policies.find((item) => item.ownerId === null)?.enabled ?? true;
      const days = await database.client`
        WITH dates AS (
          SELECT generate_series((now() AT TIME ZONE 'UTC')::date-27,(now() AT TIME ZONE 'UTC')::date,interval '1 day')::date AS day
        ), operations AS (
          SELECT (settled_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS operations,
            count(*) FILTER(WHERE outcome='completed')::int AS completed,
            count(*) FILTER(WHERE outcome IN ('failed','interrupted'))::int AS failed,
            count(*) FILTER(WHERE outcome='unknown')::int AS unknown,
            bool_or(NOT EXISTS(SELECT 1 FROM factory.usage_entry entry WHERE entry.operation_id=factory.usage_operation.id)) AS missing_usage,
            percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM settled_at-created_at))::float8 AS elapsed
          FROM factory.usage_operation
          WHERE settled_at >= ((now() AT TIME ZONE 'UTC')::date-27) AT TIME ZONE 'UTC'
            AND (${projectId}::uuid IS NULL OR project_id=${projectId})
            AND (NOT ${permitted.ownUsage} OR user_id=${userId})
            AND purpose NOT IN ('probe','learning') GROUP BY 1
        ), costs AS (
          SELECT (entry.occurred_at AT TIME ZONE 'UTC')::date AS day,
            sum(entry.known_nano_usd)::text AS cost,bool_or(entry.nano_usd IS NULL) AS incomplete
          FROM factory.usage_entry entry JOIN factory.usage_operation operation ON operation.id=entry.operation_id
          WHERE entry.occurred_at>=((now() AT TIME ZONE 'UTC')::date-27) AT TIME ZONE 'UTC'
            AND (${projectId}::uuid IS NULL OR operation.project_id=${projectId})
            AND (NOT ${permitted.ownUsage} OR operation.user_id=${userId}) AND operation.purpose<>'probe' GROUP BY 1
        ), covered AS (
          SELECT (source.settled_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS observed,
            count(*) FILTER(WHERE source.selected)::int AS selected,
            count(result.value)::int AS reviewed,
            count(*) FILTER(WHERE result.value->>'fulfillment'='supported')::int AS supported,
            count(*) FILTER(WHERE result.value->>'fulfillment'='problem')::int AS problems,
            count(*) FILTER(WHERE result.value->>'rework'='avoidable')::int AS avoidable,
            count(*) FILTER(WHERE result.value->>'rework' IN ('avoidable','necessary'))::int AS rework_known
          FROM factory.learning_case source
          LEFT JOIN factory.learning_review review ON review.id=source.batch_id AND review.state='completed' AND review.kind='work'
          LEFT JOIN LATERAL jsonb_array_elements(review.result->'cases') result(value) ON result.value->>'caseId'=source.id
          WHERE source.settled_at>=((now() AT TIME ZONE 'UTC')::date-27) AT TIME ZONE 'UTC'
            AND (${projectId}::uuid IS NULL OR source.project_id=${projectId})
            AND source.owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
            AND (NOT source.developer_only OR ${permitted.developer})
            AND (source.activity<>'setup' OR ${permitted.manager})
          GROUP BY 1
        )
        SELECT dates.day::text AS date,coalesce(operations.operations,0) AS operations,
          coalesce(operations.completed,0) AS completed,coalesce(operations.failed,0) AS failed,
          coalesce(operations.unknown,0) AS unknown,coalesce(costs.cost,'0') AS "knownNanoUSD",
          (coalesce(costs.incomplete,false) OR coalesce(operations.missing_usage,false)) AS incomplete,operations.elapsed AS "elapsedSeconds",
          coalesce(covered.observed,0) AS observed,coalesce(covered.selected,0) AS selected,
          coalesce(covered.reviewed,0) AS reviewed,coalesce(covered.supported,0) AS supported,
          coalesce(covered.problems,0) AS problems,coalesce(covered.avoidable,0) AS avoidable,
          coalesce(covered.rework_known,0) AS "reworkKnown"
        FROM dates LEFT JOIN operations USING(day) LEFT JOIN costs USING(day) LEFT JOIN covered USING(day) ORDER BY dates.day`;
      let reviews: Array<Record<string, unknown>> = projectId
        ? await database.client`
        SELECT id,kind,state,model_id AS "modelId",rubric,calibrated,reason,
          created_at AS "createdAt",completed_at AS "completedAt",result,input AS cases
        FROM factory.learning_review WHERE project_id=${projectId}
          AND owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
          AND (NOT developer_only OR ${permitted.developer})
          AND (${permitted.manager} OR NOT(input @> '[{"activity":"setup"}]'::jsonb))
        ORDER BY created_at DESC LIMIT 12`
        : [];
      const proposals = projectId
        ? await database.client`
        SELECT proposal.id,proposal.review_id AS "reviewId",proposal.content,proposal.state,
          proposal.ticket_id AS "ticketId",(review.owner_id IS NOT NULL) AS private
        FROM factory.learning_proposal proposal JOIN factory.learning_review review ON review.id=proposal.review_id
        WHERE review.project_id=${projectId} AND review.owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
          AND (NOT review.developer_only OR ${permitted.developer})
          AND (${permitted.manager} OR NOT(review.input @> '[{"activity":"setup"}]'::jsonb))
        ORDER BY review.created_at DESC,proposal.ordinal LIMIT 24`
        : [];
      // Pending proposals can outlive the recent-history window. Always return
      // their exact supporting reviews, under the same visibility predicate.
      const missing = [...new Set(proposals.map((item) => String(item["reviewId"])))].filter(
        (id) => !reviews.some((review) => review["id"] === id),
      );
      if (projectId && missing.length) {
        const sources = await database.client`
          SELECT id,kind,state,model_id AS "modelId",rubric,calibrated,reason,
            created_at AS "createdAt",completed_at AS "completedAt",result,input AS cases
          FROM factory.learning_review WHERE id=ANY(${missing}::uuid[]) AND project_id=${projectId}
            AND owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
            AND (NOT developer_only OR ${permitted.developer})
            AND (${permitted.manager} OR NOT(input @> '[{"activity":"setup"}]'::jsonb))
          ORDER BY created_at DESC`;
        reviews = [...reviews, ...sources];
      }
      const applications = projectId
        ? await database.client`
        SELECT application.id,application.proposal_id AS "proposalId",application.target,
          proposal.content->>'title' AS title,proposal.content->'edit' AS edit,
          application.applied_revision_id AS "appliedRevisionId",application.applied_version AS "appliedVersion",
          application.state,application.created_at AS "createdAt",application.reverted_at AS "revertedAt",
          (application.comparison_id IS NOT NULL) AS automatic,(application.reverted_comparison_id IS NOT NULL) AS "automaticRecovery",
          jsonb_build_object('sampled',coalesce(subsequent.sampled,0),'reviewed',coalesce(subsequent.reviewed,0),
            'problems',coalesce(subsequent.problems,0),'cases',coalesce(subsequent.cases,'[]'::jsonb)) AS subsequent
        FROM factory.learning_application application
        JOIN factory.learning_proposal proposal ON proposal.id=application.proposal_id
        JOIN factory.learning_review review ON review.id=proposal.review_id
        LEFT JOIN LATERAL (
          SELECT max(recent.sampled)::int AS sampled,max(recent.reviewed)::int AS reviewed,max(recent.problems)::int AS problems,
            jsonb_agg(jsonb_build_object('source',recent.snapshot,'reviewId',recent.review_id,'verdict',recent.verdict)
              ORDER BY recent.settled_at DESC,recent.id) AS cases FROM (
          SELECT source.id,source.snapshot,source.settled_at,later.id AS review_id,verdict.value AS verdict,
            count(*) OVER() AS sampled,count(verdict.value) OVER() AS reviewed,
            count(*) FILTER(WHERE verdict.value->>'fulfillment'='problem') OVER() AS problems
          FROM factory.learning_case source
          LEFT JOIN factory.learning_review later ON later.id=source.batch_id AND later.state='completed' AND later.kind='work'
          LEFT JOIN LATERAL jsonb_array_elements(later.result->'cases') verdict(value) ON verdict.value->>'caseId'=source.id
          WHERE source.project_id=review.project_id AND source.owner_id IS NOT DISTINCT FROM review.owner_id
            AND source.developer_only=review.developer_only AND source.selected
            AND source.snapshot->'targets' @> jsonb_build_array(jsonb_build_object('target',jsonb_build_object(
              'kind',application.target->>'kind','id',application.target->>'id','revisionId',application.applied_revision_id::text)))
            AND (${permitted.manager} OR source.activity<>'setup')
          ORDER BY source.settled_at DESC,source.id LIMIT 3
          ) recent
        ) subsequent ON true
        WHERE review.project_id=${projectId} AND review.owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
          AND (NOT review.developer_only OR ${permitted.developer})
          AND (${permitted.manager} OR NOT(review.input @> '[{"activity":"setup"}]'::jsonb))
        ORDER BY application.created_at DESC LIMIT 24`
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
            ...(await database.client`
        SELECT trial.id,trial.proposal_id AS "proposalId",trial.phase,proposal.content->>'title' AS title,
          trial.state,trial.reason,trial.model_id AS "modelId",trial.rubric,trial.created_at AS "createdAt",trial.result,
          (trial.input->>'candidateFirst')::boolean AS "candidateFirst",trial.input->'cases' AS evidence,
          trial.input->'baselineTarget' AS "baselineTarget",trial.input->>'before' AS before,trial.input->>'after' AS after,
          coalesce((SELECT jsonb_agg(step.result ORDER BY step.stage) FROM factory.learning_trial_step step
            WHERE step.trial_id=trial.id AND step.stage<2 AND step.state='completed'),'[]'::jsonb) AS responses
        FROM factory.learning_trial trial JOIN factory.learning_proposal proposal ON proposal.id=trial.proposal_id
        JOIN factory.learning_review review ON review.id=proposal.review_id
        WHERE review.project_id=${projectId} AND review.owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
          AND (NOT review.developer_only OR ${permitted.developer})
          AND (${permitted.manager} OR NOT(review.input @> '[{"activity":"setup"}]'::jsonb))
        ORDER BY trial.created_at DESC LIMIT 24`),
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
        await projectAuthorityIn(sql, userId, input.projectId, input.scope === "project");
        const existing = await replay(sql, input.commandId, userId, input);
        if (existing) return existing.result;
        const ownerId = input.scope === "personal" ? userId : null;
        const key = `${input.projectId}:${ownerId ?? "project"}`;
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`learning-policy:${key}`}))`;
        const [current] = await sql<
          { version: number }[]
        >`SELECT version FROM factory.learning_policy WHERE scope_key=${key}`;
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "Learning settings changed. Reload before saving.");
        await sql`INSERT INTO factory.learning_policy(scope_key,project_id,owner_id,enabled,automatic_skills,version,updated_by)
          VALUES(${key},${input.projectId},${ownerId},${input.enabled},${input.automaticSkills},${input.expectedVersion + 1},${userId})
          ON CONFLICT(scope_key) DO UPDATE SET enabled=EXCLUDED.enabled,automatic_skills=EXCLUDED.automatic_skills,
            version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()`;
        const result = { version: input.expectedVersion + 1 };
        await sql`INSERT INTO factory.learning_command(id,actor_id,input,result)
          VALUES(${input.commandId},${userId},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
        return result;
      });
    },
    async decide(userId: string, raw: unknown) {
      const input = learningDecisionCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const [proposal] = await sql<
          {
            content: unknown;
            state: string;
            projectId: string;
            ownerId: string | null;
            developerOnly: boolean;
            managerOnly: boolean;
            cases: unknown;
          }[]
        >`SELECT proposal.content,proposal.state,review.project_id AS "projectId",review.owner_id AS "ownerId",
          review.developer_only AS "developerOnly",review.input AS cases,(review.input @> '[{"activity":"setup"}]'::jsonb) AS "managerOnly" FROM factory.learning_proposal proposal
          JOIN factory.learning_review review ON review.id=proposal.review_id WHERE proposal.id=${input.proposalId} FOR UPDATE OF proposal`;
        if (!proposal) throw new CommandError("not-found", "Improvement not found");
        const content = learningProposal.parse(proposal.content);
        if (input.decision === "apply" && content.edit?.target.kind === "skill")
          await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
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
          const [reverted] = await sql`
            SELECT application.id FROM factory.learning_application application
            JOIN factory.learning_proposal previous ON previous.id=application.proposal_id
            WHERE application.state='reverted' AND application.target->>'kind'=${content.edit.target.kind}
              AND application.target->>'id'=${content.edit.target.id} AND application.target->>'field'=${content.edit.target.field}
              AND previous.content->'edit'->>'after'=${content.edit.after} LIMIT 1`;
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
          await sql`INSERT INTO factory.learning_application(id,proposal_id,target,edit_digest,activation,applied_revision_id,applied_version,applied_by)
            VALUES(${id},${input.proposalId},${JSON.stringify(content.edit.target)}::jsonb,${input.editDigest},
              ${JSON.stringify(saved.activation)}::jsonb,${saved.revisionId},${saved.version},${userId})`;
          await sql`UPDATE factory.learning_proposal SET state='applied',decision_id=${input.commandId},decided_by=${userId},decided_at=now()
            WHERE id=${input.proposalId}`;
          const result = { applicationId: id, revisionId: saved.revisionId };
          await sql`INSERT INTO factory.learning_command(id,actor_id,input,result)
            VALUES(${input.commandId},${userId},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
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
          const revision = createRequirementRevision({
            id: crypto.randomUUID(),
            ticketId,
            ordinal: 1,
            content: {
              summary: content.change,
              acceptanceCriteria: [content.validation],
              nonGoals: [
                "Do not weaken security, confirmed requirements, independent review or protected Verification gates.",
                "Keep .forgejo/workflows/factory-verification.yml unchanged. Optimize project checks, tests or auxiliary CI instead.",
              ],
            },
          });
          await sql`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
            VALUES(${ticketId},${proposal.projectId},${content.title},${description},'ready',${userId})`;
          await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
            VALUES(${revision.id},${ticketId},1,${revision.canonicalContent},${revision.contentDigest},${userId})`;
          await sql`INSERT INTO factory.ticket_document_revision(id,ticket_id,ordinal,title,description,canonical_content,
            content_digest,requirement_revision_id,input_digest,created_by,author_kind)
            VALUES(${crypto.randomUUID()},${ticketId},1,${content.title},${description},${revision.canonicalContent},
              ${revision.contentDigest},${revision.id},${revision.contentDigest},${userId},'ai')`;
          await sql`INSERT INTO factory.ticket_conversation(id,project_id,ticket_id,mode,created_by)
            VALUES(${crypto.randomUUID()},${proposal.projectId},${ticketId},'plan',${userId})`;
        }
        await sql`UPDATE factory.learning_proposal SET state=${ticketId ? "ticket-created" : "dismissed"},
          decision_id=${input.commandId},decided_by=${userId},decided_at=now(),ticket_id=${ticketId} WHERE id=${input.proposalId}`;
        const result = { ticketId };
        await sql`INSERT INTO factory.learning_command(id,actor_id,input,result)
          VALUES(${input.commandId},${userId},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
        return result;
      });
    },
    async rollback(userId: string, raw: unknown) {
      const input = learningRollbackCommand.parse(raw);
      return database.client.begin(async (sql) => {
        const [identity] = await sql<{ proposalId: string }[]>`
          SELECT proposal_id AS "proposalId" FROM factory.learning_application WHERE id=${input.applicationId}`;
        if (!identity) throw new CommandError("not-found", "Applied improvement not found");
        const [source] = await sql<
          {
            projectId: string;
            ownerId: string | null;
            developerOnly: boolean;
            managerOnly: boolean;
          }[]
        >`
          SELECT review.project_id AS "projectId",review.owner_id AS "ownerId",review.developer_only AS "developerOnly",
            (review.input @> '[{"activity":"setup"}]'::jsonb) AS "managerOnly"
          FROM factory.learning_proposal proposal JOIN factory.learning_review review ON review.id=proposal.review_id
          WHERE proposal.id=${identity.proposalId} FOR UPDATE OF proposal`;
        const [application] = await sql<
          {
            target: unknown;
            state: string;
            revisionId: string;
            version: number;
            activation: unknown;
          }[]
        >`SELECT target,state,applied_revision_id AS "revisionId",applied_version AS version,activation
          FROM factory.learning_application WHERE id=${input.applicationId} FOR UPDATE`;
        if (!source || !application)
          throw new CommandError("not-found", "Applied improvement not found");
        const target = learningTarget.parse(application.target);
        if (target.kind === "skill")
          await sql`SELECT pg_advisory_xact_lock(hashtext('factory-skills'))`;
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
        await sql`UPDATE factory.learning_application SET state='reverted',reverted_revision_id=${saved.revisionId},
          reverted_version=${saved.version},reverted_by=${userId},reverted_at=now() WHERE id=${input.applicationId}`;
        const result = { revisionId: saved.revisionId, version: saved.version };
        await sql`INSERT INTO factory.learning_command(id,actor_id,input,result)
          VALUES(${input.commandId},${userId},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
        return result;
      });
    },
  };
}
