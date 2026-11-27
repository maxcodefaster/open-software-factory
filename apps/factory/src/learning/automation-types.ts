import { createHash } from "node:crypto";
import { z } from "zod";
import type { LearningEdit } from "#conversation-domain/learning";
import type { learningComparisonPlan } from "#conversation-domain/learning-comparison";
import type { ModelConnectionReference } from "#conversation-domain/model-connection";
import type { createDatabase, DatabaseTransaction } from "#db/client";
import type { ResolvedModelConnection } from "../models/inference-contracts";
import type { reviewWork } from "./judge";
import type { replayPlanning } from "./replay";
import { type createLearningTargets, learningActivation } from "./targets";

export type LearningDatabase = ReturnType<typeof createDatabase>;
export type LearningTargets = ReturnType<typeof createLearningTargets>;
export type LearningScope = { projectId: string; ownerId: string | null; developerOnly: boolean };
export type LearningActivation = z.output<typeof learningActivation>;
export type LearningComparisonPlan = z.output<typeof learningComparisonPlan>;

export type AutomationModel = {
  modelId: string;
  reference: ModelConnectionReference | null;
  fallback: ResolvedModelConnection | null;
  judgeKey: string;
};

export type AutomationDependencies = {
  modelIn(
    sql: DatabaseTransaction,
    scope: LearningScope,
    actorId: string,
  ): Promise<AutomationModel>;
  connect(model: AutomationModel): Promise<ResolvedModelConnection>;
  review?: typeof reviewWork;
  replay?: typeof replayPlanning;
};

export type CandidateBase = LearningScope & {
  proposalId: string;
  reviewId: string;
  content: unknown;
  policyVersion: number;
  actorId: string;
  proposalAfterGrant: boolean;
};

export type AdoptCandidate = CandidateBase & {
  phase: "adopt";
};

export type RecoverCandidate = CandidateBase & {
  phase: "recover";
  applicationId: string;
  appliedRevisionId: string;
  appliedVersion: number;
  activation: LearningActivation[];
};

export type Candidate = AdoptCandidate | RecoverCandidate;

export type RawCandidateRow = CandidateBase & {
  phase: "adopt" | "recover";
  applicationId: string | null;
  appliedRevisionId: string | null;
  appliedVersion: number | null;
  activation: unknown;
};

export type AdmittedTrial = Candidate & {
  id: string;
  token: string;
  plan: LearningComparisonPlan;
  model: AutomationModel;
};

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function currentTarget(
  row:
    | Pick<AdoptCandidate, "phase">
    | Pick<RecoverCandidate, "phase" | "appliedRevisionId" | "appliedVersion">,
  edit: LearningEdit,
) {
  if (row.phase === "adopt") return edit.target;
  return { ...edit.target, revisionId: row.appliedRevisionId, version: row.appliedVersion };
}

export function parseCandidateRow(row: RawCandidateRow): Candidate | null {
  const base: CandidateBase = {
    projectId: row.projectId,
    ownerId: row.ownerId,
    developerOnly: row.developerOnly,
    proposalId: row.proposalId,
    reviewId: row.reviewId,
    content: row.content,
    policyVersion: row.policyVersion,
    actorId: row.actorId,
    proposalAfterGrant: row.proposalAfterGrant,
  };
  if (row.phase === "adopt") return { ...base, phase: "adopt" };
  if (!row.applicationId || !row.appliedRevisionId || row.appliedVersion === null) return null;
  const activation = z.array(learningActivation).safeParse(row.activation);
  if (!activation.success) return null;
  return {
    ...base,
    phase: "recover",
    applicationId: row.applicationId,
    appliedRevisionId: row.appliedRevisionId,
    appliedVersion: row.appliedVersion,
    activation: activation.data,
  };
}
