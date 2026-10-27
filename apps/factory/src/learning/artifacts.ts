import type { AgentTurnTransaction } from "../agent/turn-store";
import { sampleLearningCase } from "../../../../packages/conversation-domain/src/learning";
import { learningEnabledIn } from "./authority";

export type LearningSourceArtifact = { reference: string; body: string; truncated: boolean };
export async function retainLearningArtifactsIn(
  sql: AgentTurnTransaction,
  turn: { id: string; command: { projectId: string; createdBy: string; ticketId?: string | null } },
  artifacts: LearningSourceArtifact[],
) {
  if (!sampleLearningCase(`turn:${turn.id}`, "completed") || !artifacts.length) return;
  const [personal] = await sql`SELECT loaded.turn_id FROM factory.agent_turn_skill loaded
    JOIN factory.skill_library_revision link ON link.revision_id=loaded.revision_id
    JOIN factory.skill_library library ON library.id=link.library_id
    WHERE loaded.turn_id=${turn.id} AND library.scope='personal' LIMIT 1`;
  const ownerId = turn.command.ticketId && !personal ? null : turn.command.createdBy;
  if (!(await learningEnabledIn(sql, turn.command.projectId, ownerId))) return;
  for (const [ordinal, artifact] of artifacts
    .filter((item) => item.body.trim())
    .slice(0, 3)
    .entries())
    await sql`INSERT INTO factory.learning_source_artifact(turn_id,ordinal,reference,body,truncated)
      VALUES(${turn.id},${ordinal},${artifact.reference.slice(0, 400)},${artifact.body.slice(0, 2_000)},
        ${artifact.truncated || artifact.body.length > 2_000})`;
}
