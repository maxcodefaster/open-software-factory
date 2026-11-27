import type { z } from "zod";
import type { codeReadInput } from "./contracts";

// Whole blobs remain bounded in the repository adapter; model reads are still
// paginated to 16,000 characters, including large lockfiles and source modules.
export const maximumReadableCodeBytes = 16 * 1024 * 1024;

export function readCodePage(
  content: string,
  input: Pick<z.infer<typeof codeReadInput>, "startLine" | "lineCount">,
) {
  const lines = content.split("\n");
  const selected: string[] = [];
  let length = 0;
  for (
    let index = input.startLine - 1;
    index < Math.min(lines.length, input.startLine - 1 + input.lineCount);
    index++
  ) {
    const line = `${index + 1}: ${lines[index]}`;
    if (line.length > 16000 && selected.length === 0)
      throw new Error(`Code line ${index + 1} exceeds the readable page size`);
    const size = line.length + (selected.length ? 1 : 0);
    if (length + size > 16000) break;
    selected.push(line);
    length += size;
  }
  const next = input.startLine + selected.length;
  const nextStartLine = next <= lines.length ? next : null;
  return {
    body: selected.join("\n"),
    truncated: nextStartLine !== null,
    nextStartLine,
    totalLines: lines.length,
  };
}
export function readableCodePath(path: string) {
  return (
    !path.startsWith("/") &&
    !path.split("/").some(
      (part) =>
        ["..", "node_modules", ".git", "dist", "build", "vendor"].includes(part) ||
        // This source-controlled App declaration is not Factory runtime data.
        // Keep every other .factory path private, including nested lookalikes.
        (part === ".factory" && path !== ".factory/system.json"),
    ) &&
    !/(^|\/)(\.env($|\.)|.*(?:secret|credential|private[-_]?key).*|.*\.(?:pem|key|p12|pfx))$/i.test(
      path,
    ) &&
    (/\.(?:mdx?|tsx?|jsx?|mjs|cjs|json|ya?ml|toml|go|py|rs|java|kt|cs|sh|sql|html|css|astro|svelte|vue|rb|php|exs?|tf)$/i.test(
      path,
    ) ||
      /(?:^|\/)readme$/i.test(path) ||
      /(?:^|\/)(?:Dockerfile|Containerfile)(?:\.[^/]+)?$/i.test(path))
  );
}

export function findReadableCodePaths(
  files: readonly { path: string; size: number }[],
  query: string,
) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  // Agents often name several files in one lookup. Requiring every term in
  // the same path made present sources look unavailable. Rank relevant paths,
  // retaining the inventory order for ties and for the empty first page.
  const matches = files
    .map((file, index) => ({
      ...file,
      index,
      score: terms.filter((term) => file.path.toLowerCase().includes(term)).length,
    }))
    .filter(
      (file) =>
        readableCodePath(file.path) &&
        file.size <= maximumReadableCodeBytes &&
        (!terms.length || file.score > 0),
    )
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    paths: matches.slice(0, 40).map((file) => file.path),
    truncated: matches.length > 40,
  };
}
