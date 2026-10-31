import { z } from "zod";

export const codeReference = z
  .object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    path: z.string().min(1).max(1000),
  })
  .strict();
export const codeReadInput = codeReference.extend({
  startLine: z.number().int().min(1).max(100000).default(1),
  lineCount: z.number().int().min(1).max(160).default(80),
});
export const codeReadResult = codeReadInput.extend({
  body: z.string().max(16000),
  truncated: z.boolean(),
  nextStartLine: z.number().int().positive().nullable().optional(),
  totalLines: z.number().int().nonnegative().optional(),
  url: z.string().url(),
});
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
    /\.(?:mdx?|tsx?|jsx?|mjs|cjs|json|ya?ml|toml|go|py|rs|java|kt|cs|sh|sql|html|css|svelte|vue|rb|php|exs?|tf)$/i.test(
      path,
    )
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
        readableCodePath(file.path) && file.size <= 250000 && (!terms.length || file.score > 0),
    )
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return {
    paths: matches.slice(0, 40).map((file) => file.path),
    truncated: matches.length > 40,
  };
}
