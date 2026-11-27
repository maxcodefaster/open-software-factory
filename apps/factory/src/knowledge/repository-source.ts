import { and, desc, eq, sql as expression } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { operation, project as projectTable } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import type { WikiPageSnapshot } from "#knowledge-domain/generation";
import { createAccessController } from "../access/api";
import { CommandError } from "../command-error";
import {
  findReadableCodePaths,
  maximumReadableCodeBytes,
  readableCodePath,
  readCodePage,
} from "./code-read";
import { codeReadInput, codeReadResult } from "./contracts";
import { factoryForgeSource } from "./forge-source";
import { createRepositoryKnowledgeCache } from "./repository-cache";

export type KnowledgeDatabase = ReturnType<typeof createDatabase>;
export type RepositoryReader = Pick<
  ReturnType<typeof createForgejoClient>,
  "getDefaultBranch" | "listFiles" | "getFileInfo"
>;
export type ForgeOrigin = {
  apiURL: string;
  publicURL: string | undefined;
  owner: string;
};

const sourceExtensions = new Set([
  ".md",
  ".mdx",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".py",
  ".rs",
  ".mod",
  ".sql",
  ".css",
  ".html",
]);

function extension(path: string) {
  const file = path.split("/").at(-1) ?? "";
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot).toLowerCase();
}

export function repositoryTitle(path: string) {
  return (
    path
      .split("/")
      .at(-1)
      ?.replace(/\.(md|mdx)$/i, "")
      .replaceAll(/[-_]+/g, " ") ?? path
  );
}

export function isMarkdownDocument(file: { path: string; size: number }) {
  return /\.mdx?$/i.test(file.path) && file.size <= 250_000;
}

export function projectGenerationWhere(projectID: string) {
  return and(
    eq(operation.kind, "knowledge.generation"),
    eq(operation.scopeType, "project"),
    eq(operation.scopeId, projectID),
  );
}

export function createKnowledgeRepository(
  database: KnowledgeDatabase,
  reader: RepositoryReader,
  forgeOrigin: ForgeOrigin,
) {
  const repositoryCache = createRepositoryKnowledgeCache();

  async function project(projectID: string) {
    const rows = await database.db
      .select({
        id: projectTable.id,
        name: projectTable.name,
        repositoryURL: projectTable.repositoryUrl,
        defaultBranch: projectTable.defaultBranch,
        actorTemplatePath: projectTable.actorTemplatePath,
      })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
    const value = rows[0];
    if (!value) throw new Error("Project not found");
    const repository = factoryForgeSource(
      value.repositoryURL,
      forgeOrigin.apiURL,
      forgeOrigin.owner,
      forgeOrigin.publicURL,
    );
    return { ...value, repository };
  }

  async function inventory(projectID: string, commitSha?: string) {
    const current = await project(projectID);
    const branch = commitSha
      ? { name: current.defaultBranch, headSha: commitSha }
      : await reader.getDefaultBranch(current.repository);
    if (branch.name !== current.defaultBranch)
      throw new Error("Project default branch does not match Forge");
    const files = await repositoryCache.inventory(current.repositoryURL, branch.headSha, () =>
      reader.listFiles(current.repository, branch.headSha),
    );
    return { project: current, commitSha: branch.headSha, files };
  }

  type InventorySnapshot = Awaited<ReturnType<typeof inventory>>;

  async function readVerifiedBlob(
    current: InventorySnapshot,
    path: string,
    expectedSha: string,
    mismatchMessage: string,
    options?: { maxBytes?: number; rejectNull?: boolean },
  ) {
    return repositoryCache.content(
      current.project.repositoryURL,
      expectedSha,
      async () => {
        const file = await reader.getFileInfo(current.project.repository, path, current.commitSha);
        if (file.sha !== expectedSha || (options?.rejectNull && file.content.includes("\0")))
          throw new Error(mismatchMessage);
        return file.content;
      },
      options?.maxBytes,
    );
  }

  async function documentContent(current: InventorySnapshot, path: string) {
    const entry = current.files.find((file) => file.path === path);
    if (!entry || !isMarkdownDocument(entry))
      throw new CommandError("not-found", "Repository document is unavailable at this revision.");
    const body = await readVerifiedBlob(
      current,
      path,
      entry.sha,
      "Repository document blob does not match its inventory",
    );
    return { entry, body };
  }

  async function verifyHead(
    repository: { owner: string; name: string },
    expectedCommitSha: string,
    message: string,
  ) {
    const head = await reader.getDefaultBranch(repository);
    if (head.headSha !== expectedCommitSha) throw new Error(message);
  }

  async function sourceBundle(projectID: string, commitSha: string, pages: WikiPageSnapshot[]) {
    const current = await inventory(projectID, commitSha);
    if (current.files.length > 8_000 || JSON.stringify(pages).length > 240_000)
      throw new Error("Project exceeds the bounded Wiki analysis size");
    const candidates = current.files.filter(
      (file) =>
        file.size <= 80_000 &&
        (file.path === current.project.actorTemplatePath ||
          sourceExtensions.has(extension(file.path)) ||
          (/(^|\/)readme$/i.test(file.path) && readableCodePath(file.path))) &&
        !file.path
          .split("/")
          .some((part) => ["node_modules", "vendor", "dist", "build", ".git"].includes(part)) &&
        !/(^|\/)\.env(?:$|\.)/i.test(file.path) &&
        !/(^|\/)(.*lock.*|.*\.min\.(?:[jt]s|css)|.*\.map|.*secret.*|.*credentials.*)$/i.test(
          file.path,
        ),
    );
    const [previous] = await database.db
      .select({ commit: expression<string>`${operation.payload}->>'sourceCommitSha'` })
      .from(operation)
      .where(and(projectGenerationWhere(projectID), eq(operation.state, "succeeded")))
      .orderBy(desc(operation.completedAt))
      .limit(1);
    const previousFiles = previous ? (await inventory(projectID, previous.commit)).files : [];
    const old = new Map(previousFiles.map((file) => [file.path, file.sha]));
    const next = new Map(current.files.map((file) => [file.path, file.sha]));
    const changedPaths = [
      ...new Set([
        ...current.files.filter((file) => old.get(file.path) !== file.sha).map((file) => file.path),
        ...previousFiles.filter((file) => !next.has(file.path)).map((file) => file.path),
      ]),
    ];
    const read = new Map<string, { path: string; content: string }>();
    let bytes = 0;
    async function readFiles(paths: string[]) {
      const result: Array<{ path: string; content: string }> = [];
      for (const path of paths) {
        const cached = read.get(path);
        if (cached) {
          result.push(cached);
          continue;
        }
        const entry = candidates.find((file) => file.path === path);
        if (!entry || paths.length > 8 || read.size >= 384 || bytes + entry.size > 2_000_000)
          throw new Error("Wiki source read is unavailable or exceeds its analysis bound");
        const content = await readVerifiedBlob(
          current,
          path,
          entry.sha,
          "Wiki source blob changed unexpectedly",
        );
        bytes += new TextEncoder().encode(content).byteLength;
        if (bytes > 2_000_000) throw new Error("Wiki analysis exceeds its total source bound");
        const value = { path, content };
        read.set(path, value);
        result.push(value);
      }
      return result;
    }
    const nativePaths = new Set([current.project.actorTemplatePath, ".factory/system.json"]);
    const initial = candidates
      .filter(
        (file) =>
          nativePaths.has(file.path) ||
          /(^|\/)(readme(?:\.md)?|package\.json|go\.mod|pyproject\.toml|cargo\.toml|system\.json|main\.[a-z]+|index\.[jt]sx?)$/i.test(
            file.path,
          ),
      )
      .sort(
        (left, right) =>
          Number(nativePaths.has(right.path)) - Number(nativePaths.has(left.path)) ||
          left.path.split("/").length - right.path.split("/").length ||
          left.path.localeCompare(right.path),
      )
      .slice(0, 6);
    const sources = await readFiles(initial.map((file) => file.path));
    return {
      ...current,
      candidates,
      changedPaths,
      sources,
      readFiles,
      readPaths: () => new Set(read.keys()),
    };
  }

  return {
    inventory,
    documentContent,
    verifyHead,
    sourceBundle,
    async codePaths(projectID: string, query: string, userID: string, commitSha?: string) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      const current = await inventory(projectID, commitSha);
      const matches = findReadableCodePaths(current.files, query);
      await createAccessController(database).requireDevelopment(userID, projectID);
      return {
        commitSha: current.commitSha,
        ...matches,
      };
    },
    async code(projectID: string, value: unknown, userID: string) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      const input = codeReadInput.parse(value);
      const current = await inventory(projectID, input.commitSha);
      const entry = current.files.find((file) => file.path === input.path);
      if (!entry || entry.size > maximumReadableCodeBytes || !readableCodePath(input.path))
        throw new CommandError("not-found", "Code source is unavailable");
      const content = await readVerifiedBlob(
        current,
        input.path,
        entry.sha,
        "Code blob does not match its readable inventory",
        { maxBytes: Math.max(250_000, entry.size), rejectNull: true },
      );
      await createAccessController(database).requireDevelopment(userID, projectID);
      return codeReadResult.parse({
        ...input,
        ...readCodePage(content, input),
        url: `${current.project.repositoryURL.replace(/\.git$/, "")}/src/commit/${input.commitSha}/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      });
    },
    async documents(projectID: string) {
      const current = await inventory(projectID);
      return {
        commitSha: current.commitSha,
        documents: current.files
          .filter(isMarkdownDocument)
          .map((file) => ({ ...file, title: repositoryTitle(file.path) }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    },
    async document(projectID: string, path: string) {
      if (!/\.mdx?$/i.test(path)) throw new Error("Repository Document must be Markdown");
      const current = await inventory(projectID);
      const { entry, body } = await documentContent(current, path);
      return {
        path,
        title: repositoryTitle(path),
        body,
        blobSha: entry.sha,
        commitSha: current.commitSha,
      };
    },
  };
}

export type KnowledgeRepository = ReturnType<typeof createKnowledgeRepository>;
