export type ChangeView = {
  id: string;
  projectId: string;
  ticketId: string;
  requirementApprovalId: string;
  branchName: string;
  baseSha: string;
  state: string;
  version: number;
  runtimeAttemptId: string | null;
  failure: string | null;
  branchState: string;
  branchHeadSha: string | null;
  runtimeState: string | null;
  verificationState: string | null;
  buildTurnState: string | null;
  buildTurnPurpose?: string | null;
  implementationState: string | null;
  deliveryApprovedAt: string | null;
  mergeState: string | null;
  promotionState: string | null;
};

export type RequirementRevisionView = {
  id: string;
  ticketId: string;
  ordinal: number;
  canonicalContent: string;
  contentDigest: string;
  createdAt?: string;
};

export type RequirementApprovalView = {
  id: string;
  ticketId: string;
  requirementRevisionId: string;
  approvedBy: string;
  approvedAt: string;
};
