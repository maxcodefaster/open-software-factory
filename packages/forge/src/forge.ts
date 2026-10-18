import { z } from "zod";

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

export class ForgeConflictError extends Error {
  override readonly name = "ForgeConflictError";
}

export class ForgeAmbiguousWriteError extends Error {
  override readonly name = "ForgeAmbiguousWriteError";
}

class ForgeHttpError extends Error {
  constructor(readonly status: number) {
    super(`Forge request failed with HTTP ${status}`);
  }
}

const sha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const hookResponse = z
  .object({
    id: z.number().int().positive(),
    active: z.boolean(),
    events: z.array(z.string()),
    config: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    branch_filter: z.string().optional(),
  })
  .loose();
export type RepositoryPushHook = {
  id: number;
  active: boolean;
  events: string[];
  targetURL: string;
  branchFilter: string;
};
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
const setupRepositoryResponse = repositoryResponse
  .extend({
    description: z.string(),
    private: z.boolean(),
    mirror: z.boolean(),
    empty: z.boolean().optional(),
  })
  .loose();
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
const actionRunResponse = z
  .object({
    id: z.number().int().positive(),
    html_url: z.string().url(),
    commit_sha: sha,
    workflow_id: z.string().min(1),
    event: z.string().min(1),
    status: z.string().min(1),
  })
  .loose();
const actionRunsResponse = z.object({ workflow_runs: z.array(actionRunResponse) }).loose();
const runnerRegistrationResponse = z.object({
  id: z.number().int().positive(),
  uuid: z.string().uuid(),
  token: z.string().min(20),
});
const runnerResponse = z
  .object({
    id: z.number().int().positive(),
    uuid: z.string().uuid(),
    name: z.string().min(1),
    ephemeral: z.boolean(),
    status: z.string(),
  })
  .loose();
const contentResponse = z
  .object({ content: z.string(), encoding: z.literal("base64"), sha })
  .loose();
const treeResponse = z
  .object({
    truncated: z.boolean().optional(),
    total_count: z.number().int().nonnegative().optional(),
    tree: z.array(
      z
        .object({
          path: z.string().min(1),
          type: z.string(),
          size: z.number().int().nonnegative().optional(),
          sha,
        })
        .loose(),
    ),
  })
  .loose();
const fileUpdateResponse = z
  .object({ commit: z.object({ sha }).loose(), content: z.object({ sha }).loose() })
  .loose();

function segment(value: string) {
  if (!value || value === "." || value === ".." || value.includes("\\")) {
    throw new TypeError("Forge path segment is invalid");
  }
  return encodeURIComponent(value);
}

function repositoryPath(repository: ForgeRepository) {
  return `repos/${segment(repository.owner)}/${segment(repository.name)}`;
}

function ambiguous(error: unknown) {
  return (
    error instanceof DOMException ||
    (error instanceof ForgeHttpError && [408, 429].includes(error.status)) ||
    (error instanceof ForgeHttpError && error.status >= 500)
  );
}

export function createForgejoClient(options: {
  readonly apiURL: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}) {
  const request = options.fetch ?? fetch;
  const baseURL = new URL(options.apiURL.endsWith("/") ? options.apiURL : `${options.apiURL}/`);

  async function response(path: string, init: RequestInit = {}) {
    const result = await request(new URL(path, baseURL), {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!result.ok) throw new ForgeHttpError(result.status);
    return result;
  }

  async function json(path: string, init: RequestInit = {}) {
    return (await response(path, init)).json() as Promise<unknown>;
  }

  async function getBranch(
    repository: ForgeRepository,
    branch: string,
  ): Promise<BranchState | null> {
    try {
      const value = branchResponse.parse(
        await json(`${repositoryPath(repository)}/branches/${segment(branch)}`),
      );
      return { name: value.name, headSha: value.commit.id };
    } catch (error) {
      if (error instanceof ForgeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  function pullRequest(value: unknown): PullRequestState {
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

  async function getPullRequest(
    repository: ForgeRepository,
    base: string,
    head: string,
  ): Promise<PullRequestState | null> {
    try {
      return pullRequest(
        await json(`${repositoryPath(repository)}/pulls/${segment(base)}/${segment(head)}`),
      );
    } catch (error) {
      if (error instanceof ForgeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async function getFileInfo(repository: ForgeRepository, path: string, ref: string) {
    const encodedPath = path.split("/").filter(Boolean).map(segment).join("/");
    const value = contentResponse.parse(
      await json(
        `${repositoryPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      ),
    );
    return { content: Buffer.from(value.content, "base64").toString(), sha: value.sha };
  }

  return {
    async setupRepository(repository: ForgeRepository, setupID: string) {
      try {
        const value = setupRepositoryResponse.parse(await json(repositoryPath(repository)));
        if (
          value.owner.login !== repository.owner ||
          value.name !== repository.name ||
          value.description !== `Factory Project setup ${setupID}` ||
          !value.private ||
          value.mirror
        )
          throw new ForgeConflictError("Repository identity does not match this Project setup");
        return { defaultBranch: value.default_branch, empty: value.empty === true };
      } catch (error) {
        if (error instanceof ForgeHttpError && error.status === 404) return null;
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
        const value = setupRepositoryResponse.parse(
          await json(input.sourceURL ? "repos/migrate" : "user/repos", {
            method: "POST",
            signal: AbortSignal.timeout(input.sourceURL ? 120_000 : 10_000),
            body: JSON.stringify(
              input.sourceURL
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
                  },
            ),
          }),
        );
        if (
          value.name !== input.repository.name ||
          value.owner.login !== input.repository.owner ||
          value.description !== `Factory Project setup ${input.setupID}` ||
          !value.private ||
          value.mirror
        )
          throw new ForgeConflictError("Created repository has an unexpected identity");
        return { defaultBranch: value.default_branch, empty: value.empty === true };
      } catch (error) {
        if (
          ambiguous(error) ||
          (error instanceof ForgeHttpError && [409, 422].includes(error.status))
        )
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
        input.files.some(
          (file) =>
            !file.path ||
            file.path.startsWith("/") ||
            file.path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
            file.path.includes("\\"),
        )
      )
        throw new ForgeConflictError("Invalid setup file set");
      try {
        await json(`${repositoryPath(input.repository)}/contents`, {
          method: "POST",
          body: JSON.stringify({
            branch: input.branch,
            message: `Initialize Factory Starter (${input.setupID})`,
            files: input.files.map((file) => ({
              operation: "create",
              path: file.path,
              content: Buffer.from(file.content).toString("base64"),
            })),
          }),
        });
      } catch (error) {
        if (ambiguous(error))
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
        input.files.some(
          (file) =>
            !/^(?:\.factory\/system\.json|\.forgejo\/workflows\/factory-verification\.yml|\.devcontainer\/(?:devcontainer\.json|Dockerfile|compose\.ya?ml))$/.test(
              file.path,
            ),
        )
      )
        throw new ForgeConflictError("Invalid confirmed setup file set");
      let branch = await getBranch(input.repository, input.branch);
      if (!branch)
        branch = await this.ensureBranch(input.repository, input.branch, input.baseCommit);
      const verify = async (commit: string) => {
        const value = z
          .object({ parents: z.array(z.object({ sha })) })
          .loose()
          .parse(await json(`${repositoryPath(input.repository)}/git/commits/${segment(commit)}`));
        if (value.parents.length !== 1 || value.parents[0]?.sha !== input.baseCommit)
          throw new ForgeConflictError("Setup commit has an unexpected parent");
        const [before, after] = await Promise.all([
          this.listFiles(input.repository, input.baseCommit),
          this.listFiles(input.repository, commit),
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
          if ((await this.getFile(input.repository, file.path, commit)) !== file.content)
            throw new ForgeConflictError("Setup commit differs from the confirmed proposal");
        return commit;
      };
      if (branch.headSha !== input.baseCommit) return verify(branch.headSha);
      try {
        await json(`${repositoryPath(input.repository)}/contents`, {
          method: "POST",
          body: JSON.stringify({
            branch: input.branch,
            message: `Configure Factory Project (${input.proposalID})`,
            files: input.files.map((file) => ({
              operation: "create",
              path: file.path,
              content: Buffer.from(file.content).toString("base64"),
            })),
          }),
        });
      } catch (error) {
        const observed = await getBranch(input.repository, input.branch);
        if (observed && observed.headSha !== input.baseCommit) return verify(observed.headSha);
        if (ambiguous(error))
          throw new ForgeAmbiguousWriteError("Confirmed setup commit needs another source check");
        throw error;
      }
      const observed = await getBranch(input.repository, input.branch);
      if (!observed || observed.headSha === input.baseCommit)
        throw new ForgeAmbiguousWriteError("Confirmed setup commit is not visible yet");
      return verify(observed.headSha);
    },
    async listPushHooks(repository: ForgeRepository): Promise<RepositoryPushHook[]> {
      const hooks: RepositoryPushHook[] = [];
      for (let page = 1; page <= 20; page++) {
        const values = z
          .array(hookResponse)
          .parse(await json(`${repositoryPath(repository)}/hooks?limit=50&page=${page}`));
        for (const value of values)
          hooks.push({
            id: value.id,
            active: value.active,
            events: value.events,
            targetURL: value.config?.["url"] ?? value.url ?? "",
            branchFilter: value.branch_filter ?? "",
          });
        if (values.length < 50) return hooks;
      }
      throw new Error("Repository hook inventory exceeds the supported limit");
    },
    async createPushHook(
      repository: ForgeRepository,
      targetURL: string,
      secret: string,
      branch: string,
    ) {
      try {
        return hookResponse.parse(
          await json(`${repositoryPath(repository)}/hooks`, {
            method: "POST",
            body: JSON.stringify({
              type: "forgejo",
              active: true,
              events: ["push"],
              branch_filter: branch,
              config: { url: targetURL, content_type: "json", secret },
            }),
          }),
        ).id;
      } catch (cause) {
        if (ambiguous(cause) || cause instanceof TypeError)
          throw new ForgeAmbiguousWriteError("Push hook create outcome is unknown");
        throw cause;
      }
    },
    async configurePushHook(
      repository: ForgeRepository,
      id: number,
      targetURL: string,
      secret: string,
      branch: string,
    ) {
      return hookResponse.parse(
        await json(`${repositoryPath(repository)}/hooks/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            active: true,
            events: ["push"],
            branch_filter: branch,
            config: { url: targetURL, content_type: "json", secret },
          }),
        }),
      ).id;
    },
    async getDefaultBranch(repository: ForgeRepository) {
      const value = repositoryResponse.parse(await json(repositoryPath(repository)));
      if (value.owner.login !== repository.owner || value.name !== repository.name) {
        throw new Error("Forge repository response does not match the request");
      }
      const branch = await getBranch(repository, value.default_branch);
      if (!branch) throw new Error("Forge default branch does not exist");
      return branch;
    },
    getBranch,
    getPullRequest,
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
          await json(`${repositoryPath(repository)}/branches`, {
            method: "POST",
            body: JSON.stringify({ new_branch_name: branch, old_ref_name: startSha }),
          }),
        );
        if (value.name !== branch || value.commit.id !== startSha) {
          throw new ForgeConflictError("Forge created the branch with unexpected identity");
        }
        return { name: value.name, headSha: value.commit.id };
      } catch (error) {
        if (
          !(error instanceof ForgeHttpError && [409, 422].includes(error.status)) &&
          !ambiguous(error)
        ) {
          throw error;
        }
        const recovered = await getBranch(repository, branch);
        if (recovered?.headSha === startSha) return recovered;
        if (recovered) {
          throw new ForgeConflictError(
            `Branch ${branch} exists at ${recovered.headSha}, expected ${startSha}`,
          );
        }
        if (ambiguous(error)) {
          throw new ForgeAmbiguousWriteError(`Branch creation outcome for ${branch} is unknown`);
        }
        throw error;
      }
    },
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
        const created = pullRequest(
          await json(`${repositoryPath(input.repository)}/pulls`, {
            method: "POST",
            body: JSON.stringify({
              base: input.baseBranch,
              head: input.headBranch,
              title: input.title,
              body: input.body,
            }),
          }),
        );
        if (created.headSha !== input.expectedHeadSha) {
          throw new ForgeConflictError("Pull request was created for an unexpected commit");
        }
        return created;
      } catch (error) {
        if (
          !(error instanceof ForgeHttpError && [409, 422].includes(error.status)) &&
          !ambiguous(error)
        ) {
          throw error;
        }
        const recovered = await getPullRequest(
          input.repository,
          input.baseBranch,
          input.headBranch,
        );
        if (recovered?.headSha === input.expectedHeadSha) return recovered;
        if (recovered) {
          throw new ForgeConflictError("Recovered pull request has an unexpected head commit");
        }
        if (ambiguous(error)) {
          throw new ForgeAmbiguousWriteError("Pull request creation outcome is unknown");
        }
        throw error;
      }
    },
    async ensureDefaultBranchProtection(
      repository: ForgeRepository,
      branch: string,
      protectWorkflow = true,
    ) {
      try {
        return await json(`${repositoryPath(repository)}/branch_protections/${segment(branch)}`);
      } catch (error) {
        if (!(error instanceof ForgeHttpError && error.status === 404)) throw error;
      }
      try {
        return await json(`${repositoryPath(repository)}/branch_protections`, {
          method: "POST",
          body: JSON.stringify({
            rule_name: branch,
            enable_push: false,
            enable_status_check: false,
            protected_file_patterns: protectWorkflow
              ? ".forgejo/workflows/factory-verification.yml"
              : "",
          }),
        });
      } catch (error) {
        // Forgejo can report a concurrent identical create as 403, not only
        // 422. Observe once before classifying the failed response. This is
        // not another write and must prove the exact protected outcome.
        try {
          const recovered = await json(
            `${repositoryPath(repository)}/branch_protections/${segment(branch)}`,
          );
          const observed = z
            .object({
              rule_name: z.literal(branch),
              enable_push: z.literal(false),
              protected_file_patterns: z.string().optional(),
            })
            .safeParse(recovered);
          if (
            observed.success &&
            (!protectWorkflow ||
              (observed.data.protected_file_patterns ?? "")
                .split(";")
                .includes(".forgejo/workflows/factory-verification.yml"))
          )
            return recovered;
        } catch {
          // Missing, denied or lost readback cannot confirm the intended write.
        }
        if (ambiguous(error))
          throw new ForgeAmbiguousWriteError("Branch protection outcome is unknown");
        throw error;
      }
    },
    async protectSetupWorkflow(repository: ForgeRepository, branch: string) {
      const value = z
        .object({ enable_push: z.boolean(), protected_file_patterns: z.string().optional() })
        .loose()
        .parse(await json(`${repositoryPath(repository)}/branch_protections/${segment(branch)}`));
      if (value.enable_push)
        throw new ForgeConflictError("Main branch protection permits direct pushes");
      if (
        (value.protected_file_patterns ?? "")
          .split(";")
          .includes(".forgejo/workflows/factory-verification.yml")
      )
        return;
      return json(`${repositoryPath(repository)}/branch_protections/${segment(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({
          protected_file_patterns: [
            value.protected_file_patterns,
            ".forgejo/workflows/factory-verification.yml",
          ]
            .filter(Boolean)
            .join(";"),
        }),
      });
    },
    getFileInfo,
    async getFile(repository: ForgeRepository, path: string, ref: string) {
      return (await getFileInfo(repository, path, ref)).content;
    },
    async listFiles(repository: ForgeRepository, commitSha: string) {
      type Entry = z.infer<typeof treeResponse>["tree"][number];
      const maximumEntries = 100_000;
      async function tree(ref: string, recursive: boolean) {
        const entries = new Map<string, Entry>();
        for (let page = 1; page <= 1000; page += 1) {
          const result = await response(
            `${repositoryPath(repository)}/git/trees/${segment(ref)}?recursive=${recursive}&page=${page}&per_page=1000`,
          );
          const value = treeResponse.parse(await result.json());
          if (value.truncated) return { entries: [...entries.values()], truncated: true };
          const before = entries.size;
          for (const entry of value.tree) {
            if (entries.has(entry.path))
              throw new Error("Forge repository inventory is incomplete: repeated tree entry");
            entries.set(entry.path, entry);
          }
          if (entries.size > maximumEntries)
            throw new Error("Forge repository inventory exceeds its bound");
          const hasNext = /rel="next"/.test(result.headers.get("link") ?? "");
          const total = value.total_count;
          if (total !== undefined && entries.size > total)
            throw new Error("Forge repository inventory is incomplete: inconsistent total");
          if (!hasNext && (total !== undefined ? entries.size === total : value.tree.length < 1000))
            return { entries: [...entries.values()], truncated: false };
          if (before === entries.size)
            throw new Error("Forge repository inventory is incomplete: empty page");
        }
        throw new Error("Forge repository inventory is incomplete: pagination bound");
      }
      let value = await tree(commitSha, true);
      if (value.truncated) {
        const entries: Entry[] = [];
        const queue = [{ ref: commitSha, prefix: "", ancestors: new Set<string>() }];
        for (let index = 0; index < queue.length; index += 1) {
          const current = queue[index];
          if (!current) break;
          if (current.ancestors.has(current.ref)) throw new Error("Forge tree contains a cycle");
          const subtree = await tree(current.ref, false);
          if (subtree.truncated)
            throw new Error("Forge repository inventory is incomplete: truncated subtree");
          const ancestors = new Set([...current.ancestors, current.ref]);
          for (const entry of subtree.entries) {
            if (
              entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
              entry.path.includes("\\")
            )
              throw new Error("Forge tree contains an invalid path");
            const path = `${current.prefix}${entry.path}`;
            if (entry.type === "tree")
              queue.push({ ref: entry.sha, prefix: `${path}/`, ancestors });
            else entries.push({ ...entry, path });
            if (entries.length + queue.length > maximumEntries)
              throw new Error("Forge repository inventory exceeds its bound");
          }
        }
        value = { entries, truncated: false };
      }
      return value.entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
    },
    async updateFile(input: {
      repository: ForgeRepository;
      branch: string;
      expectedBranchSha: string;
      path: string;
      expectedBlobSha: string;
      content: string;
      message: string;
    }) {
      const encodedPath = input.path.split("/").filter(Boolean).map(segment).join("/");
      const apply = async () =>
        fileUpdateResponse.parse(
          await json(`${repositoryPath(input.repository)}/contents/${encodedPath}`, {
            method: "PUT",
            body: JSON.stringify({
              branch: input.branch,
              sha: input.expectedBlobSha,
              message: input.message,
              content: Buffer.from(input.content).toString("base64"),
            }),
          }),
        );
      const current = await getBranch(input.repository, input.branch);
      if (current?.headSha !== input.expectedBranchSha) {
        const observed = await getFileInfo(input.repository, input.path, input.branch);
        if (current && observed.content === input.content) {
          return { commitSha: current.headSha, blobSha: observed.sha };
        }
        throw new ForgeConflictError("Repository Document branch moved before save");
      }
      try {
        const updated = await apply();
        return { commitSha: updated.commit.sha, blobSha: updated.content.sha };
      } catch (error) {
        if (!ambiguous(error)) throw error;
        const observedBranch = await getBranch(input.repository, input.branch);
        const observedFile = await getFileInfo(input.repository, input.path, input.branch);
        if (
          observedBranch &&
          observedBranch.headSha !== input.expectedBranchSha &&
          observedFile.content === input.content
        ) {
          return { commitSha: observedBranch.headSha, blobSha: observedFile.sha };
        }
        throw new ForgeAmbiguousWriteError("Repository Document update outcome is unknown");
      }
    },
    async listActionRuns(repository: ForgeRepository, commitSha: string) {
      const value = actionRunsResponse.parse(
        await json(
          `${repositoryPath(repository)}/actions/runs?head_sha=${encodeURIComponent(commitSha)}&limit=20`,
        ),
      );
      // Forgejo's event filter omits synchronized PR runs. Check the returned exact context here.
      return value.workflow_runs
        .filter((run) => run.commit_sha === commitSha && run.event === "pull_request")
        .map(
          (run): ActionRunState => ({
            id: run.id,
            url: run.html_url,
            commitSha: run.commit_sha,
            workflowID: run.workflow_id,
            event: run.event,
            status: run.status,
          }),
        );
    },
    async registerEphemeralRunner(
      repository: ForgeRepository,
      name: string,
    ): Promise<RunnerRegistration> {
      const register = async () =>
        runnerRegistrationResponse.parse(
          await json(`${repositoryPath(repository)}/actions/runners`, {
            method: "POST",
            body: JSON.stringify({
              name,
              description: "Factory Verification Sandbox",
              ephemeral: true,
            }),
          }),
        );
      try {
        return await register();
      } catch (error) {
        if (!ambiguous(error)) throw error;
        const existing = z
          .array(runnerResponse)
          .parse(await json(`${repositoryPath(repository)}/actions/runners?limit=100`))
          .filter((runner) => runner.name === name);
        for (const runner of existing) {
          await response(`${repositoryPath(repository)}/actions/runners/${runner.id}`, {
            method: "DELETE",
          });
        }
        try {
          return await register();
        } catch (retryError) {
          if (ambiguous(retryError)) {
            throw new ForgeAmbiguousWriteError("Runner registration outcome is unknown");
          }
          throw retryError;
        }
      }
    },
    async deleteRunner(repository: ForgeRepository, runnerID: number) {
      try {
        await response(`${repositoryPath(repository)}/actions/runners/${runnerID}`, {
          method: "DELETE",
        });
      } catch (error) {
        if (!(error instanceof ForgeHttpError && error.status === 404)) throw error;
      }
    },
    async mergeFastForward(
      repository: ForgeRepository,
      pullRequestNumber: number,
      expectedHeadSha: string,
      defaultBranch: string,
    ) {
      const current = await getBranch(repository, defaultBranch);
      if (current?.headSha === expectedHeadSha) return current;
      try {
        await response(`${repositoryPath(repository)}/pulls/${pullRequestNumber}/merge`, {
          method: "POST",
          body: JSON.stringify({
            Do: "fast-forward-only",
            head_commit_id: expectedHeadSha,
            delete_branch_after_merge: false,
          }),
        });
      } catch (error) {
        const observed = await getBranch(repository, defaultBranch);
        if (observed?.headSha === expectedHeadSha) return observed;
        if (ambiguous(error)) {
          throw new ForgeAmbiguousWriteError("Pull request merge outcome is unknown");
        }
        throw error;
      }
      const observed = await getBranch(repository, defaultBranch);
      if (observed?.headSha !== expectedHeadSha) {
        throw new ForgeConflictError("Default branch did not advance to the approved commit");
      }
      return observed;
    },
    async deleteBranch(repository: ForgeRepository, branch: string) {
      try {
        await response(`${repositoryPath(repository)}/branches/${segment(branch)}`, {
          method: "DELETE",
        });
      } catch (error) {
        if (!(error instanceof ForgeHttpError && error.status === 404)) throw error;
      }
    },
  };
}
