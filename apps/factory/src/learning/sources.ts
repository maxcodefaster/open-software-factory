import { type LearningCase, sampleLearningCase } from "#conversation-domain/learning";
import { drizzleTransaction } from "#db/client";
import { learningCase as savedCase } from "#db/schema";
import { createPrivateObjects, type PrivateObjects } from "../storage/objects";
import { authorizedForCaseIn, resolveNativeToolEvidence } from "./sources-archive";
import { queryDueOperations } from "./sources-due";
import { collectMonitoringEvidence } from "./sources-monitoring";
import { collectTurnEvidence } from "./sources-turn";
import {
  createEvidenceCollector,
  type LearningDatabase,
  type LearningSourceCursor,
  parseEvidenceSource,
  type SnapshotMetadata,
  type SourceOperation,
} from "./sources-types";
import { collectSetupEvidence, collectWikiEvidence } from "./sources-wiki";

export type { LearningSourceCursor } from "./sources-types";

async function learningSnapshot(database: LearningDatabase, operation: SourceOperation) {
  const db = drizzleTransaction(database.client);
  const collector = createEvidenceCollector();
  const source = parseEvidenceSource(operation.id);
  let metadata: SnapshotMetadata | null;
  switch (source.kind) {
    case "turn":
      metadata = await collectTurnEvidence(db, operation, source.id, collector);
      break;
    case "monitoring":
      metadata = await collectMonitoringEvidence(db, operation, source.id, collector);
      break;
    case "wiki":
      metadata = await collectWikiEvidence(db, operation, source.id, collector);
      break;
    case "setup":
      metadata = await collectSetupEvidence(db, operation, source.id, collector);
      break;
    case "unknown":
      // Unknown activity still counts towards coverage but cannot supply a claim.
      // In particular, a human user ID never makes an AI output human feedback.
      collector.add(
        `${source.rawId}:missing`,
        "configuration",
        "No supported retained work-evidence adapter is available.",
      );
      metadata = {
        ownerId: operation.userId,
        developerOnly: false,
        activity: operation.purpose,
        outcome: operation.outcome,
        settledAt: operation.settledAt,
        nativeTurnID: null,
      };
      break;
  }
  if (!metadata) return null;
  return collector.finalize(operation, metadata);
}

export async function collectLearningCases(
  database: LearningDatabase,
  cursor: LearningSourceCursor | null = null,
  objects: PrivateObjects = createPrivateObjects(),
) {
  // The journal is an index into retained product evidence, not a transcript lake.
  // Never wake a Sandbox or fetch native logs to perform retrospective review.
  // A Wiki generation makes dozens of model calls but is one piece of work with one
  // retained outcome. Review it once, after it settles. Its calls settle first, so a
  // cursor over them would pass the generation before it could be reviewed.
  const db = drizzleTransaction(database.client);
  const operations = await queryDueOperations(db, cursor);
  for (const operation of operations) {
    if (!operation.projectId || !operation.userId || !operation.settledAt || !operation.outcome)
      continue;
    const reviewerId = operation.userId;
    const source = await learningSnapshot(database, {
      ...operation,
      projectId: operation.projectId,
      userId: operation.userId,
      settledAt: operation.settledAt,
      outcome: operation.outcome,
    });
    if (!source) continue; // An indexed operation can precede product settlement.
    const { snapshot, nativeTurnID } = source;
    const selected =
      sampleLearningCase(snapshot.id, snapshot.outcome, snapshot.reviewReasons) &&
      ((snapshot.reviewReasons?.length ?? 0) > 0 ||
        snapshot.evidence.some(
          (item) => item.kind === "outcome" || item.kind === "artifact" || item.kind === "feedback",
        ));
    if (!selected) {
      snapshot.evidence = [];
      snapshot.targets = [];
    }
    let nativeEvidence: LearningCase["evidence"][number] | undefined;
    if (selected && nativeTurnID) {
      const resolved = await resolveNativeToolEvidence(
        database,
        snapshot,
        nativeTurnID,
        reviewerId,
        objects,
      );
      if (resolved.status === "skip") continue;
      nativeEvidence = resolved.evidence;
    }
    await database.client.begin(async (sql) => {
      if (!(await authorizedForCaseIn(sql, reviewerId, snapshot))) return;
      if (nativeEvidence) snapshot.evidence.push(nativeEvidence);
      await drizzleTransaction(sql)
        .insert(savedCase)
        .values({
          id: snapshot.id,
          projectId: snapshot.projectId,
          ownerId: snapshot.ownerId,
          reviewerId,
          developerOnly: snapshot.developerOnly,
          activity: snapshot.activity,
          outcome: snapshot.outcome,
          settledAt: new Date(snapshot.settledAt),
          snapshot,
          selected,
        })
        .onConflictDoNothing();
    });
  }
  const last = operations.findLast((operation) => !operation.wiki);
  // Keep PostgreSQL's microseconds. A JS Date rounds them away and can repeat
  // the same full page when several operations share one settlement instant.
  // Full pages advance past deferred work; a completed pass starts again so
  // later archive/Verification settlement is observed without a worker restart.
  return last && operations.filter((operation) => !operation.wiki).length === 100
    ? { at: last.cursorAt, id: last.id }
    : null;
}
