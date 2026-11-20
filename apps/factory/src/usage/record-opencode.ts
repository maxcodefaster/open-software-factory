import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { unknownCounters } from "../../../../packages/conversation-domain/src/usage";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  agentTurn,
  changeAgentTurnIntent,
  modelConnectionVersion,
  usageOperation,
  usageReplayCursor,
} from "../../../../packages/db/src/schema";
import { type createOpenCodeClient, listOpenCodeSessionTree } from "../agent/opencode-client";
import { createContractRates } from "./contract-rates";
import { createUsageJournal } from "./journal";
import { drainOpenCodeUsage } from "./opencode";

type Database = ReturnType<typeof createDatabase>;
type Client = ReturnType<typeof createOpenCodeClient>;

export function createRecordedOpenCodeUsage(database: Database) {
  const journal = createUsageJournal(database);
  async function drain(
    turnID: string,
    client: Client,
    root: string,
    sessionIDs?: readonly string[],
  ) {
    const operationID = `turn:${turnID}`;
    const admitted = await database.db
      .select({ id: usageOperation.id })
      .from(usageOperation)
      .where(eq(usageOperation.id, operationID));
    if (!admitted.length) return;
    const current = alias(usageOperation, "current");
    const currentIntent = alias(changeAgentTurnIntent, "current_intent");
    const [next] = await database.db
      .select({ id: usageOperation.id, created_at: usageOperation.createdAt })
      .from(usageOperation)
      .innerJoin(
        changeAgentTurnIntent,
        sql`${usageOperation.id}='turn:'||${changeAgentTurnIntent.turnId}`,
      )
      .innerJoin(current, eq(current.id, operationID))
      .innerJoin(currentIntent, sql`${currentIntent.turnId}::text=substring(${current.id} from 6)`)
      .where(
        and(
          eq(changeAgentTurnIntent.changeId, currentIntent.changeId),
          gt(usageOperation.createdAt, current.createdAt),
        ),
      )
      .orderBy(asc(usageOperation.createdAt))
      .limit(1);
    for (const sessionID of sessionIDs ?? (await listOpenCodeSessionTree(client, root))) {
      const [boundary] = next
        ? await database.db
            .select({ start_sequence: usageReplayCursor.startSequence })
            .from(usageReplayCursor)
            .where(
              and(
                eq(usageReplayCursor.operationId, next.id),
                eq(usageReplayCursor.sessionId, sessionID),
              ),
            )
        : [];
      const ceiling = boundary ? Number(boundary.start_sequence) : null;
      await drainOpenCodeUsage({
        sessionID,
        after: await journal.cursor(operationID, sessionID),
        log: (after) =>
          client.session.log(
            { sessionID, after, follow: false },
            { signal: AbortSignal.timeout(5000) },
          ),
        record: (entry, sequence) => {
          if (
            (ceiling !== null && sequence > ceiling) ||
            (next &&
              !boundary &&
              Date.parse(entry.occurredAt) >= new Date(next.created_at).getTime())
          )
            return Promise.resolve();
          return journal.record(operationID, entry, { sessionID, sequence });
        },
        advance: (sequence) =>
          journal.advance(
            operationID,
            sessionID,
            ceiling === null ? sequence : Math.min(sequence, ceiling),
          ),
      });
    }
  }
  return {
    drain,
    async prepare(turnID: string, client: Client, root: string) {
      const operationID = `turn:${turnID}`;
      const existing = await database.db
        .select({ id: usageOperation.id })
        .from(usageOperation)
        .where(eq(usageOperation.id, operationID));
      if (existing.length) return;
      const [turn] = await database.db
        .select({
          project_id: agentTurn.projectId,
          created_by: agentTurn.createdBy,
          provider: modelConnectionVersion.provider,
          model: sql<string>`${agentTurn.authority}->>'modelId'`,
        })
        .from(agentTurn)
        .leftJoin(
          modelConnectionVersion,
          sql`
        ${modelConnectionVersion.connectionId}=(${agentTurn.authority}->'modelConnection'->>'connectionID')::uuid
        AND ${modelConnectionVersion.version}=(${agentTurn.authority}->'modelConnection'->>'version')::bigint`,
        )
        .where(eq(agentTurn.id, turnID));
      if (!turn) throw new Error("Usage needs an admitted Build turn");
      const provider = turn.provider ?? "openai";
      // Finish the previous owner before freezing the next turn's baseline, including late titles.
      const current = alias(changeAgentTurnIntent, "current");
      const previous = await database.db
        .select({ turn_id: changeAgentTurnIntent.turnId })
        .from(changeAgentTurnIntent)
        .innerJoin(
          usageOperation,
          sql`${usageOperation.id}='turn:'||${changeAgentTurnIntent.turnId}`,
        )
        .innerJoin(current, eq(current.turnId, turnID))
        .where(
          and(
            eq(changeAgentTurnIntent.changeId, current.changeId),
            eq(changeAgentTurnIntent.sessionId, root),
            ne(changeAgentTurnIntent.turnId, turnID),
          ),
        )
        .orderBy(desc(usageOperation.createdAt))
        .limit(1);
      if (previous[0]) await drain(previous[0].turn_id, client, root);
      // Capture prior Session watermarks before this turn can dispatch paid inference.
      const baselines: Array<{ sessionID: string; sequence: number }> = [];
      for (const sessionID of await listOpenCodeSessionTree(client, root)) {
        const sequence = await drainOpenCodeUsage({
          sessionID,
          after: 0,
          log: (after) =>
            client.session.log(
              { sessionID, after, follow: false },
              { signal: AbortSignal.timeout(5000) },
            ),
          record: async () => {},
          advance: async () => {},
        });
        baselines.push({ sessionID, sequence });
      }
      await journal.begin(
        {
          id: operationID,
          projectID: turn.project_id,
          userID: turn.created_by,
          purpose: "coding",
          engine: "opencode",
          provider,
          model: turn.model,
          rate: await createContractRates(database).get(provider, turn.model),
        },
        baselines,
      );
    },
    async settle(
      turnID: string,
      outcome: "completed" | "failed" | "interrupted" | "unknown",
      locallyDenied = false,
    ) {
      const operationID = `turn:${turnID}`;
      const [operation] = await database.db
        .select({ created_at: usageOperation.createdAt })
        .from(usageOperation)
        .where(and(eq(usageOperation.id, operationID), isNull(usageOperation.settledAt)));
      if (!operation) return;
      if (outcome !== "completed" && !locallyDenied)
        await journal.record(operationID, {
          eventID: "unobserved",
          source: "unobserved",
          outcome,
          counters: unknownCounters(),
          occurredAt: new Date(operation.created_at).toISOString(),
        });
      await journal.settle(operationID, outcome);
    },
    async drainAttempt(attemptID: string, client: Client) {
      const pending = await database.db
        .select({
          turn_id: changeAgentTurnIntent.turnId,
          session_id: changeAgentTurnIntent.sessionId,
        })
        .from(changeAgentTurnIntent)
        .innerJoin(
          usageOperation,
          sql`${usageOperation.id}='turn:'||${changeAgentTurnIntent.turnId}`,
        )
        .where(eq(changeAgentTurnIntent.runtimeAttemptId, attemptID))
        .orderBy(asc(usageOperation.createdAt));
      for (const input of pending) await drain(input.turn_id, client, input.session_id);
    },
    async markUnavailable(attemptID: string) {
      const pending = await database.db
        .select({ id: usageOperation.id, created_at: usageOperation.createdAt })
        .from(changeAgentTurnIntent)
        .innerJoin(
          usageOperation,
          sql`${usageOperation.id}='turn:'||${changeAgentTurnIntent.turnId}`,
        )
        .where(eq(changeAgentTurnIntent.runtimeAttemptId, attemptID));
      for (const operation of pending) {
        await journal.record(operation.id, {
          eventID: "storage-unavailable",
          source: "unobserved",
          outcome: "unknown",
          counters: unknownCounters(),
          occurredAt: new Date(operation.created_at).toISOString(),
        });
        await journal.settle(operation.id, "unknown");
      }
    },
  };
}
