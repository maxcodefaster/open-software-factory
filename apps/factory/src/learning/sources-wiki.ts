import { and, asc, eq, isNotNull, notInArray, sql as typedSQL } from "drizzle-orm";
import { knowledgePage, knowledgeRevision, operation as operationRecord } from "#db/schema";
import type {
  EvidenceCollector,
  LearningDrizzle,
  SnapshotMetadata,
  SourceOperation,
} from "./sources-types";

export async function collectWikiEvidence(
  db: LearningDrizzle,
  operation: SourceOperation,
  generationId: string,
  collector: EvidenceCollector,
): Promise<SnapshotMetadata | null> {
  const [generation] = await db
    .select({
      state: operationRecord.state,
      commit: typedSQL<string>`${operationRecord.payload}->>'sourceCommitSha'`,
      failure: typedSQL<
        string | null
      >`coalesce(${operationRecord.error}, ${operationRecord.payload}->>'failure')`,
      pages: typedSQL<number | null>`(${operationRecord.payload}->>'pageCount')::int`,
      conflicts: typedSQL<number | null>`(${operationRecord.payload}->>'conflictCount')::int`,
      completedAt: operationRecord.completedAt,
    })
    .from(operationRecord)
    .where(
      and(
        eq(operationRecord.id, generationId),
        eq(operationRecord.kind, "knowledge.generation"),
        eq(operationRecord.scopeType, "project"),
        eq(operationRecord.scopeId, operation.projectId),
        isNotNull(operationRecord.completedAt),
      ),
    );
  if (!generation?.completedAt) return null;

  // One model call's status says nothing about the generation this case reviews.
  const outcome = generation.state === "succeeded" ? "completed" : "failed";
  const { completedAt, ...retained } = generation;
  collector.add(`wiki:${generationId}:outcome`, "outcome", retained);

  const revisions = await db
    .select({
      id: knowledgeRevision.id,
      title: knowledgeRevision.title,
      body: knowledgeRevision.body,
      commit: knowledgeRevision.sourceCommitSha,
      pageId: knowledgePage.id,
      version: knowledgePage.version,
    })
    .from(knowledgeRevision)
    .leftJoin(
      knowledgePage,
      and(
        eq(knowledgePage.id, knowledgeRevision.pageId),
        eq(knowledgePage.currentRevisionId, knowledgeRevision.id),
        eq(knowledgePage.state, "active"),
      ),
    )
    .where(eq(knowledgeRevision.generationId, generationId))
    .orderBy(asc(knowledgeRevision.id))
    .limit(3);
  for (const revision of revisions) {
    collector.add(`knowledge:${revision.id}`, "artifact", revision, 5_000);
    if (revision.pageId && revision.version)
      collector.editable(
        {
          kind: "knowledge",
          id: revision.pageId,
          revisionId: revision.id,
          version: revision.version,
          field: "body",
        },
        `knowledge:${revision.id}`,
        revision.body,
      );
  }

  return {
    ownerId: null,
    developerOnly: true,
    activity: operation.purpose,
    outcome,
    settledAt: completedAt,
    nativeTurnID: null,
  };
}

export async function collectSetupEvidence(
  db: LearningDrizzle,
  operation: SourceOperation,
  inspectionId: string,
  collector: EvidenceCollector,
): Promise<SnapshotMetadata | null> {
  const [inspection] = await db
    .select({
      state: operationRecord.state,
      source: typedSQL<string>`${operationRecord.payload}->>'sourceCommit'`,
      output: typedSQL<unknown>`${operationRecord.payload}->'output'`,
      failure: typedSQL<string | null>`${operationRecord.payload}->>'failure'`,
    })
    .from(operationRecord)
    .where(
      and(
        eq(operationRecord.id, inspectionId),
        eq(operationRecord.kind, "project.setup_inspection"),
        eq(operationRecord.scopeType, "project"),
        eq(operationRecord.scopeId, operation.projectId),
        notInArray(operationRecord.state, ["inspecting", "confirming"]),
      ),
    );
  if (!inspection) return null;

  // Setup drafts/inspection answers are not a shared Project conversation.
  collector.add(`setup:${inspectionId}:outcome`, "outcome", inspection, 8_000);
  return {
    ownerId: operation.userId,
    developerOnly: false,
    activity: operation.purpose,
    outcome: operation.outcome,
    settledAt: operation.settledAt,
    nativeTurnID: null,
  };
}
