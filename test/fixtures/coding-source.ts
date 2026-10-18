import type { createForgejoClient, ForgeRepository } from "../../packages/forge/src/forge";

// Independent read-only acceptance of this UI-only fixture's non-goals.
export async function verifyCodingSource(input: {
  forge: ReturnType<typeof createForgejoClient>;
  repository: ForgeRepository;
  baseSHA: string;
  commitSHA: string;
}) {
  const [before, after] = await Promise.all([
    input.forge.listFiles(input.repository, input.baseSHA),
    input.forge.listFiles(input.repository, input.commitSHA),
  ]);
  const original = new Map(before.map((file) => [file.path, file.sha]));
  const current = new Map(after.map((file) => [file.path, file.sha]));
  const unchangedFiles = [
    "package.json",
    "package-lock.json",
    ".devcontainer/devcontainer.json",
    ".devcontainer/compose.yaml",
    ".factory/system.json",
    ".forgejo/workflows/factory-verification.yml",
    "src/server.ts",
    "src/auth.ts",
    "drizzle/0000_auth.sql",
  ];
  for (const path of unchangedFiles)
    if (!original.has(path) || original.get(path) !== current.get(path))
      throw new Error(`Coding proof changed a preserved fixture input: ${path}`);
  const changedTests = after
    .filter(
      (file) =>
        /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path) &&
        original.get(file.path) !== file.sha,
    )
    .map((file) => file.path);
  if (!changedTests.length) throw new Error("Coding proof did not add or update regression tests");
  return { unchangedFiles, changedTests };
}
