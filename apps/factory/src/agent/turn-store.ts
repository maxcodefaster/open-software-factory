import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { z } from "zod";
import {
  type AgentTurnCommand,
  type AgentTurnState,
  agentTurnAuthorityInput,
  agentTurnBoundary,
  agentTurnCommandInput,
  assertAgentTurnAuthority,
} from "../../../../packages/conversation-domain/src/agent-turn";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { lockChangeWriterIn } from "../access/change-writer";
import { codingBudgetIn } from "../usage/policy";
import { createMCPLibrary } from "../mcp/controller";
import { monitoringChangeAuthorityIn, inputTicketAssignmentsIn } from "../monitoring/authority";
import { freezeAttachmentContextIn } from "../attachments/store";
import { lockConversation } from "../project-agent/conversation-store";

type Database = ReturnType<typeof createDatabase>;
type TurnRow = {
  id: string;
  command_id: string;
  input: unknown;
  input_digest: string;
  authority: unknown;
  state: AgentTurnState;
  owner_token: string | null;
  owner_expires_at: Date | string | null;
  outcome_summary: string | null;
};

function turn(row: TurnRow) {
  return {
    id: row.id,
    commandId: row.command_id,
    command: agentTurnCommandInput.parse(row.input),
    authority: agentTurnAuthorityInput.parse(row.authority),
    state: row.state,
    ownerToken: row.owner_token,
    ownerExpiresAt: row.owner_expires_at,
    outcomeSummary: row.outcome_summary,
  };
}
export type AgentTurnRecord = ReturnType<typeof turn>;
export type AgentTurnTransaction = postgres.TransactionSql;

function fingerprint(command: AgentTurnCommand) {
  // Zod's fixed object schemas normalize key order, trim text and fill answer defaults.
  const { commandId: _commandId, ...payload } = command;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function leaseDuration(milliseconds: number) {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new Error("Agent ownership lease must be between 1 and 60000 milliseconds");
  }
  return milliseconds;
}

async function currentAuthorityIn(
  database: Database,
  sql: AgentTurnTransaction,
  record: AgentTurnRecord,
) {
  const { command, authority } = record;
  if (authority.mode === "build" && "changeId" in command) {
    // Writer transitions take Change before membership. Agent validation must
    // keep this order rather than deadlocking a concurrent human save/handoff.
    await lockChangeWriterIn(sql, command.changeId);
  } else if (command.ticketId) {
    const [ticket] = await sql<{ trashed: boolean }[]>`SELECT
      (trashed_at IS NOT NULL OR converted_to_epic_id IS NOT NULL) AS trashed
      FROM factory.ticket WHERE id=${command.ticketId} FOR SHARE`;
    if (!ticket || ticket.trashed) return false;
  }
  try {
    await projectAuthorityIn(sql, command.createdBy, command.projectId);
    if (authority.mode === "build" && authority.monitoringIncidentId && "changeId" in command) {
      const delegated = await monitoringChangeAuthorityIn(
        database,
        sql,
        command.changeId,
        authority.monitoringIncidentId,
      );
      if (delegated.userId !== command.createdBy) return false;
    }
  } catch (cause) {
    if (cause instanceof CommandError) return false;
    throw cause;
  }
  if (authority.mode !== "build") {
    const current = command.conversationId
      ? await lockConversation(sql, command.conversationId, command.contextId)
      : undefined;
    return current?.mode === authority.mode && current.version === authority.conversationVersion;
  }
  if (!("changeId" in command)) return false;
  const locked = await sql<Array<{ id: string }>>`
    SELECT change.id FROM factory.change change JOIN factory.ticket ticket ON ticket.id = change.ticket_id
      WHERE change.id = ${command.changeId} AND change.ticket_id = ${command.ticketId}
        AND change.project_id = ${command.projectId} FOR UPDATE OF change, ticket`;
  if (!locked[0]) return false;
  const [writer] = await sql<
    { state: string; turnID: string | null }[]
  >`SELECT state,turn_id AS "turnID"
    FROM factory.change_writer WHERE change_id=${command.changeId}`;
  if (
    writer &&
    (["human", "handoff"].includes(writer.state) ||
      (["agent", "agent-preparing"].includes(writer.state) && writer.turnID !== record.id))
  )
    return false;
  // This fresh read occurs after any lock wait; approval/revision reads from an
  // earlier statement's snapshot cannot authorize newly changed Requirements.
  const approved = await sql<Array<{ id: string }>>`
    SELECT change.id FROM factory.change change
      JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
      WHERE change.id = ${command.changeId} AND change.state IN ('starting', 'active')
        AND NOT EXISTS(SELECT 1 FROM factory.ticket WHERE id = ${command.ticketId} AND trashed_at IS NOT NULL)
        AND approval.requirement_revision_id = ${authority.requirementRevisionId}
        AND approval.requirement_revision_id = (SELECT id FROM factory.requirement_revision
          WHERE ticket_id = ${command.ticketId} ORDER BY ordinal DESC LIMIT 1)`;
  if (!approved[0]) return false;
  if (authority.review) {
    const [candidate] = await sql`
      SELECT review.id FROM factory.candidate_review review
      JOIN factory.verification verification ON verification.id=review.verification_id
      JOIN factory.change change ON change.id=review.change_id
      WHERE review.id=${authority.review.reviewId} AND review.turn_id=${record.id}
        AND review.change_id=${command.changeId} AND review.verification_id=${authority.review.verificationId}
        AND review.commit_sha=${authority.review.commitSha} AND review.base_sha=${authority.review.baseSha}
        AND change.base_sha=review.base_sha AND verification.state='succeeded'
        AND review.state IN ('pending','running')
        AND review.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)`;
    if (!candidate) return false;
  }
  const stopping = await sql<Array<{ id: string }>>`
    SELECT change_id AS id FROM factory.change_agent_session
      WHERE change_id = ${command.changeId} AND stop_pending`;
  if (stopping[0]) return false;
  const conversations = await sql<
    Array<{ id: string; mode: string; version: number; contextID: string | null }>
  >`
    SELECT id, mode, version::float8 AS version,active_coding_context_id AS "contextID" FROM factory.ticket_conversation
      WHERE ticket_id = ${command.ticketId} FOR UPDATE`;
  if (command.conversationId === null)
    return conversations.length === 0 && authority.conversationVersion === null;
  return (
    conversations[0]?.id === command.conversationId &&
    (conversations[0].contextID ?? undefined) === command.contextId &&
    conversations[0].mode === "build" &&
    conversations[0].version === authority.conversationVersion
  );
}

export function createAgentTurnStore(database: Database) {
  async function observeCommit(
    id: string,
    persist: (sql: AgentTurnTransaction, current: boolean) => Promise<void>,
  ) {
    return database.client.begin(async (sql) => {
      const rows = await sql<TurnRow[]>`SELECT * FROM factory.agent_turn WHERE id = ${id}
        AND change_id IS NOT NULL AND state = 'completed' FOR UPDATE`;
      if (!rows[0]) return false;
      const current = await currentAuthorityIn(database, sql, turn(rows[0]));
      await persist(sql, current);
      return current;
    });
  }

  async function admitIn(
    transaction: AgentTurnTransaction,
    rawCommand: AgentTurnCommand,
    rawAuthority: z.input<typeof agentTurnAuthorityInput>,
    persistInput?: (transaction: AgentTurnTransaction, record: AgentTurnRecord) => Promise<void>,
  ) {
    const command = agentTurnCommandInput.parse(rawCommand);
    const authority = agentTurnAuthorityInput.parse(rawAuthority);
    assertAgentTurnAuthority(command, authority);
    const monitoring =
      authority.mode === "build" && authority.monitoringIncidentId && "changeId" in command
        ? await monitoringChangeAuthorityIn(
            database,
            transaction,
            command.changeId,
            authority.monitoringIncidentId,
          )
        : null;
    if (
      monitoring &&
      (monitoring.userId !== command.createdBy || monitoring.projectId !== command.projectId)
    )
      throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
    const digest = fingerprint(command);
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${command.commandId}`}))`;
    const existing = await transaction<TurnRow[]>`
          SELECT * FROM factory.agent_turn WHERE command_id = ${command.commandId}
        `;
    if (existing[0]) {
      if (existing[0].input_digest !== digest) {
        throw new CommandError(
          "conflict",
          "The Agent command identity was reused with different input",
        );
      }
      return { turn: turn(existing[0]), replayed: true };
    }
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${agentTurnBoundary(command)}))`;
    const active = await transaction<Array<{ id: string }>>`
          SELECT id FROM factory.agent_turn WHERE project_id = ${command.projectId}
            AND ticket_id IS NOT DISTINCT FROM ${command.ticketId}
            AND (${command.ticketId}::uuid IS NOT NULL OR created_by = ${command.createdBy})
            AND (CASE WHEN change_id IS NULL THEN input->>'contextId' ELSE NULL END)
              IS NOT DISTINCT FROM ${!("changeId" in command) ? (command.contextId ?? null) : null}
            AND (state IN ('pending', 'dispatching', 'running') OR (change_id IS NOT NULL AND state = 'uncertain'))
        `;
    if (active[0])
      throw new CommandError(
        "conflict",
        "An active or unresolved Agent turn already owns this conversation",
      );
    const rows = await transaction<TurnRow[]>`
          INSERT INTO factory.agent_turn(
            id, command_id, project_id, ticket_id, conversation_id, change_id, created_by,
            input, input_digest, authority
          ) VALUES (
            ${crypto.randomUUID()}, ${command.commandId}, ${command.projectId}, ${command.ticketId},
            ${command.conversationId}, ${"changeId" in command ? command.changeId : null}, ${command.createdBy},
            ${JSON.stringify(command)}::jsonb, ${digest}, ${JSON.stringify(authority)}::jsonb
          ) RETURNING *
        `;
    if (!rows[0]) throw new Error("Agent Turn admission was not recorded");
    const record = turn(rows[0]);
    if (!(authority.mode === "build" && authority.review)) {
      const [initial] =
        authority.mode === "build" && "changeId" in command
          ? await transaction<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
            WHERE change_id=${command.changeId} AND id<>${record.id} AND input->>'kind'<>'change-review'
            ORDER BY created_at,id LIMIT 1`
          : [];
      if (initial)
        await transaction`INSERT INTO factory.agent_turn_mcp(turn_id,connection_id,credential_epoch,revision_id,policy_version,tools,required)
          SELECT ${record.id},connection_id,credential_epoch,revision_id,policy_version,tools,required
          FROM factory.agent_turn_mcp WHERE turn_id=${initial.id}`;
      else {
        const inputSources =
          monitoring?.assignments ??
          (authority.mode === "build" && command.ticketId
            ? await inputTicketAssignmentsIn(
                database,
                transaction,
                command.ticketId,
                command.projectId,
                command.createdBy,
              )
            : []);
        for (const source of inputSources) {
          await transaction`INSERT INTO factory.agent_turn_mcp(turn_id,connection_id,credential_epoch,revision_id,policy_version,tools,required)
            VALUES(${record.id},${source.connectionId},${source.credentialEpoch},${source.revisionId},
              ${source.policyVersion},${JSON.stringify(source.tools)}::jsonb,true)`;
        }
        await createMCPLibrary(database).admitIn(
          transaction,
          record.id,
          command.projectId,
          command.createdBy,
          authority.mode === "build" ? "build" : "planning",
          !monitoring,
        );
      }
    }
    await persistInput?.(transaction, record);
    await freezeAttachmentContextIn(transaction, record);
    return { turn: record, replayed: false };
  }

  return {
    admitIn,
    async resumePendingIn(sql: AgentTurnTransaction, id: string) {
      const [row] = await sql<
        TurnRow[]
      >`SELECT * FROM factory.agent_turn WHERE id=${id} AND state='pending' FOR UPDATE`;
      if (!row || !(await currentAuthorityIn(database, sql, turn(row))))
        throw new CommandError("conflict", "Paused work no longer has execution authority");
      const budget = await codingBudgetIn(sql, turn(row).command.projectId, true);
      if (!budget.allowed)
        throw new CommandError(
          "conflict",
          "Increase the Coding allowance or wait for its monthly reset before resuming",
        );
      await sql`UPDATE factory.coding_pause SET resumed_by_turn_id=${id} WHERE turn_id=${id} AND resumed_by_turn_id IS NULL`;
      return id;
    },
    async admit(
      command: AgentTurnCommand,
      authority: z.input<typeof agentTurnAuthorityInput>,
      persistInput?: (transaction: AgentTurnTransaction, record: AgentTurnRecord) => Promise<void>,
    ) {
      return database.client.begin((transaction) =>
        admitIn(transaction, command, authority, persistInput),
      );
    },

    async getByCommand(commandID: string, transaction?: AgentTurnTransaction) {
      const sql = transaction ?? database.client;
      const rows = await sql<TurnRow[]>`
        SELECT * FROM factory.agent_turn WHERE command_id = ${commandID}
      `;
      return rows[0] ? turn(rows[0]) : null;
    },

    async get(id: string) {
      const rows = await database.client<
        TurnRow[]
      >`SELECT * FROM factory.agent_turn WHERE id = ${id}`;
      return rows[0] ? turn(rows[0]) : null;
    },

    async claimPending(id: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      const rows = await database.client<TurnRow[]>`
        UPDATE factory.agent_turn SET owner_token = ${crypto.randomUUID()},
          owner_expires_at = clock_timestamp() + ${duration} * interval '1 millisecond', updated_at = now()
        WHERE id = ${id} AND state = 'pending'
          AND NOT EXISTS(SELECT 1 FROM factory.coding_pause WHERE turn_id=${id} AND resumed_by_turn_id IS NULL)
          AND (owner_token IS NULL OR owner_expires_at <= clock_timestamp())
        RETURNING *
      `;
      return rows[0] ? turn(rows[0]) : null;
    },

    async releasePending(id: string, ownerToken: string) {
      await database.client`UPDATE factory.agent_turn SET owner_token=NULL,owner_expires_at=NULL,updated_at=now()
        WHERE id=${id} AND state='pending' AND owner_token=${ownerToken}`;
    },

    async beginDispatch(id: string, ownerToken: string) {
      return database.client.begin(async (sql) => {
        const owned = await sql<TurnRow[]>`SELECT * FROM factory.agent_turn
          WHERE id = ${id} AND state = 'pending' AND owner_token = ${ownerToken}
            AND owner_expires_at > clock_timestamp() FOR UPDATE`;
        if (!owned[0] || !(await currentAuthorityIn(database, sql, turn(owned[0])))) return null;
        const record = turn(owned[0]);
        if (record.authority.mode === "build") {
          const budget = await codingBudgetIn(sql, record.command.projectId, true);
          if (!budget.allowed) {
            await sql`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${id},${budget.reason})
              ON CONFLICT(turn_id) DO UPDATE SET reason=EXCLUDED.reason,resumed_by_turn_id=NULL,created_at=now()`;
            await sql`UPDATE factory.agent_turn SET owner_token=NULL,owner_expires_at=NULL,updated_at=now() WHERE id=${id}`;
            return null;
          }
        }
        const rows = await sql<
          TurnRow[]
        >`UPDATE factory.agent_turn SET state = 'dispatching', updated_at = now()
          WHERE id = ${id} AND state = 'pending' AND owner_token = ${ownerToken}
            AND owner_expires_at > clock_timestamp() RETURNING *`;
        return rows[0] ? turn(rows[0]) : null;
      });
    },

    async validateExecution(
      id: string,
      ownerToken: string,
      forward?: (sql: AgentTurnTransaction) => Promise<void>,
    ) {
      return database.client.begin(async (sql) => {
        const rows = await sql<TurnRow[]>`SELECT * FROM factory.agent_turn WHERE id = ${id}
          AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp()
          AND state IN ('pending', 'dispatching', 'running') FOR UPDATE`;
        if (!rows[0] || !(await currentAuthorityIn(database, sql, turn(rows[0])))) return false;
        // Authority locks can outlast the lease. Do not authorize an external
        // operation using the ownership snapshot from before that wait.
        const live = await sql<Array<{ id: string }>>`SELECT id FROM factory.agent_turn
          WHERE id = ${id} AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp()
            AND state IN ('pending', 'dispatching', 'running')`;
        if (!live[0]) return false;
        await forward?.(sql);
        return true;
      });
    },

    async claimExternalRecovery(id: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      // Recovery may observe an external operation, but never acquires permission
      // to repeat it. A still-live owner and terminal decisions remain untouched.
      const rows = await database.client<TurnRow[]>`
        UPDATE factory.agent_turn SET state = 'running', owner_token = ${crypto.randomUUID()},
          owner_expires_at = clock_timestamp() + ${duration} * interval '1 millisecond', updated_at = now()
        WHERE id = ${id} AND change_id IS NOT NULL
          AND state IN ('dispatching', 'running', 'uncertain')
          AND (owner_token IS NULL OR owner_expires_at <= clock_timestamp())
        RETURNING *`;
      return rows[0] ? turn(rows[0]) : null;
    },

    async validateCommit(id: string, forward: (sql: AgentTurnTransaction) => Promise<void>) {
      return observeCommit(id, async (sql, current) => {
        if (current) await forward(sql);
      });
    },

    // An already dispatched push may finish after authority is revoked. Retain
    // its observed result, but publish to the current Session only if permitted.
    observeCommit,

    async quarantineExpiredProject(id: string) {
      // The provider has no recoverable operation identity. Lease loss permits
      // recording uncertainty, never submitting the admitted input again.
      const rows = await database.client<Array<{ id: string }>>`
        UPDATE factory.agent_turn SET state = 'uncertain', owner_token = NULL, owner_expires_at = NULL,
          outcome_summary = 'The provider outcome was lost after dispatch. Retry requires a new explicit attempt.',
          updated_at = now()
        WHERE id = ${id} AND change_id IS NULL AND state IN ('dispatching', 'running')
          AND (owner_token IS NULL OR owner_expires_at <= clock_timestamp()) RETURNING id`;
      return rows.length === 1;
    },

    async renew(id: string, ownerToken: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      return database.client.begin(async (sql) => {
        const [owned] = await sql<
          TurnRow[]
        >`SELECT * FROM factory.agent_turn WHERE id=${id} AND owner_token=${ownerToken} FOR UPDATE`;
        if (!owned || !(await currentAuthorityIn(database, sql, turn(owned)))) return false;
        const rows = await sql<Array<{ id: string }>>`
        UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() + ${duration} * interval '1 millisecond',
          updated_at = now()
        WHERE id = ${id} AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp()
          AND state IN ('pending', 'dispatching', 'running') RETURNING id
      `;
        return rows.length === 1;
      });
    },

    async failPending(id: string, ownerToken: string, summary: string) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      const rows = await database.client<Array<{ id: string }>>`
        UPDATE factory.agent_turn SET state = 'failed', outcome_summary = ${summary},
          owner_token = NULL, owner_expires_at = NULL, updated_at = now()
        WHERE id = ${id} AND state = 'pending' AND owner_token = ${ownerToken}
          AND owner_expires_at > clock_timestamp() RETURNING id
      `;
      return rows.length === 1;
    },

    async markRunning(
      id: string,
      ownerToken: string,
      persistOutcome: (sql: AgentTurnTransaction) => Promise<void>,
    ) {
      return database.client.begin(async (sql) => {
        const admitted = await sql<TurnRow[]>`SELECT * FROM factory.agent_turn WHERE id = ${id}
          AND state = 'dispatching' AND owner_token = ${ownerToken}
          AND owner_expires_at > clock_timestamp() FOR UPDATE`;
        if (!admitted[0] || !(await currentAuthorityIn(database, sql, turn(admitted[0]))))
          return false;
        const rows = await sql<
          Array<{ id: string }>
        >`UPDATE factory.agent_turn SET state = 'running', updated_at = now()
          WHERE id = ${id} AND state = 'dispatching' AND owner_token = ${ownerToken}
            AND owner_expires_at > clock_timestamp() RETURNING id`;
        if (!rows[0]) return false;
        await persistOutcome(sql);
        const owned = await sql<
          Array<{ id: string }>
        >`SELECT id FROM factory.agent_turn WHERE id = ${id}
          AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp() AND state = 'running'`;
        if (!owned[0])
          throw new CommandError("conflict", "Agent ownership expired while recording dispatch");
        return true;
      });
    },

    async settle(
      id: string,
      ownerToken: string,
      state: "completed" | "failed" | "uncertain",
      summary: string,
      persistOutcome?: (transaction: AgentTurnTransaction) => Promise<void>,
    ) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      if (persistOutcome && state !== "completed") {
        throw new Error("Only a completed Agent turn may publish product effects");
      }
      return database.client.begin(async (transaction) => {
        const owned = await transaction<TurnRow[]>`
          SELECT * FROM factory.agent_turn WHERE id = ${id} AND owner_token = ${ownerToken}
            AND owner_expires_at > clock_timestamp() AND state IN ('dispatching', 'running')
          FOR UPDATE
        `;
        if (!owned[0]) return false;
        if (persistOutcome && !(await currentAuthorityIn(database, transaction, turn(owned[0]))))
          return false;
        await persistOutcome?.(transaction);
        const settled = await transaction<Array<{ id: string }>>`
          UPDATE factory.agent_turn SET state = ${state}::factory.agent_turn_state,
            outcome_summary = ${summary}, owner_token = NULL, owner_expires_at = NULL, updated_at = now()
          WHERE id = ${id} AND owner_token = ${ownerToken} AND owner_expires_at > clock_timestamp()
            AND state IN ('dispatching', 'running') RETURNING id
        `;
        if (!settled[0]) {
          // Throwing rolls back effects if ownership expired while the transaction ran.
          throw new CommandError("conflict", "Agent turn ownership expired before settlement");
        }
        return true;
      });
    },
  };
}
