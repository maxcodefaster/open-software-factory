import { and, eq, sql as expression } from "drizzle-orm";
import { sampleLearningCase } from "#conversation-domain/learning";
import { type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { operation, skillLibrary, skillRevision } from "#db/schema";
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
    .select({ turnId: operation.scopeId })
    .from(operation)
    .innerJoin(
      skillRevision,
      eq(skillRevision.id, expression`(${operation.payload}->>'revisionId')::uuid`),
    )
    .innerJoin(skillLibrary, eq(skillLibrary.id, skillRevision.libraryId))
    .where(
      and(
        eq(operation.kind, "coding.turn_skill"),
        eq(operation.scopeType, "agent_turn"),
        eq(operation.scopeId, turn.id),
        eq(skillLibrary.scope, "personal"),
      ),
    )
    .limit(1);
  const ownerId = turn.command.ticketId && !personal ? null : turn.command.createdBy;
  if (!(await learningEnabledIn(sql, turn.command.projectId, ownerId))) return;
  for (const [ordinal, artifact] of artifacts
    .filter((item) => item.body.trim())
    .slice(0, 3)
    .entries())
    await db.insert(operation).values({
      id: crypto.randomUUID(),
      kind: "learning.source_artifact",
      scopeType: "agent_turn",
      scopeId: turn.id,
      idempotencyKey: `learning.source_artifact:${turn.id}:${ordinal}`,
      state: "recorded",
      createdBy: turn.command.createdBy,
      completedAt: expression<Date>`now()`,
      payload: {
        turnId: turn.id,
        ordinal,
        reference: artifact.reference.slice(0, 400),
        body: artifact.body.slice(0, 2_000),
        truncated: artifact.truncated || artifact.body.length > 2_000,
      },
    });
}
