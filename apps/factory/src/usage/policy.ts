import type { createDatabase } from "../../../../packages/db/src/client";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { requireActiveAccountIn, projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import {
  executionPolicy,
  executionPolicyCommand,
  defaultExecutionPolicy,
  effectiveExecutionPolicy,
  tighterExecutionPolicy,
  codingDecision,
} from "../../../../packages/conversation-domain/src/execution-policy";
import { createHash } from "node:crypto";
import { computeAllocationIn } from "./compute";

function fingerprint(value: unknown) {
  const normalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(normalize)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, normalize(value)]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

type SQL = AgentTurnTransaction | ReturnType<typeof createDatabase>["client"];
export const usageAdmissionLock = "factory-usage-admission";
export async function lockUsageIn(sql: SQL) {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${usageAdmissionLock}))`;
}
export async function policyIn(sql: SQL, projectID: string | null) {
  const rows = await sql<
    Array<{ scope: string; version: string; policy: unknown; timezone: string | null }>
  >`
    SELECT scope,version,policy,timezone FROM factory.execution_policy WHERE scope='factory' OR scope=${projectID}`;
  const factory = rows.find((row) => row.scope === "factory");
  const project = rows.find((row) => row.scope === projectID);
  const factoryPolicy = factory ? executionPolicy.parse(factory.policy) : defaultExecutionPolicy();
  const projectPolicy = project ? executionPolicy.parse(project.policy) : null;
  return {
    factory: factoryPolicy,
    project: projectPolicy,
    effective: effectiveExecutionPolicy(factoryPolicy, projectPolicy),
    timezone: factory?.timezone ?? "UTC",
    version: Number(projectID ? (project?.version ?? 0) : (factory?.version ?? 0)),
  };
}
export async function codingBudgetIn(sql: SQL, projectID: string | null, continuation: boolean) {
  await lockUsageIn(sql);
  const policy = await policyIn(sql, projectID);
  const scopes = [
    { scope: null, policy: policy.factory },
    ...(projectID ? [{ scope: projectID, policy: policy.effective }] : []),
  ];
  const results = [];
  for (const scope of scopes) {
    const [usage] = await sql<Array<{ cost: string; unknown: boolean; reset: Date }>>`
      WITH period AS (SELECT date_trunc('month',now() AT TIME ZONE ${policy.timezone}) AT TIME ZONE ${policy.timezone} AS starts,
        (date_trunc('month',now() AT TIME ZONE ${policy.timezone})+interval '1 month') AT TIME ZONE ${policy.timezone} AS ends)
      SELECT coalesce(sum(entry.known_nano_usd),0)::text AS cost,
        coalesce(bool_or(operation.id IS NOT NULL AND ((operation.rate IS NULL AND operation.created_at>=period.starts) OR (entry.event_id IS NOT NULL AND entry.nano_usd IS NULL) OR
          (entry.event_id IS NULL AND operation.settled_at IS NOT NULL AND operation.created_at>=period.starts))),false) AS unknown,
        (SELECT ends FROM period) AS reset FROM period
      LEFT JOIN factory.usage_operation operation ON operation.purpose='coding'
        AND (${scope.scope}::uuid IS NULL OR operation.project_id=${scope.scope})
      LEFT JOIN factory.usage_entry entry ON entry.operation_id=operation.id
        AND entry.occurred_at>=period.starts AND entry.occurred_at<period.ends
      WHERE operation.id IS NULL OR entry.event_id IS NOT NULL OR operation.created_at>=period.starts`;
    const decision = codingDecision({
      policy: scope.policy,
      knownNanoUSD: BigInt(usage?.cost ?? "0"),
      unknown: usage?.unknown ?? false,
      continuation,
    });
    results.push({
      ...decision,
      scope: scope.scope,
      incomplete: usage?.unknown ?? false,
      knownNanoUSD: usage?.cost ?? "0",
      reset: usage?.reset ? new Date(usage.reset).toISOString() : null,
    });
  }
  return {
    ...policy,
    scopes: results,
    allowed: results.every((value) => value.allowed),
    reason: results.find((value) => !value.allowed)?.reason ?? null,
  };
}
export function createUsagePolicy(database: ReturnType<typeof createDatabase>) {
  async function authorize(
    sql: AgentTurnTransaction,
    actorID: string,
    projectID: string | null,
    manage: boolean,
  ) {
    await requireActiveAccountIn(sql, actorID);
    const admin =
      await sql`SELECT user_id FROM factory.administrator WHERE user_id=${actorID} FOR SHARE`;
    if (!projectID && !admin.length)
      throw new CommandError("forbidden", "Factory usage requires System management");
    const manager = projectID ? await projectAuthorityIn(sql, actorID, projectID) : true;
    if (manage && !manager) throw new CommandError("forbidden", "Project management is required");
    return { systemManager: Boolean(admin.length), manager };
  }
  return {
    async get(actorID: string, projectID: string | null) {
      return database.client.begin(async (sql) => {
        const rights = await authorize(sql, actorID, projectID, false);
        const budget = await codingBudgetIn(sql, projectID, false);
        const summary = await sql<
          Array<{
            provider: string;
            model: string;
            purpose: string;
            knownNanoUSD: string;
            incomplete: boolean;
            steps: number;
            input: string;
            output: string;
            cacheRead: string;
            cacheWrite: string;
          }>
        >`
          WITH period AS (SELECT date_trunc('month',now() AT TIME ZONE ${budget.timezone}) AT TIME ZONE ${budget.timezone} AS starts)
          SELECT operation.provider,operation.model,operation.purpose,
            coalesce(sum(entry.known_nano_usd),0)::text AS "knownNanoUSD",
            coalesce(bool_or(entry.nano_usd IS NULL),false) AS incomplete,
            count(entry.event_id)::int AS steps,
            coalesce(sum((entry.counters->>'input')::numeric),0)::text AS input,
            coalesce(sum((entry.counters->>'output')::numeric),0)::text AS output,
            coalesce(sum((entry.counters->>'cacheRead')::numeric),0)::text AS "cacheRead",
            coalesce(sum((entry.counters->>'cacheWrite')::numeric),0)::text AS "cacheWrite"
          FROM factory.usage_operation operation CROSS JOIN period LEFT JOIN factory.usage_entry entry ON entry.operation_id=operation.id
            AND entry.occurred_at>=period.starts AND entry.occurred_at<now()
          WHERE (entry.event_id IS NOT NULL OR operation.created_at>=period.starts)
            AND (${projectID}::uuid IS NULL OR operation.project_id=${projectID})
            AND (${rights.manager} OR operation.user_id=${actorID})
          GROUP BY operation.provider,operation.model,operation.purpose ORDER BY operation.purpose,operation.provider,operation.model`;
        const [projectAgentTotal] = await sql<Array<{ knownNanoUSD: string; incomplete: boolean }>>`
          SELECT coalesce(sum(entry.known_nano_usd),0)::text AS "knownNanoUSD",coalesce(bool_or(entry.nano_usd IS NULL),false) AS incomplete
          FROM factory.usage_operation operation LEFT JOIN factory.usage_entry entry ON entry.operation_id=operation.id
            AND entry.occurred_at>=date_trunc('month',now() AT TIME ZONE ${budget.timezone}) AT TIME ZONE ${budget.timezone}
            AND entry.occurred_at<now()
          WHERE operation.purpose<>'coding' AND (${projectID}::uuid IS NULL OR operation.project_id=${projectID})
            AND (entry.event_id IS NOT NULL OR operation.created_at>=date_trunc('month',now() AT TIME ZONE ${budget.timezone}) AT TIME ZONE ${budget.timezone})`;
        // Members may see inherited restrictions, never another Project's consumption.
        return {
          ...budget,
          scopes: rights.systemManager
            ? budget.scopes
            : budget.scopes.filter((scope) => scope.scope === projectID),
          canEdit: rights.manager,
          summary,
          detailScope: !projectID ? "factory" : rights.manager ? "project" : "own",
          allocation: await computeAllocationIn(sql, projectID),
          projectAgentTotal: projectAgentTotal ?? { knownNanoUSD: "0", incomplete: false },
        };
      });
    },
    async set(actorID: string, projectID: string | null, raw: unknown) {
      const input = executionPolicyCommand.parse(raw);
      return database.client.begin(async (sql) => {
        await authorize(sql, actorID, projectID, true);
        await lockUsageIn(sql);
        const scope = projectID ?? "factory";
        const [old] = await sql<
          Array<{ actor_id: string; input: unknown; result: unknown; scope: string }>
        >`SELECT * FROM factory.execution_policy_command WHERE command_id=${input.commandID}`;
        if (old) {
          if (
            old.actor_id !== actorID ||
            old.scope !== scope ||
            fingerprint(old.input) !== fingerprint(input)
          )
            throw new CommandError("conflict", "Policy command changed input");
          return old.result;
        }
        const current = await policyIn(sql, projectID);
        if (current.version !== input.version)
          throw new CommandError("conflict", "Usage settings changed; reload before saving");
        if (projectID && (input.timezone || !tighterExecutionPolicy(current.factory, input.policy)))
          throw new CommandError(
            "forbidden",
            "Project settings may only tighten Factory restrictions",
          );
        const timezone = projectID ? null : (input.timezone ?? current.timezone);
        if (!projectID && timezone !== current.timezone) {
          const existing =
            await sql`SELECT id FROM factory.usage_operation WHERE purpose='coding' LIMIT 1`;
          if (existing.length)
            throw new CommandError(
              "conflict",
              "The installation timezone is fixed once Coding usage exists",
            );
        }
        await sql`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
          VALUES(${scope},${current.version + 1},${JSON.stringify(input.policy)}::jsonb,${timezone},${actorID})
          ON CONFLICT(scope) DO UPDATE SET version=EXCLUDED.version,policy=EXCLUDED.policy,timezone=EXCLUDED.timezone,updated_by=EXCLUDED.updated_by,updated_at=now()`;
        const result = await policyIn(sql, projectID);
        await sql`INSERT INTO factory.execution_policy_command(command_id,scope,actor_id,input,result)
          VALUES(${input.commandID},${scope},${actorID},${JSON.stringify(input)}::jsonb,${JSON.stringify(result)}::jsonb)`;
        return result;
      });
    },
  };
}
