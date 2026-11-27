import { z } from "zod";
import type { BranchState, ForgeRepository } from "./contracts";
import {
  ForgeAmbiguousWriteError,
  ForgeConflictError,
  type ForgeTransport,
  isAmbiguousError,
  isNotFound,
  recoverIdempotentCreate,
  repositoryPath,
  segment,
  sha,
  VERIFICATION_WORKFLOW_PATH,
} from "./forge-http";

const branchResponse = z
  .object({ name: z.string().min(1), commit: z.object({ id: sha }).loose() })
  .loose();

const repositoryResponse = z
  .object({
    name: z.string().min(1),
    default_branch: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }).loose(),
  })
  .loose();

function splitProtectedPatterns(patterns: string | undefined) {
  return (patterns ?? "").split(";").filter(Boolean);
}

export function createForgeBranches(transport: ForgeTransport) {
  async function getBranch(
    repository: ForgeRepository,
    branch: string,
  ): Promise<BranchState | null> {
    try {
      const value = branchResponse.parse(
        await transport.json(`${repositoryPath(repository)}/branches/${segment(branch)}`),
      );
      return { name: value.name, headSha: value.commit.id };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  return {
    getBranch,
    async getDefaultBranch(repository: ForgeRepository) {
      const value = repositoryResponse.parse(await transport.json(repositoryPath(repository)));
      if (value.owner.login !== repository.owner || value.name !== repository.name) {
        throw new Error("Forge repository response does not match the request");
      }
      const branch = await getBranch(repository, value.default_branch);
      if (!branch) throw new Error("Forge default branch does not exist");
      return branch;
    },
    async ensureBranch(repository: ForgeRepository, branch: string, startSha: string) {
      const existing = await getBranch(repository, branch);
      if (existing) {
        if (existing.headSha !== startSha) {
          throw new ForgeConflictError(
            `Branch ${branch} exists at ${existing.headSha}, expected ${startSha}`,
          );
        }
        return existing;
      }
      try {
        const value = branchResponse.parse(
          await transport.jsonBody(`${repositoryPath(repository)}/branches`, "POST", {
            new_branch_name: branch,
            old_ref_name: startSha,
          }),
        );
        if (value.name !== branch || value.commit.id !== startSha) {
          throw new ForgeConflictError("Forge created the branch with unexpected identity");
        }
        return { name: value.name, headSha: value.commit.id };
      } catch (error) {
        return recoverIdempotentCreate(error, {
          read: () => getBranch(repository, branch),
          matches: (recovered) => recovered.headSha === startSha,
          unknownMessage: `Branch creation outcome for ${branch} is unknown`,
          conflictMessage: (recovered) =>
            `Branch ${branch} exists at ${recovered.headSha}, expected ${startSha}`,
        });
      }
    },
    async ensureDefaultBranchProtection(
      repository: ForgeRepository,
      branch: string,
      protectWorkflow = true,
    ) {
      const path = `${repositoryPath(repository)}/branch_protections`;
      const endpoint = `${path}/${segment(branch)}`;
      const protection = z.object({
        rule_name: z.literal(branch),
        enable_push: z.literal(false),
        protected_file_patterns: z.string().optional(),
      });
      const confirm = (value: unknown) => {
        const observed = protection.safeParse(value);
        if (
          !observed.success ||
          (protectWorkflow &&
            !splitProtectedPatterns(observed.data.protected_file_patterns).includes(
              VERIFICATION_WORKFLOW_PATH,
            ))
        )
          throw new ForgeConflictError("Default branch protection was not confirmed");
        return value;
      };
      try {
        return confirm(await transport.json(endpoint));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      let created: unknown;
      try {
        created = await transport.jsonBody(path, "POST", {
          rule_name: branch,
          enable_push: false,
          enable_status_check: false,
          protected_file_patterns: protectWorkflow ? VERIFICATION_WORKFLOW_PATH : "",
        });
      } catch (error) {
        // Forgejo can report a concurrent identical create as 403, not only
        // 422. Observe once before classifying the failed response. This is
        // not another write and must prove the exact protected outcome.
        try {
          return confirm(await transport.json(endpoint));
        } catch {
          // Missing, denied or lost readback cannot confirm the intended write.
        }
        if (isAmbiguousError(error))
          throw new ForgeAmbiguousWriteError("Branch protection outcome is unknown");
        throw error;
      }
      return confirm(created);
    },
    async protectSetupWorkflow(repository: ForgeRepository, branch: string) {
      const endpoint = `${repositoryPath(repository)}/branch_protections/${segment(branch)}`;
      const value = z
        .object({ enable_push: z.boolean(), protected_file_patterns: z.string().optional() })
        .loose()
        .parse(await transport.json(endpoint));
      if (value.enable_push)
        throw new ForgeConflictError("Main branch protection permits direct pushes");
      if (
        splitProtectedPatterns(value.protected_file_patterns).includes(VERIFICATION_WORKFLOW_PATH)
      )
        return;
      return transport.jsonBody(endpoint, "PATCH", {
        protected_file_patterns: [value.protected_file_patterns, VERIFICATION_WORKFLOW_PATH]
          .filter(Boolean)
          .join(";"),
      });
    },
    async deleteBranch(repository: ForgeRepository, branch: string) {
      await transport.deleteOptional(`${repositoryPath(repository)}/branches/${segment(branch)}`);
    },
  };
}

export type ForgeBranches = ReturnType<typeof createForgeBranches>;
