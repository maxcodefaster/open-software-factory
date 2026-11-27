import { and, asc, eq, sql as expression, inArray, isNotNull, ne, or } from "drizzle-orm";
import type { z } from "zod";
import {
  type AgentTurnCommand,
  agentTurnAuthorityInput,
  agentTurnBoundary,
  agentTurnCommandInput,
  assertAgentTurnAuthority,
} from "#conversation-domain/agent-turn";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn, operation } from "#db/schema";
import { freezeAttachmentContextIn } from "../attachments/api";
import { CommandError } from "../command-error";
import { createMCPLibrary } from "../mcp/library-api";
import { inputTicketAssignmentsIn, monitoringChangeAuthorityIn } from "../monitoring/authority";
import type { AgentTurnRecord } from "./turn-record";
import {
  CODING_TURN_MCP_KIND,
  type Database,
  fingerprintCommand,
  LIVE_TURN_STATES,
  toTurnRecord,
} from "./turn-store-types";

type MonitoringDelegation = Awaited<ReturnType<typeof monitoringChangeAuthorityIn>> | null;

async function bindAdmittedTurnMcpIn(
  database: Database,
  transaction: DatabaseTransaction,
  record: AgentTurnRecord,
  monitoring: MonitoringDelegation,
) {
  const { command, authority } = record;
  if (authority.mode === "build" && authority.review) return;
  const db = drizzleTransaction(transaction);
  const [initial] =
    authority.mode === "build" && "changeId" in command
      ? await db
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.changeId, command.changeId),
              ne(agentTurn.id, record.id),
              expression`${agentTurn.input}->>'kind' <> 'change-review'`,
            ),
          )
          .orderBy(asc(agentTurn.createdAt), asc(agentTurn.id))
          .limit(1)
      : [];
  if (initial) {
    await db.insert(operation).select(
      db
        .select({
          id: expression<string>`gen_random_uuid()`.as("id"),
          kind: expression<string>`'coding.turn_mcp'::text`.as("kind"),
          scopeType: expression<string>`'agent_turn'::text`.as("scope_type"),
          scopeId: expression<string>`${record.id}::text`.as("scope_id"),
          idempotencyKey:
            expression<string>`'coding.turn_mcp:' || ${record.id}::text || ':' || (${operation.payload}->>'connectionId')`.as(
              "idempotency_key",
            ),
          activeKey: expression<null>`NULL::text`.as("active_key"),
          state: expression<string>`'bound'::text`.as("state"),
          payload: expression<
            Record<string, unknown>
          >`jsonb_set(${operation.payload}, '{turnId}', to_jsonb(${record.id}::text))`.as(
            "payload",
          ),
          result: expression<null>`NULL::jsonb`.as("result"),
          error: expression<null>`NULL::text`.as("error"),
          createdBy: expression<null>`NULL::uuid`.as("created_by"),
          leaseOwner: expression<null>`NULL::text`.as("lease_owner"),
          leaseExpiresAt: expression<null>`NULL::timestamptz`.as("lease_expires_at"),
          createdAt: expression<Date>`now()`.as("created_at"),
          updatedAt: expression<Date>`now()`.as("updated_at"),
          completedAt: expression<null>`NULL::timestamptz`.as("completed_at"),
        })
        .from(operation)
        .where(
          and(
            eq(operation.kind, CODING_TURN_MCP_KIND),
            eq(operation.scopeType, "agent_turn"),
            eq(operation.scopeId, initial.id),
          ),
        ),
    );
    return;
  }
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
    await db.insert(operation).values({
      id: crypto.randomUUID(),
      kind: CODING_TURN_MCP_KIND,
      scopeType: "agent_turn",
      scopeId: record.id,
      idempotencyKey: `${CODING_TURN_MCP_KIND}:${record.id}:${source.connectionId}`,
      activeKey: null,
      state: "bound",
      payload: {
        turnId: record.id,
        connectionId: source.connectionId,
        credentialEpoch: source.credentialEpoch,
        revisionId: source.revisionId,
        policyVersion: source.policyVersion,
        tools: source.tools,
        required: true,
      },
    });
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

export async function admitTurnIn(
  database: Database,
  transaction: DatabaseTransaction,
  rawCommand: AgentTurnCommand,
  rawAuthority: z.input<typeof agentTurnAuthorityInput>,
  persistInput?: (transaction: DatabaseTransaction, record: AgentTurnRecord) => Promise<void>,
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
  ) {
    throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
  }
  const digest = fingerprintCommand(command);
  await transaction`SELECT pg_advisory_xact_lock(hashtext(${`agent-command:${command.commandId}`}))`;
  const db = drizzleTransaction(transaction);
  const existing = await db
    .select()
    .from(agentTurn)
    .where(eq(agentTurn.commandId, command.commandId));
  if (existing[0]) {
    if (existing[0].inputDigest !== digest) {
      throw new CommandError(
        "conflict",
        "The Agent command identity was reused with different input",
      );
    }
    return { turn: toTurnRecord(existing[0]), replayed: true };
  }
  await transaction`SELECT pg_advisory_xact_lock(hashtext(${agentTurnBoundary(command)}))`;
  const active = await db
    .select({ id: agentTurn.id })
    .from(agentTurn)
    .where(
      and(
        eq(agentTurn.projectId, command.projectId),
        expression`${agentTurn.ticketId} IS NOT DISTINCT FROM ${command.ticketId}::uuid`,
        command.ticketId !== null ? undefined : eq(agentTurn.createdBy, command.createdBy),
        expression`(CASE WHEN ${agentTurn.changeId} IS NULL THEN ${agentTurn.input}->>'contextId' ELSE NULL END)
        IS NOT DISTINCT FROM ${!("changeId" in command) ? (command.contextId ?? null) : null}::text`,
        or(
          inArray(agentTurn.state, LIVE_TURN_STATES),
          and(isNotNull(agentTurn.changeId), eq(agentTurn.state, "uncertain")),
        ),
      ),
    );
  if (active[0]) {
    throw new CommandError(
      "conflict",
      "An active or unresolved Agent turn already owns this conversation",
    );
  }
  const rows = await db
    .insert(agentTurn)
    .values({
      id: crypto.randomUUID(),
      commandId: command.commandId,
      projectId: command.projectId,
      ticketId: command.ticketId,
      conversationId: command.conversationId,
      changeId: "changeId" in command ? command.changeId : null,
      createdBy: command.createdBy,
      input: command,
      inputDigest: digest,
      authority,
    })
    .returning();
  if (!rows[0]) throw new Error("Agent Turn admission was not recorded");
  const record = toTurnRecord(rows[0]);
  await bindAdmittedTurnMcpIn(database, transaction, record, monitoring);
  await persistInput?.(transaction, record);
  await freezeAttachmentContextIn(transaction, record);
  return { turn: record, replayed: false };
}
