import { createHmac, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import {
  monitoringChange,
  monitoringSave,
  monitoringView,
  defaultAutofixInstructions,
} from "../../../../packages/conversation-domain/src/monitoring";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";
import { monitoringDigest, type MonitoringSignal } from "./payload";
import {
  manageMonitoringIn,
  inputAssignmentsIn,
  monitoringAuthorityIn,
  retainedInputAssignments,
  validateInputAssignmentsIn,
} from "./authority";
import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";

type Database = ReturnType<typeof createDatabase>;

export function createMonitoringController(
  database: Database,
  signingKey: string,
  origin: string,
  wake: (projectId: string) => void,
) {
  const manageIn = manageMonitoringIn;
  function key(id: string, commandId: string) {
    return createHmac("sha256", signingKey)
      .update(`factory-monitoring-key-v1:${id}:${commandId}`)
      .digest("base64url");
  }
  function webhook(id: string, commandId: string) {
    return `${origin}/hooks/inputs/${id}/${key(id, commandId)}`;
  }
  async function replayIn(
    sql: AgentTurnTransaction,
    userId: string,
    projectId: string,
    hookId: string,
    commandId: string,
    action: string,
    input: unknown,
  ) {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`monitoring-command:${commandId}`}))`;
    const [old] = await sql<
      { userId: string; projectId: string; hookId: string; action: string; digest: string }[]
    >`SELECT actor_id AS "userId",project_id AS "projectId",hook_id AS "hookId",action,input_digest AS digest
      FROM factory.monitoring_command WHERE id=${commandId}`;
    if (
      old &&
      (old.userId !== userId ||
        old.projectId !== projectId ||
        old.hookId !== hookId ||
        old.action !== action ||
        old.digest !== monitoringDigest(input))
    )
      throw new CommandError(
        "conflict",
        "Webhook command identity was reused with different input",
      );
    return Boolean(old);
  }
  async function recordIn(
    sql: AgentTurnTransaction,
    userId: string,
    projectId: string,
    hookId: string,
    commandId: string,
    action: string,
    input: unknown,
  ) {
    await sql`INSERT INTO factory.monitoring_command(id,project_id,hook_id,actor_id,action,input_digest)
      VALUES(${commandId},${projectId},${hookId},${userId},${action},${monitoringDigest(input)})`;
  }
  const authorityIn = (sql: AgentTurnTransaction, incidentId: string) =>
    monitoringAuthorityIn(database, sql, incidentId);
  return {
    authorityIn,
    authorize: (incidentId: string) => database.client.begin((sql) => authorityIn(sql, incidentId)),
    async view(projectId: string, userId: string) {
      return database.client.begin(async (sql) => {
        const manager = await projectAuthorityIn(sql, userId, projectId);
        let developer = false;
        try {
          await projectDevelopmentAuthorityIn(sql, userId, projectId);
          developer = true;
        } catch (cause) {
          if (!(cause instanceof CommandError) || cause.code !== "forbidden") throw cause;
        }
        const hooks =
          await sql`SELECT hook.id,hook.name,hook.version::float8 AS version,hook.enabled,
          policy.delegated_by AS "delegatedBy",policy.id AS "policyId",policy.assignment,
          policy.source_assignments AS "sourceAssignments",policy.source_ids AS "connectionIds",
          coalesce(policy.instructions,${defaultAutofixInstructions}) AS instructions,policy.delegation
          FROM factory.monitoring_hook hook JOIN factory.monitoring_policy policy ON policy.id=hook.policy_id
          WHERE hook.project_id=${projectId} ORDER BY hook.name,hook.id`;
        const checked = [];
        for (const hook of hooks) {
          let delegationCurrent = false;
          if (hook["enabled"]) {
            try {
              await manageIn(
                sql,
                String(hook["delegatedBy"]),
                projectId,
                hook["delegation"] === "prepare-ticket"
                  ? "prepare-ticket"
                  : "application-fix-and-delivery",
              );
              await validateInputAssignmentsIn(
                database,
                sql,
                retainedInputAssignments({
                  sourceAssignments: hook["sourceAssignments"] as MCPAssignment[] | null,
                  assignment: hook["assignment"] as MCPAssignment | null,
                }),
                projectId,
                String(hook["delegatedBy"]),
              );
              delegationCurrent = true;
            } catch (cause) {
              if (!(cause instanceof CommandError)) throw cause;
            }
          }
          const assignments = retainedInputAssignments({
            sourceAssignments: hook["sourceAssignments"] as MCPAssignment[] | null,
            assignment: hook["assignment"] as MCPAssignment | null,
          });
          checked.push({
            ...hook,
            sourceIds: assignments.map((source) => source.connectionId),
            connectionIds:
              hook["sourceAssignments"] === null
                ? assignments.map((source) => source.connectionId)
                : hook["connectionIds"],
            delegationCurrent,
          });
        }
        const incidents =
          await sql`SELECT id,hook_id AS "hookId",title,state,occurrences::float8 AS occurrences,reason,
          ticket_id AS "ticketId",received_at::text AS "receivedAt",last_seen_at::text AS "lastSeenAt"
          FROM factory.monitoring_incident WHERE project_id=${projectId}
          ORDER BY last_seen_at DESC,id LIMIT 50`;
        return monitoringView.parse({
          canManage: manager,
          canDelegate: manager && developer,
          canDisable: manager,
          hooks: checked,
          incidents,
        });
      });
    },
    async save(projectId: string, userId: string, value: z.input<typeof monitoringSave>) {
      const input = monitoringSave.parse(value);
      return database.client.begin(async (sql) => {
        await manageIn(sql, userId, projectId, input.delegation);
        const replay = await replayIn(
          sql,
          userId,
          projectId,
          input.id,
          input.commandId,
          "save",
          input,
        );
        const [old] = await sql<
          { projectId: string; version: number; digest: string }[]
        >`SELECT project_id AS "projectId",version::float8 AS version,secret_digest AS digest
          FROM factory.monitoring_hook WHERE id=${input.id} FOR UPDATE`;
        if (old && old.projectId !== projectId)
          throw new CommandError("not-found", "Webhook not found");
        if (replay)
          return {
            url:
              old?.digest === monitoringDigest(key(input.id, input.commandId))
                ? webhook(input.id, input.commandId)
                : null,
          };
        if ((old?.version ?? 0) !== input.expectedVersion)
          throw new CommandError("conflict", "Webhook changed. Reload before saving");
        const assignments = await inputAssignmentsIn(
          database,
          sql,
          input.connectionIds,
          projectId,
          userId,
        );
        if (input.delegation === "application-fix-and-delivery" && !assignments.length)
          throw new CommandError(
            "conflict",
            "Automatic fixes require a connected read-only source",
          );
        const policyId = crypto.randomUUID();
        if (old)
          await sql`UPDATE factory.monitoring_hook SET name=${input.name},enabled=${input.enabled},
            policy_id=${policyId},version=version+1 WHERE id=${input.id}`;
        else
          await sql`INSERT INTO factory.monitoring_hook(id,project_id,name,enabled,version,secret_digest,policy_id)
            VALUES(${input.id},${projectId},${input.name},${input.enabled},1,
              ${monitoringDigest(key(input.id, input.commandId))},${policyId})`;
        await sql`INSERT INTO factory.monitoring_policy(id,hook_id,connection_id,assignment,delegated_by,delegation,
          instructions,source_ids,source_assignments)
          VALUES(${policyId},${input.id},NULL,NULL,${userId},${input.delegation},
            ${input.instructions},${input.connectionIds},${JSON.stringify(assignments)}::jsonb)`;
        await recordIn(sql, userId, projectId, input.id, input.commandId, "save", input);
        return { url: old ? null : webhook(input.id, input.commandId) };
      });
    },
    async change(
      projectId: string,
      id: string,
      userId: string,
      action: "disable" | "rotate",
      value: z.input<typeof monitoringChange>,
    ) {
      const input = monitoringChange.parse(value);
      return database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, userId, projectId, true);
        const replay = await replayIn(sql, userId, projectId, id, input.commandId, action, input);
        const [old] = await sql<
          { version: number; digest: string }[]
        >`SELECT version::float8 AS version,secret_digest AS digest
          FROM factory.monitoring_hook WHERE id=${id} AND project_id=${projectId} FOR UPDATE`;
        if (!old) throw new CommandError("not-found", "Webhook not found");
        if (replay)
          return {
            url:
              action === "rotate" && old.digest === monitoringDigest(key(id, input.commandId))
                ? webhook(id, input.commandId)
                : null,
          };
        if (old.version !== input.expectedVersion)
          throw new CommandError("conflict", "Webhook changed. Reload before changing it");
        // Rotation also disables execution. A fresh explicit save/delegation is
        // required, rather than carrying queued work across a leaked key.
        await sql`UPDATE factory.monitoring_hook SET enabled=false,version=version+1,
          secret_digest=${action === "rotate" ? monitoringDigest(key(id, input.commandId)) : old.digest}
          WHERE id=${id}`;
        await recordIn(sql, userId, projectId, id, input.commandId, action, input);
        return { url: action === "rotate" ? webhook(id, input.commandId) : null };
      });
    },
    async authenticate(id: string, presented: string) {
      const [hook] = await database.client<
        { digest: string; enabled: boolean }[]
      >`SELECT secret_digest AS digest,enabled FROM factory.monitoring_hook WHERE id=${id}`;
      const expected = Buffer.from(hook?.digest ?? "0".repeat(64), "hex");
      const candidate = Buffer.from(monitoringDigest(presented), "hex");
      return Boolean(timingSafeEqual(expected, candidate) && hook?.enabled);
    },
    async receive(
      id: string,
      presented: string,
      payloadDigest: string,
      signals: MonitoringSignal[],
    ) {
      const result = await database.client.begin(async (sql) => {
        const [hook] = await sql<
          {
            projectId: string;
            policyId: string;
            version: number;
            digest: string;
            enabled: boolean;
          }[]
        >`SELECT project_id AS "projectId",policy_id AS "policyId",version::float8 AS version,
          secret_digest AS digest,enabled FROM factory.monitoring_hook WHERE id=${id} FOR UPDATE`;
        if (
          !hook?.enabled ||
          !timingSafeEqual(
            Buffer.from(hook.digest, "hex"),
            Buffer.from(monitoringDigest(presented), "hex"),
          )
        )
          throw new CommandError("not-found", "Webhook not found");
        const [rate] = await sql`UPDATE factory.monitoring_hook
          SET received_count=CASE WHEN received_window < now()-interval '1 minute' THEN 1 ELSE received_count+1 END,
            received_window=CASE WHEN received_window < now()-interval '1 minute' THEN now() ELSE received_window END
          WHERE id=${id} AND (received_window < now()-interval '1 minute' OR received_count < 120)
          RETURNING id`;
        if (!rate)
          return {
            projectId: hook.projectId,
            limited: true,
            accepted: 0,
            duplicates: 0,
            ignored: 0,
          };
        let accepted = 0;
        let duplicates = 0;
        let ignored = 0;
        for (const signal of signals) {
          if (signal.ignored) {
            ignored++;
            continue;
          }
          const [duplicate] =
            await sql`UPDATE factory.monitoring_incident SET occurrences=occurrences+1,last_seen_at=now()
            WHERE hook_id=${id} AND fingerprint=${signal.fingerprint} RETURNING id`;
          if (duplicate) {
            duplicates++;
            continue;
          }
          const [queued] = await sql<{ count: number }[]>`SELECT count(*)::integer AS count
            FROM factory.monitoring_incident WHERE hook_id=${id} AND state IN ('queued','diagnosing','implementing')`;
          if (Number(queued?.count) >= 50)
            throw new CommandError(
              "conflict",
              "This Input has 50 unsettled requests. Resolve them before sending more",
            );
          await sql`INSERT INTO factory.monitoring_incident(id,hook_id,project_id,policy_id,hook_version,
            fingerprint,payload_digest,title,reference,context)
            VALUES(${crypto.randomUUID()},${id},${hook.projectId},${hook.policyId},${hook.version},
              ${signal.fingerprint},${payloadDigest},${signal.title},${signal.reference},${signal.context})`;
          accepted++;
        }
        return { projectId: hook.projectId, limited: false, accepted, duplicates, ignored };
      });
      if (result.accepted) wake(result.projectId);
      return result;
    },
  };
}
