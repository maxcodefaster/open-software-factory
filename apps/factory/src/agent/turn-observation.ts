import { agentTurnAuthorityInput } from "../../../../packages/conversation-domain/src/agent-turn";
import { turnObservationInput } from "../../../../packages/conversation-domain/src/turn-observation";
import type { createDatabase } from "../../../../packages/db/src/client";

type Database = ReturnType<typeof createDatabase>;
type Target = { changeID: string; turnID?: string } | { conversationID: string };

// Internal read only. Callers authorize the containing Project/Change/conversation.
export async function readTurnObservation(database: Database, target: Target) {
  const rows = await database.client<
    Array<{
      id: string;
      commandId: string;
      state: string;
      summary: string | null;
      authority: unknown;
    }>
  >`
    SELECT id, command_id AS "commandId", state, outcome_summary AS summary, authority
    FROM factory.agent_turn
    WHERE (${"changeID" in target ? target.changeID : null}::uuid IS NOT NULL
      AND change_id = ${"changeID" in target ? target.changeID : null}
      AND (${"turnID" in target ? (target.turnID ?? null) : null}::uuid IS NULL
        OR id = ${"turnID" in target ? (target.turnID ?? null) : null}))
      OR (${"conversationID" in target ? target.conversationID : null}::uuid IS NOT NULL
        AND conversation_id = ${"conversationID" in target ? target.conversationID : null}
        AND change_id IS NULL)
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = rows[0];
  if (!row) return undefined;
  const authority = agentTurnAuthorityInput.parse(row.authority);
  const skills = await database.client<
    Array<{
      id: string;
      name: string;
      revision: number;
      digest: string;
      loaded: boolean;
    }>
  >`
    SELECT revision.id, revision.content->>'name' AS name, revision.revision::float8 AS revision,
      revision.content_digest AS digest,
      EXISTS(SELECT 1 FROM factory.agent_turn_skill loaded
        WHERE loaded.turn_id = ${row.id} AND loaded.revision_id = revision.id) AS loaded
    FROM factory.skill_revision revision
    WHERE revision.id = ANY(${authority.skillRevisionIds}::uuid[])
    ORDER BY array_position(${authority.skillRevisionIds}::uuid[], revision.id)`;
  return turnObservationInput.parse({
    id: row.id,
    commandId: row.commandId,
    state: row.state,
    summary: row.summary,
    engine: authority.mode === "build" ? "opencode" : "mastra",
    mode: authority.mode,
    modelId: authority.modelId,
    skills,
  });
}
