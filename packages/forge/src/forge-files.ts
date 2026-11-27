import { z } from "zod";
import type { ForgeRepository } from "./contracts";
import type { ForgeBranches } from "./forge-branches";
import {
  encodeRepoFilePath,
  ForgeAmbiguousWriteError,
  ForgeConflictError,
  type ForgeTransport,
  hasInvalidRelativePath,
  isAmbiguousError,
  isNotFound,
  readAfterWrite,
  repositoryPath,
  segment,
  sha,
} from "./forge-http";

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

type TreeEntry = z.infer<typeof treeResponse>["tree"][number];

const MAXIMUM_TREE_ENTRIES = 100_000;

export function createForgeFiles(
  transport: ForgeTransport,
  branches: Pick<ForgeBranches, "getBranch">,
) {
  async function getFileInfo(repository: ForgeRepository, path: string, ref: string) {
    const encodedPath = encodeRepoFilePath(path);
    const value = contentResponse.parse(
      await transport.json(
        `${repositoryPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      ),
    );
    return { content: Buffer.from(value.content, "base64").toString(), sha: value.sha };
  }

  async function readTreePage(repository: ForgeRepository, ref: string, recursive: boolean) {
    const entries = new Map<string, TreeEntry>();
    for (let page = 1; page <= 1000; page += 1) {
      const result = await transport.response(
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
      if (entries.size > MAXIMUM_TREE_ENTRIES)
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

  return {
    getFileInfo,
    async getFile(repository: ForgeRepository, path: string, ref: string) {
      return (await getFileInfo(repository, path, ref)).content;
    },
    async getOptionalFile(repository: ForgeRepository, path: string, ref: string) {
      try {
        return (await getFileInfo(repository, path, ref)).content;
      } catch (cause) {
        if (isNotFound(cause)) return null;
        throw cause;
      }
    },
    async listFiles(repository: ForgeRepository, commitSha: string) {
      let value = await readTreePage(repository, commitSha, true);
      if (value.truncated) {
        const entries: TreeEntry[] = [];
        const queue = [{ ref: commitSha, prefix: "", ancestors: new Set<string>() }];
        for (let index = 0; index < queue.length; index += 1) {
          const current = queue[index];
          if (!current) break;
          if (current.ancestors.has(current.ref)) throw new Error("Forge tree contains a cycle");
          const subtree = await readTreePage(repository, current.ref, false);
          if (subtree.truncated)
            throw new Error("Forge repository inventory is incomplete: truncated subtree");
          const ancestors = new Set([...current.ancestors, current.ref]);
          for (const entry of subtree.entries) {
            if (hasInvalidRelativePath(entry.path))
              throw new Error("Forge tree contains an invalid path");
            const path = `${current.prefix}${entry.path}`;
            if (entry.type === "tree")
              queue.push({ ref: entry.sha, prefix: `${path}/`, ancestors });
            else entries.push({ ...entry, path });
            if (entries.length + queue.length > MAXIMUM_TREE_ENTRIES)
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
      const encodedPath = encodeRepoFilePath(input.path);
      const current = await branches.getBranch(input.repository, input.branch);
      if (current?.headSha !== input.expectedBranchSha) {
        const observed = await getFileInfo(input.repository, input.path, input.branch);
        if (current && observed.content === input.content) {
          return { commitSha: current.headSha, blobSha: observed.sha };
        }
        throw new ForgeConflictError("Repository Document branch moved before save");
      }
      try {
        const updated = fileUpdateResponse.parse(
          await transport.jsonBody(
            `${repositoryPath(input.repository)}/contents/${encodedPath}`,
            "PUT",
            {
              branch: input.branch,
              sha: input.expectedBlobSha,
              message: input.message,
              content: Buffer.from(input.content).toString("base64"),
            },
          ),
        );
        return { commitSha: updated.commit.sha, blobSha: updated.content.sha };
      } catch (error) {
        if (!isAmbiguousError(error)) throw error;
        const [observedBranch, observedFile] = await readAfterWrite(
          error,
          async () =>
            [
              await branches.getBranch(input.repository, input.branch),
              await getFileInfo(input.repository, input.path, input.branch),
            ] as const,
          "Repository Document update outcome is unknown",
        );
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
  };
}

export type ForgeFiles = ReturnType<typeof createForgeFiles>;
