import { createTwoFilesPatch } from "diff";
import { boundForgeRepositoryFromURL } from "#forge/repository";
import { CommandError } from "../command-error";
import type {
  Inventory,
  ReviewCache,
  ReviewCall,
  ReviewForgeBinding,
  ReviewForgeClient,
  ReviewScope,
} from "./candidate-review-types";

export type ReviewSourceCall = Extract<
  ReviewCall,
  { name: "review_files" | "review_search" | "review_read" | "review_diff" }
>;

export type ReviewInventories = { base: Inventory; candidate: Inventory };

export function createReviewSourceReader(
  forge: ReviewForgeClient,
  binding: ReviewForgeBinding,
  cached: ReviewCache,
) {
  function repository(scope: ReviewScope) {
    return boundForgeRepositoryFromURL(
      scope.repositoryURL,
      binding,
      () => new Error("Review repository is not the configured Project forge"),
    );
  }

  async function inventories(scope: ReviewScope): Promise<ReviewInventories> {
    const repo = repository(scope);
    const [base, candidate] = await Promise.all([
      cached(`inventory:${scope.repositoryURL}:${scope.baseSHA}`, () =>
        forge.listFiles(repo, scope.baseSHA),
      ),
      cached(`inventory:${scope.repositoryURL}:${scope.commitSHA}`, () =>
        forge.listFiles(repo, scope.commitSHA),
      ),
    ]);
    return { base, candidate };
  }

  async function revisionFiles(scope: ReviewScope, inventory: ReviewInventories, revision: string) {
    if (revision === "candidate" || revision === "base") {
      return {
        files: inventory[revision],
        sha: revision === "base" ? scope.baseSHA : scope.commitSHA,
      };
    }
    const sha = revision === "previous" ? scope.previousSHA : revision;
    if (!sha) throw new CommandError("conflict", "This review has no previous candidate");
    return {
      sha,
      files: await cached(`inventory:${scope.repositoryURL}:${sha}`, () =>
        forge.listFiles(repository(scope), sha),
      ),
    };
  }

  async function readRawFile(scope: ReviewScope, path: string, ref: string) {
    return cached(`file:${scope.repositoryURL}:${ref}:${path}`, () =>
      forge.getFile(repository(scope), path, ref),
    );
  }

  async function readSource(scope: ReviewScope, files: Inventory, path: string, ref: string) {
    const file = files.find((item) => item.path === path);
    if (!file) throw new CommandError("not-found", "File is absent from this exact revision");
    if (file.size > 1_048_576) {
      throw new CommandError("conflict", "Review file exceeds the 1 MiB text limit");
    }
    const content = await readRawFile(scope, path, ref);
    if (Buffer.byteLength(content) > 1_048_576 || content.includes("\0")) {
      throw new CommandError("conflict", "Review requires a bounded text file");
    }
    return content;
  }

  return { inventories, revisionFiles, readRawFile, readSource };
}

export type ReviewSourceReader = ReturnType<typeof createReviewSourceReader>;

export async function executeReviewSourceTool(
  scope: ReviewScope,
  call: ReviewSourceCall,
  inventory: ReviewInventories,
  reader: ReviewSourceReader,
): Promise<{ output: unknown; observation: Record<string, unknown> }> {
  if (call.name === "review_files") {
    const comparison = await reader.revisionFiles(scope, inventory, call.arguments.comparison);
    const before = new Map(comparison.files.map((file) => [file.path, file]));
    const after = new Map(inventory.candidate.map((file) => [file.path, file]));
    const files = [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .map((path) => ({
        path,
        base: before.get(path) ?? null,
        candidate: after.get(path) ?? null,
        changed: before.get(path)?.sha !== after.get(path)?.sha,
      }))
      .filter((file) => !call.arguments.changedOnly || file.changed);
    const page: typeof files = [];
    let bytes = 256;
    for (const file of files.slice(call.arguments.offset, call.arguments.offset + 200)) {
      const size = Buffer.byteLength(JSON.stringify(file)) + 1;
      if (bytes + size > 30_000) {
        if (!page.length) {
          throw new CommandError("conflict", "Review inventory contains an oversized path");
        }
        break;
      }
      page.push(file);
      bytes += size;
    }
    return {
      output: {
        commit: scope.commitSHA,
        base: comparison.sha,
        files: page,
        nextOffset:
          call.arguments.offset + page.length < files.length
            ? call.arguments.offset + page.length
            : null,
      },
      observation: {
        kind: "inventory",
        changedOnly: call.arguments.changedOnly,
        offset: call.arguments.offset,
      },
    };
  }

  if (call.name === "review_search") {
    const { query, revision, pathPrefix, offset, startLine } = call.arguments;
    const selected = await reader.revisionFiles(scope, inventory, revision);
    const files = selected.files
      .filter((file) => file.path.startsWith(pathPrefix))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const skipped: string[] = [];
    let nextOffset: number | null = null;
    let nextLine = 1;
    let bytes = 0;
    let readBytes = 0;
    let index = offset;
    function skip(path: string) {
      const size = Buffer.byteLength(JSON.stringify(path));
      if (bytes + size > 24_000) {
        if (!bytes) throw new CommandError("conflict", "Search contains an oversized path");
        return false;
      }
      skipped.push(path);
      bytes += size;
      return true;
    }
    outer: for (; index < Math.min(files.length, offset + 200); index++) {
      const file = files[index];
      if (!file) break;
      if (file.size > 1_048_576) {
        if (!skip(file.path)) break;
        continue;
      }
      if (readBytes + file.size > 1_048_576 && index > offset) break;
      const content = await reader.readRawFile(scope, file.path, selected.sha);
      readBytes += Buffer.byteLength(content);
      if (content.includes("\0") || Buffer.byteLength(content) > 1_048_576) {
        if (!skip(file.path)) break;
        continue;
      }
      const lines = content.split("\n");
      for (let line = index === offset ? startLine - 1 : 0; line < lines.length; line++) {
        const text = lines[line];
        if (text === undefined) continue;
        const position = text.indexOf(query);
        if (position < 0) continue;
        const start = Math.max(0, position - 200);
        const match = {
          path: file.path,
          line: line + 1,
          text: text.slice(start, start + 1_000),
        };
        const size = Buffer.byteLength(JSON.stringify(match));
        if (bytes + size > 24_000) {
          if (!bytes) throw new CommandError("conflict", "Search contains an oversized path");
          nextOffset = index;
          nextLine = line + 1;
          break outer;
        }
        matches.push(match);
        bytes += size;
      }
    }
    if (nextOffset === null && index < files.length) nextOffset = index;
    return {
      output: { revision, commit: selected.sha, matches, skipped, nextOffset, nextLine },
      observation: {
        kind: matches.length ? "source" : "search",
        revision: selected.sha === scope.commitSHA ? "candidate" : revision,
        sourceCommit: selected.sha,
        search: query,
        pathPrefix,
        offset,
        startLine,
        paths: matches.map((match) => match.path),
      },
    };
  }

  if (call.name === "review_read") {
    const { path, revision, startLine, lines } = call.arguments;
    const selected = await reader.revisionFiles(scope, inventory, revision);
    const content = await reader.readSource(scope, selected.files, path, selected.sha);
    const all = content.split("\n");
    return {
      output: {
        path,
        revision,
        commit: selected.sha,
        totalLines: all.length,
        text: all
          .slice(startLine - 1, startLine - 1 + lines)
          .map((line, idx) => `${startLine + idx}: ${line}`)
          .join("\n"),
      },
      observation: {
        kind: "source",
        path,
        revision: selected.sha === scope.commitSHA ? "candidate" : revision,
        sourceCommit: selected.sha,
        startLine,
        lines,
      },
    };
  }

  const { path, comparison } = call.arguments;
  const beforeRevision = await reader.revisionFiles(scope, inventory, comparison);
  const beforeFile = beforeRevision.files.find((file) => file.path === path);
  const candidateFile = inventory.candidate.find((file) => file.path === path);
  if (!beforeFile && !candidateFile) {
    throw new CommandError("not-found", "File is absent from the review");
  }
  const before = beforeFile
    ? await reader.readSource(scope, beforeRevision.files, path, beforeRevision.sha)
    : "";
  const after = candidateFile
    ? await reader.readSource(scope, inventory.candidate, path, scope.commitSHA)
    : "";
  return {
    output: createTwoFilesPatch(
      `base/${path}`,
      `candidate/${path}`,
      before,
      after,
      beforeRevision.sha,
      scope.commitSHA,
      { context: 4 },
    ),
    observation: { kind: "source", path, diff: true, comparison },
  };
}
