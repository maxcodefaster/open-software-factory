import { z } from "zod";
import { setupFile } from "#project-domain/setup";
import type { ForgeRepository } from "./contracts";
import type { ForgeBranches } from "./forge-branches";
import type { ForgeFiles } from "./forge-files";
import {
  ForgeAmbiguousWriteError,
  ForgeConflictError,
  ForgeHttpError,
  type ForgeTransport,
  hasInvalidRelativePath,
  isAmbiguousError,
  isNotFound,
  readAfterWrite,
  repositoryPath,
  segment,
  sha,
} from "./forge-http";

const setupRepositoryResponse = z
  .object({
    name: z.string().min(1),
    default_branch: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }).loose(),
    description: z.string(),
    private: z.boolean(),
    mirror: z.boolean(),
    empty: z.boolean().optional(),
  })
  .loose();

type SetupRepositoryPayload = z.infer<typeof setupRepositoryResponse>;

function verifySetupRepositoryIdentity(
  value: SetupRepositoryPayload,
  repository: ForgeRepository,
  setupID: string,
  conflictMessage: string,
) {
  if (
    value.owner.login !== repository.owner ||
    value.name !== repository.name ||
    value.description !== `Factory Project setup ${setupID}` ||
    !value.private ||
    value.mirror
  ) {
    throw new ForgeConflictError(conflictMessage);
  }
  return { defaultBranch: value.default_branch, empty: value.empty === true };
}

function setupFilesBatchPayload(
  branch: string,
  message: string,
  files: readonly { path: string; content: string }[],
) {
  return {
    branch,
    message,
    files: files.map((file) => ({
      operation: "create",
      path: file.path,
      content: Buffer.from(file.content).toString("base64"),
    })),
  };
}

export function createForgeSetup(
  transport: ForgeTransport,
  branches: Pick<ForgeBranches, "getBranch" | "ensureBranch">,
  files: Pick<ForgeFiles, "listFiles" | "getFile">,
) {
  return {
    async setupRepository(repository: ForgeRepository, setupID: string) {
      try {
        const value = setupRepositoryResponse.parse(
          await transport.json(repositoryPath(repository)),
        );
        return verifySetupRepositoryIdentity(
          value,
          repository,
          setupID,
          "Repository identity does not match this Project setup",
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async createSetupRepository(input: {
      repository: ForgeRepository;
      setupID: string;
      sourceURL?: string;
      importToken?: string;
    }) {
      // The caller must persist this exact identity before invoking this write.
      try {
        const payload = input.sourceURL
          ? {
              clone_addr: input.sourceURL,
              repo_name: input.repository.name,
              repo_owner: input.repository.owner,
              service: "git",
              mirror: false,
              private: true,
              description: `Factory Project setup ${input.setupID}`,
              issues: false,
              labels: false,
              milestones: false,
              pull_requests: false,
              releases: false,
              wiki: false,
              lfs: false,
              ...(input.importToken ? { auth_token: input.importToken } : {}),
            }
          : {
              name: input.repository.name,
              description: `Factory Project setup ${input.setupID}`,
              default_branch: "main",
              private: true,
              auto_init: false,
            };
        const value = setupRepositoryResponse.parse(
          await transport.jsonBody(
            input.sourceURL ? "repos/migrate" : "user/repos",
            "POST",
            payload,
            {
              signal: AbortSignal.timeout(input.sourceURL ? 120_000 : 10_000),
            },
          ),
        );
        return verifySetupRepositoryIdentity(
          value,
          input.repository,
          input.setupID,
          "Created repository has an unexpected identity",
        );
      } catch (error) {
        if (isAmbiguousError(error) || (error instanceof ForgeHttpError && error.status === 409))
          throw new ForgeAmbiguousWriteError(
            "Repository creation needs an identity check before continuing",
          );
        throw error;
      }
    },
    async createSetupFiles(input: {
      repository: ForgeRepository;
      branch: string;
      files: readonly { path: string; content: string }[];
      setupID: string;
    }) {
      if (
        !input.files.length ||
        input.files.length > 100 ||
        input.files.some((file) => hasInvalidRelativePath(file.path))
      )
        throw new ForgeConflictError("Invalid setup file set");
      try {
        await transport.jsonBody(
          `${repositoryPath(input.repository)}/contents`,
          "POST",
          setupFilesBatchPayload(
            input.branch,
            `Initialize Factory Starter (${input.setupID})`,
            input.files,
          ),
        );
      } catch (error) {
        if (isAmbiguousError(error))
          throw new ForgeAmbiguousWriteError("Starter initialization needs a source check");
        throw error;
      }
    },
    async applySetupFiles(input: {
      repository: ForgeRepository;
      branch: string;
      baseCommit: string;
      files: readonly { path: string; content: string }[];
      proposalID: string;
    }) {
      const paths = new Set(input.files.map((file) => file.path));
      if (
        !input.files.length ||
        input.files.length > 6 ||
        paths.size !== input.files.length ||
        input.files.some((file) => !setupFile.safeParse(file).success)
      )
        throw new ForgeConflictError("Invalid confirmed setup file set");
      let branch = await branches.getBranch(input.repository, input.branch);
      if (!branch)
        branch = await branches.ensureBranch(input.repository, input.branch, input.baseCommit);
      const verify = async (commit: string) => {
        const value = z
          .object({ parents: z.array(z.object({ sha })) })
          .loose()
          .parse(
            await transport.json(
              `${repositoryPath(input.repository)}/git/commits/${segment(commit)}`,
            ),
          );
        if (value.parents.length !== 1 || value.parents[0]?.sha !== input.baseCommit)
          throw new ForgeConflictError("Setup commit has an unexpected parent");
        const [before, after] = await Promise.all([
          files.listFiles(input.repository, input.baseCommit),
          files.listFiles(input.repository, commit),
        ]);
        if (
          before.some((file) => paths.has(file.path)) ||
          after.length !== before.length + paths.size
        )
          throw new ForgeConflictError("Setup would overwrite existing source");
        for (const file of before)
          if (after.find((candidate) => candidate.path === file.path)?.sha !== file.sha)
            throw new ForgeConflictError("Setup changed source outside its confirmed file set");
        for (const file of input.files)
          if ((await files.getFile(input.repository, file.path, commit)) !== file.content)
            throw new ForgeConflictError("Setup commit differs from the confirmed proposal");
        return commit;
      };
      if (branch.headSha !== input.baseCommit) return verify(branch.headSha);
      try {
        await transport.jsonBody(
          `${repositoryPath(input.repository)}/contents`,
          "POST",
          setupFilesBatchPayload(
            input.branch,
            `Configure Factory Project (${input.proposalID})`,
            input.files,
          ),
        );
      } catch (error) {
        const observed = await readAfterWrite(
          error,
          () => branches.getBranch(input.repository, input.branch),
          "Confirmed setup commit needs another source check",
        );
        if (observed && observed.headSha !== input.baseCommit) return verify(observed.headSha);
        if (isAmbiguousError(error))
          throw new ForgeAmbiguousWriteError("Confirmed setup commit needs another source check");
        throw error;
      }
      const observed = await branches.getBranch(input.repository, input.branch);
      if (!observed || observed.headSha === input.baseCommit)
        throw new ForgeAmbiguousWriteError("Confirmed setup commit is not visible yet");
      return verify(observed.headSha);
    },
  };
}
