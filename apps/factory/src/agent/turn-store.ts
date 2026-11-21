import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  sql as expression,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import type { z } from "zod";
import {
  type AgentTurnCommand,
  agentTurnAuthorityInput,
  agentTurnBoundary,
  agentTurnCommandInput,
  assertAgentTurnAuthority,
} from "../../../../packages/conversation-domain/src/agent-turn";
import {
  type createDatabase,
  type DatabaseTransaction,
  drizzleTransaction,
} from "../../../../packages/db/src/client";
import {
  agentTurn,
  agentTurnMcp,
  change,
  changeAgentSession,
  changeWriter,
  codingPause,
  ticket,
  ticketConversation,
} from "../../../../packages/db/src/schema";
import { projectAuthorityIn } from "../access/authority";
import { lockChangeWriterIn } from "../access/change-writer";
import { freezeAttachmentContextIn } from "../attachments/api";
import { CommandError } from "../command-error";
import { lockConversation } from "../conversations/api";
import { createMCPLibrary } from "../mcp/library-api";
import { inputTicketAssignmentsIn, monitoringChangeAuthorityIn } from "../monitoring/authority";
import { codingBudgetIn } from "../usage/api";
import type { AgentTurnRecord } from "./turn-record";

type Database = ReturnType<typeof createDatabase>;
type TurnRow = typeof agentTurn.$inferSelect;

function turn(row: TurnRow): AgentTurnRecord {
  return {
    id: row.id,
    commandId: row.commandId,
    command: agentTurnCommandInput.parse(row.input),
    authority: agentTurnAuthorityInput.parse(row.authority),
    state: row.state,
    ownerToken: row.ownerToken,
    ownerExpiresAt: row.ownerExpiresAt?.toISOString() ?? null,
    outcomeSummary: row.outcomeSummary,
  };
}

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
  sql: DatabaseTransaction,
  record: AgentTurnRecord,
  renewingPreparation = false,
) {
  const { command, authority } = record;
  const db = drizzleTransaction(sql);
  if (authority.mode === "build" && "changeId" in command) {
    // Writer transitions take Change before membership. Agent validation must
    // keep this order rather than deadlocking a concurrent human save/handoff.
    await lockChangeWriterIn(sql, command.changeId);
  } else if (command.ticketId) {
    const [currentTicket] = await db
      .select({
        trashed: expression<boolean>`${ticket.trashedAt} IS NOT NULL OR ${ticket.convertedToEpicId} IS NOT NULL`,
      })
      .from(ticket)
      .where(eq(ticket.id, command.ticketId))
      .for("share");
    if (!currentTicket || currentTicket.trashed) return false;
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
  const locked = await db
    .select({ id: change.id })
    .from(change)
    .innerJoin(ticket, eq(ticket.id, change.ticketId))
    .where(
      and(
        eq(change.id, command.changeId),
        eq(change.ticketId, command.ticketId),
        eq(change.projectId, command.projectId),
      ),
    )
    .for("update");
  if (!locked[0]) return false;
  const [writer] = await db
    .select({ state: changeWriter.state, turnID: changeWriter.turnId })
    .from(changeWriter)
    .where(eq(changeWriter.changeId, command.changeId));
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
        AND COALESCE((SELECT integration_base_sha FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),change.base_sha)=review.base_sha
        AND verification.state='succeeded'
        AND verification.runner_id IS NULL
        AND (verification.runtime_attempt_id IS NULL OR EXISTS(
          SELECT 1 FROM factory.runtime_attempt execution
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=execution.id
          WHERE execution.id=verification.runtime_attempt_id AND execution.state='stopped'
            AND binding.deleted_at IS NOT NULL
        ))
        AND review.state IN ('pending','running')
        AND review.commit_sha=(SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)`;
    if (!candidate) return false;
  }
  const stopping = await sql<Array<{ id: string }>>`
    SELECT session.change_id AS id FROM factory.change_agent_session session
      WHERE session.change_id = ${command.changeId} AND session.stop_pending
        AND NOT (${renewingPreparation && record.state === "pending"}
          AND session.stop_turn_id IS DISTINCT FROM ${record.id}::uuid
          AND EXISTS(
            SELECT 1 FROM factory.change_writer writer
            JOIN factory.change change ON change.id=writer.change_id
              AND change.runtime_attempt_id=session.runtime_attempt_id
            JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
              AND attempt.change_id=change.id
            JOIN factory.change_agent_turn_intent intent ON intent.turn_id=writer.turn_id
              AND intent.change_id=change.id AND intent.runtime_attempt_id IS NULL
            WHERE writer.change_id=change.id AND writer.turn_id=${record.id}
              AND writer.state='agent-preparing' AND writer.fence_required
              AND writer.fence_attempt_id=attempt.id))`;
  if (stopping[0]) return false;
  const conversations = await db
    .select({
      id: ticketConversation.id,
      mode: ticketConversation.mode,
      version: ticketConversation.version,
      contextID: ticketConversation.activeCodingContextId,
    })
    .from(ticketConversation)
    .where(eq(ticketConversation.ticketId, command.ticketId))
    .for("update");
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
  async function lockTurnChangeIn(sql: DatabaseTransaction, id: string) {
    const [scope] = await drizzleTransaction(sql)
      .select({ changeID: agentTurn.changeId })
      .from(agentTurn)
      .where(eq(agentTurn.id, id));
    // The immutable linkage selects a lock, never execution authority. Writer
    // transitions already hold Change before Turn; renewal and validation must
    // follow that order too. The owned row and current authority are read below
    // after this wait, including a fresh lease-expiry check.
    if (scope?.changeID) await lockChangeWriterIn(sql, scope.changeID);
  }

  async function validateExecutionIn(
    sql: DatabaseTransaction,
    id: string,
    ownerToken: string,
    forward?: (sql: DatabaseTransaction) => Promise<void>,
  ) {
    await lockTurnChangeIn(sql, id);
    const db = drizzleTransaction(sql);
    const rows = await db
      .select()
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.id, id),
          eq(agentTurn.ownerToken, ownerToken),
          gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
          inArray(agentTurn.state, ["pending", "dispatching", "running"]),
        ),
      )
      .for("update");
    if (!rows[0] || !(await currentAuthorityIn(database, sql, turn(rows[0])))) return false;
    // Authority locks can outlast the lease. Recheck after the last lock wait.
    const live = await db
      .select({ id: agentTurn.id })
      .from(agentTurn)
      .where(
        and(
          eq(agentTurn.id, id),
          eq(agentTurn.ownerToken, ownerToken),
          gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
          inArray(agentTurn.state, ["pending", "dispatching", "running"]),
        ),
      );
    if (!live[0]) return false;
    await forward?.(sql);
    return true;
  }
  async function observeCommit(
    id: string,
    persist: (sql: DatabaseTransaction, current: boolean) => Promise<void>,
  ) {
    return database.client.begin(async (sql) => {
      await lockTurnChangeIn(sql, id);
      const rows = await drizzleTransaction(sql)
        .select()
        .from(agentTurn)
        .where(
          and(
            eq(agentTurn.id, id),
            isNotNull(agentTurn.changeId),
            eq(agentTurn.state, "completed"),
          ),
        )
        .for("update");
      if (!rows[0]) return false;
      const current = await currentAuthorityIn(database, sql, turn(rows[0]));
      await persist(sql, current);
      return current;
    });
  }

  async function admitIn(
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
    )
      throw new CommandError("forbidden", "Autofix must use its recorded Project delegation");
    const digest = fingerprint(command);
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
      return { turn: turn(existing[0]), replayed: true };
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
            inArray(agentTurn.state, ["pending", "dispatching", "running"]),
            and(isNotNull(agentTurn.changeId), eq(agentTurn.state, "uncertain")),
          ),
        ),
      );
    if (active[0])
      throw new CommandError(
        "conflict",
        "An active or unresolved Agent turn already owns this conversation",
      );
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
    const record = turn(rows[0]);
    if (!(authority.mode === "build" && authority.review)) {
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
      if (initial)
        await db.insert(agentTurnMcp).select(
          db
            .select({
              turnId: expression<string>`${record.id}::uuid`.as("turn_id"),
              connectionId: agentTurnMcp.connectionId,
              credentialEpoch: agentTurnMcp.credentialEpoch,
              revisionId: agentTurnMcp.revisionId,
              policyVersion: agentTurnMcp.policyVersion,
              tools: agentTurnMcp.tools,
              required: agentTurnMcp.required,
            })
            .from(agentTurnMcp)
            .where(eq(agentTurnMcp.turnId, initial.id)),
        );
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
          await db.insert(agentTurnMcp).values({
            turnId: record.id,
            connectionId: source.connectionId,
            credentialEpoch: source.credentialEpoch,
            revisionId: source.revisionId,
            policyVersion: source.policyVersion,
            tools: source.tools,
            required: true,
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
    }
    await persistInput?.(transaction, record);
    await freezeAttachmentContextIn(transaction, record);
    return { turn: record, replayed: false };
  }

  return {
    admitIn,
    async resumePendingIn(sql: DatabaseTransaction, id: string) {
      await lockTurnChangeIn(sql, id);
      const db = drizzleTransaction(sql);
      const [row] = await db
        .select()
        .from(agentTurn)
        .where(and(eq(agentTurn.id, id), eq(agentTurn.state, "pending")))
        .for("update");
      if (!row || !(await currentAuthorityIn(database, sql, turn(row))))
        throw new CommandError("conflict", "Paused work no longer has execution authority");
      const budget = await codingBudgetIn(sql, turn(row).command.projectId, true);
      if (!budget.allowed)
        throw new CommandError(
          "conflict",
          "Increase the Coding allowance or wait for its monthly reset before resuming",
        );
      await db
        .update(codingPause)
        .set({ resumedByTurnId: id })
        .where(and(eq(codingPause.turnId, id), isNull(codingPause.resumedByTurnId)));
      return id;
    },
    async admit(
      command: AgentTurnCommand,
      authority: z.input<typeof agentTurnAuthorityInput>,
      persistInput?: (transaction: DatabaseTransaction, record: AgentTurnRecord) => Promise<void>,
    ) {
      return database.client.begin((transaction) =>
        admitIn(transaction, command, authority, persistInput),
      );
    },

    async getByCommand(commandID: string, transaction?: DatabaseTransaction) {
      const rows = await drizzleTransaction(transaction ?? database.client)
        .select()
        .from(agentTurn)
        .where(eq(agentTurn.commandId, commandID));
      return rows[0] ? turn(rows[0]) : null;
    },

    async get(id: string) {
      const rows = await database.db.select().from(agentTurn).where(eq(agentTurn.id, id));
      return rows[0] ? turn(rows[0]) : null;
    },

    async claimPending(id: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      const rows = await database.db
        .update(agentTurn)
        .set({
          ownerToken: crypto.randomUUID(),
          ownerExpiresAt: expression`clock_timestamp() + ${duration} * interval '1 millisecond'`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(agentTurn.id, id),
            eq(agentTurn.state, "pending"),
            notExists(
              database.db
                .select({ id: codingPause.turnId })
                .from(codingPause)
                .where(and(eq(codingPause.turnId, id), isNull(codingPause.resumedByTurnId))),
            ),
            or(
              isNull(agentTurn.ownerToken),
              lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          ),
        )
        .returning();
      return rows[0] ? turn(rows[0]) : null;
    },

    async releasePending(id: string, ownerToken: string) {
      await database.db
        .update(agentTurn)
        .set({ ownerToken: null, ownerExpiresAt: null, updatedAt: expression`now()` })
        .where(
          and(
            eq(agentTurn.id, id),
            eq(agentTurn.state, "pending"),
            eq(agentTurn.ownerToken, ownerToken),
          ),
        );
    },

    async failRevokedPendingPreparation(id: string, ownerToken: string, summary: string) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      return database.client.begin(async (sql) => {
        await lockTurnChangeIn(sql, id);
        const db = drizzleTransaction(sql);
        const [owned] = await db
          .select()
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .for("update");
        if (!owned) return false;
        const record = turn(owned);
        if (
          record.authority.mode !== "build" ||
          !("changeId" in record.command) ||
          (await currentAuthorityIn(database, sql, record, true))
        )
          return false;
        // A Source/predecessor fence can legitimately wait. Record only revoked
        // admission authority, and let every published Stop settle its own Turn.
        const failed = await db
          .update(agentTurn)
          .set({
            state: "failed",
            outcomeSummary: summary,
            ownerToken: null,
            ownerExpiresAt: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              notExists(
                db
                  .select({ id: changeAgentSession.changeId })
                  .from(changeAgentSession)
                  .where(
                    and(
                      eq(changeAgentSession.changeId, record.command.changeId),
                      eq(changeAgentSession.stopPending, true),
                    ),
                  ),
              ),
            ),
          )
          .returning({ id: agentTurn.id });
        return failed.length === 1;
      });
    },

    async beginDispatch(id: string, ownerToken: string) {
      return database.client.begin(async (sql) => {
        await lockTurnChangeIn(sql, id);
        const db = drizzleTransaction(sql);
        const owned = await db
          .select()
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .for("update");
        if (!owned[0] || !(await currentAuthorityIn(database, sql, turn(owned[0])))) return null;
        const record = turn(owned[0]);
        if (record.authority.mode === "build") {
          const budget = await codingBudgetIn(sql, record.command.projectId, true);
          if (!budget.allowed) {
            const reason = budget.reason;
            if (
              reason !== "accounting-incomplete" &&
              reason !== "coding-budget-used" &&
              reason !== "finish-reserve-used"
            )
              throw new Error("Coding allowance denial has no valid pause reason");
            await db
              .insert(codingPause)
              .values({ turnId: id, reason })
              .onConflictDoUpdate({
                target: codingPause.turnId,
                set: { reason, resumedByTurnId: null, createdAt: expression`now()` },
              });
            await db
              .update(agentTurn)
              .set({ ownerToken: null, ownerExpiresAt: null, updatedAt: expression`now()` })
              .where(eq(agentTurn.id, id));
            return null;
          }
        }
        const rows = await db
          .update(agentTurn)
          .set({ state: "dispatching", updatedAt: expression`now()` })
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .returning();
        return rows[0] ? turn(rows[0]) : null;
      });
    },

    validateExecutionIn,
    async validateExecution(
      id: string,
      ownerToken: string,
      forward?: (sql: DatabaseTransaction) => Promise<void>,
    ) {
      return database.client.begin((sql) => validateExecutionIn(sql, id, ownerToken, forward));
    },

    async claimExternalRecovery(id: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      // Recovery may observe an external operation, but never acquires permission
      // to repeat it. A still-live owner and terminal decisions remain untouched.
      const rows = await database.db
        .update(agentTurn)
        .set({
          state: "running",
          ownerToken: crypto.randomUUID(),
          ownerExpiresAt: expression`clock_timestamp() + ${duration} * interval '1 millisecond'`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(agentTurn.id, id),
            isNotNull(agentTurn.changeId),
            inArray(agentTurn.state, ["dispatching", "running", "uncertain"]),
            or(
              isNull(agentTurn.ownerToken),
              lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          ),
        )
        .returning();
      return rows[0] ? turn(rows[0]) : null;
    },

    async validateCommit(id: string, forward: (sql: DatabaseTransaction) => Promise<void>) {
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
      const rows = await database.db
        .update(agentTurn)
        .set({
          state: "uncertain",
          ownerToken: null,
          ownerExpiresAt: null,
          outcomeSummary:
            "The provider outcome was lost after dispatch. Retry requires a new explicit attempt.",
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(agentTurn.id, id),
            isNull(agentTurn.changeId),
            inArray(agentTurn.state, ["dispatching", "running"]),
            or(
              isNull(agentTurn.ownerToken),
              lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          ),
        )
        .returning({ id: agentTurn.id });
      return rows.length === 1;
    },

    async renew(id: string, ownerToken: string, milliseconds = 30_000) {
      const duration = leaseDuration(milliseconds);
      return database.client.begin(async (sql) => {
        await lockTurnChangeIn(sql, id);
        const db = drizzleTransaction(sql);
        const [owned] = await db
          .select()
          .from(agentTurn)
          .where(and(eq(agentTurn.id, id), eq(agentTurn.ownerToken, ownerToken)))
          .for("update");
        // Renew only the current pending preparation while its previous input
        // settles. Ordinary execution validation still rejects that Stop.
        if (!owned || !(await currentAuthorityIn(database, sql, turn(owned), true))) return false;
        const rows = await db
          .update(agentTurn)
          .set({
            ownerExpiresAt: expression`clock_timestamp() + ${duration} * interval '1 millisecond'`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              inArray(agentTurn.state, ["pending", "dispatching", "running"]),
            ),
          )
          .returning({ id: agentTurn.id });
        return rows.length === 1;
      });
    },

    async failPending(id: string, ownerToken: string, summary: string) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      const rows = await database.db
        .update(agentTurn)
        .set({
          state: "failed",
          outcomeSummary: summary,
          ownerToken: null,
          ownerExpiresAt: null,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(agentTurn.id, id),
            eq(agentTurn.state, "pending"),
            eq(agentTurn.ownerToken, ownerToken),
            gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
          ),
        )
        .returning({ id: agentTurn.id });
      return rows.length === 1;
    },

    // Only the worker whose runtime startup has rejected may record this
    // never-bound input's failure after lease loss. This grants no execution
    // authority, renews no lease and cannot settle another owner's preparation.
    async failUnboundStartup(id: string, ownerToken: string, summary: string) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      return database.client.begin(async (sql) => {
        await lockTurnChangeIn(sql, id);
        const [owned] = await drizzleTransaction(sql)
          .select()
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "pending"),
              eq(agentTurn.ownerToken, ownerToken),
              lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .for("update");
        if (!owned) return false;
        const record = turn(owned);
        if (
          record.authority.mode !== "build" ||
          !("changeId" in record.command) ||
          !(await currentAuthorityIn(database, sql, record))
        )
          return false;
        // Authority may wait on Change/Stop. A fresh statement after those
        // locks must still prove that no intent or Session was bound.
        const failed = await sql<{ id: string }[]>`UPDATE factory.agent_turn turn
          SET state='failed',outcome_summary=${summary},owner_token=NULL,owner_expires_at=NULL,updated_at=now()
          WHERE turn.id=${id} AND turn.change_id=${record.command.changeId}
            AND turn.state='pending' AND turn.owner_token=${ownerToken}
            AND turn.owner_expires_at<=clock_timestamp()
            AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent intent
              WHERE intent.turn_id=turn.id AND intent.change_id=turn.change_id
                AND intent.runtime_attempt_id IS NULL)
            AND EXISTS(SELECT 1 FROM factory.change_writer writer
              WHERE writer.change_id=turn.change_id AND writer.turn_id=turn.id
                AND writer.state='agent' AND NOT writer.fence_required)
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session
              WHERE session.change_id=turn.change_id
                AND (session.active_turn_id=turn.id OR session.stop_pending))
          RETURNING turn.id`;
        return failed.length === 1;
      });
    },

    async markRunning(
      id: string,
      ownerToken: string,
      persistOutcome: (sql: DatabaseTransaction) => Promise<void>,
    ) {
      return database.client.begin(async (sql) => {
        await lockTurnChangeIn(sql, id);
        const db = drizzleTransaction(sql);
        const admitted = await db
          .select()
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "dispatching"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .for("update");
        if (!admitted[0] || !(await currentAuthorityIn(database, sql, turn(admitted[0]))))
          return false;
        const rows = await db
          .update(agentTurn)
          .set({ state: "running", updatedAt: expression`now()` })
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.state, "dispatching"),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
            ),
          )
          .returning({ id: agentTurn.id });
        if (!rows[0]) return false;
        await persistOutcome(sql);
        const owned = await db
          .select({ id: agentTurn.id })
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              eq(agentTurn.state, "running"),
            ),
          );
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
      persistOutcome?: (transaction: DatabaseTransaction) => Promise<void>,
    ) {
      if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
      if (persistOutcome && state !== "completed") {
        throw new Error("Only a completed Agent turn may publish product effects");
      }
      return database.client.begin(async (transaction) => {
        if (persistOutcome) await lockTurnChangeIn(transaction, id);
        const db = drizzleTransaction(transaction);
        const owned = await db
          .select()
          .from(agentTurn)
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              inArray(agentTurn.state, ["dispatching", "running"]),
            ),
          )
          .for("update");
        if (!owned[0]) return false;
        if (persistOutcome && !(await currentAuthorityIn(database, transaction, turn(owned[0]))))
          return false;
        await persistOutcome?.(transaction);
        const settled = await db
          .update(agentTurn)
          .set({
            state,
            outcomeSummary: summary,
            ownerToken: null,
            ownerExpiresAt: null,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(agentTurn.id, id),
              eq(agentTurn.ownerToken, ownerToken),
              gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
              inArray(agentTurn.state, ["dispatching", "running"]),
            ),
          )
          .returning({ id: agentTurn.id });
        if (!settled[0]) {
          // Throwing rolls back effects if ownership expired while the transaction ran.
          throw new CommandError("conflict", "Agent turn ownership expired before settlement");
        }
        return true;
      });
    },
  };
}
