import { z } from "zod";
import type { ForgeRepository, PullRequestState } from "./contracts";
import type { ForgeBranches } from "./forge-branches";
import type { ForgeFiles } from "./forge-files";
import {
  ForgeAmbiguousWriteError,
  ForgeConflictError,
  ForgeHttpError,
  type ForgeTransport,
  isAmbiguousError,
  isNotFound,
  readAfterWrite,
  recoverIdempotentCreate,
  repositoryPath,
  segment,
  sha,
  VERIFICATION_WORKFLOW_PATH,
} from "./forge-http";

const pullRequestResponse = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    state: z.string(),
    merged: z.boolean(),
    base: z.object({ ref: z.string().min(1), sha }).loose(),
    head: z.object({ ref: z.string().min(1), sha }).loose(),
  })
  .loose();

function parsePullRequest(value: unknown): PullRequestState {
  const parsed = pullRequestResponse.parse(value);
  return {
    number: parsed.number,
    url: parsed.html_url,
    state: parsed.state,
    merged: parsed.merged,
    baseBranch: parsed.base.ref,
    baseSha: parsed.base.sha,
    headBranch: parsed.head.ref,
    headSha: parsed.head.sha,
  };
}

export function createForgePullRequests(
  transport: ForgeTransport,
  branches: Pick<ForgeBranches, "getBranch" | "protectSetupWorkflow">,
  files: Pick<ForgeFiles, "getOptionalFile">,
) {
  async function getPullRequest(
    repository: ForgeRepository,
    base: string,
    head: string,
  ): Promise<PullRequestState | null> {
    try {
      return parsePullRequest(
        await transport.json(
          `${repositoryPath(repository)}/pulls/${segment(base)}/${segment(head)}`,
        ),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function mergeFastForward(
    repository: ForgeRepository,
    pullRequestNumber: number,
    expectedHeadSha: string,
    defaultBranch: string,
  ) {
    const current = await branches.getBranch(repository, defaultBranch);
    if (current?.headSha === expectedHeadSha) return current;
    try {
      // Forgejo answers 405 while it still computes whether the pull request can merge. That
      // check ends within seconds, so ask again before treating the answer as a refusal.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await transport.response(
            `${repositoryPath(repository)}/pulls/${pullRequestNumber}/merge`,
            {
              method: "POST",
              body: JSON.stringify({
                Do: "fast-forward-only",
                head_commit_id: expectedHeadSha,
                delete_branch_after_merge: false,
              }),
            },
          );
          break;
        } catch (error) {
          if (!(error instanceof ForgeHttpError && error.status === 405) || attempt >= 20)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (error) {
      const observed = await readAfterWrite(
        error,
        () => branches.getBranch(repository, defaultBranch),
        "Pull request merge outcome is unknown",
      );
      if (observed?.headSha === expectedHeadSha) return observed;
      if (isAmbiguousError(error)) {
        throw new ForgeAmbiguousWriteError("Pull request merge outcome is unknown");
      }
      throw error;
    }
    const observed = await branches.getBranch(repository, defaultBranch);
    if (observed?.headSha !== expectedHeadSha) {
      throw new ForgeConflictError("Default branch did not advance to the approved commit");
    }
    return observed;
  }

  return {
    getPullRequest,
    async ensurePullRequest(input: {
      repository: ForgeRepository;
      baseBranch: string;
      headBranch: string;
      expectedHeadSha: string;
      title: string;
      body: string;
    }) {
      const existing = await getPullRequest(input.repository, input.baseBranch, input.headBranch);
      if (existing) {
        if (
          existing.baseBranch !== input.baseBranch ||
          existing.headBranch !== input.headBranch ||
          existing.headSha !== input.expectedHeadSha
        ) {
          throw new ForgeConflictError("Existing pull request does not match the Change commit");
        }
        return existing;
      }
      try {
        const created = parsePullRequest(
          await transport.jsonBody(`${repositoryPath(input.repository)}/pulls`, "POST", {
            base: input.baseBranch,
            head: input.headBranch,
            title: input.title,
            body: input.body,
          }),
        );
        if (created.headSha !== input.expectedHeadSha) {
          throw new ForgeConflictError("Pull request was created for an unexpected commit");
        }
        return created;
      } catch (error) {
        return recoverIdempotentCreate(error, {
          read: () => getPullRequest(input.repository, input.baseBranch, input.headBranch),
          matches: (recovered) => recovered.headSha === input.expectedHeadSha,
          unknownMessage: "Pull request creation outcome is unknown",
          conflictMessage: () => "Recovered pull request has an unexpected head commit",
        });
      }
    },
    async mergeInitialSetupWorkflow(
      repository: ForgeRepository,
      pullRequestNumber: number,
      expectedHeadSha: string,
      defaultBranch: string,
      baseCommit: string,
    ) {
      const current = await branches.getBranch(repository, defaultBranch);
      if (current?.headSha === expectedHeadSha) {
        await branches.protectSetupWorkflow(repository, defaultBranch);
        return current;
      }
      if (current?.headSha !== baseCommit)
        throw new ForgeConflictError("Main branch changed before initial setup merge");
      if (
        (await files.getOptionalFile(repository, VERIFICATION_WORKFLOW_PATH, baseCommit)) !== null
      )
        throw new ForgeConflictError(
          "Initial setup cannot replace an existing Verification workflow",
        );
      const endpoint = `${repositoryPath(repository)}/branch_protections/${segment(defaultBranch)}`;
      const protection = z.object({
        rule_name: z.literal(defaultBranch),
        enable_push: z.literal(false),
        protected_file_patterns: z.string(),
      });
      const before = protection.parse(await transport.json(endpoint));
      const patterns = before.protected_file_patterns
        .split(";")
        .filter((pattern) => pattern !== VERIFICATION_WORKFLOW_PATH)
        .join(";");
      try {
        // The workflow is proven absent at the exact confirmed source commit.
        // Keep push/merge authority and every other protected path unchanged.
        if (patterns !== before.protected_file_patterns) {
          await transport.jsonBody(endpoint, "PATCH", { protected_file_patterns: patterns });
          const observed = protection.parse(await transport.json(endpoint));
          if (observed.protected_file_patterns !== patterns)
            throw new ForgeConflictError("Initial setup protection change is unconfirmed");
        }
        return await mergeFastForward(
          repository,
          pullRequestNumber,
          expectedHeadSha,
          defaultBranch,
        );
      } finally {
        await branches.protectSetupWorkflow(repository, defaultBranch);
      }
    },
    mergeFastForward,
  };
}
