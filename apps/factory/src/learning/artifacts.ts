import { and, eq } from "drizzle-orm";
import { sampleLearningCase } from "../../../../packages/conversation-domain/src/learning";
import { type DatabaseTransaction, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  agentTurnSkill,
  learningSourceArtifact,
  skillLibrary,
  skillLibraryRevision,
} from "../../../../packages/db/src/schema";
import { learningEnabledIn } from "./authority";

export type LearningSourceArtifact = { reference: string; body: string; truncated: boolean };
export async function retainLearningArtifactsIn(
  sql: DatabaseTransaction,
  turn: { id: string; command: { projectId: string; createdBy: string; ticketId?: string | null } },
  artifacts: LearningSourceArtifact[],
) {
  if (!sampleLearningCase(`turn:${turn.id}`, "completed") || !artifacts.length) return;
  const db = drizzleTransaction(sql);
  const [personal] = await db
    .select({ turnId: agentTurnSkill.turnId })
    .from(agentTurnSkill)
    .innerJoin(skillLibraryRevision, eq(skillLibraryRevision.revisionId, agentTurnSkill.revisionId))
    .innerJoin(skillLibrary, eq(skillLibrary.id, skillLibraryRevision.libraryId))
    .where(and(eq(agentTurnSkill.turnId, turn.id), eq(skillLibrary.scope, "personal")))
    .limit(1);
  const ownerId = turn.command.ticketId && !personal ? null : turn.command.createdBy;
  if (!(await learningEnabledIn(sql, turn.command.projectId, ownerId))) return;
  for (const [ordinal, artifact] of artifacts
    .filter((item) => item.body.trim())
    .slice(0, 3)
    .entries())
    await db.insert(learningSourceArtifact).values({
      turnId: turn.id,
      ordinal,
      reference: artifact.reference.slice(0, 400),
      body: artifact.body.slice(0, 2_000),
      truncated: artifact.truncated || artifact.body.length > 2_000,
    });
}
