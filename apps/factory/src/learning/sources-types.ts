import {
  type LearningCase,
  type LearningTarget,
  learningCase,
} from "#conversation-domain/learning";
import type { createDatabase, drizzleTransaction } from "#db/client";

export type LearningDatabase = ReturnType<typeof createDatabase>;
export type LearningDrizzle = ReturnType<typeof drizzleTransaction>;
export type LearningSourceCursor = { at: string; id: string };

export type SourceOperation = {
  id: string;
  projectId: string;
  userId: string;
  purpose: string;
  outcome: LearningCase["outcome"];
  settledAt: Date;
  cursorAt: string;
};

export type SnapshotMetadata = {
  ownerId: string | null;
  developerOnly: boolean;
  activity: string;
  outcome: LearningCase["outcome"];
  settledAt: Date;
  nativeTurnID: string | null;
};

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EvidenceSource =
  | { kind: "turn"; id: string }
  | { kind: "monitoring"; id: string }
  | { kind: "wiki"; id: string }
  | { kind: "setup"; id: string }
  | { kind: "unknown"; rawId: string };

export function parseEvidenceSource(operationId: string): EvidenceSource {
  const separator = operationId.indexOf(":");
  if (separator === -1) return { kind: "unknown", rawId: operationId };
  const prefix = operationId.slice(0, separator);
  const sourceId = operationId.slice(separator + 1).split(":")[0] ?? "";
  if (!uuidPattern.test(sourceId)) return { kind: "unknown", rawId: operationId };
  switch (prefix) {
    case "turn":
      return { kind: "turn", id: sourceId };
    case "monitoring":
      return { kind: "monitoring", id: sourceId };
    case "wiki":
      return { kind: "wiki", id: sourceId };
    case "setup":
      return { kind: "setup", id: sourceId };
    default:
      return { kind: "unknown", rawId: operationId };
  }
}

export type EvidenceCollector = ReturnType<typeof createEvidenceCollector>;

export function createEvidenceCollector() {
  const evidence: LearningCase["evidence"] = [];
  const targets: LearningCase["targets"] = [];
  const reviewReasons: string[] = [];
  let remaining = 20_000;
  let evidenceLimit = 24;

  // Gather before allocating: SQL/source order must not spend the budget of
  // later approved scope, observed outcomes or editable guidance.
  function add(
    id: string,
    kind: LearningCase["evidence"][number]["kind"],
    value: unknown,
    limit = 4_000,
    preTruncated = false,
  ) {
    if (value === null || value === undefined) return;
    const body = typeof value === "string" ? value : JSON.stringify(value);
    if (!body?.trim()) return;
    const excerpt = body.slice(0, limit);
    if (!excerpt.trim()) return;
    evidence.push({
      id,
      kind,
      body: excerpt,
      truncated: preTruncated || body.length > excerpt.length,
    });
  }

  function editable(target: LearningTarget, evidenceId: string, value: unknown) {
    if (typeof value !== "string" || !value.trim() || targets.length >= 8) return;
    const excerpt = value.slice(0, 4_000);
    if (!excerpt.trim()) return;
    targets.push({ target, evidenceId, text: excerpt, truncated: excerpt.length < value.length });
  }

  function addReviewReasons(...reasons: string[]) {
    reviewReasons.push(...reasons);
  }

  function reserveNativeEvidence(maxBytes: number) {
    // Leave one complete, bounded JSON item for the gated archive projection.
    remaining -= maxBytes;
    evidenceLimit--;
  }

  function finalize(operation: SourceOperation, metadata: SnapshotMetadata) {
    evidence.splice(evidenceLimit);
    const caseTargets = targets.filter((target) =>
      evidence.some((item) => item.id === target.evidenceId),
    );
    remaining -= caseTargets.length * 256;
    let passages = evidence.length + caseTargets.length;
    let unallocatedBytes =
      evidence.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0) +
      caseTargets.reduce((sum, target) => sum + Buffer.byteLength(target.text), 0);

    function allocate(value: string) {
      const bytes = Buffer.byteLength(value);
      const budget = unallocatedBytes <= remaining ? bytes : Math.floor(remaining / passages);
      unallocatedBytes -= bytes;
      passages--;
      let excerpt = value.slice(0, budget);
      while (Buffer.byteLength(excerpt) > budget)
        excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.75));
      remaining -= Buffer.byteLength(excerpt);
      return excerpt;
    }

    for (const item of evidence) {
      const excerpt = allocate(item.body);
      item.truncated ||= excerpt.length < item.body.length;
      item.body = excerpt;
    }
    for (const target of caseTargets) {
      const excerpt = allocate(target.text);
      target.truncated ||= excerpt.length < target.text.length;
      target.text = excerpt;
    }

    const retainedEvidence = evidence.filter((item) => item.body.trim());
    const snapshot = learningCase.parse({
      id: operation.id,
      projectId: operation.projectId,
      ownerId: metadata.ownerId,
      developerOnly: metadata.developerOnly,
      activity: metadata.activity,
      outcome: metadata.outcome,
      settledAt: new Date(metadata.settledAt).toISOString(),
      evidence: retainedEvidence,
      targets: caseTargets.filter(
        (target) =>
          target.text.trim() && retainedEvidence.some((item) => item.id === target.evidenceId),
      ),
      ...(reviewReasons.length ? { reviewReasons } : {}),
    });
    return { snapshot, nativeTurnID: metadata.nativeTurnID };
  }

  return { add, editable, addReviewReasons, reserveNativeEvidence, finalize };
}
