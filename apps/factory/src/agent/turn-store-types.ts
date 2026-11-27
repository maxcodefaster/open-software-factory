import { createHash } from "node:crypto";
import { and, eq, sql as expression, gt, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import {
  type AgentTurnAuthority,
  type AgentTurnCommand,
  type AgentTurnState,
  agentTurnAuthorityInput,
  agentTurnCommandInput,
} from "#conversation-domain/agent-turn";
import type { createDatabase } from "#db/client";
import { agentTurn, operation } from "#db/schema";
import type { AgentTurnRecord } from "./turn-record";

export type Database = ReturnType<typeof createDatabase>;
export type TurnRow = typeof agentTurn.$inferSelect;

export type BuildTurnCommand = Extract<AgentTurnCommand, { changeId: string }>;
export type ProjectTurnCommand = Exclude<AgentTurnCommand, { changeId: string }>;
export type BuildTurnAuthority = Extract<AgentTurnAuthority, { mode: "build" }>;
export type ProjectTurnAuthority = Exclude<AgentTurnAuthority, { mode: "build" }>;

export type TurnAuthorityScope =
  | {
      kind: "build";
      record: AgentTurnRecord;
      command: BuildTurnCommand;
      authority: BuildTurnAuthority;
    }
  | {
      kind: "project";
      record: AgentTurnRecord;
      command: ProjectTurnCommand;
      authority: ProjectTurnAuthority;
    };

export const CODING_PAUSE_KIND = "usage.coding_pause";
export const CODING_TURN_MCP_KIND = "coding.turn_mcp";

export type CodingPauseReason =
  | "accounting-incomplete"
  | "coding-budget-used"
  | "finish-reserve-used";

export type CodingPauseState =
  | { kind: "paused"; turnId: string; reason: CodingPauseReason; resumedByTurnId: null }
  | { kind: "resumed"; turnId: string; resumedByTurnId: string };

export type TurnLeaseCondition =
  | { kind: "live"; ownerToken: string }
  | { kind: "expired-owner"; ownerToken: string }
  | { kind: "claimable" };

export const LIVE_TURN_STATES: AgentTurnState[] = ["pending", "dispatching", "running"];
export const DISPATCHED_TURN_STATES: AgentTurnState[] = ["dispatching", "running"];
export const RECOVERABLE_TURN_STATES: AgentTurnState[] = ["dispatching", "running", "uncertain"];

export function toTurnRecord(row: TurnRow): AgentTurnRecord {
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

export function classifyTurnScope(record: AgentTurnRecord): TurnAuthorityScope | null {
  if (record.authority.mode === "build") {
    if (!("changeId" in record.command)) return null;
    return {
      kind: "build",
      record,
      command: record.command,
      authority: record.authority,
    };
  }
  if ("changeId" in record.command) return null;
  return {
    kind: "project",
    record,
    command: record.command,
    authority: record.authority,
  };
}

export function fingerprintCommand(command: AgentTurnCommand) {
  // Zod's fixed object schemas normalize key order, trim text and fill answer defaults.
  const { commandId: _commandId, ...payload } = command;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function leaseDuration(milliseconds: number) {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new Error("Agent ownership lease must be between 1 and 60000 milliseconds");
  }
  return milliseconds;
}

export function leaseExpirySql(durationMilliseconds: number) {
  return expression`clock_timestamp() + ${durationMilliseconds} * interval '1 millisecond'`;
}

export function assertOutcomeSummary(summary: string) {
  if (summary.length > 2_000) throw new Error("Agent outcome summary is too large");
}

export function assertCodingPauseReason(reason: string | null | undefined): CodingPauseReason {
  if (
    reason !== "accounting-incomplete" &&
    reason !== "coding-budget-used" &&
    reason !== "finish-reserve-used"
  ) {
    throw new Error("Coding allowance denial has no valid pause reason");
  }
  return reason;
}

export function turnLeasePredicate(
  id: string,
  states: AgentTurnState | AgentTurnState[],
  lease: TurnLeaseCondition,
): SQL | undefined {
  const statePredicate = Array.isArray(states)
    ? inArray(agentTurn.state, states)
    : eq(agentTurn.state, states);
  switch (lease.kind) {
    case "live":
      return and(
        eq(agentTurn.id, id),
        statePredicate,
        eq(agentTurn.ownerToken, lease.ownerToken),
        gt(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
      );
    case "expired-owner":
      return and(
        eq(agentTurn.id, id),
        statePredicate,
        eq(agentTurn.ownerToken, lease.ownerToken),
        lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
      );
    case "claimable":
      return and(
        eq(agentTurn.id, id),
        statePredicate,
        or(
          isNull(agentTurn.ownerToken),
          lte(agentTurn.ownerExpiresAt, expression`clock_timestamp()`),
        ),
      );
  }
}

export function unresumedCodingPauseWhere(turnID: string) {
  return and(
    eq(operation.kind, CODING_PAUSE_KIND),
    eq(operation.scopeType, "agent_turn"),
    eq(operation.scopeId, turnID),
    eq(operation.state, "paused"),
    expression`(${operation.payload}->>'resumedByTurnId') IS NULL`,
  );
}
