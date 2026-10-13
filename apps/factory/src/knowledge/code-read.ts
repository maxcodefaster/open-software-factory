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
