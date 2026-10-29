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
  url: z.string().url(),
});
export function readableCodePath(path: string) {
  return (
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) =>
        ["..", "node_modules", ".git", "dist", "build", "vendor", ".factory"].includes(part),
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
