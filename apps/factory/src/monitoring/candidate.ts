import { applicationFixPath } from "../../../../packages/requirement-domain/src/autofix";
import type { createForgejoClient, ForgeRepository } from "../../../../packages/forge/src/forge";
import { CommandError } from "../command-error";
import { monitoringDigest } from "./payload";

export async function monitoringCandidate(
  forge: Pick<ReturnType<typeof createForgejoClient>, "listFiles">,
  repository: ForgeRepository,
  baseSha: string,
  commitSha: string,
) {
  const [base, candidate] = await Promise.all([
    forge.listFiles(repository, baseSha),
    forge.listFiles(repository, commitSha),
  ]);
  const before = new Map(base.map((file) => [file.path, file.sha]));
  const after = new Map(candidate.map((file) => [file.path, file.sha]));
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
  if (
    !changed.length ||
    changed.length > 100 ||
    changed.some((path) => !applicationFixPath(path)) ||
    changed.some(
      (path) =>
        !after.has(path) &&
        /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\./i.test(path),
    )
  )
    throw new CommandError(
      "conflict",
      "Automatic Delivery only accepts application-code fixes and regression coverage. This candidate requires human review and Delivery approval.",
    );
  return monitoringDigest({
    baseSha,
    commitSha,
    files: changed.map((path) => ({
      path,
      before: before.get(path) ?? null,
      after: after.get(path) ?? null,
    })),
  });
}
