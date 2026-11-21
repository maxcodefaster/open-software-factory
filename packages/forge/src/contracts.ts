export interface ForgeRepository {
  readonly owner: string;
  readonly name: string;
}

export interface BranchState {
  readonly name: string;
  readonly headSha: string;
}

export interface PullRequestState {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly merged: boolean;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export interface ActionRunState {
  readonly id: number;
  readonly url: string;
  readonly commitSha: string;
  readonly workflowID: string;
  readonly event: string;
  readonly status: string;
}

export interface RunnerRegistration {
  readonly id: number;
  readonly uuid: string;
  readonly token: string;
}
