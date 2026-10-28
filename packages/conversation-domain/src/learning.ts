import { z } from "zod";

export const learningRubric = "work-review/v1";
export const learningScope = z.enum(["project", "personal"]);
const text = (max: number) => z.string().trim().min(1).max(max);
const passage = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Use a nonempty passage");
export const learningTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("skill"),
      id: z.uuid(),
      revisionId: z.uuid(),
      version: z.number().int().positive(),
      field: z.enum(["instructions", "description"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("knowledge"),
      id: z.uuid(),
      revisionId: z.uuid(),
      version: z.number().int().positive(),
      field: z.literal("body"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("input"),
      id: z.uuid(),
      revisionId: z.uuid(),
      version: z.number().int().positive(),
      field: z.literal("instructions"),
    })
    .strict(),
]);
export type LearningTarget = z.infer<typeof learningTarget>;
export const learningEdit = z
  .object({
    target: learningTarget,
    before: passage(3_000),
    after: passage(6_000),
  })
  .strict();
export type LearningEdit = z.infer<typeof learningEdit>;
export const learningTargetEvidence = z.object({
  target: learningTarget,
  evidenceId: text(400),
  text: passage(4_000),
  truncated: z.boolean(),
});
export const learningEvidence = z.object({
  id: text(400),
  kind: z.enum(["task", "outcome", "artifact", "feedback", "configuration"]),
  body: text(12_000),
  truncated: z.boolean(),
});
export const learningCase = z.object({
  id: text(400),
  projectId: z.uuid(),
  ownerId: z.uuid().nullable(),
  developerOnly: z.boolean().default(false),
  activity: text(80),
  outcome: z.enum(["completed", "failed", "interrupted", "unknown"]),
  settledAt: z.iso.datetime(),
  evidence: z.array(learningEvidence).max(24),
  targets: z.array(learningTargetEvidence).max(8).default([]),
  reviewReasons: z.array(text(80)).max(8).optional(),
});
export type LearningCase = z.infer<typeof learningCase>;

export const learningFinding = z.object({
  caseIds: z.array(text(400)).min(1).max(8),
  evidenceIds: z.array(text(400)).min(1).max(16),
  dimension: z.enum(["fulfillment", "rework", "verification", "method"]),
  cause: text(1_200),
  observation: text(2_000),
});
export const learningProposal = z.object({
  title: text(200),
  target: z.enum(["skill", "knowledge", "input", "tests", "ci", "instructions", "factory-defect"]),
  caseIds: z.array(text(400)).min(1).max(8),
  evidenceIds: z.array(text(400)).min(1).max(16),
  change: text(4_000),
  expectedEffect: text(1_200),
  validation: text(2_000),
  edit: learningEdit.nullable().optional(),
});
export const learningResult = z.object({
  cases: z
    .array(
      z.object({
        caseId: text(400),
        fulfillment: z.enum(["supported", "problem", "unknown"]),
        rework: z.enum(["avoidable", "necessary", "unknown"]),
        verification: z.enum(["supported", "problem", "unknown"]),
        explanation: text(1_200),
        evidenceIds: z.array(text(400)).max(16),
      }),
    )
    .min(1)
    .max(8),
  findings: z.array(learningFinding).max(12),
  proposals: z.array(learningProposal).max(4),
});
export type LearningResult = z.infer<typeof learningResult>;

// A judge can interpret the packet, never invent source identities or treat an
// unobserved result as proof. Findings need an observed outcome, not task text alone.
export function validateLearningResult(input: unknown, cases: LearningCase[]): LearningResult {
  const value = learningResult.parse(input);
  const byId = new Map(cases.map((item) => [item.id, item]));
  if (
    value.cases.length !== cases.length ||
    new Set(value.cases.map((item) => item.caseId)).size !== cases.length ||
    value.cases.some((item) => !byId.has(item.caseId))
  )
    throw new Error("Work review must account for every admitted case exactly once");
  function observedCase(id: string) {
    const item = byId.get(id);
    if (!item) throw new Error("Unknown work review case");
    return item;
  }
  function references(caseIds: string[], evidenceIds: string[]) {
    const evidence = caseIds.flatMap((id) => observedCase(id).evidence);
    if (evidenceIds.some((id) => !evidence.some((item) => item.id === id)))
      throw new Error("Work review cited unobserved evidence");
    return evidence.filter((item) => evidenceIds.includes(item.id));
  }
  for (const result of value.cases) {
    const evidence = references([result.caseId], result.evidenceIds);
    if (
      (result.fulfillment !== "unknown" ||
        result.verification !== "unknown" ||
        result.rework !== "unknown") &&
      !evidence.some(
        (item) => item.kind === "outcome" || item.kind === "artifact" || item.kind === "feedback",
      )
    )
      throw new Error("Missing work evidence cannot establish a review verdict");
  }
  for (const item of [...value.findings, ...value.proposals]) {
    const evidence = references(item.caseIds, item.evidenceIds);
    if (!evidence.some((source) => ["outcome", "artifact", "feedback"].includes(source.kind)))
      throw new Error("A learning finding needs observed work");
  }
  for (const proposal of value.proposals) {
    if (!proposal.edit) continue;
    const edit = proposal.edit;
    if (proposal.target !== edit.target.kind || edit.before === edit.after)
      throw new Error("An improvement edit must change its declared target");
    const observed = proposal.caseIds
      .flatMap((id) => observedCase(id).targets)
      .some(
        (source) =>
          JSON.stringify(source.target) === JSON.stringify(edit.target) &&
          proposal.evidenceIds.includes(source.evidenceId) &&
          source.text.includes(edit.before),
      );
    if (!observed)
      throw new Error("An improvement edit must name an observed exact revision and text");
  }
  return value;
}

export function applyLearningEdit(body: string, edit: Pick<LearningEdit, "before" | "after">) {
  if (edit.before === edit.after || !body.includes(edit.before))
    throw new Error("The proposed text no longer matches this revision");
  if (body.indexOf(edit.before) !== body.lastIndexOf(edit.before))
    throw new Error("The proposed text must identify one unique passage");
  return body.replace(edit.before, () => edit.after);
}

// Stable sampling does not re-roll on restart. Failed/uncertain operations are
// always eligible; healthy work supplies a comparison without judging every turn.
export function sampleLearningCase(
  id: string,
  outcome: LearningCase["outcome"],
  reviewReasons: readonly string[] = [],
) {
  if (outcome !== "completed" || reviewReasons.length) return true;
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % 5 === 0;
}
export function learningBatchDue(cases: LearningCase[], now = Date.now()) {
  return (
    cases.length >= 6 || cases.some((item) => now - Date.parse(item.settledAt) >= 24 * 60 * 60_000)
  );
}

export const learningPolicyCommand = z
  .object({
    commandId: z.uuid(),
    projectId: z.uuid(),
    scope: learningScope,
    expectedVersion: z.number().int().nonnegative(),
    enabled: z.boolean(),
    automaticSkills: z.boolean().default(false),
  })
  .strict();
export const learningDecisionCommand = z
  .object({
    commandId: z.uuid(),
    proposalId: z.uuid(),
    decision: z.enum(["dismiss", "create-ticket", "apply"]),
    releasePrivate: z.boolean().default(false),
    editDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export const learningRollbackCommand = z
  .object({
    commandId: z.uuid(),
    applicationId: z.uuid(),
    expectedRevisionId: z.uuid(),
  })
  .strict();

export const learningDay = z.object({
  date: z.string(),
  operations: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  knownNanoUSD: z.string().regex(/^\d+$/),
  incomplete: z.boolean(),
  elapsedSeconds: z.number().nonnegative().nullable(),
  observed: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  supported: z.number().int().nonnegative(),
  problems: z.number().int().nonnegative(),
  avoidable: z.number().int().nonnegative(),
  reworkKnown: z.number().int().nonnegative(),
});
export type LearningDay = z.infer<typeof learningDay>;
export const learningView = z.object({
  projectId: z.uuid().nullable(),
  scope: learningScope,
  detailScope: z.enum(["factory", "project", "own"]),
  enabled: z.boolean(),
  automaticSkills: z.boolean().default(false),
  parentEnabled: z.boolean(),
  canManage: z.boolean(),
  version: z.number().int().nonnegative(),
  days: z.array(learningDay),
  reviews: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(["calibration", "work"]),
      state: z.string(),
      modelId: z.string(),
      rubric: z.string(),
      calibrated: z.boolean().nullable(),
      reason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
      result: learningResult.nullable(),
      cases: z.array(learningCase),
    }),
  ),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      reviewId: z.uuid(),
      content: learningProposal,
      state: z.enum(["proposed", "dismissed", "ticket-created", "applied"]),
      ticketId: z.uuid().nullable(),
      private: z.boolean(),
      editDigest: z.string().nullable().optional(),
      canApply: z.boolean().optional(),
      applyBlockedReason: z.string().nullable().optional(),
      targetScope: z.enum(["personal", "project", "system"]).nullable().optional(),
      requiresPrivateRelease: z.boolean().optional(),
      targetLabel: z.string().nullable().optional(),
      comparisonState: z
        .enum(["untested", "running", "not-demonstrated", "unconfirmed"])
        .default("untested"),
    }),
  ),
  applications: z
    .array(
      z.object({
        id: z.uuid(),
        proposalId: z.uuid(),
        target: learningTarget,
        title: z.string(),
        edit: learningEdit,
        appliedRevisionId: z.uuid(),
        appliedVersion: z.number().int().positive(),
        state: z.enum(["applied", "reverted"]),
        canRevert: z.boolean().optional(),
        createdAt: z.iso.datetime(),
        revertedAt: z.iso.datetime().nullable(),
        automatic: z.boolean().default(false),
        automaticRecovery: z.boolean().default(false),
        targetLabel: z.string().nullable().optional(),
        targetScope: z.enum(["personal", "project", "system"]).nullable().optional(),
        subsequent: z
          .object({
            sampled: z.number().int().nonnegative(),
            reviewed: z.number().int().nonnegative(),
            problems: z.number().int().nonnegative(),
            cases: z
              .array(
                z.object({
                  source: learningCase,
                  reviewId: z.uuid().nullable(),
                  verdict: learningResult.shape.cases.element.nullable(),
                }),
              )
              .max(3)
              .default([]),
          })
          .default({ sampled: 0, reviewed: 0, problems: 0, cases: [] }),
      }),
    )
    .default([]),
  comparisons: z
    .array(
      z.object({
        id: z.uuid(),
        proposalId: z.uuid(),
        phase: z.enum(["adopt", "recover"]),
        title: z.string(),
        state: z.enum(["running", "completed", "failed", "uncertain"]),
        reason: z.string().nullable(),
        modelId: z.string(),
        rubric: z.string(),
        createdAt: z.iso.datetime(),
        result: z
          .object({
            passed: z.boolean(),
            decision: z.enum(["applied", "reverted", "kept", "blocked"]),
            cases: learningResult.shape.cases,
          })
          .nullable(),
        candidateFirst: z.boolean(),
        baselineTarget: learningTarget,
        before: z.string(),
        after: z.string(),
        evidence: z.array(learningCase).max(3),
        responses: z
          .array(
            z.object({
              answers: z.array(z.object({ caseId: z.string(), body: z.string() })),
            }),
          )
          .max(2),
      }),
    )
    .default([]),
});
export type LearningView = z.infer<typeof learningView>;
