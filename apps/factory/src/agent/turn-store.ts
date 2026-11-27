import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { AgentTurnCommand, agentTurnAuthorityInput } from "#conversation-domain/agent-turn";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { agentTurn } from "#db/schema";
import type { AgentTurnRecord } from "./turn-record";
import { admitTurnIn } from "./turn-store-admission";
import {
  claimExternalRecoveryTurn,
  claimPendingTurn,
  observeTurnCommit,
  quarantineExpiredProjectTurn,
  releasePendingTurn,
  renewTurnLease,
  validateTurnExecutionIn,
} from "./turn-store-lease";
import {
  beginTurnDispatch,
  failPendingTurn,
  failRevokedPendingPreparationTurn,
  failUnboundStartupTurn,
  markTurnRunning,
  resumePendingTurnIn,
  settleTurn,
} from "./turn-store-settlement";
import { type Database, toTurnRecord } from "./turn-store-types";

export function createAgentTurnStore(database: Database) {
  function admitIn(
    transaction: DatabaseTransaction,
    rawCommand: AgentTurnCommand,
    rawAuthority: z.input<typeof agentTurnAuthorityInput>,
    persistInput?: (transaction: DatabaseTransaction, record: AgentTurnRecord) => Promise<void>,
  ) {
    return admitTurnIn(database, transaction, rawCommand, rawAuthority, persistInput);
  }

  function validateExecutionIn(
    sql: DatabaseTransaction,
    id: string,
    ownerToken: string,
    forward?: (sql: DatabaseTransaction) => Promise<void>,
  ) {
    return validateTurnExecutionIn(database, sql, id, ownerToken, forward);
  }

  // An already dispatched push may finish after authority is revoked. Retain
  // its observed result, but publish to the current Session only if permitted.
  function observeCommit(
    id: string,
    persist: (sql: DatabaseTransaction, current: boolean) => Promise<void>,
  ) {
    return observeTurnCommit(database, id, persist);
  }

  return {
    admitIn,

    resumePendingIn(sql: DatabaseTransaction, id: string) {
      return resumePendingTurnIn(database, sql, id);
    },

    admit(
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
      return rows[0] ? toTurnRecord(rows[0]) : null;
    },

    async get(id: string) {
      const rows = await database.db.select().from(agentTurn).where(eq(agentTurn.id, id));
      return rows[0] ? toTurnRecord(rows[0]) : null;
    },

    claimPending(id: string, milliseconds = 30_000) {
      return claimPendingTurn(database, id, milliseconds);
    },

    releasePending(id: string, ownerToken: string) {
      return releasePendingTurn(database, id, ownerToken);
    },

    failRevokedPendingPreparation(id: string, ownerToken: string, summary: string) {
      return failRevokedPendingPreparationTurn(database, id, ownerToken, summary);
    },

    beginDispatch(id: string, ownerToken: string) {
      return beginTurnDispatch(database, id, ownerToken);
    },

    validateExecutionIn,

    validateExecution(
      id: string,
      ownerToken: string,
      forward?: (sql: DatabaseTransaction) => Promise<void>,
    ) {
      return database.client.begin((sql) => validateExecutionIn(sql, id, ownerToken, forward));
    },

    claimExternalRecovery(id: string, milliseconds = 30_000) {
      return claimExternalRecoveryTurn(database, id, milliseconds);
    },

    validateCommit(id: string, forward: (sql: DatabaseTransaction) => Promise<void>) {
      return observeCommit(id, async (sql, current) => {
        if (current) await forward(sql);
      });
    },

    observeCommit,

    quarantineExpiredProject(id: string) {
      return quarantineExpiredProjectTurn(database, id);
    },

    renew(id: string, ownerToken: string, milliseconds = 30_000) {
      return renewTurnLease(database, id, ownerToken, milliseconds);
    },

    failPending(id: string, ownerToken: string, summary: string) {
      return failPendingTurn(database, id, ownerToken, summary);
    },

    failUnboundStartup(id: string, ownerToken: string, summary: string) {
      return failUnboundStartupTurn(database, id, ownerToken, summary);
    },

    markRunning(
      id: string,
      ownerToken: string,
      persistOutcome: (sql: DatabaseTransaction) => Promise<void>,
    ) {
      return markTurnRunning(database, id, ownerToken, persistOutcome);
    },

    settle(
      id: string,
      ownerToken: string,
      state: "completed" | "failed" | "uncertain",
      summary: string,
      persistOutcome?: (transaction: DatabaseTransaction) => Promise<void>,
    ) {
      return settleTurn(database, id, ownerToken, state, summary, persistOutcome);
    },
  };
}
