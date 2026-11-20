import { and, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
import { turnObservationInput } from "../../../../packages/conversation-domain/src/turn-observation";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  agentTurn,
  agentTurnSkill,
  change,
  modelConnectionVersion,
  skillRevision,
  ticketConversation,
} from "../../../../packages/db/src/schema";

type Database = ReturnType<typeof createDatabase>;
type Target =
  | { changeID: string; turnID?: string }
  | { conversationID: string; contextID?: string };

// Internal read only. Callers authorize the containing Project/Change/conversation.
export async function readTurnObservation(database: Database, target: Target) {
  const db = database.db;
  const contextID = sql<string | null>`${agentTurn.input}->>'contextId'`;
  const scope =
    "changeID" in target
      ? and(
          eq(agentTurn.changeId, target.changeID),
          target.turnID != null
            ? eq(agentTurn.id, target.turnID)
            : sql`${contextID} IS NOT DISTINCT FROM (${db
                .select({
                  id: sql<string | null>`${ticketConversation.activeCodingContextId}::text`,
                })
                .from(ticketConversation)
                .innerJoin(change, eq(change.ticketId, ticketConversation.ticketId))
                .where(eq(change.id, target.changeID))})`,
        )
      : and(
          eq(agentTurn.conversationId, target.conversationID),
          sql`${contextID} IS NOT DISTINCT FROM ${target.contextID ?? null}`,
          isNull(agentTurn.changeId),
        );
  const [row] = await db
    .select({
      id: agentTurn.id,
      commandId: agentTurn.commandId,
      state: agentTurn.state,
      summary: agentTurn.outcomeSummary,
      authority: agentTurn.authority,
      provider: modelConnectionVersion.provider,
    })
    .from(agentTurn)
    .leftJoin(
      modelConnectionVersion,
      and(
        eq(
          sql`${modelConnectionVersion.connectionId}::text`,
          sql`${agentTurn.authority}#>>'{modelConnection,connectionID}'`,
        ),
        eq(
          sql`${modelConnectionVersion.version}::text`,
          sql`${agentTurn.authority}#>>'{modelConnection,version}'`,
        ),
      ),
    )
    .where(scope)
    .orderBy(desc(agentTurn.createdAt), desc(agentTurn.id))
    .limit(1);
  if (!row) return undefined;
  const authority = agentTurnAuthorityInput.parse(row.authority);
  const skills = await db
    .select({
      id: skillRevision.id,
      name: sql<string>`${skillRevision.content}->>'name'`,
      revision: skillRevision.revision,
      digest: skillRevision.contentDigest,
      loaded: exists(
        db
          .select({ id: agentTurnSkill.revisionId })
          .from(agentTurnSkill)
          .where(
            and(eq(agentTurnSkill.turnId, row.id), eq(agentTurnSkill.revisionId, skillRevision.id)),
          ),
      ),
    })
    .from(skillRevision)
    .where(inArray(skillRevision.id, authority.skillRevisionIds))
    .orderBy(
      sql`array_position(${sql.param(authority.skillRevisionIds)}::uuid[],${skillRevision.id})`,
    );
  return turnObservationInput.parse({
    id: row.id,
    commandId: row.commandId,
    state: row.state,
    summary: row.summary,
    engine: authority.mode === "build" ? "opencode" : "mastra",
    mode: authority.mode,
    ...(authority.mode === "build" && authority.review ? { purpose: "review" as const } : {}),
    modelId: authority.modelId,
    ...(authority.mode === "build" &&
    authority.codingReasoning &&
    (row.provider ?? process.env["FACTORY_MODEL_PROVIDER"] ?? "openai") === "openai"
      ? { codingReasoning: authority.codingReasoning }
      : {}),
    skills,
  });
}
